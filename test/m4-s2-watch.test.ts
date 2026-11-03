import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { appendFileSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { startRun, cancelRun } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { readRun } from '../src/run/store.js';
import { runCli } from '../src/cli.js';
import { paneTarget } from '../src/commands/watch.js';
import { validateEnvelope } from '../src/contracts/envelope.js';
import { validateRun } from '../src/contracts/run.js';
import { validatePipelineRun, type PipelineRun } from '../src/contracts/pipelineRun.js';
import { job, temporary } from './helpers.js';
import { testEnv } from './helpers/run.js';
import { fixture as fakeRunFixture, until } from './helpers/m3.js';
import { Lifecycle, ViewFiles, type Clock, type ViewOptions } from '../src/render/views/common.js';
import { WatchView, watchView, type Target } from '../src/render/views/watch.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { HomeFs, RefusedPath, TransientPath } from '../src/render/homeFs.js';
import { JobRenderer } from '../src/render/job.js';
import { type RenderLine } from '../src/render/format.js';
import { indexView } from '../src/render/views/index.js';

const at = '2026-10-28T12:00:00.000+00:00', initialTime = Date.parse(at);
const job1 = 'j_20261028_1200_1111', job2 = 'j_20261028_1201_2222';
const pipeline1 = 'p_20261027_0915_11aa', pipeline2 = 'p_20261028_1201_2222';
function fixture(t: TestContext) {
  const root = temporary(t), home = join(root, 'home'); mkdirSync(home);
  testEnv(t, { GBDEV_HOME: home, GBDEV_CONFIG: join(root, 'never-read'), NO_COLOR: '1' });
  const save = (path: string, value: unknown) => { const full = join(home, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, JSON.stringify(value)); };
  const run = validateRun(JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8')));
  // Fixture paths are display-only; replace them with test-owned paths so accidental access fails locally.
  run.repo = join(root, 'repo'); run.integration.worktree = join(root, 'integration'); run.created_at = at;
  for (const lane of run.lanes) lane.worktree = join(root, lane.lane);
  const saveRun = () => save(`runs/${run.run_id}/run.json`, run); saveRun();
  const makeJob = (id: string, text: string, extra = {}) => {
    const value = { ...job(id), created_at: at, state: 'succeeded', ...extra };
    save(`jobs/${id}/job.json`, value);
    writeFileSync(join(home, `jobs/${id}/raw.jsonl`), JSON.stringify({ type: 'item.completed', at, item: { type: 'agent_message', text } }) + '\n'); return value;
  };
  const makePipeline = (id: string, jid: string, instance = 'implement#1') => {
    const p: PipelineRun = { schema: 'gbdev.pipeline-run.v1', pipeline_id: id, pipeline: 'implement-review', state: 'running', state_reason: null, outcome: null, failure_reason: null,
      repo: run.repo, workspace: { mode: 'shared_run_worktree', branch: 'test', worktree: join(root, 'tree') }, base_sha: 'abc', diff_base_sha: 'abc', head_sha: 'abc', round: 1, max_rounds: 3, jobs_used: 1, max_total_jobs: 10,
      current: { instance, job_id: jid, job_state: 'running', attempt: 1 }, steps: [{ instance, step_id: instance.split('#')[0]!, kind: 'step', role: 'executor', provider: 'fake', sandbox: 'workspace-write', state: 'running', round: 1, attempts: [{ attempt: 1, job_id: jid, job_state: 'running', failure_reason: null }], gate: null, verdict: null, head_before: 'abc', head_after: null, handoff: null, started_at: at, finished_at: null }], decision: null, pending_questions: [], supervisor_pid: null, heartbeat_at: at, created_at: at, updated_at: at, deadline_at: at, state_history: [{ state: 'running', at, by: 'gbdev', reason: null }], warnings: [], integration: null };
    save(`pipelines/${id}/pipeline.json`, validatePipelineRun(p)); return p;
  };
  return { root, home, run, save, saveRun, makeJob, makePipeline };
}
async function cli(args: string[]) {
  let stdout = '', stderr = ''; const code = await runCli(args, { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } }); return { code, stdout, stderr };
}
function fakeClock(onSleep: (now: number) => void = () => {}) {
  let now = initialTime, sleeps = 0;
  const clock: Clock = { now: () => now, sleep: async ms => { assert.ok(++sleeps < 20000, 'bounded lifecycle'); now += ms; onSleep(now); } };
  return { clock, now: () => now, sleeps: () => sleeps };
}
async function render(home: string, target: Target, options: ViewOptions) {
  let output = ''; const code = await watchView(new WatchView(home, target, options), s => { output += s; }); return { code, output };
}

test('M4 AC-9 run watch lane-1 switches two fake tasks and backfills the second job', async t => {
  const f = fixture(t); f.makeJob(job1, 'first-task'); f.makePipeline(pipeline1, job1);
  f.makeJob(job2, 'second-task'); f.makePipeline(pipeline2, job2, 'implement#2');
  let output = '', stderr = '', switched = false;
  const result = await runCli(['run', 'watch', f.run.run_id, '--pane', 'lane-1', '--no-color'], {
    stdout: s => {
      output += s;
      if (s.includes('first-task') && !switched) { switched = true; f.run.lanes[0]!.pipeline_id = pipeline2; f.run.lanes[0]!.task_id = 'lib-sum'; f.saveRun(); }
      if (s.includes('second-task')) { f.run.state = 'succeeded'; f.run.outcome = 'integrated'; f.saveRun(); }
    }, stderr: s => { stderr += s; },
  });
  assert.equal(result, 0, stderr); assert.equal(stderr, '');
  assert.match(output, /──── health · implement#1 · fake/); assert.match(output, /──── lib-sum · implement#2 · fake/);
  assert.equal(output.match(/first-task/g)?.length, 1); assert.equal(output.match(/second-task/g)?.length, 1);
  assert.ok(output.indexOf('first-task') < output.indexOf('second-task')); assert.match(output, /DONE\s+summary/);
});

test('M4 AC-10 run watch once JSON is a valid v1 envelope, stderr empty and byte-read-only', async t => {
  const f = fixture(t), path = join(f.home, `runs/${f.run.run_id}/run.json`), before = readFileSync(path);
  // Stale heartbeat + dead supervisor would cause existing status/reconcile to mutate this record.
  const out = await cli(['run', 'watch', f.run.run_id, '--once', '--json']); assert.equal(out.code, 0); assert.equal(out.stderr, '');
  const envelope = validateEnvelope(JSON.parse(out.stdout)); assert.ok(envelope.ok); assert.equal(envelope.contract_version, '1');
  assert.deepEqual(JSON.parse(out.stdout).result, f.run); assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(dirname(path)), ['run.json']);
});

test('M4 AC-11 decisions and safe title are visible; all sections use projected metadata', async t => {
  const f = fixture(t); f.run.state = 'needs_decision';
  f.run.attention = ['integration_gate_failed', 'task_failed'].map((reason, i) => ({ decision_id: `d_${i}`, scope: 'task', task_id: 'health', reason: reason as 'task_failed', allowed_actions: ['extra_fix', 'drop_task'], detail: 'password=abcdef,ghijkl', pipeline_id: null, merge_seq: null, pending_questions: [], created_at: at }));
  f.saveRun(); f.save(`runs/${f.run.run_id}/request.json`, { goal: 'NEVER_GOAL', tasks: [{ id: 'health', title: 'Safe\x1b]52;c;PAYLOAD\x07 Title' + 'x'.repeat(80), goal: 'NEVER_GOAL' }] });
  f.save(`runs/${f.run.run_id}/merges/1.json`, { seq: 1, task_id: 'version', result: 'integrated', gate: { checks: [{ id: 'test', exit_code: 0, duration_s: 41 }] } });
  f.save(`runs/${f.run.run_id}/baseline-gate.json`, { gate: { passed: true } });
  f.save(`runs/${f.run.run_id}/final-review.json`, { verdict: 'revise', findings: [{ message: 'HIDDEN_BODY' }] });
  const out = await cli(['run', 'watch', f.run.run_id, '--once', '--pane', 'status', '--no-color']);
  assert.equal(out.code, 0); assert.equal(out.stderr, '');
  for (const d of f.run.attention) { assert.ok(out.stdout.includes(d.decision_id)); assert.ok(out.stdout.includes(d.reason)); for (const a of d.allowed_actions) assert.ok(out.stdout.includes(a)); }
  for (const section of ['TASK', 'LANES', 'MERGES', 'GATES', 'ATTENTION', 'BUDGET', 'SLOTS', 'FINAL REVIEW']) assert.ok(out.stdout.includes(section));
  f.run.integration.head_sha = f.run.integration.verified_sha = 'sk-' + 'X'.repeat(24); f.saveRun();
  const secretSha = await cli(['run', 'watch', f.run.run_id, '--once', '--pane', 'status']);
  assert.match(secretSha.stdout, /@‹redacted›/); assert.doesNotMatch(secretSha.stdout, /sk-XXX/);
  assert.match(out.stdout, /Safe Title/); assert.match(out.stdout, /‹redacted›/); assert.doesNotMatch(out.stdout, /[\x1b\x07\x9b]|PAYLOAD|NEVER_GOAL|HIDDEN_BODY|ghijkl|x{40}/);
});

test('M4 pipeline watch step switch, terminal fallback, JSON current_job_lines and needs_input', async t => {
  const f = fixture(t); f.makeJob(job1, 'pipeline-first'); f.makeJob(job2, 'pipeline-second'); const p = f.makePipeline(pipeline1, job1);
  let tick = 0; const clock = fakeClock(() => {
    if (++tick === 1) { const next = f.makePipeline(pipeline1, job2, 'review#1'); Object.assign(p, next); }
    else { p.state = 'succeeded'; p.outcome = 'approved'; p.current = null; f.save(`pipelines/${pipeline1}/pipeline.json`, p); }
  });
  const out = await render(f.home, { kind: 'pipeline-all', id: pipeline1 }, { clock: clock.clock });
  assert.equal(out.code, 0); assert.match(out.output, /pipeline-first/); assert.match(out.output, /pipeline-second/); assert.match(out.output, /summary .* succeeded/);
  const snapshot = await cli(['pipeline', 'watch', pipeline1, '--once', '--json']); assert.equal(snapshot.code, 0); assert.equal(snapshot.stderr, ''); validateEnvelope(JSON.parse(snapshot.stdout));
  assert.ok(JSON.parse(snapshot.stdout).result.current_job_lines.some((l: RenderLine) => l.text === 'pipeline-second'));
  p.state = 'needs_input'; p.outcome = null; p.pending_questions = [{ id: 'q1', question: 'Choose safe option?', options: ['A', 'B'], default: null, blocking: true }]; f.save(`pipelines/${pipeline1}/pipeline.json`, p);
  const paused = await cli(['pipeline', 'watch', pipeline1, '--once']); assert.match(paused.stdout, /QUESTION q1 Choose safe option/); assert.doesNotMatch(paused.stdout, /DONE\s+summary p_/);
});

test('M4 integration discovers planner resolver verifier final review and safe gate tails', async t => {
  const f = fixture(t);
  for (const [i, role] of ['planner', 'resolver', 'verifier', 'final_review'].entries()) f.makeJob(`j_20261028_1200_000${i}`, `body-${role}`, { run_id: f.run.run_id, step_instance: `run:${role}#1` });
  f.makeJob(job1, 'HIDDEN_LANE', { run_id: f.run.run_id, pipeline_id: pipeline1 }); f.makeJob(job2, 'HIDDEN_OTHER', { run_id: 'r_20261028_1200_ffff' });
  const base = `runs/${f.run.run_id}`;
  f.save(`${base}/merges/2.json`, { seq: 2, task_id: 'health', result: 'rolled_back_gate_failed', gate: { checks: [{ id: 'npm-test', exit_code: 1, duration_s: 1 }], log_dir: '/outside/ignored' } });
  mkdirSync(join(f.home, `${base}/merges/2.gate`));
  writeFileSync(join(f.home, `${base}/merges/2.gate/npm-test.log`), 'head\n' + Array.from({ length: 12 }, (_, i) => `line${i} password=abcdef,ghijkl`).join('\n'));
  writeFileSync(join(f.home, `${base}/events.jsonl`), [{ type: 'merge_precheck', data: { seq: 2, clean: true }, task_id: 'health' }, { type: 'gate_finished', data: { seq: 2, passed: false, failed_checks: ['npm-test'] } }, { type: 'merge_rolled_back', data: { seq: 2 }, task_id: 'health' }, { type: 'decision_required', data: { decision_id: 'd_gate', reason: 'integration_gate_failed' } }].map(e => JSON.stringify({ ...e, at })).join('\n') + '\n');
  const view = new WatchView(f.home, { kind: 'run-integration', id: f.run.run_id }); const out = view.poll(initialTime).lines.map(l => l.line.text).join('\n');
  for (const role of ['planner', 'resolver', 'verifier', 'final_review']) assert.ok(out.includes(`body-${role}`));
  assert.match(out, /#2 health precheck clean/); assert.match(out, /d_gate integration_gate_failed/); assert.match(out, /rolled_back → health integration-fix/); assert.match(out, /npm-test ✗ exit 1/);
  assert.match(out, /line2/); assert.doesNotMatch(out, /line1 |│ head|ghijkl|HIDDEN/); assert.equal(view.poll(initialTime + 500).lines.length, 0);
});

test('M4 all view merges lane and integration by time and prefixes each source', async t => {
  const f = fixture(t); f.makeJob(job1, 'lane-message'); f.makePipeline(pipeline1, job1); f.makeJob(job2, 'integration-message', { run_id: f.run.run_id, role: 'planner' });
  const out = await render(f.home, { kind: 'run-all', id: f.run.run_id }, { once: true });
  assert.match(out.output, /\[lane-1\] lane-message/); assert.match(out.output, /\[integration\] integration-message/);
  const frame = new WatchView(f.home, { kind: 'run-all', id: f.run.run_id }).poll(initialTime);
  const times = frame.lines.map(l => Date.parse(l.line.at)); assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

for (const kind of ['run-status', 'run-lane', 'run-integration', 'pipeline-status', 'pipeline-step', 'job'] as const) test(`M4 lifecycle ${kind} SUMMARY LINGER EXIT uses injected clock`, async t => {
  const f = fixture(t); f.run.state = 'succeeded'; f.run.outcome = 'integrated'; f.saveRun(); f.makeJob(job1, 'done'); const p = f.makePipeline(pipeline1, job1); p.state = 'succeeded'; f.save(`pipelines/${pipeline1}/pipeline.json`, p);
  const clock = fakeClock(); const id = kind.startsWith('run-') ? f.run.run_id : kind.startsWith('pipeline-') ? pipeline1 : job1;
  const out = await render(f.home, { kind, id, ...(kind === 'run-lane' ? { lane: 'lane-1' } : {}) }, { pane: true, retainFinishedMin: 1, clock: clock.clock });
  assert.equal(out.code, 0); assert.equal(clock.now() - initialTime, 60000); assert.match(out.output, /summary/); assert.equal(out.output.match(/窗口将在/g)?.length, 1);
});

test('M4 lifecycle zero retention gives ten seconds; public watch never lingers', async t => {
  const f = fixture(t); f.run.state = 'cancelled'; f.saveRun();
  for (const pane of [true, false]) { const clock = fakeClock(); const out = await render(f.home, { kind: 'run-status', id: f.run.run_id }, { pane, retainFinishedMin: 0, clock: clock.clock }); assert.equal(out.code, 0); assert.equal(clock.now() - initialTime, pane ? 10000 : 0); }
  const life = new Lifecycle({ pane: true, retainFinishedMin: 1 }); life.observe(false, false, 0); assert.equal(life.state, 'WAIT_FILES'); life.observe(true, false, 0); assert.equal(life.state, 'BACKFILL'); life.observe(true, false, 500); assert.equal(life.state, 'FOLLOW'); life.observe(true, true, 1000); assert.equal(life.state, 'SUMMARY'); life.summarized(1000); assert.equal(life.state, 'LINGER'); life.observe(true, true, 60999); assert.equal(life.state, 'LINGER'); life.observe(true, true, 61000); assert.equal(life.state, 'EXIT');
});

test('M4 lifecycle WAIT_FILES late metadata, deduplicated idle, removed unit, corrupt metadata', async t => {
  const f = fixture(t), runPath = join(f.home, `runs/${f.run.run_id}/run.json`); rmSync(runPath);
  let tick = 0; const clock = fakeClock(() => { if (++tick === 2) f.saveRun(); if (tick === 4) rmSync(runPath); });
  const out = await render(f.home, { kind: 'run-status', id: f.run.run_id }, { pane: true, retainFinishedMin: 0, clock: clock.clock });
  assert.equal(out.code, 0); assert.equal(out.output.match(/waiting for/g)?.length, 1); assert.match(out.output, /directory removed/); assert.match(out.output, /summary unit unavailable/);
  f.saveRun(); const view = new WatchView(f.home, { kind: 'run-lane', id: f.run.run_id, lane: 'lane-2' }); assert.equal(view.poll(initialTime).lines.length, 1); assert.equal(view.poll(initialTime + 500).lines.length, 0);
  writeFileSync(runPath, '{partial'); assert.equal(view.poll(initialTime).found, false); f.saveRun(); assert.equal(view.poll(initialTime).found, true);
});

test('M4 index excludes child units and expired history; idle timer resets on active work', async t => {
  const f = fixture(t); f.makeJob(job1, 'child', { run_id: f.run.run_id }); f.makeJob(job2, 'old');
  const p = f.makePipeline(pipeline1, job1); p.integration = { run_id: f.run.run_id, task_id: 'health', integration_branch: 'test', merge_state: 'pending', merged_sha: null, target_branch: null, approved_by_user_at: null }; f.save(`pipelines/${pipeline1}/pipeline.json`, p);
  const index = indexView(new ViewFiles(f.home), initialTime, { session: 'gbdev-test' }); assert.equal(index.active, true); assert.ok(index.rows.some(r => r.includes(f.run.run_id))); assert.ok(index.rows.some(r => r.includes('gbdev-test'))); assert.ok(index.rows.every(r => !r.includes(job1) && !r.includes(job2) && !r.includes(pipeline1)));
  f.run.state = 'succeeded'; f.saveRun(); const clock = fakeClock(); const out = await render(f.home, { kind: 'index', id: 'index' }, { pane: true, idleExitMin: 5, clock: clock.clock }); assert.equal(out.code, 0); assert.equal(clock.now() - initialTime, 300000);
  const life = new Lifecycle({ idleExitMin: 5 }); assert.equal(life.idle(false, 0), false); assert.equal(life.idle(true, 299999), false); assert.equal(life.idle(false, 300000), false); assert.equal(life.idle(false, 599999), false); assert.equal(life.idle(false, 600000), true);
});

test('M4 pane crash is sanitized and waits sixty injected seconds; abort skips retention', async t => {
  const f = fixture(t), clock = fakeClock(); const view = new WatchView(f.home, { kind: 'run-status', id: f.run.run_id }, { pane: true, clock: clock.clock });
  t.mock.method(view, 'poll', () => { throw new Error('oops\x1b]0;TITLE\x07 password=abcdef,ghijkl'); });
  let output = ''; assert.equal(await watchView(view, s => { output += s; }), 1); assert.equal(clock.now() - initialTime, 60000); assert.match(output, /renderer crashed: oops/); assert.doesNotMatch(output, /TITLE|ghijkl|\x1b/);
  f.run.state = 'cancelled'; f.saveRun(); const abort = new AbortController(), clock2 = fakeClock(() => abort.abort());
  assert.equal((await render(f.home, { kind: 'run-status', id: f.run.run_id }, { pane: true, clock: clock2.clock, signal: abort.signal })).code, 0); assert.equal(clock2.now() - initialTime, 500);
});

test('M4 watch CLI validates combinations, unknown ids and hides __pane from HELP', async t => {
  const f = fixture(t);
  for (const args of [ ['run', 'watch', f.run.run_id, '--json'], ['run', 'watch', f.run.run_id, '--follow', '--json'], ['run', 'watch', f.run.run_id, '--pane', 'lane-5', '--json', '--once'], ['pipeline', 'watch', pipeline1, '--pane', 'status', '--json', '--once'], ['run', 'watch', '../bad', '--once', '--json'], ['status', '--once', '--json'], ['__pane', 'run-lane', f.run.run_id, 'lane-5', '--json'] ]) {
    const out = await cli(args); assert.equal(out.code, 2, args.join(' ')); assert.equal(out.stderr, ''); assert.equal(JSON.parse(out.stdout).error.code, 'usage_error');
  }
  for (const type of ['run', 'pipeline']) { const id = type === 'run' ? 'r_20261028_1200_ffff' : pipeline2; const out = await cli([type, 'watch', id, '--once', '--json']); assert.equal(out.code, 1); assert.equal(JSON.parse(out.stdout).error.code, `${type}_not_found`); }
  const help = await cli(['--help']); assert.match(help.stdout, /run watch/); assert.match(help.stdout, /pipeline watch/); assert.doesNotMatch(help.stdout, /__pane/);
  assert.deepEqual(paneTarget(['index']), { kind: 'index', id: 'index' }); assert.deepEqual(paneTarget(['index', 'index']), { kind: 'index', id: 'index' });
  for (const args of [['index', '../bad'], ['job', '../bad'], ['run-status', f.run.run_id, 'lane-1'], ['unknown', f.run.run_id]]) assert.throws(() => paneTarget(args));
});

test('M4 HomeFs refuses hard links, view symlinks and symlinked directories', async t => {
  const f = fixture(t), outside = join(f.root, 'outside'); writeFileSync(outside, 'OUTSIDE_SECRET');
  const path = join(f.home, 'linked'); linkSync(outside, path); assert.throws(() => new HomeFs(f.home).readUnderHome('linked'), RefusedPath);
  const runPath = join(f.home, `runs/${f.run.run_id}/run.json`); rmSync(runPath); symlinkSync(outside, runPath);
  const out = await cli(['run', 'watch', f.run.run_id, '--once', '--json']); assert.equal(out.code, 1); assert.match(out.stdout, /refused path outside/); assert.doesNotMatch(out.stdout, /OUTSIDE_SECRET/);
  symlinkSync(f.root, join(f.home, 'jobs')); const files = new ViewFiles(f.home); assert.deepEqual(files.names('jobs', /.*/), []); assert.match(files.warnings(initialTime)[0]!.text, /refused path/);
});

test('M4 JobRenderer end-to-end rotation preserves new content exactly once', t => {
  const f = fixture(t), status = f.makeJob(job1, 'old', { state: 'running' }); const renderer = new JobRenderer(f.home, job1); const first = [...renderer.pollLines()]; assert.ok(first.some(l => l.text === 'old'));
  const path = join(f.home, `jobs/${job1}/raw.jsonl`); writeFileSync(path + '.new', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'new' } }) + '\n'); renameSync(path + '.new', path);
  const next = [...renderer.pollLines()]; assert.equal(next.filter(l => l.text === '[file rotated]').length, 1); assert.equal(next.filter(l => l.text === 'new').length, 1); assert.deepEqual([...renderer.pollLines()], []);
  status.state = 'succeeded'; f.save(`jobs/${job1}/job.json`, status); assert.ok([...renderer.pollLines()].some(l => l.tag === 'DONE'));
});

for (const signal of ['SIGHUP', 'SIGTERM'] as const) test(`M4 __pane ${signal} exits promptly without touching live job files`, async t => {
  const f = fixture(t); f.makeJob(job1, 'watch-ready', { state: 'running', pid: 99999 }); const path = join(f.home, `jobs/${job1}/job.json`), before = readFileSync(path);
  const child = spawn(process.execPath, [resolve('dist/src/cli.js'), '__pane', 'job', job1], { env: { PATH: process.env.PATH, GBDEV_HOME: f.home, GBDEV_CONFIG: join(f.root, 'never-read'), NO_COLOR: '1' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', s => { stdout += s; }); child.stderr.on('data', s => { stderr += s; });
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(async () => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  await until(() => stdout.includes('watch-ready')); child.kill(signal); assert.equal(await done, 0); assert.equal(stderr, ''); assert.deepEqual(readFileSync(path), before); assert.ok(!readdirSync(dirname(path)).includes('cancel.json'));
});

test('M4 status redraw is every two injected seconds and only TTY emits owned escapes', async t => {
  const f = fixture(t);
  for (const tty of [true, false]) {
    const abort = new AbortController(); const clock = fakeClock(now => { if (now >= initialTime + 4500) abort.abort(); });
    const out = await render(f.home, { kind: 'run-status', id: f.run.run_id }, { tty, signal: abort.signal, clock: clock.clock });
    assert.equal(out.output.match(/TASK /g)?.length, 3); assert.equal(out.output.match(/\x1b\[H\x1b\[2J/g)?.length ?? 0, tty ? 3 : 0);
  }
});

test('M4 final summary preserves outcome merges findings branch and SHA, with recovery in status', async t => {
  const f = fixture(t); f.run.state = 'succeeded'; f.run.outcome = 'integrated'; f.saveRun();
  const result = JSON.parse(readFileSync('test/fixtures/m3-run-result.json', 'utf8'));
  result.integration_sha = 'a'.repeat(40); result.final_review.findings = [{ message: 'do not show finding body' }];
  f.save(`runs/${f.run.run_id}/result.json`, result);
  writeFileSync(join(f.home, `runs/${f.run.run_id}/events.jsonl`), JSON.stringify({ type: 'recovery_step', at, data: { step: 'restored\x1b]0;INJECTED_TITLE\x07' } }) + '\n');
  const out = await cli(['run', 'watch', f.run.run_id, '--once', '--pane', 'status']);
  assert.equal(out.code, 0); assert.match(out.stdout, /outcome=integrated merges=1 findings=1/); assert.ok(out.stdout.includes(result.integration_branch)); assert.ok(out.stdout.includes(result.integration_sha));
  assert.match(out.stdout, /RECOVERY restored/); assert.doesNotMatch(out.stdout, /INJECTED_TITLE|finding body/);
});

test('M4 partially rewritten run metadata waits and resumes without an early summary', async t => {
  const f = fixture(t), path = join(f.home, `runs/${f.run.run_id}/run.json`); let tick = 0;
  const clock = fakeClock(() => { tick++; if (tick === 1) writeFileSync(path, '{partial'); if (tick === 2) f.saveRun(); if (tick === 3) { f.run.state = 'cancelled'; f.saveRun(); } });
  const out = await render(f.home, { kind: 'run-status', id: f.run.run_id }, { clock: clock.clock });
  assert.equal(out.code, 0); assert.equal(clock.now() - initialTime, 1500); assert.match(out.output, /summary .* cancelled/); assert.doesNotMatch(out.output, /summary unit unavailable/);
});

test('M4 lane backfill separator precedes historic content and tail remains bounded', t => {
  const f = fixture(t); f.makeJob(job1, 'old'); f.makePipeline(pipeline1, job1);
  const path = join(f.home, `jobs/${job1}/raw.jsonl`);
  writeFileSync(path, Array.from({ length: 1000 }, (_, i) => JSON.stringify({ type: 'item.completed', at: '2020-01-01T00:00:00.000+00:00', item: { type: 'agent_message', text: `history-${i}` } })).join('\n') + '\n');
  const view = new WatchView(f.home, { kind: 'run-lane', id: f.run.run_id, lane: 'lane-1' }); const frame = view.poll(initialTime);
  const sep = frame.lines.findIndex(l => l.line.text.includes('────'));
  assert.ok(sep >= 0); assert.ok(frame.lines.findIndex(l => l.line.text.includes('history-999')) > sep); assert.ok(frame.lines.length <= 402); assert.ok(frame.lines.some(l => l.line.tag === 'SKIP'));
});

test('M4 live bursts drain across bounded polls before terminal summary without dropping lines', async t => {
  const f = fixture(t); const j = f.makeJob(job1, 'initial', { state: 'running' }); f.makePipeline(pipeline1, job1);
  const target: Target = { kind: 'run-lane', id: f.run.run_id, lane: 'lane-1' }; let tick = 0;
  const clock = fakeClock(() => {
    if (++tick !== 1) return;
    appendFileSync(join(f.home, `jobs/${job1}/raw.jsonl`), Array.from({ length: 1001 }, (_, i) => JSON.stringify({ type: 'item.completed', at, item: { type: 'agent_message', text: `burst-${i}` } })).join('\n') + '\n');
    j.state = 'succeeded'; f.save(`jobs/${job1}/job.json`, j); f.run.state = 'succeeded'; f.run.outcome = 'integrated'; f.saveRun();
  });
  const out = await render(f.home, target, { clock: clock.clock }); assert.equal(out.code, 0);
  assert.equal(out.output.match(/MSG\s+burst-\d+/g)?.length, 1001); assert.ok(out.output.indexOf('burst-1000') < out.output.indexOf(`summary ${f.run.run_id}`)); assert.doesNotMatch(out.output, /SKIP/);
});

test('M4 AC-9 live fake supervisor run watches two sequential lane tasks without controlling workers', async t => {
  const f = fakeRunFixture(t); f.request.lanes = 1; f.request.tasks![1]!.depends_on = ['a'];
  for (const task of ['a', 'b']) f.fakePlan[`${task}/implement#1`] = { sleep_ms: 1000, actions: [{ type: 'write_file', path: `src/${task}.txt`, content: task + '\n' }] };
  f.savePlan(); testEnv(t, { GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config });
  const initial = await startRun(f.store, f.request, false); const work = superviseRun(f.store, initial.run_id);
  let output = '', stderr = '';
  try {
    await until(() => !!readRun(f.store, initial.run_id).lanes.find(l => l.lane === 'lane-1' && l.pipeline_id));
    const [code] = await Promise.all([runCli(['run', 'watch', initial.run_id, '--pane', 'lane-1'], { stdout: s => { output += s; }, stderr: s => { stderr += s; } }), work]);
    assert.equal(code, 0, stderr); assert.equal(stderr, ''); assert.equal(readRun(f.store, initial.run_id).state, 'succeeded');
    assert.match(output, /──── a · implement#1 · fake/); assert.match(output, /──── b · implement#1 · fake/); assert.match(output, /DONE\s+summary r_/);
    f.invariants(initial.run_id);
  } finally {
    if (!['succeeded', 'failed', 'cancelled'].includes(readRun(f.store, initial.run_id).state)) await cancelRun(f.store, initial.run_id);
    await work;
  }
});

test('M4 current job metadata can recover after a partial rewrite', t => {
  const f = fixture(t); f.makeJob(job1, 'initial', { state: 'running' }); f.makePipeline(pipeline1, job1);
  const view = new WatchView(f.home, { kind: 'run-lane', id: f.run.run_id, lane: 'lane-1' }); view.poll(initialTime);
  writeFileSync(join(f.home, `jobs/${job1}/job.json`), '{partial'); assert.ok(view.poll(initialTime + 500).lines.some(l => l.line.tag === 'WARN'));
  f.save(`jobs/${job1}/job.json`, { ...job(job1), state: 'succeeded' }); appendFileSync(join(f.home, `jobs/${job1}/raw.jsonl`), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'recovered' } }) + '\n');
  assert.ok(view.poll(initialTime + 1000).lines.some(l => l.line.text === 'recovered')); view.close();
});

for (const kind of ['run-all', 'pipeline-all'] as const) test(`M4 S2 P1 TTY ${kind} preserves MSG history after status refresh`, async t => {
  const f = fixture(t); f.makeJob(job1, 'preserved-message'); f.makePipeline(pipeline1, job1);
  const abort = new AbortController(), clock = fakeClock(now => { if (now >= initialTime + 4500) abort.abort(); });
  const out = await render(f.home, { kind, id: kind === 'run-all' ? f.run.run_id : pipeline1 }, { tty: true, signal: abort.signal, clock: clock.clock });
  assert.equal(out.output.match(/preserved-message/g)?.length, 1);
  assert.equal(out.output.match(kind === 'run-all' ? /TASK /g : /STEP          STATE/g)?.length, 3);
  assert.doesNotMatch(out.output, /\x1b\[2J|\x1b\[H/);
  assert.ok(out.output.indexOf('preserved-message') < out.output.lastIndexOf('BUDGET'));
});

test('M4 S2 P2 refused exists is unavailable and leaves FOLLOW with WARN', async t => {
  const f = fixture(t), path = join(f.home, `runs/${f.run.run_id}/run.json`), outside = join(f.root, 'outside');
  writeFileSync(outside, 'SECRET');
  const clock = fakeClock(() => { if (!readFileSync(path, 'utf8').includes('SECRET')) { rmSync(path); symlinkSync(outside, path); } });
  const out = await render(f.home, { kind: 'run-status', id: f.run.run_id }, { pane: true, retainFinishedMin: 0, clock: clock.clock });
  assert.match(out.output, /WARN.*refused path outside/); assert.match(out.output, /summary unit unavailable/); assert.doesNotMatch(out.output, /SECRET/);
  const files = new ViewFiles(f.home); assert.equal(files.exists(`runs/${f.run.run_id}/run.json`), false); assert.equal(files.warnings(initialTime).length, 1);
});

test('M4 S2 P2 pipeline needs_input sanitizes OSC and redacts question option decision secrets', async t => {
  const f = fixture(t); f.makeJob(job1, 'done'); const p = f.makePipeline(pipeline1, job1);
  const injected = 'safe\x1b]52;c;PAYLOAD\x07 sk-' + 'X'.repeat(24);
  p.state = 'needs_input'; p.pending_questions = [{ id: 'q1', question: injected, options: [injected], default: null, blocking: true }];
  p.decision = { reason: 'needs_input', detail: injected, allowed_actions: ['answer', 'abort'] } as PipelineRun['decision']; f.save(`pipelines/${pipeline1}/pipeline.json`, p);
  for (const json of [false, true]) {
    const out = await cli(['pipeline', 'watch', pipeline1, '--once', ...(json ? ['--json'] : [])]); assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /‹redacted›/); assert.doesNotMatch(out.stdout, /PAYLOAD|XXXX|\x1b|\\u001b/);
  }
});

test('M4 S2 P2 corrupt unit JSON gives one bounded WARN and recovers', t => {
  const f = fixture(t), path = `runs/${f.run.run_id}/run.json`, files = new ViewFiles(f.home);
  writeFileSync(join(f.home, path), '{partial');
  for (let n = 0; n < 10; n++) assert.equal(files.json(path), undefined);
  assert.equal(files.warnings(initialTime).length, 1); assert.equal(files.warnings(initialTime).length, 0);
  f.saveRun(); assert.ok(files.run(f.run.run_id));
});

test('M4 S2 P2 integration paginates unrelated metadata and follows more than four jobs', t => {
  const f = fixture(t);
  for (let i = 0; i < 130; i++) f.makeJob(`j_20261028_1100_${i.toString(16).padStart(4, '0')}`, 'unrelated');
  for (let i = 0; i < 6; i++) f.makeJob(`j_20261028_1200_${i.toString(16).padStart(4, '0')}`, `owned-${i}`, { run_id: f.run.run_id, state: 'running', role: 'x'.repeat(72) + ' sk-' + 'A'.repeat(24) });
  const view = new WatchView(f.home, { kind: 'run-integration', id: f.run.run_id });
  let reads = 0; const original = view.files.json.bind(view.files); t.mock.method(view.files, 'json', (path: string) => { if (/jobs\/.*job.json/.test(path)) reads++; return original(path); });
  let output = '';
  for (let n = 0; n < 6; n++) { reads = 0; output += view.poll(initialTime + n * 500).lines.map(l => l.line.text).join('\n'); assert.ok(reads <= 70, String(reads)); }
  for (let i = 0; i < 6; i++) assert.equal(output.match(new RegExp(`owned-${i}`, 'g'))?.length, 1);
  assert.doesNotMatch(output, /unrelated|sk-A/); view.close();
  const once = new WatchView(f.home, { kind: 'run-integration', id: f.run.run_id }, { once: true });
  const snapshot = once.poll(initialTime).lines.map(l => l.line.text).join('\n');
  for (let i = 0; i < 6; i++) assert.ok(snapshot.includes(`owned-${i}`));
  once.close();
});

for (const kind of ['run-all', 'run-integration'] as const) test(`M4 R55 P1 live ${kind} drains >64 directories and exits with SUMMARY`, async t => {
  const f = fixture(t);
  for (let i = 0; i < 140; i++) f.makeJob(`j_20261028_1100_${i.toString(16).padStart(4, '0')}`, 'unrelated');
  f.makeJob(job1, 'last-owned-job', { run_id: f.run.run_id });
  f.run.state = 'succeeded'; f.saveRun();
  for (const pane of [false, true]) {
    const clock = fakeClock();
    const out = await render(f.home, { kind, id: f.run.run_id }, { pane, retainFinishedMin: 0, clock: clock.clock });
    assert.equal(out.code, 0); assert.ok(clock.now() - initialTime <= (pane ? 12000 : 2000));
    assert.match(out.output, /last-owned-job/); assert.match(out.output, /DONE\s+summary r_/);
  }
});
for (const refused of [false, true]) test(`M4 R55 P2 integration rediscovers ${refused ? 'refused' : 'missing'} metadata without completed tombstone`, t => {
  const f = fixture(t), value = f.makeJob(job1, 'initial', { run_id: f.run.run_id, state: 'running' });
  const view = new WatchView(f.home, { kind: 'run-integration', id: f.run.run_id }); view.poll(initialTime);
  const path = join(f.home, `jobs/${job1}/job.json`); rmSync(path);
  if (refused) { const outside = join(f.root, 'outside'); writeFileSync(outside, 'SECRET'); symlinkSync(outside, path); }
  const missing = view.poll(initialTime + 500);
  if (refused) { assert.ok(missing.lines.some(l => /refused path/.test(l.line.text))); rmSync(path); }
  f.save(`jobs/${job1}/job.json`, { ...value, state: 'succeeded' });
  appendFileSync(join(f.home, `jobs/${job1}/raw.jsonl`), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'rediscovered' } }) + '\n');
  const recovered = view.poll(initialTime + 31000); assert.ok(recovered.lines.some(l => l.line.text === 'rediscovered')); view.close();
});

// Each sleep is exactly one renderer poll: assertions inspect the preceding frame.
test('M4 D-M4-3 lane stays live from unassigned through raw appends, step and task switches', async t => {
  const f = fixture(t), abort = new AbortController();
  Object.assign(f.run.lanes[0]!, { state: 'idle', task_id: null, pipeline_id: null }); f.saveRun();
  let output = '', tick = 0;
  const clock = fakeClock(() => {
    tick++;
    assert.doesNotMatch(output, /renderer crashed|summary unit unavailable/);
    if (tick === 1) {
      assert.match(output, /lane-1 idle/);
      f.makeJob(job1, 'initial', { state: 'running' }); f.makePipeline(pipeline1, job1);
      Object.assign(f.run.lanes[0]!, { state: 'busy', task_id: 'health', pipeline_id: pipeline1 }); f.saveRun();
    } else if (tick === 2) {
      assert.match(output, /initial/);
      appendFileSync(join(f.home, `jobs/${job1}/raw.jsonl`), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'live-first' } }) + '\n');
    } else if (tick === 3) {
      assert.match(output, /live-first/);
      f.makeJob(job2, 'review-backfill', { state: 'running' }); f.makePipeline(pipeline1, job2, 'review#1');
    } else if (tick === 4) {
      assert.match(output, /review-backfill/);
      assert.ok(output.indexOf('review#1') < output.indexOf('review-backfill'));
      f.makeJob('j_20261028_1202_3333', 'next-task', { state: 'running' }); f.makePipeline(pipeline2, 'j_20261028_1202_3333');
      Object.assign(f.run.lanes[0]!, { task_id: 'lib-sum', pipeline_id: pipeline2 }); f.saveRun();
    } else {
      assert.match(output, /next-task/); assert.ok(output.indexOf('lib-sum') < output.indexOf('next-task')); abort.abort();
    }
  });
  const code = await watchView(new WatchView(f.home, { kind: 'run-lane', id: f.run.run_id, lane: 'lane-1' }, { pane: true, retainFinishedMin: 0, pollMs: 500, clock: clock.clock, signal: abort.signal }), s => { output += s; });
  assert.equal(code, 0); assert.equal(tick, 5); assert.equal(output.match(/live-first/g)?.length, 1);
});

test('M4 D-M4-3 missing pipeline or job snapshot preserves follower offsets without replay', t => {
  const f = fixture(t); f.makeJob(job1, 'initial', { state: 'running' }); f.makePipeline(pipeline1, job1);
  const view = new WatchView(f.home, { kind: 'run-lane', id: f.run.run_id, lane: 'lane-1' }); t.after(() => view.close());
  assert.ok(view.poll(initialTime).lines.some(l => l.line.text === 'initial'));
  for (const rel of [`pipelines/${pipeline1}/pipeline.json`, `jobs/${job1}/job.json`]) {
    const path = join(f.home, rel); renameSync(path, path + '.hold');
    const missing = view.poll(initialTime + 500); assert.equal(missing.done, false); assert.deepEqual(missing.lines, []);
    renameSync(path + '.hold', path);
    appendFileSync(join(f.home, `jobs/${job1}/raw.jsonl`), JSON.stringify({ type: 'item.completed', at, item: { type: 'agent_message', text: rel } }) + '\n');
    const next = view.poll(initialTime + 1000).lines;
    assert.deepEqual(next.map(l => l.line.text), [rel]);
  }
});

for (const kind of ['run-lane', 'run-status', 'run-integration', 'index'] as const) test(`M4 D-M4-4 ${kind} skips one missing run snapshot without WARN WAIT or exit`, async t => {
  const f = fixture(t), abort = new AbortController(), path = join(f.home, `runs/${f.run.run_id}/run.json`);
  let output = '', tick = 0, before = '';
  const clock = fakeClock(() => {
    if (++tick === 1) { before = output; renameSync(path, path + '.hold'); }
    if (tick === 2) { assert.equal(output, before); renameSync(path + '.hold', path); }
    if (tick === 3) abort.abort();
  });
  const code = await watchView(new WatchView(f.home, { kind, id: kind === 'index' ? 'index' : f.run.run_id, ...(kind === 'run-lane' ? { lane: 'lane-2' } : {}) }, { pane: true, retainFinishedMin: 0, clock: clock.clock, signal: abort.signal }), s => { output += s; });
  assert.equal(code, 0); assert.equal(tick, 3); assert.doesNotMatch(output, /WARN|ERR|summary|metadata unavailable/);
});

test('M4 D-M4-3 __pane lane argv with 64 MiB heap survives startup and streams before task switch', async t => {
  const f = fixture(t);
  Object.assign(f.run.lanes[0]!, { state: 'idle', task_id: null, pipeline_id: null }); f.saveRun();
  const child = spawn(process.execPath, ['--max-old-space-size=64', resolve('dist/src/cli.js'), '__pane', 'run-lane', f.run.run_id, 'lane-1'], { env: { GBDEV_HOME: f.home, GBDEV_CONFIG: join(f.root, 'never-read'), NO_COLOR: '1' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', s => { stdout += s; }); child.stderr.on('data', s => { stderr += s; });
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  await until(() => stdout.includes('lane-1 idle'));
  f.makeJob(job1, 'child-initial', { state: 'running', provider: 'codex' }); f.makePipeline(pipeline1, job1);
  Object.assign(f.run.lanes[0]!, { state: 'busy', task_id: 'health', pipeline_id: pipeline1 }); f.saveRun();
  await until(() => stdout.includes('child-initial'));
  appendFileSync(join(f.home, `jobs/${job1}/raw.jsonl`), JSON.stringify({ type: 'thread.started', thread_id: 'live-session' }) + '\n');
  await until(() => stdout.includes('codex session live-ses'));
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert.doesNotMatch(stdout, /ERR|WARN|time=read.*live-ses/);
  child.kill('SIGTERM'); assert.equal(await done, 0); assert.equal(stderr, '');
});

for (const exhausted of [false, true]) test(`M4 D-M4-4 atomic rename during open is silent and bounded exhausted=${exhausted}`, async t => {
  const f = fixture(t); f.makeJob(job1, 'first', { state: 'running' }); f.makePipeline(pipeline1, job1);
  const targets: Target[] = [{ kind: 'run-status', id: f.run.run_id }, { kind: 'run-lane', id: f.run.run_id, lane: 'lane-1' }, { kind: 'run-integration', id: f.run.run_id }, { kind: 'index', id: 'index' }];
  for (const target of targets) {
    const view = new WatchView(f.home, target); view.poll(initialTime);
    const original = fs.openSync, reads = new Map<string, number>();
    const paths = new Set([`runs/${f.run.run_id}/run.json`, `pipelines/${pipeline1}/pipeline.json`, `jobs/${job1}/job.json`].map(p => fs.realpathSync(join(f.home, p))));
    const bytes = new Map([...paths].map(p => [p, readFileSync(p)]));
    const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const fd = original(...args), path = String(args[0]);
      if (paths.has(path)) {
        const count = reads.get(path) ?? 0; reads.set(path, count + 1);
        if (exhausted || count === 0) { fs.writeFileSync(path + '.new', bytes.get(path)!); fs.renameSync(path + '.new', path); }
      }
      return fd;
    });
    syncBuiltinESMExports();
    try {
      const frame = view.poll(initialTime + 500);
      assert.ok(frame.lines.every(l => l.line.tag !== 'WARN' && l.line.tag !== 'WAIT'));
      assert.equal(frame.done, false);
      assert.ok([...reads.values()].every(n => n <= (exhausted ? 6 : 3)), JSON.stringify([...reads]));
      if (exhausted) assert.notEqual(frame.removed, true);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    const restored = view.poll(initialTime + 1000);
    assert.equal(restored.found, true); assert.equal(restored.done, false);
    assert.ok(restored.lines.every(l => !l.line.text.includes('────'))); view.close();
  }
});

for (const replacement of ['symlink', 'hardlink', 'inside-link'] as const) test(`M4 D-M4-4 revalidation ${replacement} never reads an unchecked descriptor`, t => {
  const f = fixture(t), path = join(f.home, 'target.json'), outside = join(f.root, 'outside.json'), inside = join(f.home, 'inside.json');
  writeFileSync(path, '{"old":true}'); writeFileSync(outside, '{"secret":"DO_NOT_READ"}'); writeFileSync(inside, '{"safe":true}');
  const canonical = fs.realpathSync(path), original = fs.openSync; let changed = false;
  const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = original(...args);
    if (!changed && String(args[0]) === canonical) {
      changed = true; rmSync(path);
      if (replacement === 'hardlink') linkSync(outside, path); else symlinkSync(replacement === 'symlink' ? outside : inside, path);
    }
    return fd;
  });
  syncBuiltinESMExports();
  try {
    if (replacement === 'inside-link') assert.deepEqual(new HomeFs(f.home).json('target.json'), { safe: true });
    else assert.throws(() => new HomeFs(f.home).json('target.json'), RefusedPath);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('M4 D-M4-4 exhausted job metadata race skips poll and resumes original raw offset', t => {
  const f = fixture(t); f.makeJob(job1, 'first', { state: 'running' });
  const renderer = new JobRenderer(f.home, job1); assert.ok([...renderer.pollLines()].some(l => l.text === 'first'));
  const original = renderer.fs.readUnderHome.bind(renderer.fs);
  const mock = t.mock.method(renderer.fs, 'readUnderHome', (rel: string, directory = false) => { if (rel.endsWith('job.json')) throw new TransientPath(); return original(rel, directory); });
  assert.deepEqual([...renderer.pollLines()], []); assert.equal(renderer.complete, false); mock.mock.restore();
  appendFileSync(join(f.home, `jobs/${job1}/raw.jsonl`), JSON.stringify({ type: 'item.completed', at, item: { type: 'agent_message', text: 'after-race' } }) + '\n');
  assert.deepEqual([...renderer.pollLines()].map(l => l.text), ['after-race']);
});

test('M4 Codex untimestamped backfill is labelled read-time; timestamped history and live lines stay exact', t => {
  const f = fixture(t); f.makeJob(job1, 'timestamped', { state: 'running', provider: 'codex' });
  const path = join(f.home, `jobs/${job1}/raw.jsonl`);
  const event = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n';
  appendFileSync(path, event('historic'));
  const renderer = new JobRenderer(f.home, job1), initial = [...renderer.pollLines()];
  assert.equal(Date.parse(initial.find(l => l.text === 'timestamped')!.at), Date.parse(at));
  assert.ok(initial.some(l => l.text === 'historic'));
  assert.ok(initial.some(l => l.tag === 'NOTE' && l.text === '[backfill] untimestamped Codex raw uses read time, not event time'));
  appendFileSync(path, event('live'));
  assert.deepEqual([...renderer.pollLines()].map(l => l.text), ['live']);
});

test('M4 D-M4-3 atomic replacement cannot send a running lane into irreversible LINGER', async t => {
  const f = fixture(t), path = fs.realpathSync(join(f.home, `runs/${f.run.run_id}/run.json`)), bytes = readFileSync(path);
  const original = fs.openSync, abort = new AbortController(); let race = false, replacements = 0;
  const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = original(...args);
    if (race && String(args[0]) === path) { replacements++; writeFileSync(path + '.new', bytes); renameSync(path + '.new', path); }
    return fd;
  });
  syncBuiltinESMExports();
  const clock = fakeClock(now => { race = now === initialTime + 500; if (now >= initialTime + 12000) abort.abort(); });
  try {
    const out = await render(f.home, { kind: 'run-lane', id: f.run.run_id, lane: 'lane-2' }, { pane: true, retainFinishedMin: 0, clock: clock.clock, signal: abort.signal });
    assert.equal(out.code, 0); assert.equal(replacements, 6); assert.equal(abort.signal.aborted, true);
    assert.equal(clock.now(), initialTime + 12000); assert.doesNotMatch(out.output, /WARN|ERR|DONE|metadata unavailable/);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
