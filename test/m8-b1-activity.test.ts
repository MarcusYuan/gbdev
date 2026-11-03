import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ActivityTracker,
  activityProbeIntervalMs,
  createWorkspaceFileProbe,
  workspaceActivityChanged,
} from '../src/core/activity.js';
import { parsePsCpuTimeToMs, type CpuSampleState, type WorkerCpuSample } from '../src/core/proc.js';
import { interpretCursorToolEvent, JsonlEventBuffer } from '../src/providers/cursorEvents.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { superviseJob } from '../src/core/supervise.js';
import { localIso, realClock, setActiveClock } from '../src/core/time.js';
import { captureWorkspaceSnapshot, diffSnapshotPaths, WorkspaceObservationRaceError } from '../src/core/workspaceSnapshot.js';
import { job } from './helpers.js';
import { eventually, tmpRepo } from './helpers/tmpRepo.js';

const idleCpu = (): WorkerCpuSample => ({
  unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: new Map(),
});

/** In-process supervisor integration with isolated config and injectable CPU, never real ps. */
function seedActivityJob(t: TestContext, options: { provider?: 'fake' | 'cursor'; inspect?: boolean; deadlineMs?: number; stallTimeoutS?: number } = {}) {
  const provider = options.provider ?? 'fake';
  const h = tmpRepo(t, 'slow', { provider, acceptance_criteria: [], stall_timeout_s: options.stallTimeoutS ?? 3 });
  const env = { ...h.env, GBDEV_CLI_HOME: join(h.root, 'cli'), GBDEV_FAKE_PLAN: '', GBDEV_LAUNCH_EXECUTION: '' };
  const saved = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const store = new JobStore(resolvePaths(h.env));
  const worktree = options.inspect ? join(h.root, 'inspect-worktree') : h.repo;
  if (options.inspect) h.git('worktree', 'add', '--detach', worktree, 'HEAD');
  const status = {
    ...job(), state: 'starting' as const, repo: h.repo, worktree, provider,
    role: options.inspect ? 'inspector' : 'executor',
    sandbox: options.inspect ? 'read-only' as const : 'workspace-write' as const,
    base_sha: h.git('rev-parse', 'HEAD').trim(),
    created_at: localIso(), deadline_at: localIso(new Date(Date.now() + (options.deadlineMs ?? 120_000))),
    state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }],
    step_instance: options.inspect ? null : 'b1#1',
    ...(options.inspect ? { kind: 'inspect' as const, inspection: {
      workspace_owned: true as const, detached: true as const, question: 'q', paths: [], diff: false, tests: false,
      target: { kind: 'job' as const, id: 'j_20261031_1203_aaaa', job_id: 'j_20261031_1203_aaaa', run_id: null, task_id: null, pipeline_id: null },
      snapshot: { mode: 'committed' as const, target_sha: h.git('rev-parse', 'HEAD').trim(), diff_base_sha: h.git('rev-parse', 'HEAD').trim(), captured_at: localIso(), uncommitted_included: false as const },
    } } : {}),
  };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(paths.brief, { ...h.task, role: status.role, sandbox: status.sandbox });
  const bin = join(h.root, 'b1-worker.mjs');
  atomicWriteJson(join(paths.dir, 'provider.json'), { bin: provider === 'cursor' ? bin : process.execPath, writable_roots: [] });
  writeFileSync(paths.prompt, 'b1 activity test');
  writeFileSync(paths.rawJsonl, '');
  writeFileSync(paths.workerLog, '');
  writeFileSync(paths.events, '');
  return { h, store, status, paths, bin,
    events: () => readFileSync(paths.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    result: () => JSON.parse(readFileSync(paths.result, 'utf8')),
  };
}

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) { now += ms; },
    set(ms: number) { now = ms; },
  };
}

function taskStarted(id = 'call-1') {
  return {
    type: 'tool_call',
    subtype: 'started',
    call_id: id,
    tool_call: { taskToolCall: { args: { description: 'sub' } } },
  };
}

function taskCompleted(id = 'call-1') {
  return {
    type: 'tool_call',
    subtype: 'completed',
    call_id: id,
    tool_call: { taskToolCall: { args: {}, result: { ok: true } } },
  };
}

function cpuProbe(sequence: WorkerCpuSample[]): (pgid: number, prev: CpuSampleState | null) => WorkerCpuSample {
  let i = 0;
  return () => {
    const sample = sequence[Math.min(i, sequence.length - 1)]!;
    i += 1;
    return sample;
  };
}

test('activityProbeIntervalMs follows min(1000, max(100, S*250))', () => {
  assert.equal(activityProbeIntervalMs(0), 1000);
  assert.equal(activityProbeIntervalMs(1), 250);
  assert.equal(activityProbeIntervalMs(2), 500);
  assert.equal(activityProbeIntervalMs(8), 1000);
});

test('parsePsCpuTimeToMs accepts macOS/Linux ps time forms', () => {
  assert.equal(parsePsCpuTimeToMs('1:02.50'), 62500);
  assert.equal(parsePsCpuTimeToMs('1:02:03'), 3723000);
  assert.equal(parsePsCpuTimeToMs('1-00:00:01'), 86401000);
  assert.equal(parsePsCpuTimeToMs('bogus'), null);
});

test('cursor tool events: started/completed/error and unknown shapes', () => {
  assert.equal(interpretCursorToolEvent(taskStarted('x')).kind, 'started');
  assert.equal(interpretCursorToolEvent(taskCompleted('x')).kind, 'completed');
  assert.equal(interpretCursorToolEvent({
    type: 'tool_call', subtype: 'error', call_id: 'x',
    tool_call: { shellToolCall: { args: {} } },
  }).kind, 'completed');
  assert.equal(interpretCursorToolEvent({ type: 'assistant', message: {} }).kind, 'none');
  assert.equal(interpretCursorToolEvent({ type: 'tool_call', subtype: 'started', tool_call: {} }).kind, 'none');
});

test('JsonlEventBuffer tolerates fragmented lines and noise', () => {
  const buf = new JsonlEventBuffer();
  assert.deepEqual(buf.push('{"type":"too'), []);
  assert.equal(buf.push('l_call","subtype":"started","call_id":"a","tool_call":{"taskToolCall":{"args":{}}}}\n').length, 1);
  assert.deepEqual(buf.push('not-json\n{"type":"unknown"}\n'), [{ type: 'unknown' }]);
});

test('AC-B1-1: pending task grants grace through 2S silence then success path', async () => {
  const clock = fakeClock();
  const tracker = new ActivityTracker({
    stallTimeoutS: 1,
    clock,
    pgid: () => 42,
    processProbe: () => ({ unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: new Map() }),
    fileProbe: () => ({ content_progress: false }),
  });
  tracker.noteOutput();
  tracker.noteCursorEvent(taskStarted());
  clock.advance(2000);
  let tick = await tracker.tick();
  assert.equal(tick.stalled, false);
  assert.equal(tick.diagnostics.grace_used, true);
  assert.equal(tick.diagnostics.pending_tool_count, 1);
  tracker.noteOutput(); // final result bytes
  tracker.noteCursorEvent(taskCompleted());
  clock.advance(500);
  tick = await tracker.tick();
  assert.equal(tick.stalled, false);
});

test('AC-B1-2: process alive alone stalls at S (+ sample)', async () => {
  const clock = fakeClock();
  const tracker = new ActivityTracker({
    stallTimeoutS: 1,
    clock,
    pgid: () => 42,
    processProbe: () => ({ unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: new Map([[42, 0]]) }),
    fileProbe: () => ({ content_progress: false }),
  });
  tracker.noteOutput();
  clock.advance(999);
  assert.equal((await tracker.tick()).stalled, false);
  clock.advance(1);
  const tick = await tracker.tick();
  assert.equal(tick.stalled, true);
  assert.equal(tick.diagnostics.grace_used, false);
  assert.ok(tick.events.some(e => e.type === 'warning' && e.data.code === 'worker_stalled'));
});

test('AC-B1-3a: never-ending pending tool stalls at 3S', async () => {
  const clock = fakeClock();
  const tracker = new ActivityTracker({
    stallTimeoutS: 1,
    clock,
    pgid: () => 42,
    processProbe: () => ({ unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: new Map() }),
    fileProbe: () => ({ content_progress: false }),
  });
  tracker.noteOutput();
  tracker.noteCursorEvent(taskStarted());
  clock.advance(2999);
  assert.equal((await tracker.tick()).stalled, false);
  clock.advance(1);
  const tick = await tracker.tick();
  assert.equal(tick.stalled, true);
  assert.equal(tick.diagnostics.grace_used, true);
  assert.equal(tick.diagnostics.pending_tool_count, 1);
});

test('orphan/duplicate completed never underflows pending or renews a window', async () => {
  const clock = fakeClock();
  const tracker = new ActivityTracker({ stallTimeoutS: 1, clock, pgid: () => 42, processProbe: idleCpu });
  clock.advance(999);
  assert.deepEqual(tracker.noteCursorEvent(taskCompleted('orphan')), []);
  assert.equal(tracker.pendingToolCount, 0);
  clock.advance(1);
  assert.equal((await tracker.tick()).stalled, true);
  tracker.noteOutput();
  tracker.noteCursorEvent(taskStarted());
  clock.advance(2000);
  assert.deepEqual(tracker.noteCursorEvent(taskCompleted('orphan')), []);
  assert.equal(tracker.pendingToolCount, 1);
  assert.equal((await tracker.tick()).stalled, false);
  tracker.noteCursorEvent(taskCompleted());
  assert.deepEqual(tracker.noteCursorEvent(taskCompleted()), []);
  const tick = await tracker.tick();
  assert.equal(tick.diagnostics.pending_tool_count, 0);
  assert.equal(tick.diagnostics.grace_used, false);
  assert.equal(tick.stalled, true);
});

test('flush processes final JSON without LF exactly once and tolerates partial/noise', () => {
  const tracker = new ActivityTracker({ stallTimeoutS: 1, clock: fakeClock(), pgid: () => null });
  tracker.consumeStdout(JSON.stringify(taskStarted()) + '\n' + JSON.stringify(taskCompleted()));
  assert.equal(tracker.pendingToolCount, 1);
  assert.equal(tracker.flushStdout().length, 1);
  assert.equal(tracker.pendingToolCount, 0);
  assert.deepEqual(tracker.flushStdout(), []);
  for (const tail of ['{"type":', 'noise', 'null', '[]']) {
    tracker.consumeStdout(tail);
    assert.deepEqual(tracker.flushStdout(), []);
  }
});

test('CPU timeout budget is at most half a tick/200ms; timeouts warn only once and do not grant grace', async () => {
  for (const s of [0.1, 1, 8]) {
    const clock = fakeClock();
    let calls = 0;
    const tracker = new ActivityTracker({ stallTimeoutS: s, clock, pgid: () => 42,
      processProbe: (_pgid, _previous, timeoutMs) => {
        calls++;
        assert.equal(timeoutMs, Math.min(200, activityProbeIntervalMs(s) / 2));
        throw Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT' });
      },
    });
    const first = await tracker.tick();
    assert.equal(first.events.filter(e => e.data.code === 'activity_probe_unavailable').length, 1);
    clock.advance(s * 1000);
    const last = await tracker.tick();
    assert.equal(last.events.filter(e => e.data.code === 'activity_probe_unavailable').length, 0);
    assert.equal(last.stalled, true);
    assert.equal(last.diagnostics.grace_used, false);
    assert.equal(calls, 2);
  }
});

test('stall diagnostics use the exact decision timestamp', async () => {
  let now = 0;
  const tracker = new ActivityTracker({ stallTimeoutS: 1, clock: { now: () => now++ }, pgid: () => null });
  now = 1000;
  const tick = await tracker.tick();
  assert.equal(tick.stalled, true);
  assert.equal(tick.diagnostics.idle_s, 1);
  assert.equal(tick.events.find(e => e.data.code === 'worker_stalled')?.data.idle_s, 1);
});

test('output drained after CPU sampling resets CPU grace and preserves transition event order', async () => {
  const clock = fakeClock();
  const tracker = new ActivityTracker({
    stallTimeoutS: 1, clock, pgid: () => 42,
    processProbe: () => {
      clock.advance(4000);
      return { ...idleCpu(), cpuDeltaMs: 100 };
    },
  });
  const tick = await tracker.tick(() => tracker.noteOutput());
  assert.equal(tick.stalled, false);
  assert.equal(tick.diagnostics.idle_s, 0);
  assert.equal(tick.diagnostics.grace_used, false);
  assert.deepEqual(tick.events.filter(e => e.type === 'heartbeat').map(e => e.data.grace_active), [true, false]);
});

test('AC-B1-3b: continuous CPU without output/file stalls at 3S', async () => {
  const clock = fakeClock();
  let cpu = 0;
  const tracker = new ActivityTracker({
    stallTimeoutS: 1,
    clock,
    pgid: () => 42,
    processProbe: () => {
      cpu += 100;
      return { unavailable: false, identityChanged: false, cpuDeltaMs: 100, cpuTotalMs: cpu, state: new Map([[42, cpu]]) };
    },
    fileProbe: () => ({ content_progress: false }),
  });
  tracker.noteOutput();
  clock.advance(1000);
  assert.equal((await tracker.tick()).stalled, false); // grace via CPU inside [S, 3S)
  clock.advance(2000);
  const tick = await tracker.tick();
  assert.equal(tick.stalled, true);
  assert.equal(tick.diagnostics.cpu_progress_observed, true);
});

async function flushProbe(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('AC-B1-4: file content progress refreshes window past 3S; silence then stalls', async () => {
  const clock = fakeClock();
  let progress = false;
  const tracker = new ActivityTracker({
    stallTimeoutS: 1,
    clock,
    pgid: () => 42,
    processProbe: () => ({ unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: new Map() }),
    fileProbe: async () => ({ content_progress: progress }),
  });
  tracker.noteOutput();
  async function pulseFile(): Promise<void> {
    progress = true;
    await tracker.tick();
    await flushProbe();
    await tracker.tick(); // apply content progress
    progress = false;
    await tracker.tick();
    await flushProbe();
  }
  await pulseFile();
  assert.equal(tracker.diagnostics().last_progress_source, 'file');
  for (let i = 0; i < 5; i++) {
    clock.advance(900); // < S since last file progress
    await pulseFile();
    assert.equal((await tracker.tick()).stalled, false, `loop ${i}`);
  }
  clock.advance(1000);
  assert.equal((await tracker.tick()).stalled, true);
});

test('AC-B1-5: real gbdev heartbeat/runtime writes outside worktree do not refresh tracker', async t => {
  const h = tmpRepo(t);
  assert.ok(!h.home.startsWith(h.repo + '/'));
  mkdirSync(join(h.home, 'runs', 'b1'), { recursive: true });
  const probe = createWorkspaceFileProbe(h.repo, 'j_test_heartbeat');
  assert.equal((await probe()).content_progress, false);
  const clock = fakeClock();
  let scanned: Promise<unknown> = Promise.resolve();
  const tracker = new ActivityTracker({
    stallTimeoutS: 1,
    clock,
    pgid: () => 42,
    processProbe: () => ({ unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: new Map() }),
    fileProbe: () => {
      const result = probe();
      scanned = Promise.resolve(result);
      return result;
    },
  });
  tracker.noteOutput();
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(h.home, 'runs', 'b1', 'run.json'), JSON.stringify({ heartbeat_at: clock.now() }));
    writeFileSync(join(h.home, 'events.jsonl'), JSON.stringify({ type: 'heartbeat', seq: i }) + '\n');
    await tracker.tick();
    await scanned;
    await flushProbe();
    clock.advance(250);
  }
  assert.equal((await tracker.tick()).stalled, true);
  await scanned;
  await flushProbe();
  assert.equal(tracker.diagnostics().last_progress_source, 'output');
});

test('AC-B1-5 integration: workspace mtime touch is not content progress', async t => {
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [] });
  const target = join(h.repo, 'src', 'mtime-only.txt');
  mkdirSync(join(h.repo, 'src'), { recursive: true });
  writeFileSync(target, 'same\n');
  const probe = createWorkspaceFileProbe(h.repo, 'j_test_mtime');
  assert.equal((await probe()).content_progress, false); // baseline
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  utimesSync(target, past, future);
  assert.equal((await probe()).content_progress, false);
  writeFileSync(target, 'changed\n');
  assert.equal((await probe()).content_progress, true);
});

test('activity comparison ignores unknown/hash availability/index/HEAD, preserves B3 unknown=changed unless stat-proven', async t => {
  const h = tmpRepo(t);
  const target = join(h.repo, 'src', 'large.bin');
  writeFileSync(target, Buffer.alloc(300 * 1024, 7));
  const before = await captureWorkspaceSnapshot(h.repo, { job_id: 'b1', phase: 'after_worker' }, { maxHashBytes: 256 * 1024 });
  assert.equal(before.entries.find(e => e.path === 'src/large.bin')?.content_unknown, true);
  const after = structuredClone(before);
  after.head_sha = 'f'.repeat(40);
  for (const entry of after.entries) entry.index_state = { xy: 'A ', staged: true, unstaged: false, untracked: false, index_blob: 'changed-index' };
  assert.equal(workspaceActivityChanged(before, after), false);
  // M8.1: B3 treats unknown content as changed unless an equal, non-racy stat identity proves otherwise.
  const noStat = structuredClone(before);
  delete noStat.entries.find(e => e.path === 'src/large.bin')!.content_stat;
  assert.ok(diffSnapshotPaths(noStat, noStat).includes('src/large.bin'), 'B3 must retain unknown=changed without a stat identity');
  const restat = structuredClone(before);
  restat.entries.find(e => e.path === 'src/large.bin')!.content_stat!.ctime_ns = '1';
  assert.ok(diffSnapshotPaths(before, restat).includes('src/large.bin'), 'B3 must treat a different stat identity as changed');
  const known = structuredClone(before);
  const large = known.entries.find(e => e.path === 'src/large.bin')!;
  delete large.content_unknown;
  large.content_hash = 'a'.repeat(64);
  assert.equal(workspaceActivityChanged(before, known), false);
  assert.equal(workspaceActivityChanged(known, before), false);
  for (const change of ['hash', 'kind', 'mode', 'add', 'delete'] as const) {
    const changed = structuredClone(known);
    const entry = changed.entries.find(e => e.path === 'src/large.bin')!;
    if (change === 'hash') entry.content_hash = 'b'.repeat(64);
    if (change === 'kind') entry.kind = 'symlink';
    if (change === 'mode') entry.mode ^= 0o100;
    if (change === 'add') changed.entries.push({ ...entry, path: 'src/added' });
    if (change === 'delete') changed.entries = changed.entries.filter(e => e !== entry);
    assert.equal(workspaceActivityChanged(known, changed), true, change);
  }
});

test('real git index-only changes and unknown large-file mtime do not count as activity', async t => {
  const h = tmpRepo(t);
  const large = join(h.repo, 'src', 'large.bin');
  writeFileSync(large, Buffer.alloc(300 * 1024));
  const probe = createWorkspaceFileProbe(h.repo, 'b1-index');
  assert.equal((await probe()).content_progress, false);
  h.git('add', 'src/large.bin');
  assert.equal((await probe()).content_progress, false);
  const future = new Date(Date.now() + 60_000);
  utimesSync(large, future, future);
  assert.equal((await probe()).content_progress, false);
  h.git('rm', '--cached', 'src/large.bin');
  assert.equal((await probe()).content_progress, false);
  unlinkSync(join(h.repo, 'src', 'initial.txt'));
  assert.equal((await probe()).content_progress, true);
  h.git('rm', '--cached', 'src/initial.txt');
  assert.equal((await probe()).content_progress, false, 'index removal of an already absent file is not a new path deletion');
});

test('AC-B1-6: fragmented JSON, duplicate started, unknown events, probe errors, identity change', async () => {
  const clock = fakeClock();
  const tracker = new ActivityTracker({
    stallTimeoutS: 1,
    clock,
    pgid: () => 42,
    processProbe: cpuProbe([
      { unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 10, state: new Map([[42, 10]]) },
      { unavailable: true, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 10, state: new Map([[42, 10]]) },
      { unavailable: false, identityChanged: true, cpuDeltaMs: 500, cpuTotalMs: 5, state: new Map([[99, 5]]) },
      { unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 5, state: new Map([[99, 5]]) },
    ]),
    fileProbe: () => { throw new Error('boom'); },
  });
  // Fragmented started
  tracker.consumeStdout('{"type":"tool_call","subtype":"started","call_id":"dup",');
  tracker.consumeStdout('"tool_call":{"taskToolCall":{"args":{}}}}\n');
  assert.equal(tracker.pendingToolCount, 1);
  tracker.noteCursorEvent(taskStarted('dup')); // duplicate: no re-lease / no pending growth
  assert.equal(tracker.pendingToolCount, 1);
  tracker.noteCursorEvent({ type: 'mystery', subtype: 'x' });
  clock.advance(500);
  await tracker.tick(); // schedule failing file probe + first cpu sample
  await flushProbe();
  let tick = await tracker.tick(); // apply file unavailable warning once
  assert.ok(tick.events.some(e => e.type === 'warning' && e.data.code === 'activity_probe_unavailable'));
  clock.advance(500);
  tick = await tracker.tick(); // cpu unavailable (second sample) — warning already emitted
  assert.ok(!tick.events.some(e => e.data.code === 'activity_probe_unavailable'));
  // Identity change must not grant CPU grace; pending tool still under 3S.
  clock.advance(500);
  tick = await tracker.tick();
  assert.equal(tick.stalled, false);
  clock.advance(2000);
  tick = await tracker.tick();
  assert.equal(tick.stalled, true); // 3S from last output despite identity churn
});

test('AC-B1-7 unit: S=0 disables stall; cancel/deadline remain caller-owned', async () => {
  const clock = fakeClock();
  const tracker = new ActivityTracker({
    stallTimeoutS: 0,
    clock,
    pgid: () => 42,
    processProbe: () => ({ unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: new Map() }),
  });
  clock.advance(60_000);
  assert.equal((await tracker.tick()).stalled, false);
});

for (const completed of [false, true]) {
  test(`stall decision drains worker output written during a blocking probe (completed=${completed})`, async t => {
    const fx = seedActivityJob(t, { provider: 'cursor', stallTimeoutS: 1 });
    const gate = join(fx.h.root, 'output-gate');
    const ready = join(fx.h.root, 'output-ready');
    const clock = fakeClock(Date.now());
    setActiveClock({ ...realClock, now: clock.now });
    t.after(() => setActiveClock(null));
    writeFileSync(fx.bin, `#!${process.execPath}
import { existsSync, writeFileSync, writeSync } from 'node:fs';
const gate = ${JSON.stringify(gate)}, ready = ${JSON.stringify(ready)};
const events = ${JSON.stringify([taskStarted(), ...(completed ? [taskCompleted()] : [])])};
for (let i = 0; i < events.length; i++) {
  while (!existsSync(gate + i)) await new Promise(r => setTimeout(r, 5));
  writeSync(1, JSON.stringify(events[i]) + '\\n');
  writeFileSync(ready + i, 'written');
}
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let calls = 0;
    let writesObserved = 0;
    await superviseJob(fx.status.job_id, fx.store, undefined, { processProbe: () => {
      const i = calls++;
      if (i === 0 || (completed && i === 1)) {
        writeFileSync(gate + i, 'go');
        const until = Date.now() + 10_000;
        // Block the supervisor event loop, but let the real child write stdout.
        // No data callback can run before the impending stall decision.
        while (!existsSync(ready + i) && Date.now() < until) Atomics.wait(sleeper, 0, 0, 10);
        if (existsSync(ready + i)) writesObserved++;
        clock.advance(4000); // exceeds even 3S before the new output is read
      } else {
        clock.advance(i === 1 ? 2000 : 1000);
      }
      return idleCpu();
    } });
    assert.equal(writesObserved, completed ? 2 : 1);
    assert.equal(calls, 3, 'fresh output resets the window; pending alone must not renew it');
    assert.equal(fx.result().failure_reason, 'worker_stalled');
    const stalls = fx.events().filter(e => e.data.code === 'worker_stalled');
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].data.idle_s, completed ? 1 : 3);
    assert.equal(stalls[0].data.pending_tool_count, completed ? 0 : 1);
    assert.equal(stalls[0].data.grace_used, !completed);
    assert.equal(stalls[0].data.last_progress_source, 'output');
    const summary = fx.events().findLast(e => e.type === 'worker_output');
    assert.equal(summary.data.raw_events, writesObserved, 'tail reads must not count bytes twice');
    assert.equal(summary.data.bytes, readFileSync(fx.paths.rawJson).length);
  });
}

test('AC-B1-1/7 integration: cursor stub task-started + 2S silence succeeds', async t => {
  const s = 3;
  const fx = seedActivityJob(t, { provider: 'cursor', stallTimeoutS: s });
  const ready = join(fx.h.root, 'worker-ready');
  const base = Date.now();
  let readyAt: number | undefined;
  // Exclude interpreter startup from this test's silence window. After the
  // first synchronous worker write, elapsed time is entirely real wall time.
  setActiveClock({ ...realClock, now: () => {
    if (readyAt === undefined && existsSync(ready)) {
      const stamp = Number(readFileSync(ready, 'utf8'));
      if (stamp > 0) readyAt = stamp; // the child may be between opening and writing the marker
    }
    return base + (readyAt === undefined ? 0 : Date.now() - readyAt);
  } });
  t.after(() => setActiveClock(null));
  writeFileSync(fx.bin, `#!${process.execPath}
import { writeFileSync, writeSync } from 'node:fs';
const started = JSON.stringify({
  type: 'tool_call', subtype: 'started', call_id: 't1',
  tool_call: { taskToolCall: { args: { description: 'wait' } } }
});
writeSync(1, started + '\\n');
writeFileSync(${JSON.stringify(ready)}, String(Date.now()));
await new Promise(r => setTimeout(r, ${2 * s * 1000})); // 2S, strictly below the 3S ceiling
const report = { schema: 'gbdev.worker-result.v1', status: 'succeeded', summary: 'b1 ok',
  files_changed: [], commits: [], tests: [], evidence: [], open_questions: [], blockers: [], policy_violations: [] };
const message = 'ok\\n\\n\`\`\`json\\n' + JSON.stringify(report) + '\\n\`\`\`\\n';
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: message }) + '\\n');
`, { mode: 0o700 });
  await superviseJob(fx.status.job_id, fx.store, undefined, { processProbe: idleCpu });
  assert.equal(fx.result().state, 'succeeded', JSON.stringify(fx.result()));
  const events = fx.events();
  assert.ok(!events.some(e => e.type === 'warning' && e.data.code === 'worker_stalled'));
  assert.ok(events.some(e => e.type === 'heartbeat' && e.data.kind === 'worker_activity' && e.data.grace_active === true));
});

test('AC-B1-2 integration: stable over-budget file + silent worker stalls near S without grace', async t => {
  // Preserve a strict <3S end-to-end bound while leaving room for process/Git
  // startup on a loaded machine. Exact stall timing is also tested with fake clocks.
  const s = 5;
  const fx = seedActivityJob(t, { stallTimeoutS: s });
  const upperMs = s * 1000 + activityProbeIntervalMs(s) + 6000;
  assert.ok(upperMs < 3 * s * 1000, 'load allowance must remain well below 3S');
  writeFileSync(join(fx.h.repo, 'src', 'large.bin'), Buffer.alloc(300 * 1024));
  const begin = Date.now();
  await superviseJob(fx.status.job_id, fx.store, undefined, { processProbe: idleCpu });
  const result = fx.result();
  assert.equal(result.failure_reason, 'worker_stalled');
  // Includes baseline/startup/finalization and 6s scheduling slack, not grace.
  assert.ok(Date.now() - begin < upperMs, `took ${Date.now() - begin}ms; limit ${upperMs}ms`);
  const stall = fx.events().find(e => e.type === 'warning' && e.data.code === 'worker_stalled');
  assert.ok(stall);
  assert.equal(stall.data.retryable, true);
  assert.equal(stall.data.pending_tool_count, 0);
  assert.equal(stall.data.grace_used, false);
  assert.ok(stall.data.idle_s >= s && stall.data.idle_s < upperMs / 1000, JSON.stringify(stall));
});

test('non-Cursor provider emitting Cursor-shaped started JSONL gets no pending grace', async t => {
  const fx = seedActivityJob(t);
  const plan = join(fx.h.root, 'plan.json');
  atomicWriteJson(plan, { 'b1#1': { scenario: 'fix_noop', actions: [
    { type: 'emit_json', value: taskStarted() }, { type: 'sleep_ms', ms: 15000 },
  ] } });
  process.env.GBDEV_FAKE_PLAN = plan;
  await superviseJob(fx.status.job_id, fx.store, undefined, { processProbe: idleCpu });
  assert.equal(fx.result().failure_reason, 'worker_stalled');
  assert.match(readFileSync(fx.paths.rawJsonl, 'utf8'), /taskToolCall/);
  const stall = fx.events().find(e => e.data.code === 'worker_stalled');
  assert.equal(stall.data.pending_tool_count, 0);
  assert.equal(stall.data.grace_used, false);
  const s = fx.h.task.stall_timeout_s!;
  assert.ok(stall.data.idle_s >= s && stall.data.idle_s < s + activityProbeIntervalMs(s) / 1000 + 2);
});

function cursorHold(bin: string): void {
  writeFileSync(bin, `#!${process.execPath}
process.stdout.write(${JSON.stringify(JSON.stringify(taskStarted()) + '\n')});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
}

test('Cursor inspect ignores pending tools and CPU, keeps running job.json frozen until S stall', async t => {
  const fx = seedActivityJob(t, { provider: 'cursor', inspect: true });
  cursorHold(fx.bin);
  let cpuCalls = 0;
  const running = superviseJob(fx.status.job_id, fx.store, undefined, { processProbe: () => {
    cpuCalls++;
    return { ...idleCpu(), cpuDeltaMs: 100 };
  } });
  await eventually(() => fx.store.read(fx.status.job_id).state === 'running'
    && readFileSync(fx.paths.rawJson, 'utf8').includes('taskToolCall') ? true : undefined);
  const frozen = readFileSync(fx.paths.job);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(readFileSync(fx.paths.job), frozen);
  await running;
  assert.equal(cpuCalls, 0);
  assert.equal(fx.result().failure_reason, 'worker_stalled');
  const stall = fx.events().find(e => e.data.code === 'worker_stalled');
  assert.equal(stall.data.pending_tool_count, 0);
  assert.equal(stall.data.grace_used, false);
  assert.ok(!fx.events().some(e => e.data.kind === 'worker_activity'));
});

test('AC-B1-7: absolute deadline wins while pending grace is active (injected clock/probe)', async t => {
  const fx = seedActivityJob(t, { provider: 'cursor', deadlineMs: 60_000 });
  cursorHold(fx.bin);
  const clock = fakeClock(Date.now());
  setActiveClock({ ...realClock, now: clock.now });
  t.after(() => setActiveClock(null));
  let advanced = false;
  await superviseJob(fx.status.job_id, fx.store, undefined, { processProbe: () => {
    // Wait for confirmed pending before advancing: child startup can take a tick.
    if (fx.events().some(e => e.data.kind === 'worker_activity' && e.data.grace_active)) {
      advanced = true;
      clock.advance(60_001);
    }
    return idleCpu();
  } });
  assert.equal(fx.result().state, 'timeout');
  assert.notEqual(fx.result().failure_reason, 'worker_stalled');
  assert.equal(advanced, true, 'deadline must be crossed by injected time while pending');
  assert.ok(fx.events().some(e => e.data.kind === 'worker_activity' && e.data.grace_active));
  assert.ok(!fx.events().some(e => e.data.code === 'worker_stalled'));
});

test('Cursor close flushes the final completed line once without altering success', async t => {
  const fx = seedActivityJob(t, { provider: 'cursor' });
  const report = { schema: 'gbdev.worker-result.v1', status: 'succeeded', summary: 'ok',
    files_changed: [], commits: [], tests: [], evidence: [], open_questions: [], blockers: [], policy_violations: [] };
  const resultEvent = { type: 'result', subtype: 'success', is_error: false,
    result: '```json\n' + JSON.stringify(report) + '\n```' };
  const output = [taskStarted(), resultEvent, taskCompleted()].map(value => JSON.stringify(value)).join('\n');
  writeFileSync(fx.bin, `#!${process.execPath}
process.stdout.write(${JSON.stringify(output)});
`, { mode: 0o700 });
  const original = ActivityTracker.prototype.flushStdout;
  const counts: number[] = [];
  t.mock.method(ActivityTracker.prototype, 'flushStdout', function (this: ActivityTracker) {
    counts.push(this.pendingToolCount);
    const events = original.call(this);
    counts.push(this.pendingToolCount);
    return events;
  });
  await superviseJob(fx.status.job_id, fx.store, undefined, { processProbe: idleCpu });
  assert.deepEqual(counts, [1, 0]);
  assert.equal(fx.result().state, 'succeeded', JSON.stringify(fx.result()));
});

test('AC-B1-7 integration: cancel during pending grace wins over stall', async t => {
  const fx = seedActivityJob(t, { provider: 'cursor' });
  cursorHold(fx.bin);
  const running = superviseJob(fx.status.job_id, fx.store, undefined, { processProbe: idleCpu });
  await eventually(() => fx.events().some(e => e.data.kind === 'worker_activity' && e.data.grace_active) ? true : undefined);
  atomicWriteJson(fx.paths.cancelRequest, { by: 'test', reason: 'b1' });
  await running;
  assert.equal(fx.result().state, 'cancelled');
  assert.notEqual(fx.result().failure_reason, 'worker_stalled');
});

test('B1 real file probe treats mid-hash writes as progress; B3 still fails closed', async t => {
  const f = tmpRepo(t);
  const path = 'src/initial.txt';
  writeFileSync(join(f.repo, path), Buffer.alloc(128 * 1024, 'a'));
  let writes = 0;
  const onHashChunk = (rel: string, bytes: number) => {
    if (rel === path && bytes === 64 * 1024) {
      appendFileSync(join(f.repo, path), 'changed during hashing');
      writes++;
    }
  };
  const probe = createWorkspaceFileProbe(f.repo, 'activity-race', { onHashChunk });
  assert.deepEqual(await probe(), { content_progress: true });
  assert.deepEqual(await probe(), { content_progress: true });
  assert.equal(writes, 2);
  await assert.rejects(captureWorkspaceSnapshot(f.repo, {
    job_id: 'activity-race', phase: 'after_worker',
  }, { onHashChunk }), (error: unknown) => error instanceof WorkspaceObservationRaceError
    && error.contract.code === 'workspace_snapshot_invalid');
  assert.equal(writes, 3);
  for (const options of [{ cancelled: () => true }, { deadlineAt: Date.now() - 1 }]) {
    assert.deepEqual(await createWorkspaceFileProbe(f.repo, 'unavailable', options)(), {
      content_progress: false, unavailable: true,
    });
  }
  assert.deepEqual(await createWorkspaceFileProbe(join(f.root, 'missing'), 'unavailable')(), {
    content_progress: false, unavailable: true,
  });
});
