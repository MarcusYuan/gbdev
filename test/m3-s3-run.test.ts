import { findExecutable } from '../src/core/proc.js';
import { locked } from '../src/core/runtime.js';
import { acquireLock } from '../src/core/lock.js';
import { LaneManager } from '../src/run/lanes.js';
import { runGate } from '../src/run/gate.js';
import { openIntegration } from '../src/run/integration.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startRun, cancelRun, runCommand } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { activeRun, jsonFile, readRun, runPaths, writeRun } from '../src/run/store.js';
import { assertRunInvariants, runJobs } from '../src/run/invariants.js';
import { mergeRecords } from '../src/run/result.js';
import { DEFAULT_PARALLEL } from '../src/core/runConfig.js';
import { JobStore } from '../src/core/jobStore.js';
import { head, isAncestor } from '../src/core/git.js';
import { fake } from '../src/providers/fake.js';
import { validateRunResult, type RunResult } from '../src/contracts/runResult.js';
import { validateEvent } from '../src/contracts/event.js';
import type { RunRequest } from '../src/contracts/runRequest.js';
import { runFixture, testEnv } from './helpers/run.js';
import { errorCode } from './helpers.js';
import { isProcessAlive } from '../src/core/lock.js';
import { jobPaths } from '../src/core/paths.js';
import { assertReviewPrompt } from './helpers/reviewPrompt.js';
import { extractWorkerResult } from '../src/contracts/workerResult.js';
function fixture(t: TestContext) {
  const f = runFixture(t), store = new JobStore(f.paths), plan = join(f.root, 'fake-plan.json');
  testEnv(t, { GBDEV_FAKE_PLAN: plan, GBDEV_FAKE_SCENARIO: 'ok', GBDEV_TIMEOUT_SCALE: '60000' });
  const build = fake.buildInvocation.bind(fake);
  t.mock.method(fake, 'buildInvocation', (...args: Parameters<typeof build>) => { const v = build(...args); v.args[0] = resolve('test/fixtures/fake-worker.js'); return v; });
  const tasks = ['a', 'b'].map(id => ({ id, title: id, goal: `Implement ${id}`, context: '', depends_on: [] as string[], file_scope: [`src/${id}.txt`], acceptance_criteria: [{ id: 'AC1', text: 'works', check: null }], pipeline: null, size: 'S' as const, notes: null }));
  const request: RunRequest = { schema: 'gbdev.run-request.v1', request_id: 'test-run', repo: f.repo, base_ref: 'main', goal: 'Two changes', context: '', constraints: [], allowed_paths: ['src/**'], checks: [{ id: 'test', cmd: 'true', timeout_min: 1 }], integration_checks: ['test'], task_checks: [], acceptance_criteria: [], decompose: 'provided', tasks, lanes: 2, overlap_policy: 'serialize', default_task_pipeline: 'implement-review', task_pipeline_overrides: { implement: { provider: 'fake' }, review: { provider: 'fake' }, fix: { provider: 'fake' } }, final_review: 'none', worktree_setup_cmd: null, max_tasks: 12, max_total_jobs: 60, max_integration_fixes: 1, timeout_min: 60, network: false };
  const fakePlan: Record<string, unknown> = { 'a/implement#1': { sleep_ms: 200, actions: [{ type: 'write_file', path: 'src/a.txt', content: 'a\n' }] }, 'b/implement#1': { sleep_ms: 500, actions: [{ type: 'write_file', path: 'src/b.txt', content: 'b\n' }] }, 'review#1': 'review_approve', 'fix#1': { actions: [{ type: 'write_file', path: 'src/fixed.txt', content: 'fixed\n' }] }, 'run:final_review#1': 'review_approve' };
  const savePlan = () => writeFileSync(plan, JSON.stringify(fakePlan)); savePlan();
  const execute = async () => { savePlan(); const initial = await startRun(store, request, false); await superviseRun(store, initial.run_id); const run = readRun(store, initial.run_id); return { run, result: validateRunResult(jsonFile(runPaths(store, run.run_id).result)) }; };
  const invariants = (id: string) => { const run = readRun(store, id); assertRunInvariants(store, run, mergeRecords(store, run), DEFAULT_PARALLEL, { 'refs/heads/main': f.base }); };
  return { ...f, store, request, fakePlan, savePlan, execute, invariants };
}
async function until(condition: () => boolean, timeout = 45_000) { const end = Date.now() + timeout; while (!condition()) { if (Date.now() >= end) throw new Error('Test wait timed out'); await delay(20); } }
test('AC-S3.1 two fake tasks overlap on two lanes, serial clean merges and succeeded; F11 dispatch exactly once', async t => {
  const f = fixture(t);
  for (const method of ['start', 'park'] as const) {
    const original = LaneManager.prototype[method];
    t.mock.method(LaneManager.prototype, method, function (this: LaneManager, ...args: unknown[]) {
      const lock = acquireLock(f.paths.lock); lock.release();
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    });
  }
  const { run, result } = await f.execute();
  assert.equal(run.state, 'succeeded', JSON.stringify(run)); assert.equal(run.integration.merges, 2); assert.equal(result.outcome, 'integrated');
  const jobs = runJobs(f.store, run).filter(j => j.step_instance === 'implement#1');
  assert.equal(jobs.length, 2);
  const intervals = jobs.map(j => [Date.parse(j.state_history.find(h => h.state === 'running')!.at), Date.parse(j.state_history.find(h => h.state === 'succeeded')!.at)]);
  assert.ok(Math.max(...intervals.map(i => i[0]!)) < Math.min(...intervals.map(i => i[1]!)));
  const records = mergeRecords(f.store, run); assert.equal(records[1]!.pre_merge_sha, records[0]!.merge_sha);
  assert.ok(run.tasks.every(task => task.attempts.length === 1));
  const events = readFileSync(runPaths(f.store, run.run_id).events, 'utf8').trim().split('\n').map(l => validateEvent(JSON.parse(l)));
  for (const task of run.tasks) assert.equal(events.filter(e => e.task_id === task.task_id && e.type === 'task_state_change' && e.data.state === 'ready').length, 1);
  assert.ok(events.some(e => e.run_id === run.run_id && e.task_id === 'a' && e.lane));
  f.invariants(run.run_id); assert.equal(head(f.repo), f.base);
});
test('AC-S3.2 dependent task base includes dependency merge commit', async t => {
  const f = fixture(t); f.request.tasks![1]!.depends_on = ['a'];
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded', JSON.stringify(run));
  assert.ok(isAncestor(f.repo, run.tasks[0]!.merged_sha!, run.tasks[1]!.base_sha!));
  assert.equal(run.tasks[1]!.attempts.length, 1); f.invariants(run.run_id);
});
for (const exhausted of [false, true]) test(`AC-S3.3 semantic gate failure rollback then integration-fix; exhausted=${exhausted}`, async t => {
  const f = fixture(t);
  f.request.checks[0]!.cmd = 'test ! -f src/a.txt || test ! -f src/b.txt || test -f src/fixed.txt';
  if (exhausted) f.fakePlan['fix#1'] = 'fix_noop';
  const { run, result } = await f.execute();
  assert.equal(run.state, exhausted ? 'needs_decision' : 'succeeded', JSON.stringify(run));
  const records = mergeRecords(f.store, run), failed = records.find(r => r.result === 'rolled_back_gate_failed')!;
  assert.ok(failed); assert.equal(failed.rolled_back_to, failed.pre_merge_sha); assert.notEqual(failed.merge_sha, failed.pre_merge_sha);
  const task = run.tasks.find(t => t.task_id === failed.task_id)!;
  assert.equal(task.integration_fixes, 1); assert.equal(task.attempts[1]!.kind, 'integration_fix');
  const pipeline = jsonFile<{ base_sha: string }>(join(f.paths.home, 'pipelines', task.attempts[1]!.pipeline_id, 'pipeline.json'));
  assert.ok(isAncestor(f.repo, failed.pre_merge_sha, pipeline.base_sha));
  assert.ok(isAncestor(f.repo, failed.task_head_sha, pipeline.base_sha));
  const seed = jsonFile<{ seed_findings: { source: string; logs: unknown[] } }>(join(f.paths.home, 'pipelines', task.attempts[1]!.pipeline_id, 'request.json'));
  assert.equal(seed.seed_findings.source, 'integration_gate'); assert.ok(seed.seed_findings.logs.length);
  for (const job of runJobs(f.store, run).filter(j => j.pipeline_id === task.attempts[1]!.pipeline_id)) {
    const prompt = readFileSync(jobPaths(f.paths, job.job_id).prompt, 'utf8');
    assert.ok(extractWorkerResult(prompt).handoff);
    if (job.role === 'reviewer') assertReviewPrompt(prompt);
  }
  if (exhausted) { assert.equal(task.state, 'needs_decision'); assert.equal(run.attention[0]!.reason, 'integration_gate_failed'); assert.equal(run.integration.verified_sha, failed.pre_merge_sha); }
  assert.equal(result.merges.length, 3);
  assert.equal(result.merges.filter(m => m.result === 'integrated').length, exhausted ? 1 : 2); f.invariants(run.run_id);
});
test('AC-S3.4 cancel during post-merge gate restores verified SHA and I1', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  f.request.checks[0]!.cmd = 'test ! -f src/a.txt || sleep 30'; f.savePlan();
  const initial = await startRun(f.store, f.request, false), execution = superviseRun(f.store, initial.run_id);
  cleanup = async () => { if (activeRun(readRun(f.store, initial.run_id).state)) await cancelRun(f.store, initial.run_id); await execution; };
  await until(() => readRun(f.store, initial.run_id).integration.merging?.phase === 'gating');
  const during = readRun(f.store, initial.run_id); assert.notEqual(during.integration.head_sha, during.integration.verified_sha);
  const cancelled = await cancelRun(f.store, initial.run_id); await execution;
  assert.equal(cancelled.state, 'cancelled'); assert.equal(head(cancelled.integration.worktree), cancelled.integration.verified_sha);
  assert.equal(mergeRecords(f.store, cancelled)[0]!.result, 'aborted_cancelled'); f.invariants(initial.run_id);
});
for (const verdict of ['review_approve', 'review_revise', 'review_reject', 'review_no_verdict']) test(`final reviewer fake ${verdict}`, async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.final_review = 'reviewer';
  f.fakePlan['run:final_review#1'] = verdict; f.fakePlan['run:final_review#2'] = verdict;
  const { run, result } = await f.execute();
  assert.equal(run.state, verdict === 'review_approve' ? 'succeeded' : 'needs_decision', JSON.stringify(run));
  assert.ok(result.final_review); assert.equal(runJobs(f.store, run).filter(j => j.step_instance?.startsWith('run:')).length, ['review_no_verdict', 'review_reject'].includes(verdict) ? 2 : 1); f.invariants(run.run_id);
});
test('baseline failure never starts lanes; result has log evidence', async t => {
  const f = fixture(t); f.request.checks[0]!.cmd = 'echo baseline-broken; exit 3';
  const { run } = await f.execute(); assert.equal(run.state, 'failed'); assert.equal(run.failure_reason, 'baseline_checks_failed'); assert.equal(run.lanes.length, 0);
  assert.match(readFileSync(join(runPaths(f.store, run.run_id).dir, 'baseline.gate/test.log'), 'utf8'), /baseline-broken/); f.invariants(run.run_id);
});
test('run command validation, not-settled and wait timeout retain M1 error semantics', async t => {
  const f = fixture(t);
  const planned = await startRun(f.store, { ...f.request, decompose: 'planner', tasks: null }, false, true);
  assert.equal(planned.plan.source, 'planner'); assert.equal(planned.tasks.length, 0);
  await assert.rejects(startRun(f.store, { ...f.request, task_pipeline_overrides: { review: { cursor_model: 'not-auto' } } }), errorCode('cursor_model_not_allowed'));
  assert.equal(existsSync(f.paths.home), false);
  const run = await startRun(f.store, f.request, false);
  await assert.rejects(startRun(f.store, f.request, false), errorCode('busy'));
  await assert.rejects(runCommand(f.store, ['result', run.run_id], {}), errorCode('run_not_settled'));
  await assert.rejects(runCommand(f.store, ['wait', run.run_id], { 'timeout-ms': '0' }), e => { assert.equal((e as { contract: { details: { run: { run_id: string } } } }).contract.details.run.run_id, run.run_id); return errorCode('wait_timeout')(e); });
  const cancelled = await cancelRun(f.store, run.run_id); assert.equal(cancelled.state, 'cancelled');
  assert.equal((await cancelRun(f.store, run.run_id)).state, 'cancelled');
});
test('detached __run-supervise starts and exits reliably, wait --with-result returns run-result', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  // Dist/src CLI uses a different relative fake fixture path, so test the production build CLI.
  const { spawnSync } = await import('node:child_process');
  const file = join(f.root, 'request.json'); writeFileSync(file, JSON.stringify(f.request));
  const env = { ...process.env, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config };
  const child = spawnSync(process.execPath, [resolve('dist/cli.js'), 'run', 'start', '--request', file, '--json'], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const envelope = JSON.parse(child.stdout); assert.equal(envelope.contract_version, '1');
  const id = envelope.result.run_id as string, pid = envelope.result.supervisor_pid as number;
  cleanup = async () => { await cancelRun(f.store, id); await until(() => !isProcessAlive(pid)); };
  const waited = await runCommand(f.store, ['wait', id], { 'timeout-ms': '60000', 'until': 'settled', 'with-result': true });
  assert.equal(waited.schema, 'gbdev.run-result.v1'); assert.equal((waited.result as RunResult).state, 'succeeded', readFileSync(runPaths(f.store, id).log, 'utf8'));
  await until(() => !isProcessAlive(pid)); f.invariants(id);
});
test('I1-I7 each reject corrupted runtime evidence', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded');
  const records = mergeRecords(f.store, run), check = (r = run, merges = records, refs = { 'refs/heads/main': f.base }) => assertRunInvariants(f.store, r, merges, DEFAULT_PARALLEL, refs);
  writeFileSync(join(run.integration.worktree, 'src/a.txt'), 'dirty'); assert.throws(() => check(), /I1/);
  writeFileSync(join(run.integration.worktree, 'src/a.txt'), 'a\n'); check();
  assert.throws(() => check(run, []), /I2/);
  const i3 = structuredClone(run); i3.tasks[0]!.state = 'ready'; assert.throws(() => check(i3), /I3/);
  const i4 = structuredClone(run); i4.lanes[0]!.state = 'busy'; assert.throws(() => check(i4), /I4/);
  const i5 = structuredClone(run); i5.slots.in_use = 1; assert.throws(() => check(i5), /I5/);
  assert.throws(() => check(run, records, { 'refs/heads/main': '0'.repeat(40) }), /I6/);
  const read = f.store.read.bind(f.store); const mock = t.mock.method(f.store, 'read', (id: string) => ({ ...read(id), worktree: f.repo }));
  assert.throws(() => check(), /I7/); mock.mock.restore(); check();
});
test('dry-run does not write; roles/providers are pinned before supervisor starts; status events and attention wait', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  const preview = await startRun(f.store, f.request, false, true); assert.equal(preview.state, 'queued'); assert.equal(existsSync(f.paths.home), false);
  const initial = await startRun(f.store, f.request, false);
  writeFileSync(f.paths.config, JSON.stringify({ version: 1, allowed_repos: [], providers: { codex: { bin: 'missing' }, cursor: { bin: 'missing' } } }));
  await superviseRun(f.store, initial.run_id);
  const run = readRun(f.store, initial.run_id); assert.equal(run.state, 'succeeded', JSON.stringify(run));
  const events = await runCommand(f.store, ['status', run.run_id], { events: true, since: '2' });
  assert.ok((events.result as { seq: number }[]).every(e => e.seq > 2));
  assert.equal((await runCommand(f.store, ['wait', run.run_id], { 'timeout-ms': '0' })).schema, 'gbdev.run.v1');
  f.invariants(run.run_id);
});
test('post-merge gate retries once, records flaky warning and cleans only nonignored untracked files', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  f.request.checks[0]!.cmd = 'mkdir -p cache; touch gate-untracked; test ! -f src/a.txt || test -f cache/retried || { touch cache/retried; exit 1; }';
  const { run, result } = await f.execute(); assert.equal(run.state, 'succeeded', JSON.stringify(run));
  assert.ok(result.warnings.includes('flaky_suspected')); assert.ok(result.warnings.includes('gate_left_untracked'));
  assert.equal(existsSync(join(run.integration.worktree, 'gate-untracked')), false); assert.equal(existsSync(join(run.integration.worktree, 'cache/retried')), true);
  assert.equal(mergeRecords(f.store, run)[0]!.gate!.checks.length, 2); f.invariants(run.run_id);
});
test('gate tracked mutation rolls back even with exit zero; no ignoring a failed gate', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.max_integration_fixes = 0;
  f.request.checks[0]!.cmd = 'test ! -f src/a.txt || echo tampered > src/a.txt';
  const { run, result } = await f.execute(); assert.equal(run.state, 'needs_decision'); assert.ok(result.warnings.includes('gate_modified_worktree'));
  assert.equal(run.integration.verified_sha, f.base); assert.deepEqual(run.attention[0]!.allowed_actions, ['extra_fix', 'rebuild_task', 'drop_task']); f.invariants(run.run_id);
});
test('cancel live fake workers stops child groups and releases slots', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.fakePlan['a/implement#1'] = 'slow'; f.fakePlan['b/implement#1'] = 'slow'; f.savePlan();
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { await cancelRun(f.store, initial.run_id); await work; };
  await until(() => runJobs(f.store, readRun(f.store, initial.run_id)).filter(j => j.state === 'running').length === 2);
  const run = await cancelRun(f.store, initial.run_id); await work;
  assert.equal(run.state, 'cancelled'); assert.equal(run.slots.in_use, 0); assert.ok(runJobs(f.store, run).every(j => j.state === 'cancelled')); f.invariants(run.run_id);
});
test('post-merge check union is ordered and deduplicated including previously integrated and run ACs', async t => {
  const f = fixture(t);
  f.request.checks = ['test', 'a-check', 'b-check', 'run-check'].map(id => ({ id, cmd: 'true', timeout_min: 1 }));
  f.request.acceptance_criteria = [{ id: 'R1', text: 'run AC', check: 'run-check' }, { id: 'R2', text: 'duplicate', check: 'test' }];
  for (const task of f.request.tasks!) task.acceptance_criteria = [{ id: 'T1', text: 'task AC', check: `${task.id}-check` }];
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded', JSON.stringify(run));
  const [first, second] = mergeRecords(f.store, run);
  assert.deepEqual(first!.gate!.checks.map(c => c.id), ['test', `${first!.task_id}-check`, 'run-check']);
  assert.deepEqual(second!.gate!.checks.map(c => c.id), ['test', `${second!.task_id}-check`, `${first!.task_id}-check`, 'run-check']); f.invariants(run.run_id);
});
test('gate whole-timeout kills command group without retry', async t => {
  const f = fixture(t), integration = await openIntegration(f, f.base);
  f.request.checks[0]!.cmd = 'sleep 30';
  const started = Date.now();
  const result = await runGate({ ...f, branch: integration.branch, worktree: integration.worktree }, f.request, ['test'], join(f.root, 'timeout-gate'), new AbortController().signal, 50);
  assert.equal(result.gate.passed, false); assert.equal(result.gate.checks.length, 1); assert.ok(Date.now() - started < 3000);
});
test('cancel during worktree setup terminates setup and returns cancelled', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.request.worktree_setup_cmd = 'sleep 30';
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { await cancelRun(f.store, initial.run_id); await work; };
  await until(() => existsSync(join(runPaths(f.store, initial.run_id).dir, 'setup-integration.log')));
  const cancelled = await cancelRun(f.store, initial.run_id); await work;
  assert.equal(cancelled.state, 'cancelled'); f.invariants(initial.run_id);
});
test('final reviewer readonly violation restores verified integration and fails safely', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.final_review = 'reviewer'; f.fakePlan['run:final_review#1'] = 'readonly_violation';
  const { run } = await f.execute(); assert.equal(run.state, 'failed', JSON.stringify(run)); assert.equal(run.failure_reason, 'integration_corrupt'); f.invariants(run.run_id);
});
test('cancel without supervisor restores dirty unverified integration, never the target branch', async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false);
  run.integration = await openIntegration({ ...f, run_id: run.run_id }, run.base_sha);
  writeFileSync(join(run.integration.worktree, 'src/unverified.txt'), 'unverified');
  f.commit(run.integration.worktree, 'unverified');
  writeFileSync(join(run.integration.worktree, 'untracked'), 'untracked'); writeRun(f.store, run);
  const cancelled = await cancelRun(f.store, run.run_id); assert.equal(cancelled.state, 'cancelled'); assert.equal(head(cancelled.integration.worktree), f.base); f.invariants(run.run_id);
});
test('F13 runtime I1 violation emits invariant event and cancel-only integration_corrupt attention', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = 'slow'; f.savePlan();
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { await cancelRun(f.store, initial.run_id); await work; };
  await until(() => readRun(f.store, initial.run_id).state === 'running');
  writeFileSync(join(initial.integration.worktree, 'untracked'), 'invariant evidence');
  await work; const run = readRun(f.store, initial.run_id);
  assert.equal(run.state, 'needs_decision', JSON.stringify(run)); assert.ok(run.tasks.every(t => t.state !== 'cancelled')); assert.equal(run.attention[0]!.reason, 'integration_corrupt'); assert.deepEqual(run.attention[0]!.allowed_actions, []);
  assert.match(readFileSync(runPaths(f.store, run.run_id).events, 'utf8'), /invariant_violation/); f.invariants(run.run_id);
});
test('attention pauses only its task; independent lane continues and wait attention returns while running', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.fakePlan['a/implement#1'] = 'blocked';
  f.fakePlan['b/implement#1'] = { sleep_ms: 4000, actions: [{ type: 'write_file', path: 'src/b.txt', content: 'b\n' }] }; f.savePlan();
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { await cancelRun(f.store, initial.run_id); await work; };
  const noticed = await runCommand(f.store, ['wait', initial.run_id], { 'timeout-ms': '60000' });
  assert.equal((noticed.result as { state: string }).state, 'running');
  await work; const run = readRun(f.store, initial.run_id);
  assert.equal(run.state, 'needs_decision'); assert.equal(run.tasks[0]!.state, 'paused'); assert.equal(run.tasks[1]!.state, 'integrated'); f.invariants(run.run_id);
});

test('synchronous global transactions release before unrelated microtasks', async t => {
  const f = fixture(t);
  const operation = locked(f.store, () => 'published');
  const lock = acquireLock(f.paths.lock); lock.release();
  assert.equal(await operation, 'published');
});
test('AC-S3.4 cancel inside the running git merge subprocess kills its group and restores I1', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  const realGit = findExecutable('git')!, bin = join(f.root, 'bin'), marker = join(f.root, 'merge-running'); mkdirSync(bin);
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$2" in */integration) case " $* " in *" merge --no-ff "*) echo waiting > ${quote(marker)}; sleep 30;; esac;; esac\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
  testEnv(t, { PATH: `${bin}:${process.env.PATH}` });
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { await cancelRun(f.store, initial.run_id); await work; };
  await until(() => existsSync(marker)); assert.equal(readRun(f.store, initial.run_id).integration.merging?.phase, 'merging');
  const started = Date.now(), cancelled = await cancelRun(f.store, initial.run_id); await work;
  assert.equal(cancelled.state, 'cancelled'); assert.ok(Date.now() - started < 5000);
  assert.equal(mergeRecords(f.store, cancelled)[0]!.result, 'aborted_cancelled'); f.invariants(initial.run_id);
});
