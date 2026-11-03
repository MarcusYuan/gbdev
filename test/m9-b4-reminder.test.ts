import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporary, job } from './helpers.js';
import { atomicWriteJson, JobStore } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { acquireLock } from '../src/core/lock.js';
import { locked } from '../src/core/runtime.js';
import { localIso } from '../src/core/time.js';
import { NOTIFY_DEFAULTS, validateNotify } from '../src/core/notifyConfig.js';
import { validateNotifyPayload } from '../src/contracts/notify.js';
import type { Run } from '../src/contracts/run.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import { installNotifyTesting, notifyEvent, notifySupervisorStarted, type OutboxRecord } from '../src/notify/enqueue.js';
import { launchDeliver } from '../src/notify/trigger.js';
import { deliveryGroups } from '../src/notify/deliver.js';
import { buildPayload } from '../src/notify/payload.js';
import { pendingReminders, planReminders, reminderTick, remind, type PendingReminder } from '../src/notify/reminder.js';

const epoch = Date.parse('2026-11-01T10:00:00-08:00'), at = localIso(new Date(epoch));
const enabledEnv = { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1' };
function fixture(t: TestContext, config: Record<string, unknown> = {}) {
  const root = temporary(t), paths = resolvePaths({ GBDEV_HOME: join(root, 'home'), GBDEV_CONFIG: join(root, 'config.json') });
  mkdirSync(paths.home);
  writeFileSync(paths.config, JSON.stringify({ version: 1, notify: { enabled: true, key_name: 'X-Key', ...config } }));
  const store = new JobStore(paths); let clock = epoch, launches = 0, reminders = 0;
  t.after(installNotifyTesting(paths.home, { env: enabledEnv, now: () => clock, launch: () => { launches++; }, launchReminder: () => { reminders++; } }));
  const notices = () => {
    try { return readdirSync(join(paths.home, 'notify', 'outbox')).map(file => JSON.parse(readFileSync(join(paths.home, 'notify', 'outbox', file), 'utf8')) as OutboxRecord).sort((a, b) => a.seq - b.seq); }
    catch { return []; }
  };
  const run = JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8')) as Run;
  run.repo = root; run.state = 'needs_decision'; run.supervisor_pid = null;
  run.attention = [{ decision_id: 'd_reminder', scope: 'run', task_id: null, reason: 'task_failed', allowed_actions: ['resume_run'], detail: 'Wait', summary: '需要确认下一步', pipeline_id: null, merge_seq: null, pending_questions: [], created_at: at }];
  const runDir = join(paths.home, 'runs', run.run_id); mkdirSync(runDir, { recursive: true });
  const save = () => atomicWriteJson(join(runDir, 'run.json'), run); save();
  const original = () => locked(store, () => notifyEvent(store, { kind: 'run', id: run.run_id, state: run.state }, 'decision_required', { ...run.attention[0] }, 1, at));
  return { root, paths, store, run, save, original, notices, setMinute: (n: number) => { clock = epoch + n * 60_000; }, launches: () => launches, reminders: () => reminders };
}
function pipeline(store: JobStore, state: PipelineRun['state'] = 'needs_input', owned = false): void {
  const id = 'p_20261101_1000_abcd', dir = join(store.paths.home, 'pipelines', id);
  mkdirSync(dir, { recursive: true });
  const value: PipelineRun = {
    schema: 'gbdev.pipeline-run.v1', pipeline_id: id, pipeline: 'implement-review', state, state_reason: null, outcome: null, failure_reason: null,
    repo: store.paths.home, workspace: owned ? { mode: 'per_lane', worktree: store.paths.home, branch: 'b', run_id: 'r_20261101_1000_abcd', task_id: 'a', lane: 'lane-1' } : { mode: 'shared_run_worktree', worktree: store.paths.home, branch: 'b' },
    base_sha: 'abc', diff_base_sha: 'abc', head_sha: 'abc', round: 0, max_rounds: 1, jobs_used: 1, max_total_jobs: 10, current: null,
    steps: [], decision: null, pending_questions: [], supervisor_pid: null, heartbeat_at: null, created_at: at, updated_at: at, deadline_at: at,
    state_history: [{ state, at, by: 'gbdev', reason: null }], warnings: [], integration: owned ? { run_id: 'r_20261101_1000_abcd', task_id: 'a', integration_branch: 'b', merge_state: 'pending', merged_sha: null, target_branch: null, approved_by_user_at: null } : null,
  };
  atomicWriteJson(join(dir, 'pipeline.json'), value);
}
function standaloneJob(store: JobStore, owned: 'run' | 'pipeline' | null = null) {
  const value = job('j_20261101_1000_abcd', new Date(epoch)); value.state = 'needs_input';
  value.state_history.push({ state: 'needs_input', at, by: 'gbdev' });
  if (owned === 'run') value.run_id = 'r_20261101_1000_abcd';
  if (owned === 'pipeline') value.pipeline_id = 'p_20261101_1000_abcd';
  store.create(value); return value;
}

test('O3 pure deadlines: thresholds, cumulative exponential schedule, cap, off, invalid date', () => {
  const item: PendingReminder = { key: 'one', unit: { kind: 'job', id: 'j_20261101_1000_abcd', state: 'needs_input' }, type: 'state_change', data: { state: 'needs_input' }, since: epoch };
  assert.equal(planReminders([item], {}, epoch + 29 * 60_000, NOTIFY_DEFAULTS).due.length, 0);
  assert.equal(planReminders([item], {}, epoch + 30 * 60_000, NOTIFY_DEFAULTS).due[0]!.n, 1);
  assert.equal(planReminders([item], { one: 1 }, epoch + 59 * 60_000, NOTIFY_DEFAULTS).due.length, 0);
  assert.equal(planReminders([item], { one: 1 }, epoch + 60 * 60_000, NOTIFY_DEFAULTS).due[0]!.n, 2);
  assert.equal(planReminders([item], { one: 2 }, epoch + 120 * 60_000, NOTIFY_DEFAULTS).due[0]!.n, 3);
  assert.deepEqual(planReminders([item], { one: 3 }, epoch + 999 * 60_000, NOTIFY_DEFAULTS), { due: [], next_at: null });
  assert.deepEqual(planReminders([item], {}, epoch + 999 * 60_000, { ...NOTIFY_DEFAULTS, reminder_max: 0 }), { due: [], next_at: null });
  assert.equal(planReminders([{ ...item, since: NaN }], {}, epoch, NOTIFY_DEFAULTS).next_at, null);
});

test('O3 config closed keys, defaults, integer bounds', () => {
  assert.equal(validateNotify(undefined).reminder_after_min, 30); assert.equal(validateNotify({}).reminder_max, 3);
  for (const n of [5, 1440]) assert.equal(validateNotify({ reminder_after_min: n }).reminder_after_min, n);
  for (const n of [0, 10]) assert.equal(validateNotify({ reminder_max: n }).reminder_max, n);
  for (const value of [4, 1441, 5.5, null, '30']) assert.throws(() => validateNotify({ reminder_after_min: value }));
  for (const value of [-1, 11, 1.5, null, '3']) assert.throws(() => validateNotify({ reminder_max: value }));
  assert.throws(() => validateNotify({ reminder_secret: 'no' }));
});

test('O3 ordinary attention JSON preserves the frozen 09daf62 bytes', () => {
  const result = buildPayload({
    home_id: '0123456789ab', unit_kind: 'run', unit_id: 'r_20261101_1000_abcd',
    event: 'attention', kind: 'task_failed', decision_id: 'd_golden', unit_state: 'needs_decision',
    source_seq: 7, seq: 11, occurred_at: '2026-11-01T10:00:00-08:00', sent_at: '2026-11-01T10:01:00-08:00',
    gbdev_version: '1.0.0', attention_summary: '需要确认下一步',
  });
  // Literal baseline from 09daf62: includes field order, null/default fields and notice ID.
  const golden = '{"schema":"gbdev.notify.v1","source_seq":7,"notice_id":"n_2df89acbc1b0ce6b","seq":11,"home_id":"0123456789ab","home_label":null,"unit_kind":"run","unit_id":"r_20261101_1000_abcd","event":"attention","kind":"task_failed","reason_code":null,"decision_id":"d_golden","task_id":null,"unit_state":"needs_decision","summary":"需要确认下一步","occurred_at":"2026-11-01T10:00:00-08:00","sent_at":"2026-11-01T10:01:00-08:00","attempt":1,"coalesced":1,"covers_seq":[11,11],"next_step":"gbdev run status r_20261101_1000_abcd --json","gbdev_version":"1.0.0"}';
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('ordinary attention must fit');
  assert.equal(result.json, golden);
  assert.equal(JSON.stringify(result.payload), golden);
});

test('O3 overdue attention catches up one ordinal per tick and never exceeds the cap', async t => {
  const f = fixture(t); await f.original(); f.setMinute(10_000);
  for (const n of [1, 2, 3]) {
    const next = await reminderTick(f.store), notices = f.notices();
    assert.equal(notices.length, n + 1);
    assert.deepEqual(notices.slice(1).map(p => p.reminder!.n), Array.from({ length: n }, (_, i) => i + 1));
    assert.deepEqual(notices[n]!.reminder, { n, waited_min: 10_000 });
    assert.match(String(notices[n]!.source_seq), new RegExp(`^reminder:[a-f0-9]{64}:${n}$`));
    assert.equal(next, n === 3 ? null : epoch + 30 * 60_000 * 2 ** n);
  }
  for (let i = 0; i < 3; i++) assert.equal(await reminderTick(f.store), null);
  assert.equal(f.notices().length, 4);
  assert.equal(new Set(f.notices().map(p => p.notice_id)).size, 4);
});

test('O3 plan_review excludes even an overdue unresolved run attention', async t => {
  const f = fixture(t); f.run.state = 'plan_review'; f.save(); f.setMinute(10_000);
  assert.equal(f.run.attention.length, 1);
  assert.deepEqual(pendingReminders(f.store), []);
  assert.equal(await reminderTick(f.store), null);
  assert.equal(f.notices().length, 0);
  assert.equal(f.launches(), 0); assert.equal(f.reminders(), 0);
});

test('O3 run attention enqueues unique capped reminders; same due tick and counter crash replay deduplicate', async t => {
  const f = fixture(t); assert.equal(await f.original(), true); assert.equal(f.reminders(), 1);
  assert.equal(Object.hasOwn(f.notices()[0]!, 'reminder'), false);
  f.setMinute(29); await reminderTick(f.store); assert.equal(f.notices().length, 1);
  f.setMinute(45); await reminderTick(f.store); await reminderTick(f.store);
  let notices = f.notices(); assert.equal(notices.length, 2);
  assert.deepEqual(notices[1]!.reminder, { n: 1, waited_min: 45 });
  assert.match(notices[1]!.summary, /^提醒（已等待 45 分钟）：需要确认下一步/);
  assert.notEqual(notices[0]!.notice_id, notices[1]!.notice_id);
  const counter = join(f.paths.home, 'notify', 'reminders', readdirSync(join(f.paths.home, 'notify', 'reminders'))[0]!);
  writeFileSync(counter, '{corrupt'); await reminderTick(f.store); assert.equal(f.notices().length, 2);
  f.setMinute(60); await reminderTick(f.store); notices = f.notices(); assert.deepEqual(notices[2]!.reminder, { n: 2, waited_min: 60 });
  f.setMinute(120); await reminderTick(f.store); f.setMinute(1000); await reminderTick(f.store);
  assert.equal(f.notices().length, 4); assert.equal(new Set(f.notices().map(p => p.notice_id)).size, 4);
  assert.equal(f.reminders(), 1); assert.ok(f.launches() > 0);
  for (const { meta: _meta, ...payload } of f.notices()) { validateNotifyPayload(payload); assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 2048); }
});

for (const resolution of ['removed', 'running'] as const) test(`O3 resolved run ${resolution} stops reminders`, async t => {
  const f = fixture(t); await f.original(); f.setMinute(45);
  if (resolution === 'removed') f.run.attention = []; else f.run.state = 'running'; f.save();
  await reminderTick(f.store); assert.equal(f.notices().length, 1);
});
for (const mode of ['config', 'env', 'test', 'max'] as const) test(`O3 disabled ${mode} never enqueues/launches`, async t => {
  const f = fixture(t, mode === 'config' ? { enabled: false } : mode === 'max' ? { reminder_max: 0 } : {}); f.setMinute(45);
  await reminderTick(f.store, { env: mode === 'env' ? { ...enabledEnv, GBDEV_NOTIFY: '0' } : mode === 'test' ? { NODE_TEST_CONTEXT: 'child' } : enabledEnv });
  assert.equal(f.notices().length, 0); assert.equal(f.launches(), 0); assert.equal(f.reminders(), 0);
});
for (const state of ['needs_input', 'needs_decision', 'blocked'] as const) test(`O3 independent pipeline ${state}`, async t => {
  const f = fixture(t); f.run.attention = []; f.save(); pipeline(f.store, state); f.setMinute(31);
  await reminderTick(f.store); assert.equal(f.notices().length, state === 'blocked' ? 0 : 1);
  if (state !== 'blocked') { assert.equal(f.notices()[0]!.unit_kind, 'pipeline'); assert.equal(f.notices()[0]!.reminder!.waited_min, 31); }
});
test('O3 independent job needs_input reminders and a new pause has a fresh identity', async t => {
  const f = fixture(t); f.run.attention = []; f.save(); const j = standaloneJob(f.store); f.setMinute(45);
  await reminderTick(f.store); assert.equal(f.notices()[0]!.kind, 'job_needs_input');
  j.state = 'running'; j.state_history.push({ state: 'running', at, by: 'gbdev' }); f.store.write(j); await reminderTick(f.store); assert.equal(f.notices().length, 1);
  j.state = 'needs_input'; j.state_history.push({ state: 'needs_input', at: localIso(new Date(epoch + 60 * 60_000)), by: 'gbdev' }); f.store.write(j);
  f.setMinute(90); await reminderTick(f.store); assert.equal(f.notices().length, 2); assert.equal(f.notices()[1]!.reminder!.n, 1);
});
for (const owner of ['run', 'pipeline'] as const) test(`O3 ${owner}-owned jobs and run-owned pipelines are not reminded individually`, async t => {
  const f = fixture(t); f.run.attention = []; f.save(); pipeline(f.store, 'needs_input', true); standaloneJob(f.store, owner); f.setMinute(45);
  await reminderTick(f.store); assert.deepEqual(pendingReminders(f.store), []); assert.equal(f.notices().length, 0);
});
test('O3 distinct run decisions each remind; corrupt/missing records are skipped', async t => {
  const f = fixture(t); f.run.attention.push({ ...f.run.attention[0]!, decision_id: 'd_second' }); f.save();
  mkdirSync(join(f.paths.home, 'runs', 'r_20261101_1000_abcd')); writeFileSync(join(f.paths.home, 'runs', 'r_20261101_1000_abcd', 'run.json'), 'broken');
  mkdirSync(join(f.paths.home, 'jobs', 'j_20261101_1000_abcd'), { recursive: true });
  f.setMinute(45); await reminderTick(f.store); assert.equal(f.notices().length, 2);
  assert.deepEqual(new Set(f.notices().map(p => p.decision_id)), new Set(['d_reminder', 'd_second']));
});
test('O3 payload rejects reminder on non-attention; no coalescing with original or terminal', async t => {
  const f = fixture(t); await f.original(); f.setMinute(45); await reminderTick(f.store);
  const reminder = f.notices()[1]!, { meta: _meta, ...payload } = reminder; validateNotifyPayload(payload);
  for (const event of ['terminal', 'health', 'test']) assert.throws(() => validateNotifyPayload({ ...payload, event }));
  for (const value of [{ n: 0, waited_min: 45 }, { n: 1, waited_min: -1 }, { n: 1, waited_min: 45, extra: true }, { n: 2, waited_min: 45 }]) assert.throws(() => validateNotifyPayload({ ...payload, reminder: value }));
  const terminal = { ...f.notices()[0]!, seq: 3, event: 'terminal' as const, kind: 'succeeded' as const };
  const groups = deliveryGroups([...f.notices(), terminal], true);
  assert.equal(groups.length, 2); assert.deepEqual(groups.find(g => g.some(p => p.notice_id === reminder.notice_id)), [reminder]);
});
test('O3 timer exits after resolution, singleton prevents competing timer; restart with empty outbox', async t => {
  const f = fixture(t); let sleeps = 0;
  const lock = acquireLock(join(f.paths.home, 'notify', 'remind.lock'));
  await remind(f.store, { sleep: async () => { assert.fail('competing timer'); } }); lock.release();
  await remind(f.store, { sleep: async ms => { assert.ok(ms <= 60_000); sleeps++; f.run.attention = []; f.save(); } });
  assert.equal(sleeps, 1);
  notifySupervisorStarted(f.store); assert.equal(f.reminders(), 1);
});
test('O3 lifecycle rolls over with injected launcher and no real subprocess', async t => {
  const f = fixture(t); let clock = 0;
  await remind(f.store, { monotonic: () => clock, sleep: async () => { clock = 61 * 60_000; } });
  assert.equal(f.reminders(), 1); assert.equal(f.notices().length, 0);
});
test('O3 archived notice index still deduplicates after lost reminder counter', async t => {
  const f = fixture(t); f.setMinute(45); await reminderTick(f.store);
  const p = f.notices()[0]!; rmSync(join(f.paths.home, 'notify', 'outbox', `${p.seq}-${p.notice_id}.json`));
  rmSync(join(f.paths.home, 'notify', 'reminders'), { recursive: true }); await reminderTick(f.store);
  assert.equal(f.notices().length, 0);
});

test('O3 detached reminder argv/env uses injected spawn only', t => {
  const f = fixture(t); let launched = 0, unref = 0;
  launchDeliver(f.paths, () => assert.fail('unexpected launch failure'), { ...enabledEnv, HOME: f.root, PRIVATE_SENTINEL: 'excluded' }, (_bin, args, options) => {
    launched++; assert.equal(args.at(-1), '__notify-remind'); assert.equal(options.detached, true); assert.equal(options.shell, false);
    assert.equal(options.env!.GBDEV_HOME, f.paths.home); assert.equal(options.env!.GBDEV_CONFIG, f.paths.config);
    assert.equal(options.env!.PRIVATE_SENTINEL, undefined); assert.equal(options.env!.HOME, f.root);
    return Object.assign(new EventEmitter(), { unref: () => { unref++; } }) as ChildProcess;
  }, '__notify-remind');
  assert.equal(launched, 1); assert.equal(unref, 1);
  let refused = 0;
  launchDeliver(f.paths, () => { refused++; }, enabledEnv, undefined, '__notify-remind');
  assert.equal(refused, 1);
});
test('O3 source-lock recheck observes resolution before enqueue; original replay can restart timer', async t => {
  const f = fixture(t); await f.original(); await f.original(); assert.equal(f.reminders(), 2); assert.equal(f.notices().length, 1);
  f.setMinute(45);
  const lock = acquireLock(f.paths.lock), pending = reminderTick(f.store);
  f.run.attention = []; f.save(); lock.release(); await pending;
  assert.equal(f.notices().length, 1);
});

test('O3 delayed run needs_decision transition restarts timer after early attention scan exited', async t => {
  const f = fixture(t); f.run.state = 'running'; f.save(); await f.original();
  await remind(f.store, { sleep: async () => assert.fail('running run must not keep timer alive') });
  assert.equal(f.reminders(), 1); f.setMinute(45);
  await locked(f.store, () => {
    f.run.state = 'needs_decision';
    assert.equal(notifyEvent(f.store, { kind: 'run', id: f.run.run_id, state: f.run.state }, 'run_state_change', { state: f.run.state }, 2, at), false);
    f.save();
  });
  assert.equal(f.reminders(), 2); assert.equal(f.notices().length, 1);
  await reminderTick(f.store); assert.equal(f.notices().length, 2); assert.equal(f.notices()[1]!.reminder!.n, 1);
});
