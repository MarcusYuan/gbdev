import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPipeline, pipelineCancel, pipelineCommand, pipelineResume } from '../src/commands/pipeline.js';
import { cleanup } from '../src/commands/cleanup.js';
import { LaneManager } from '../src/run/lanes.js';
import { head, git, worktreeListPorcelain } from '../src/core/git.js';
import { JobStore } from '../src/core/jobStore.js';
import { acquireLock } from '../src/core/lock.js';
import { allRuns, pipelinePaths, readRun } from '../src/pipeline/store.js';
import { supervisePipeline, type PipelineSlotHooks } from '../src/pipeline/supervisor.js';
import { fake } from '../src/providers/fake.js';
import { errorCode, job } from './helpers.js';
import { createJobId, JOB_ID_PATTERN } from '../src/core/ids.js';
import { runFixture, testEnv } from './helpers/run.js';
async function boundFixture(t: TestContext) {
  const f = runFixture(t), manager = new LaneManager(f), lane = await manager.create(1, f.base), branch = manager.start(lane, 'a', f.base).branch;
  testEnv(t, { GBDEV_FAKE_SCENARIO: 'ok', GBDEV_FAKE_PLAN: '' });
  // Test compilation lives in dist/src; invoke the same repository fake fixture.
  const build = fake.buildInvocation.bind(fake);
  t.mock.method(fake, 'buildInvocation', (...args: Parameters<typeof build>) => { const result = build(...args); result.args[0] = resolve('test/fixtures/fake-worker.js'); return result; });
  const request = { schema: 'gbdev.pipeline-request.v1', request_id: 'pr_bound', pipeline: { schema: 'gbdev.pipeline.v1', name: 'change-only', description: 'S2 bound test', steps: [{ id: 'implement', role: 'executor' }], timeout_min: 30 }, repo: f.repo, base_ref: f.base, diff_base_ref: null, goal: 'Bound change', context: '', constraints: [], allowed_paths: ['src/**'], acceptance_criteria: [], required_evidence: [], network: false, step_overrides: { implement: { provider: 'fake' } }, run_binding: { run_id: f.run_id, task_id: 'a', lane: lane.lane, worktree: lane.worktree, branch } };
  return { ...f, manager, lane, branch, request, store: new JobStore(f.paths) };
}
function callbacks(): PipelineSlotHooks & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async acquireSlot(provider) { calls.push(`acquire:${provider}`); }, releaseSlot(provider) { calls.push(`release:${provider}`); }, onRateLimit(provider) { calls.push(`cooldown:${provider}`); } };
}
test('run_binding waits before job creation outside global lock, uses lane without creating/detaching a worktree', async t => {
  const f = await boundFixture(t), hooks = callbacks();
  let permit!: () => void, acquired!: () => void;
  const waiting = new Promise<void>(resolve => { acquired = resolve; });
  hooks.acquireSlot = async provider => { hooks.calls.push(`acquire:${provider}`); acquired(); await new Promise<void>(resolve => { permit = resolve; }); };
  const execution = runPipeline(f.store, f.request, hooks); await waiting;
  assert.equal(existsSync(f.paths.jobs), false);
  const alias = join(f.root, 'lane-alias'); symlinkSync(f.lane.worktree, alias);
  await assert.rejects(runPipeline(f.store, { ...f.request, run_binding: { ...f.request.run_binding, worktree: alias } }, callbacks()), errorCode('busy'));
  const global = acquireLock(f.paths.lock); global.release();
  assert.equal(worktreeListPorcelain(f.repo).length, 2); permit();
  const result = await execution; assert.equal(result.state, 'succeeded'); assert.equal(result.workspace.mode, 'per_lane');
  assert.equal(result.integration!.run_id, f.run_id); assert.equal(result.integration!.merge_state, 'pending');
  assert.equal(result.workspace.worktree, f.lane.worktree); assert.equal(result.supervisor_pid, process.pid);
  assert.equal(git(f.lane.worktree, ['branch', '--show-current']).trim(), f.branch); assert.equal(worktreeListPorcelain(f.repo).length, 2); assert.equal(head(f.repo), f.base);
  assert.deepEqual(hooks.calls, ['acquire:fake', 'release:fake']);
  const job = f.store.read(result.steps[0]!.attempts[0]!.job_id); assert.equal(job.worktree, f.lane.worktree); assert.equal(job.branch, f.branch);
  await assert.rejects(pipelineCancel(f.store, result.pipeline_id), errorCode('pipeline_owned_by_run'));
  await assert.rejects(pipelineResume(f.store, result.pipeline_id, 'unused'), errorCode('pipeline_owned_by_run'));
  await assert.rejects(pipelineCommand(f.store, ['cleanup', result.pipeline_id], {}), errorCode('pipeline_owned_by_run'));
  await assert.rejects(cleanup(f.store, job.job_id), errorCode('job_owned_by_run'));
  assert.equal((await pipelineCommand(f.store, ['status', result.pipeline_id], {})).schema, 'gbdev.pipeline-run.v1');
});
test('bound pipeline requests slots separately for implement and review', async t => {
  const f = await boundFixture(t), hooks = callbacks(), plan = join(f.root, 'plan.json');
  writeFileSync(plan, JSON.stringify({ 'implement#1': 'ok', 'review#1': 'review_approve' })); testEnv(t, { GBDEV_FAKE_PLAN: plan });
  const result = await runPipeline(f.store, { ...f.request, pipeline: 'implement-review', step_overrides: { implement: { provider: 'fake' }, review: { provider: 'fake' }, fix: { provider: 'fake' } } }, hooks);
  assert.equal(result.state, 'succeeded'); assert.equal(result.jobs_used, 2); assert.deepEqual(hooks.calls, ['acquire:fake', 'release:fake', 'acquire:fake', 'release:fake']);
});
for (const repeat of [false, true]) test(`bound rate limit cools and retries at most once (repeat=${repeat})`, async t => {
  const f = await boundFixture(t), hooks = callbacks(); testEnv(t, { GBDEV_FAKE_SCENARIO: 'rate_limit' });
  hooks.onRateLimit = provider => { hooks.calls.push(`cooldown:${provider}`); if (!repeat) process.env.GBDEV_FAKE_SCENARIO = 'ok'; };
  const result = await runPipeline(f.store, f.request, hooks);
  assert.equal(result.jobs_used, 2); assert.equal(result.steps[0]!.attempts.length, 2); assert.equal(result.state, repeat ? 'needs_decision' : 'succeeded');
  assert.equal(hooks.calls.filter(c => c.startsWith('release')).length, 2); assert.equal(hooks.calls.filter(c => c.startsWith('cooldown')).length, repeat ? 2 : 1);
  assert.ok(result.warnings.includes('rate_limit_retry:implement#1'));
});
test('bound pipeline releases acquired slot when pre-job git validation fails', async t => {
  const f = await boundFixture(t), hooks = callbacks();
  hooks.acquireSlot = async provider => { hooks.calls.push(`acquire:${provider}`); git(f.lane.worktree, ['switch', '--detach', f.base]); };
  const result = await runPipeline(f.store, f.request, hooks); assert.equal(result.state, 'failed'); assert.equal(result.jobs_used, 0); assert.deepEqual(hooks.calls, ['acquire:fake', 'release:fake']);
});
test('bound cancellation while waiting aborts slot request, creates no job, releases no unowned slot', async t => {
  const f = await boundFixture(t), hooks = callbacks();
  hooks.acquireSlot = async (_provider, signal) => {
    const run = allRuns(f.store)[0]!; writeFileSync(pipelinePaths(f.store, run.pipeline_id).cancel, '{}');
    await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  };
  const result = await runPipeline(f.store, f.request, hooks); assert.equal(result.state, 'cancelled'); assert.equal(result.jobs_used, 0); assert.deepEqual(hooks.calls, []);
});
test('bound branch mismatch fails before publishing pipeline; missing hooks cannot execute a bound pipeline', async t => {
  const f = await boundFixture(t);
  await assert.rejects(runPipeline(f.store, { ...f.request, run_binding: { ...f.request.run_binding, branch: 'main' } }, callbacks()), errorCode('guard_violation'));
  assert.equal(existsSync(join(f.paths.home, 'pipelines')), false);
  const result = await runPipeline(f.store, f.request, callbacks());
  await assert.rejects(supervisePipeline(f.store, result.pipeline_id), errorCode('pipeline_owned_by_run'));
  assert.equal(readRun(f.store, result.pipeline_id).state, 'succeeded');
  assert.equal(readdirSync(f.paths.jobs).length, 1); assert.match(readFileSync(join(f.lane.worktree, 'src/ok.txt'), 'utf8'), /fake ok/);
});

test('two bound lanes share one callback-managed slot without duplicate worktree/job ownership', async t => {
  const f = await boundFixture(t), second = await f.manager.create(2, f.base), branch = f.manager.start(second, 'b', f.base).branch;
  let inUse = 0, maximum = 0, jobs = 0;
  const waiting: (() => void)[] = [];
  const hooks: PipelineSlotHooks = {
    async acquireSlot() {
      while (inUse) await new Promise<void>(resolve => waiting.push(resolve));
      inUse++; jobs++; maximum = Math.max(maximum, inUse);
    },
    releaseSlot() { inUse--; waiting.shift()?.(); },
    onRateLimit() { assert.fail('No rate limiting expected'); },
  };
  const results = await Promise.all([
    runPipeline(f.store, f.request, hooks),
    runPipeline(f.store, { ...f.request, request_id: 'pr_second', run_binding: { ...f.request.run_binding, task_id: 'b', lane: second.lane, branch, worktree: second.worktree } }, hooks),
  ]);
  assert.deepEqual(results.map(r => r.state), ['succeeded', 'succeeded']);
  assert.equal(maximum, 1); assert.equal(inUse, 0); assert.equal(jobs, 2);
  assert.equal(new Set(results.map(r => r.steps[0]!.attempts[0]!.job_id)).size, 2);
  assert.equal(worktreeListPorcelain(f.repo).length, 3); assert.equal(head(f.repo), f.base);
});
test('slot_starved warning is persisted while waiting, before creating a worker job', async t => {
  const f = await boundFixture(t), hooks = callbacks(), realTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => realTimer(callback, ms === 1_800_000 ? 1 : ms, ...args)) as typeof setTimeout);
  hooks.acquireSlot = async provider => {
    hooks.calls.push(`acquire:${provider}`);
    const until = Date.now() + 2000;
    while (!allRuns(f.store)[0]?.warnings.includes('slot_starved')) {
      if (Date.now() >= until) assert.fail('slot_starved warning missing');
      await new Promise(resolve => realTimer(resolve, 5));
    }
    assert.equal(existsSync(f.paths.jobs), false);
  };
  const result = await runPipeline(f.store, f.request, hooks);
  assert.equal(result.state, 'succeeded'); assert.ok(result.warnings.includes('slot_starved'));
  assert.deepEqual(hooks.calls, ['acquire:fake', 'release:fake']);
});


test('M3 fixture avoids same-minute Job already exists collisions without accepting duplicate jobs', t => {
  const f = runFixture(t), store = new JobStore(f.paths), minute = new Date(2026, 9, 29, 12, 0);
  // 1024 ordinary 16-bit draws would collide with overwhelming probability.
  // No wall-clock delay, retry-on-assertion, shared temp home, or weakened store guard.
  const ids = Array.from({ length: 1024 }, () => createJobId(minute));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, JOB_ID_PATTERN);
  const first = job(ids[0]!); store.create(first);
  const before = readFileSync(join(f.paths.jobs, first.job_id, 'job.json'), 'utf8');
  assert.throws(() => store.create(first), /Job already exists/);
  assert.equal(readFileSync(join(f.paths.jobs, first.job_id, 'job.json'), 'utf8'), before);
  store.create(job(ids.at(-1)!)); assert.equal(store.list().length, 2);
});
