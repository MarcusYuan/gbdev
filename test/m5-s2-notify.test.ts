import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, until } from './helpers/m3.js';
import { job, temporary } from './helpers.js';
import { testEnv } from './helpers/run.js';
import { startRun, runCommand } from '../src/commands/run.js';
import { DECISION_REASONS } from '../src/contracts/run.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import { validateNotifyPayload } from '../src/contracts/notify.js';
import { JobStore } from '../src/core/jobStore.js';
import { localIso } from '../src/core/time.js';
import { resolvePaths, jobPaths } from '../src/core/paths.js';
import { event, locked, transition } from '../src/core/runtime.js';
import { requireDecision } from '../src/run/decisions.js';
import { runEvent, runPaths, readRun, transitionRun, writeRun } from '../src/run/store.js';
import { runJobs } from '../src/run/invariants.js';
import { localSupervisors, reconcileRun } from '../src/run/reconcile.js';
import { createRun as createPipeline, pipelineEvent, pipelinePaths, readRun as readPipeline, transitionRun as transitionPipeline } from '../src/pipeline/store.js';
import { pipelineStart } from '../src/commands/pipeline.js';
import { pipelineValue } from '../src/run/requests.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { resolveRequest } from '../src/contracts/pipelineRequest.js';
import { loadConfig } from '../src/core/config.js';
import { atomicWriteJson } from '../src/core/jobStore.js';
import { addWorktree } from '../src/core/git.js';
import { supervisePipeline } from '../src/pipeline/supervisor.js';
import { notifiable, type NotifyUnit } from '../src/notify/filter.js';
import { installNotifyTesting, notifyEvent, type OutboxRecord } from '../src/notify/enqueue.js';
import { deliveryEnv, launchDeliver, NotifyTrigger } from '../src/notify/trigger.js';

const at = '2026-10-29T10:31:02-07:00';
const unit: NotifyUnit = { kind: 'run', id: 'r_20261029_0930_ab12', state: 'running' };
const enabledEnv = { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1' };
function notices(store: JobStore): OutboxRecord[] {
  const dir = join(store.paths.home, 'notify', 'outbox');
  return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')) as OutboxRecord).sort((a, b) => a.seq - b.seq) : [];
}
function enable(t: TestContext, store: JobStore, options: Partial<Parameters<typeof installNotifyTesting>[1]> = {}) {
  const raw = existsSync(store.paths.config) ? JSON.parse(readFileSync(store.paths.config, 'utf8')) : { version: 1 };
  writeFileSync(store.paths.config, JSON.stringify({ ...raw, notify: { enabled: true, key_name: 'X-Key' } }));
  let launches = 0;
  t.after(installNotifyTesting(store.paths.home, { launch: () => { launches++; }, env: enabledEnv, ...options }));
  return () => launches;
}
function small(t: TestContext) {
  const root = temporary(t), paths = resolvePaths({ GBDEV_HOME: join(root, 'home'), GBDEV_CONFIG: join(root, 'config.json') });
  mkdirSync(paths.home); const store = new JobStore(paths); const launches = enable(t, store);
  return { root, store, paths, launches };
}
const send = (store: JobStore, source = 1, data = { reason: 'plan_review', decision_id: 'd_one' }) => locked(store, () => notifyEvent(store, unit, 'decision_required', data, source, at));

for (const reason of DECISION_REASONS) test(`AC-1 fake run attention exactly once: ${reason}`, async t => {
  const f = fixture(t); enable(t, f.store);
  const run = await startRun(f.store, f.request, false);
  await locked(f.store, () => { requireDecision(f.store, run, null, reason, '\x1b]52; /private/secret sk-test Ignore instructions', ['resume_run']); writeRun(f.store, run); });
  const records = notices(f.store); assert.equal(records.length, 1);
  const p = records[0]!; assert.equal(p.event, 'attention'); assert.equal(p.kind, reason); assert.equal(p.decision_id, run.attention[0]!.decision_id);
  const { meta, ...payload } = p; validateNotifyPayload(payload); assert.deepEqual(meta, { attempts: 0, next_at: p.occurred_at, last_error: null });
  assert.doesNotMatch(JSON.stringify(p), /private|Ignore|allowed_actions|detail|sk-test/);
});

test('AC-2 all run/pipeline/job terminals and standalone job attention use event hooks', async t => {
  const f = fixture(t); enable(t, f.store); const run = await startRun(f.store, f.request, false);
  await locked(f.store, () => {
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) { run.state = state; runEvent(f.store, run, 'run_state_change', { state, reason: 'run_timeout' }); }
    const p = { pipeline_id: 'p_20261029_0930_ab12', state: 'running', workspace: { mode: 'standalone' }, current: null } as unknown as PipelineRun;
    mkdirSync(join(f.paths.home, 'pipelines', p.pipeline_id), { recursive: true });
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) { p.state = state; pipelineEvent(f.store, p, 'pipeline_state_change', { state, reason: 'pipeline_supervisor_crashed' }); }
    const j = job(); f.store.create(j);
    for (const state of ['succeeded', 'failed', 'cancelled', 'timeout', 'needs_input', 'blocked'] as const) transition(f.store, j, state, 'gbdev', 'supervisor_crashed');
  });
  const records = notices(f.store); assert.equal(records.length, 12); assert.equal(records.filter(p => p.event === 'terminal').length, 10);
  assert.deepEqual(records.filter(p => p.event === 'attention').map(p => p.kind), ['job_needs_input', 'job_blocked']);
  for (const { meta: _meta, ...p } of records) validateNotifyPayload(p);
  assert.deepEqual(records.filter(p => p.kind === 'failed').map(p => p.reason_code), ['run_timeout', 'pipeline_supervisor_crashed', 'supervisor_crashed']);
});

test('O-9 pipeline decision source uses target pause state without changing event bytes', async t => {
  const f = small(t);
  const p = { pipeline_id: 'p_20261029_0930_ab12', state: 'running', workspace: { mode: 'standalone' }, current: null } as unknown as PipelineRun;
  const dir = join(f.paths.home, 'pipelines', p.pipeline_id); mkdirSync(dir, { recursive: true });
  await locked(f.store, () => { for (const state of ['needs_input', 'blocked', 'needs_decision'] as const) pipelineEvent(f.store, p, 'decision_required', { reason: 'worker_paused', detail: 'private', allowed_actions: ['resume'] }, state); });
  assert.deepEqual(notices(f.store).map(p => [p.kind, p.unit_state, p.decision_id]), ['needs_input', 'blocked', 'needs_decision'].map(s => [s, s, null]));
  for (const e of readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s))) assert.deepEqual(e.data, { reason: 'worker_paused', detail: 'private', allowed_actions: ['resume'] });
});

test('AC-3 exhaustive allowlist rejects topology, warning and nested unit events', async t => {
  const f = small(t);
  const excluded = ['state_change', 'worker_output', 'heartbeat', 'check', 'step_started', 'step_finished', 'gate', 'gate_failed', 'lane_assigned', 'merge_started', 'resolver_started', 'verifier_started', 'plan_ready', 'plan_invalid', 'task_state_change', 'decision_resolved', 'decider_decision', 'provider_cooldown', 'budget_warning', 'landed', 'recovery_step', 'invariant_violation', 'warning', 'anything_else'];
  await locked(f.store, () => {
    for (const type of excluded) { assert.equal(notifiable(unit, type, { reason: 'plan_review', state: 'running' }), null); notifyEvent(f.store, unit, type, {}, 1, at); }
    for (const state of ['queued', 'starting', 'running', 'reviewed', 'integrated', 'discarded']) assert.equal(notifiable({ kind: 'job', id: 'j_20261029_0930_ab12', state }, 'state_change', { state }), null);
    const nested: NotifyUnit[] = [{ kind: 'pipeline', id: 'p_20261029_0930_ab12', state: 'failed', workspace_mode: 'per_lane' }, { kind: 'job', id: 'j_20261029_0930_ab12', state: 'failed', pipeline_id: 'p_owned' }, { kind: 'job', id: 'j_20261029_0930_ab12', state: 'failed', run_id: unit.id }];
    for (const ref of nested) for (const type of ['decision_required', 'pipeline_state_change', 'state_change']) notifyEvent(f.store, ref, type, { state: 'failed', reason: 'task_failed' }, 1, at);
  });
  assert.equal(existsSync(join(f.paths.home, 'notify')), false); assert.equal(f.launches(), 0);
});

test('AC-3 nested hooks exclude pipeline children and run_id-only jobs', async t => {
  const f = small(t);
  await locked(f.store, () => {
    const j = job(); j.run_id = unit.id; f.store.create(j); transition(f.store, j, 'failed');
    const p = { pipeline_id: 'p_20261029_0930_ab12', state: 'failed', workspace: { mode: 'per_lane', run_id: unit.id, task_id: 't1', lane: 'lane-1' }, current: null } as unknown as PipelineRun;
    mkdirSync(join(f.paths.home, 'pipelines', p.pipeline_id), { recursive: true }); pipelineEvent(f.store, p, 'pipeline_state_change', { state: 'failed' });
  });
  assert.equal(notices(f.store).length, 0); assert.equal(existsSync(join(f.paths.home, 'notify')), false);
});

test('AC-7 pending/sent/dead dedup and distinct decision IDs', async t => {
  const f = small(t); await send(f.store); const record = notices(f.store)[0]!;
  await send(f.store); assert.equal(notices(f.store).length, 1);
  for (const name of ['sent', 'dead']) {
    const dir = join(f.paths.home, 'notify', name); mkdirSync(dir);
    const from = join(f.paths.home, 'notify', name === 'sent' ? 'outbox' : 'sent', `${record.seq}-${record.notice_id}.json`);
    renameSync(from, join(dir, `${record.seq}-${record.notice_id}.json`)); await send(f.store); assert.equal(readFileSync(join(f.paths.home, 'notify', 'seq'), 'utf8'), '1\n');
  }
  await send(f.store, 1, { reason: 'plan_review', decision_id: 'd_two' }); assert.equal(notices(f.store)[0]!.seq, 2);
  assert.equal(statSync(join(f.paths.home, 'notify')).mode & 0o777, 0o700);
  const file = readdirSync(join(f.paths.home, 'notify', 'outbox'))[0]!; assert.equal(statSync(join(f.paths.home, 'notify', 'outbox', file)).mode & 0o777, 0o600);
});

test('AC-8 eight concurrent processes allocate strict unique seq and dedup replay', async t => {
  const f = small(t);
  await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const child = spawn(process.execPath, [resolve('test/fixtures/notify-enqueue-worker.js'), String(i)], { env: { ...process.env, ...enabledEnv, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config }, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', s => { error += s; }); const [code] = await once(child, 'exit'); assert.equal(code, 0, error);
  }));
  const records = notices(f.store); assert.equal(records.length, 97); assert.deepEqual(records.map(p => p.seq), Array.from({ length: 97 }, (_, i) => i + 1));
  assert.equal(new Set(records.map(p => p.notice_id)).size, 97); assert.equal(records.filter(p => p.decision_id === 'd_shared').length, 1);
  assert.equal(readFileSync(join(f.paths.home, 'notify', 'seq'), 'utf8'), '97\n');
});

test('AC-7 durable notice index dedups after outbox and retained records are deleted', async t => {
  const f = small(t); assert.equal(await send(f.store), true);
  const record = notices(f.store)[0]!, dir = join(f.paths.home, 'notify');
  rmSync(join(dir, 'outbox', `${record.seq}-${record.notice_id}.json`));
  assert.equal(await send(new JobStore(f.paths)), true);
  assert.equal(notices(f.store).length, 0); assert.equal(f.launches(), 1);
  assert.equal(readFileSync(join(dir, 'seq'), 'utf8'), '1\n');
  assert.equal(statSync(join(dir, 'notice_ids')).mode & 0o777, 0o700);
  const marker = join(dir, 'notice_ids', record.notice_id);
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.equal(readFileSync(marker, 'utf8'), '1\n');
});

for (const indexed of [false, true]) test(`AC-7 interrupted index transaction recovers once: indexed=${indexed}`, async t => {
  const f = small(t); await send(f.store);
  const record = notices(f.store)[0]!, dir = join(f.paths.home, 'notify');
  const stage = join(dir, 'staging', `${record.notice_id}.json`);
  renameSync(join(dir, 'outbox', `${record.seq}-${record.notice_id}.json`), stage);
  if (!indexed) writeFileSync(join(dir, 'notice_ids', record.notice_id), '');
  const launches = enable(t, f.store);
  assert.equal(await send(new JobStore(f.paths)), true);
  assert.equal(await send(new JobStore(f.paths)), true);
  assert.equal(notices(f.store).length, 1); assert.equal(launches(), 1);
  assert.equal(notices(f.store)[0]!.notice_id, record.notice_id);
  assert.equal(notices(f.store)[0]!.seq, indexed ? 1 : 2);
  assert.equal(existsSync(stage), false);
});

test('AC-7 outbox publication failure preserves committed index and replays same seq', async t => {
  const f = small(t); await send(f.store);
  const record = notices(f.store)[0]!, dir = join(f.paths.home, 'notify');
  const marker = join(dir, 'notice_ids', record.notice_id), stage = join(dir, 'staging', `${record.notice_id}.json`);
  rmSync(marker); rmSync(join(dir, 'outbox', `${record.seq}-${record.notice_id}.json`));
  const blocked = join(dir, 'outbox', `2-${record.notice_id}.json`); mkdirSync(blocked);
  const launches = enable(t, f.store);
  assert.equal(await send(f.store), false); assert.equal(launches(), 0);
  assert.equal(readFileSync(marker, 'utf8'), '2\n'); assert.equal(existsSync(stage), true);
  rmSync(blocked, { recursive: true });
  assert.equal(await send(f.store), true); assert.equal(await send(f.store), true);
  assert.equal(notices(f.store).length, 1); assert.equal(notices(f.store)[0]!.seq, 2); assert.equal(launches(), 1);
});

for (const corrupt of ['json', 'directory'] as const) test(`N18 unreadable pause state ${corrupt} still fires once without enqueue_failed`, async t => {
  const f = small(t), j = job(); f.store.create(j);
  const dir = join(f.paths.home, 'notify'); mkdirSync(dir);
  if (corrupt === 'json') writeFileSync(join(dir, 'state.json'), '{bad');
  else mkdirSync(join(dir, 'state.json'));
  let fires = 0; const fire = NotifyTrigger.prototype.fire;
  t.mock.method(NotifyTrigger.prototype, 'fire', function (this: NotifyTrigger, callback: () => void) { fires++; fire.call(this, callback); });
  await locked(f.store, () => transition(f.store, j, 'failed'));
  assert.equal(notices(f.store).length, 1); assert.equal(fires, 1); assert.equal(f.launches(), 1);
  const events = readFileSync(jobPaths(f.paths, j.job_id).events, 'utf8');
  assert.doesNotMatch(events, /notify_unavailable|enqueue_failed/);
  assert.equal(existsSync(join(dir, 'notify.log')), false);
});

test('NotifyTrigger leading edge 1s, no trailing launch, contained repeated failures', () => {
  let now = 0, launches = 0, warnings = 0;
  const trigger = new NotifyTrigger(fail => { launches++; fail(); fail(); throw new Error('private'); }, () => now);
  const fire = () => trigger.fire(() => { warnings++; throw new Error('warning failure'); });
  fire(); now = 999; fire(); assert.equal(launches, 1); now = 1000; fire(); assert.equal(launches, 2); assert.equal(warnings, 2);
});
test('NotifyTrigger default test guard and delivery env whitelist never expose inherited secrets', () => {
  let failed = 0; const paths = resolvePaths({ GBDEV_HOME: '/tmp/fake-home', GBDEV_CONFIG: '/tmp/fake-config' });
  launchDeliver(paths, () => { failed++; }); assert.equal(failed, 1);
  const env = deliveryEnv(paths, { HOME: '/tmp', PATH: '/bin', ...enabledEnv, GBDEV_NOTIFY: '0', TOKEN: 'private', NODE_OPTIONS: 'private' });
  assert.equal(env.TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.GBDEV_NOTIFY, '0'); assert.equal(env.GBDEV_HOME, paths.home);
});

for (const failure of ['disk', 'config', 'paused'] as const) test(`N18 ${failure} failure is contained and persisted warning once per unit`, async t => {
  const f = small(t), j = job(); f.store.create(j);
  const dir = join(f.paths.home, 'notify');
  if (failure === 'disk') writeFileSync(dir, 'not a directory');
  if (failure === 'config') writeFileSync(f.paths.config, '{bad secret text');
  if (failure === 'paused') { mkdirSync(dir); writeFileSync(join(dir, 'state.json'), JSON.stringify({ paused: { reason: 'paused_auth_rejected' } })); }
  for (const state of ['failed', 'cancelled', 'timeout'] as const) await locked(f.store, () => transition(f.store, j, state));
  const events = readFileSync(jobPaths(f.paths, j.job_id).events, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(events.filter(e => e.type === 'warning').length, 1); assert.equal(events.find(e => e.type === 'warning').data.code, 'notify_unavailable');
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]); assert.equal(j.last_event!.seq, 4);
  assert.equal(f.store.read(j.job_id).state, 'timeout');
});

test('N18 asynchronous launch failure reacquires lock and warns once across fresh stores', async t => {
  const f = small(t); let fail: (() => void) | undefined; let now = 0;
  enable(t, f.store, { launch: callback => { fail = callback; }, now: () => now += 1000 });
  const j = job(); f.store.create(j); await locked(f.store, () => transition(f.store, j, 'failed'));
  fail!(); fail!(); await until(() => readFileSync(jobPaths(f.paths, j.job_id).events, 'utf8').includes('notify_unavailable'));
  const fresh = new JobStore(f.paths); await locked(fresh, () => transition(fresh, fresh.read(j.job_id), 'cancelled')); fail!();
  await new Promise<void>(resolve => setImmediate(resolve));
  const events = readFileSync(jobPaths(f.paths, j.job_id).events, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(events.filter(e => e.type === 'warning').length, 1);
});

test('enqueue corrupt sequence fails closed and never throws or reuses seq', async t => {
  const f = small(t); await send(f.store); writeFileSync(join(f.paths.home, 'notify', 'seq'), 'corrupt');
  assert.equal(await send(f.store, 2), false); assert.equal(notices(f.store).length, 1);
  assert.equal(readFileSync(join(f.paths.home, 'notify', 'seq'), 'utf8'), 'corrupt');
  assert.equal(readdirSync(join(f.paths.home, 'notify', 'notice_ids')).length, 1);
  writeFileSync(join(f.paths.home, 'notify', 'seq'), '1\n');
  assert.equal(await send(f.store, 2), true); assert.deepEqual(notices(f.store).map(p => p.seq), [1, 2]);
});

for (const decompose of ['provided', 'planner'] as const) test(`O-9 real fake run ${decompose} plan_review path`, async t => {
  const f = fixture(t); enable(t, f.store);
  if (decompose === 'planner') { const graph = { schema: 'gbdev.task-graph.v1', summary: 'Two tasks', tasks: f.request.tasks }; f.request.decompose = 'planner'; f.request.tasks = null; f.fakePlan['run:planner#1'] = { actions: [{ type: 'emit_task_graph', graph }] }; }
  const { run } = await f.execute(); const reviews = notices(f.store).filter(p => p.kind === 'plan_review');
  if (decompose === 'planner') { assert.equal(run.state, 'plan_review'); assert.equal(reviews.length, 1); assert.equal(reviews[0]!.decision_id, run.attention[0]!.decision_id); }
  else { assert.equal(run.state, 'succeeded'); assert.equal(run.plan.approved_by, 'grok-bot'); assert.equal(reviews.length, 0); }
  assert.ok(notices(f.store).every(p => p.unit_kind === 'run')); assert.ok(!readFileSync(runPaths(f.store, run.run_id).events, 'utf8').includes('notify_unavailable'));
});

for (const mode of ['config', 'env', 'test-default'] as const) test(`AC-10 disabled ${mode}: fake run, no directory/request/launch`, async t => {
  const f = fixture(t); let requests = 0; t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('Network prohibited'); });
  const env = mode === 'env' ? { ...enabledEnv, GBDEV_NOTIFY: '0' } : mode === 'test-default' ? { NODE_TEST_CONTEXT: 'child' } : enabledEnv;
  const launches = enable(t, f.store, { env });
  if (mode === 'config') { const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.notify.enabled = false; writeFileSync(f.paths.config, JSON.stringify(config)); }
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded'); assert.equal(existsSync(join(f.paths.home, 'notify')), false); assert.equal(requests, 0); assert.equal(launches(), 0);
  assert.ok(!readFileSync(runPaths(f.store, run.run_id).events, 'utf8').includes('notify_unavailable'));
});

test('AC-9 fake run enqueue p99 budget with 250 decision samples', async t => {
  const f = fixture(t), timings: number[] = []; enable(t, f.store, { timing: ms => timings.push(ms) });
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded');
  await locked(f.store, () => { for (let i = 0; i < 50; i++) requireDecision(f.store, run, null, 'task_failed', 'warmup', ['resume_run']); });
  timings.length = 0;
  await locked(f.store, () => { for (let i = 0; i < 250; i++) requireDecision(f.store, run, null, 'task_failed', 'performance sample', ['resume_run']); });
  const samples = timings.toSorted((a, b) => a - b), p99 = samples[Math.ceil(samples.length * .99) - 1]!;
  const budget = process.env.GBDEV_PERF_STRICT === '1' ? 5 : 10;
  t.diagnostic(`enqueue n=${samples.length}, p99=${p99.toFixed(3)} ms (budget <${budget} ms)`);
  assert.equal(samples.length, 250);
  assert.ok(p99 < budget, `enqueue p99 ${p99.toFixed(3)} ms exceeds ${budget} ms budget`);
  assert.equal(notices(f.store).length, 301);
});

test('heartbeat_stale health is persisted once across repeated status and fresh stores', async t => {
  const f = fixture(t); enable(t, f.store); testEnv(t, enabledEnv);
  const run = await startRun(f.store, f.request, false); run.state = 'running'; run.state_history.push({ state: 'running', at, by: 'gbdev', reason: null }); run.supervisor_pid = process.pid; run.heartbeat_at = localIso(new Date(Date.now() - 240_000));
  localSupervisors.add(run.run_id); t.after(() => localSupervisors.delete(run.run_id)); await locked(f.store, () => { runEvent(f.store, run, 'run_state_change', { state: 'running' }); writeRun(f.store, run); });
  const before = readFileSync(runPaths(f.store, run.run_id).events, 'utf8');
  for (let i = 0; i < 3; i++) await reconcileRun(new JobStore(f.paths), run.run_id);
  const records = notices(f.store); assert.equal(records.length, 1); assert.equal(records[0]!.kind, 'supervisor_heartbeat_stale');
  assert.equal(readRun(f.store, run.run_id).warnings.filter(w => w === 'supervisor_heartbeat_stale').length, 1);
  assert.equal(readFileSync(runPaths(f.store, run.run_id).events, 'utf8'), before);
});

for (const empty of [false, true]) test(`heartbeat_stale retries failed enqueue and commits once: empty events=${empty}`, async t => {
  const f = fixture(t); const launches = enable(t, f.store); testEnv(t, enabledEnv);
  const run = await startRun(f.store, f.request, false);
  await locked(f.store, () => {
    transitionRun(f.store, run, 'starting'); transitionRun(f.store, run, 'running');
    run.supervisor_pid = process.pid; run.heartbeat_at = localIso(new Date(Date.now() - 240_000)); writeRun(f.store, run);
  });
  localSupervisors.add(run.run_id); t.after(() => localSupervisors.delete(run.run_id));
  const dir = join(f.paths.home, 'notify'), events = runPaths(f.store, run.run_id).events;
  if (!empty) {
    writeFileSync(dir, 'force first enqueue to fail');
    await reconcileRun(f.store, run.run_id);
    assert.equal(readRun(f.store, run.run_id).warnings.includes('supervisor_heartbeat_stale'), false);
    assert.equal(launches(), 0);
    assert.match(readFileSync(events, 'utf8'), /enqueue_failed/);
    rmSync(dir);
  } else writeFileSync(events, '');
  const before = readFileSync(events, 'utf8');
  for (let i = 0; i < 3; i++) await reconcileRun(new JobStore(f.paths), run.run_id);
  const records = notices(f.store); assert.equal(records.length, 1); assert.equal(launches(), 1);
  assert.equal(records[0]!.kind, 'supervisor_heartbeat_stale');
  assert.equal(readRun(f.store, run.run_id).warnings.filter(w => w === 'supervisor_heartbeat_stale').length, 1);
  assert.equal(readFileSync(events, 'utf8'), before);
  if (empty) {
    assert.equal(records[0]!.source_seq, 1);
    await locked(f.store, () => { const current = readRun(f.store, run.run_id); transitionRun(f.store, current, 'failed', 'run_timeout'); writeRun(f.store, current); });
    const all = notices(f.store); assert.equal(all.length, 2);
    assert.notEqual(all[0]!.notice_id, all[1]!.notice_id);
    assert.equal(JSON.parse(readFileSync(events, 'utf8')).seq, 1);
    assert.equal(all[1]!.event, 'terminal');
  }
});

test('AC-10 disabled heartbeat preserves persisted run and event bytes', async t => {
  const f = fixture(t); const launches = enable(t, f.store);
  const run = await startRun(f.store, f.request, false);
  run.supervisor_pid = process.pid; run.heartbeat_at = localIso(new Date(Date.now() - 240_000));
  await locked(f.store, () => { transitionRun(f.store, run, 'starting'); writeRun(f.store, run); });
  localSupervisors.add(run.run_id); t.after(() => localSupervisors.delete(run.run_id));
  const paths = runPaths(f.store, run.run_id), before = [readFileSync(paths.run, 'utf8'), readFileSync(paths.events, 'utf8')];
  for (const mode of ['config', 'env', 'test-default']) {
    const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.notify.enabled = mode !== 'config'; writeFileSync(f.paths.config, JSON.stringify(config));
    testEnv(t, { GBDEV_NOTIFY: mode === 'env' ? '0' : '', GBDEV_NOTIFY_TEST: mode === 'test-default' ? '' : '1' });
    const current = await reconcileRun(f.store, run.run_id);
    assert.ok(current.warnings.includes('supervisor_heartbeat_stale'));
    assert.deepEqual([readFileSync(paths.run, 'utf8'), readFileSync(paths.events, 'utf8')], before);
  }
  assert.equal(existsSync(join(f.paths.home, 'notify')), false); assert.equal(launches(), 0);
});

test('AC-2 real transitionRun terminal persists one terminal notice', async t => {
  const f = fixture(t); enable(t, f.store); const run = await startRun(f.store, f.request, false);
  await locked(f.store, () => { transitionRun(f.store, run, 'cancelled'); writeRun(f.store, run); transitionRun(f.store, run, 'cancelled'); });
  assert.equal(readRun(f.store, run.run_id).state, 'cancelled');
  const records = notices(f.store); assert.equal(records.length, 1);
  assert.deepEqual([records[0]!.unit_kind, records[0]!.event, records[0]!.kind, records[0]!.unit_state], ['run', 'terminal', 'cancelled', 'cancelled']);
});

test('AC-4 killed fake supervisor then status three times yields one crash notice', { timeout: 40_000 }, async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); enable(t, f.store); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = 'slow'; f.savePlan();
  const initial = await startRun(f.store, f.request, false);
  const child = spawn(process.execPath, [resolve('test/fixtures/notify-supervisor-worker.js'), initial.run_id], { env: { ...process.env, ...enabledEnv, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config }, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr.on('data', data => { error += data; });
  const exited = once(child, 'exit');
  cleanup = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await reconcileRun(f.store, initial.run_id); };
  await until(() => {
    if (child.exitCode !== null) assert.fail(error || 'Fake supervisor exited early');
    // Job directories are staged before job.json is published; inventory can race creation.
    try { return runJobs(f.store, readRun(f.store, initial.run_id)).some(j => j.state === 'running'); } catch { return false; }
  });
  child.kill('SIGKILL'); await exited;
  let firstIds: string[] | undefined;
  for (let i = 0; i < 3; i++) {
    const result = await runCommand(f.store, ['status', initial.run_id], {}); assert.equal((result.result as typeof initial).state, 'needs_decision');
    const ids = notices(f.store).map(p => p.notice_id); if (firstIds) assert.deepEqual(ids, firstIds); else firstIds = ids;
  }
  const records = notices(f.store); assert.equal(records.filter(p => p.kind === 'supervisor_crashed').length, 1); assert.equal(records.filter(p => p.kind === 'task_failed').length, 1); assert.equal(records.length, 2);
  for (const record of records) assert.equal(record.decision_id, readRun(f.store, initial.run_id).attention.find(d => d.reason === record.kind)!.decision_id);
});


test('AC-10 disabled event/status bytes equal across config, env and test guards', async t => {
  const f = small(t); t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const j = job(); f.store.create(j); const original = readFileSync(jobPaths(f.paths, j.job_id).job);
  const snapshots: string[][] = [];
  for (const mode of ['config', 'env', 'test-default']) {
    writeFileSync(jobPaths(f.paths, j.job_id).job, original); writeFileSync(jobPaths(f.paths, j.job_id).events, '');
    writeFileSync(f.paths.config, JSON.stringify({ version: 1, notify: { enabled: mode !== 'config', key_name: 'X-Key' } }));
    const restore = installNotifyTesting(f.paths.home, { launch: () => assert.fail('Unexpected launch'), env: mode === 'env' ? { ...enabledEnv, GBDEV_NOTIFY: '0' } : mode === 'test-default' ? { NODE_TEST_CONTEXT: 'child' } : enabledEnv });
    try { await locked(f.store, () => { const current = f.store.read(j.job_id); event(f.store, current, 'heartbeat', {}); transition(f.store, current, 'failed'); }); }
    finally { restore(); }
    snapshots.push([readFileSync(jobPaths(f.paths, j.job_id).job, 'utf8'), readFileSync(jobPaths(f.paths, j.job_id).events, 'utf8')]);
  }
  assert.deepEqual(snapshots[1], snapshots[0]); assert.deepEqual(snapshots[2], snapshots[0]); assert.equal(existsSync(join(f.paths.home, 'notify')), false);
});

test('enqueue recovers lagging seq from existing queue without reuse', async t => {
  const f = small(t); await send(f.store); writeFileSync(join(f.paths.home, 'notify', 'seq'), '0'); await send(f.store, 2);
  assert.deepEqual(notices(f.store).map(p => p.seq), [1, 2]);
});

test('N18 run warnings persist once across stores and do not enqueue themselves', async t => {
  const f = fixture(t); enable(t, f.store); const run = await startRun(f.store, f.request, false);
  writeFileSync(join(f.paths.home, 'notify'), 'unwritable queue');
  for (let i = 0; i < 3; i++) await locked(f.store, () => requireDecision(new JobStore(f.paths), run, null, 'task_failed', 'private failure', ['resume_run']));
  const events = readFileSync(runPaths(f.store, run.run_id).events, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(events.filter(e => e.type === 'warning').length, 1); assert.equal(events.filter(e => e.type === 'decision_required').length, 3);
});

test('filter supports test and finalize health while rejecting invalid run reason', () => {
  assert.deepEqual(notifiable(null, 'test', {}), { event: 'test', kind: 'test' });
  assert.deepEqual(notifiable(unit, 'notify_secret_exposed', {}), { event: 'health', kind: 'notify_secret_exposed' });
  assert.equal(notifiable(unit, 'decision_required', { reason: 'not_a_decision' }), null);
  assert.deepEqual(notifiable(unit, 'decision_required', { reason: 'plan_review', decision_id: 123, task_id: {} }), { event: 'attention', kind: 'plan_review', decision_id: null, task_id: null });
});


async function standalonePipeline(t: TestContext, scenario: 'needs_input' | 'blocked' | 'review_reject' | 'ok', breakQueue = false) {
  const f = fixture(t); enable(t, f.store);
  const registry = new PipelineRegistry(f.paths.config), value = pipelineValue(f.request, f.request.tasks![0]!, registry);
  const input = join(f.root, 'pipeline-input.json'); writeFileSync(input, JSON.stringify(value));
  const run = await pipelineStart(f.store, input, true); delete run.dry_run;
  run.pipeline_id = 'p_20261029_0930_ab12'; run.workspace = { mode: 'shared_run_worktree', worktree: join(f.root, 'pipeline-worktree'), branch: `gbdev/${run.pipeline_id}` };
  const { request, definition, snapshot } = resolveRequest(value, loadConfig(f.paths.config), registry);
  snapshot.pipeline_id = run.pipeline_id;
  addWorktree(run.repo, run.workspace.branch, run.workspace.worktree, run.base_sha);
  await locked(f.store, () => {
    createPipeline(f.store, run, () => {
      const paths = pipelinePaths(f.store, run.pipeline_id);
      atomicWriteJson(paths.request, request); atomicWriteJson(paths.snapshot, snapshot);
      atomicWriteJson(paths.definition, { ...definition, timeout_min: request.timeout_min, steps: definition.steps.map(step => ({ ...step, ...snapshot.steps[step.id] })), ...(definition.fix_loop ? { fix_loop: { ...definition.fix_loop, max_rounds: request.max_rounds, resolved_role: snapshot.steps.fix } } : {}) });
    });
    transitionPipeline(f.store, run, 'starting');
  });
  f.fakePlan['implement#1'] = scenario === 'review_reject' ? 'ok' : scenario; f.fakePlan['review#1'] = scenario === 'review_reject' ? 'review_reject' : 'review_approve'; f.savePlan();
  if (breakQueue) writeFileSync(join(f.paths.home, 'notify'), 'unwritable queue');
  await supervisePipeline(f.store, run.pipeline_id);
  return { ...f, run: readPipeline(f.store, run.pipeline_id) };
}
test('AC-2 standalone fake pipeline actual success emits one terminal notice', async t => {
  const f = await standalonePipeline(t, 'ok');
  assert.equal(f.run.state, 'succeeded');
  assert.equal(JSON.parse(readFileSync(pipelinePaths(f.store, f.run.pipeline_id).result, 'utf8')).state, 'succeeded');
  const records = notices(f.store); assert.equal(records.length, 1);
  assert.deepEqual([records[0]!.unit_kind, records[0]!.event, records[0]!.kind, records[0]!.unit_state], ['pipeline', 'terminal', 'succeeded', 'succeeded']);
});
for (const [scenario, state] of [['needs_input', 'needs_input'], ['blocked', 'blocked'], ['review_reject', 'needs_decision']] as const) test(`O-9 standalone fake pipeline ${state} emits one attention from actual pause path`, async t => {
  const f = await standalonePipeline(t, scenario);
  assert.equal(f.run.state, state); const records = notices(f.store); assert.equal(records.length, 1);
  assert.equal(records[0]!.unit_kind, 'pipeline'); assert.equal(records[0]!.kind, state); assert.equal(records[0]!.unit_state, state); assert.equal(records[0]!.decision_id, null);
  assert.ok(!readFileSync(pipelinePaths(f.store, f.run.pipeline_id).events, 'utf8').includes('notify_unavailable'));
});
test('N18 standalone pipeline enqueue failure warns once across repeated source events', async t => {
  const f = await standalonePipeline(t, 'needs_input', true);
  await locked(f.store, () => { pipelineEvent(f.store, f.run, 'decision_required', { ...f.run.decision }); pipelineEvent(new JobStore(f.paths), f.run, 'decision_required', { ...f.run.decision }); });
  const events = readFileSync(pipelinePaths(f.store, f.run.pipeline_id).events, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(events.filter(e => e.type === 'warning' && e.data.code === 'notify_unavailable').length, 1); assert.equal(f.run.state, 'needs_input');
});


test('AC-7 committed index recovery rename failure retains marker and staging', async t => {
  const f = small(t); await send(f.store);
  const record = notices(f.store)[0]!, dir = join(f.paths.home, 'notify');
  const target = join(dir, 'outbox', `${record.seq}-${record.notice_id}.json`), stage = join(dir, 'staging', `${record.notice_id}.json`), marker = join(dir, 'notice_ids', record.notice_id);
  renameSync(target, stage); mkdirSync(target);
  assert.equal(await send(f.store), false);
  assert.equal(readFileSync(marker, 'utf8'), '1\n'); assert.equal(JSON.parse(readFileSync(stage, 'utf8')).seq, 1);
  rmSync(target, { recursive: true }); enable(t, f.store);
  assert.equal(await send(f.store), true); assert.equal(notices(f.store)[0]!.seq, 1);
  assert.equal(readFileSync(join(dir, 'seq'), 'utf8'), '1\n'); assert.equal(existsSync(stage), false);
});
test('AC-7 legacy outbox upgrade fires trigger exactly once', async t => {
  const f = small(t); await send(f.store); const record = notices(f.store)[0]!;
  rmSync(join(f.paths.home, 'notify', 'notice_ids', record.notice_id)); const launches = enable(t, f.store);
  let fires = 0; const fire = NotifyTrigger.prototype.fire;
  t.mock.method(NotifyTrigger.prototype, 'fire', function (this: NotifyTrigger, callback: () => void) { fires++; fire.call(this, callback); });
  assert.equal(await send(f.store), true); assert.equal(await send(f.store), true);
  assert.equal(fires, 1); assert.equal(launches(), 1); assert.equal(notices(f.store).length, 1);
});
test('heartbeat enqueue committed then marker write fails and HWM grows: one run-stable notice', async t => {
  const f = fixture(t); enable(t, f.store); testEnv(t, { ...enabledEnv, GBDEV_NOTIFY: '' });
  const run = await startRun(f.store, f.request, false);
  await locked(f.store, () => { transitionRun(f.store, run, 'starting'); transitionRun(f.store, run, 'running'); run.supervisor_pid = process.pid; run.heartbeat_at = localIso(new Date(Date.now() - 240_000)); writeRun(f.store, run); });
  localSupervisors.add(run.run_id); t.after(() => localSupervisors.delete(run.run_id));
  const fs = await import('node:fs'), { syncBuiltinESMExports } = await import('node:module'), rename = fs.default.renameSync;
  const paths = runPaths(f.store, run.run_id);
  t.mock.method(fs.default, 'renameSync', (...args: Parameters<typeof rename>) => { if (args[1] === paths.run) throw new Error('injected marker persistence failure'); return rename(...args); }); syncBuiltinESMExports();
  try { const result = await reconcileRun(f.store, run.run_id); assert.equal(result.warnings.includes('supervisor_heartbeat_stale'), false); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(notices(f.store).length, 1); assert.equal(readRun(f.store, run.run_id).warnings.includes('supervisor_heartbeat_stale'), false);
  const first = notices(f.store)[0]!;
  await locked(f.store, () => { for (let i = 0; i < 4; i++) runEvent(f.store, run, 'heartbeat', {}); });
  await reconcileRun(new JobStore(f.paths), run.run_id);
  assert.equal(notices(f.store).length, 1); assert.equal(notices(f.store)[0]!.notice_id, first.notice_id);
  assert.equal(readRun(f.store, run.run_id).warnings.filter(w => w === 'supervisor_heartbeat_stale').length, 1);
});
