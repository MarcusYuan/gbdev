import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { GbdevError } from '../src/contracts/error.js';
import { TASK_STATES, type Run } from '../src/contracts/run.js';
import { JobStore } from '../src/core/jobStore.js';
import { addDetachedWorktree } from '../src/core/git.js';
import { localIso } from '../src/core/time.js';
import { cleanupInspectWorktree } from '../src/inspect/lifecycle.js';
import { resolveInspectTarget } from '../src/inspect/target.js';
import { reconcile } from '../src/commands/status.js';
import { locked } from '../src/core/runtime.js';
import { reclaimDeadInspectLease } from '../src/core/workerReservations.js';
import { jobPaths, resolvePaths, inspectLeasePath } from '../src/core/paths.js';
import { eventually, tmpRepo } from './helpers/tmpRepo.js';
import { writeRun } from '../src/run/store.js';
import { job } from './helpers.js';
import { runFixture } from './helpers/run.js';

function minimalRun(repo: string, sha: string, tasks: Run['tasks'] = []): Run {
  const at = localIso();
  const progress = Object.fromEntries(['total', ...TASK_STATES.filter(state => state !== 'cancelled')].map(key => [key, 0])) as Run['progress'];
  return {
    schema: 'gbdev.run.v1', run_id: 'r_20261031_1203_ab12', state: 'running', state_reason: null, outcome: null, failure_reason: null,
    repo, base_ref: 'main', base_sha: sha, executor_host: 'local',
    lanes: [{ lane: 'lane-1', host: 'local', state: 'idle', worktree: repo, task_id: null, branch: null, pipeline_id: null, tasks_done: 0 }],
    integration: { branch: 'gbdev/r_20261031_1203_ab12/integration', worktree: repo, verified_sha: sha, head_sha: sha, merging: null, merges: 0, rollbacks: 0, target_branch: null, landed_sha: null, approved_by_user_at: null },
    tasks, progress, merge_queue: [], attention: [],
    slots: { max_workers: 1, in_use: 0, by_provider: { codex: 0, cursor: 0 }, cooldown_until: {} },
    budget: { jobs_used: 0, max_total_jobs: 60, max_tasks: 12, extended: false },
    plan: { source: 'provided', approved_at: null, approved_by: null, plan_attempts: 0 },
    supervisor_pid: null, heartbeat_at: null, created_at: at, updated_at: at, deadline_at: at,
    state_history: [{ state: 'running', at, by: 'test', reason: null }], warnings: [],
  };
}

test('detached inspect worktrees are removed without deleting refs', t => {
  const fx = runFixture(t);
  const store = new JobStore(fx.paths);
  const snapshot = join(fx.root, 'snapshot');
  addDetachedWorktree(fx.repo, snapshot, fx.base);
  fx.commit(fx.repo, 'later');
  const branch = 'gbdev/j_20261031_1203_ab12';
  writeFileSync(join(fx.repo, 'src', 'keep.txt'), 'keep\n');
  const tip = fx.commit(fx.repo, 'keep');
  const git = (...args: string[]) => execFileSync('git', ['-C', fx.repo, ...args], { encoding: 'utf8' });
  git('branch', branch, tip);
  assert.equal(existsSync(snapshot), true);
  cleanupInspectWorktree(fx.repo, snapshot);
  assert.equal(existsSync(snapshot), false);
  assert.equal(git('show-ref', '--verify', `refs/heads/${branch}`).includes(tip), true);
  cleanupInspectWorktree(fx.repo, snapshot);
  assert.equal(git('show-ref', '--verify', `refs/heads/${branch}`).includes(tip), true);
  const run = minimalRun(fx.repo, fx.base);
  mkdirSync(join(fx.paths.home, 'runs', run.run_id), { recursive: true });
  writeRun(store, run);
  const resolved = resolveInspectTarget(store, run.run_id);
  assert.equal(resolved.target.kind, 'run');
  assert.equal(resolved.target_sha, fx.base);
  assert.equal(resolved.diff_base_sha, fx.base);
  assert.equal(resolved.warnings.includes('uncommitted_excluded'), true);
  assert.throws(() => resolveInspectTarget(store, run.run_id, 'missing'), (error: GbdevError) => error.contract.details.reason === 'task_not_found');
  run.tasks.push({ task_id: 'alpha', state: 'pending', lane: null, branch: null, depends_on: [], attempts: [], head_sha: null, base_sha: null, merge_seq: [], merged_sha: null, integration_fixes: 0, scope_exceeded: [], decision_id: null });
  writeRun(store, run);
  assert.throws(() => resolveInspectTarget(store, run.run_id, 'alpha'), (error: GbdevError) => error.contract.details.reason === 'no_attempt');
  const missing = job('j_20261031_1203_ab12');
  missing.repo = fx.repo;
  missing.base_sha = '0'.repeat(40);
  missing.state = 'running';
  missing.state_history.push({ state: 'running', at: missing.updated_at, by: 'test' });
  store.create(missing);
  assert.throws(() => resolveInspectTarget(store, missing.job_id), (error: GbdevError) => error.contract.details.reason === 'object_missing');
  const inspect = job('j_20261031_1203_ab13');
  inspect.repo = fx.repo;
  inspect.base_sha = fx.base;
  inspect.kind = 'inspect';
  inspect.role = 'inspector';
  inspect.sandbox = 'read-only';
  inspect.inspection = {
    workspace_owned: true, detached: true, question: 'q', paths: [], diff: false, tests: false,
    target: { kind: 'job', id: missing.job_id, run_id: null, task_id: null, job_id: missing.job_id, pipeline_id: null },
    snapshot: { mode: 'committed', target_sha: fx.base, diff_base_sha: fx.base, captured_at: localIso(), uncommitted_included: false },
  };
  store.create(inspect);
  assert.throws(() => resolveInspectTarget(store, inspect.job_id), (error: GbdevError) => error.contract.details.reason === 'recursive_inspect');
  assert.throws(() => resolveInspectTarget(store, inspect.job_id, 'alpha'), (error: GbdevError) => error.contract.code === 'usage_error');
  mkdirSync(join(fx.paths.home, 'jobs', 'not-a-job'), { recursive: true });
  assert.throws(() => resolveInspectTarget(store, 'not-a-job'), (error: GbdevError) => error.contract.details.reason === 'unknown_id');
});


for (const action of ['cancel', 'timeout', 'crash'] as const) test(`AC-30 inspect ${action} releases only itself; frozen parent job/run bytes are unchanged`, async t => {
  const fx = tmpRepo(t, 'ok');
  mkdirSync(join(fx.root, 'roles'), { recursive: true });
  writeFileSync(join(fx.root, 'roles', 'inspector.json'), JSON.stringify({ schema: 'gbdev.role.v1', name: 'inspector', provider: 'fake', default_timeout_min: 1 }));
  const parent = await fx.launch(); await fx.wait(parent.job_id);
  const store = new JobStore(resolvePaths(fx.env));
  const run = minimalRun(fx.repo, fx.getJob(parent.job_id).base_sha);
  mkdirSync(join(fx.home, 'runs', run.run_id), { recursive: true }); writeRun(store, run);
  const parentFiles = [join(fx.jobDir(parent.job_id), 'job.json'), join(fx.jobDir(parent.job_id), 'result.json'), join(fx.home, 'runs', run.run_id, 'run.json')];
  const before = parentFiles.map(path => readFileSync(path));
  fx.env.GBDEV_FAKE_SCENARIO = 'inspect_hold';
  if (action === 'timeout') fx.env.GBDEV_TIMEOUT_SCALE = '1500';
  const output = await fx.command(['inspect', run.run_id, '--question', 'Read verified snapshot']);
  assert.equal(output.envelope.ok, true); if (!output.envelope.ok) return;
  const id = (output.envelope.result as { job_id: string }).job_id;
  await eventually(() => existsSync(join(fx.jobDir(id), 'fake-processes.json')) ? true : undefined);
  const info = JSON.parse(readFileSync(join(fx.jobDir(id), 'process.json'), 'utf8')) as { supervisor_pid: number; worker_pgid: number };
  const lease = JSON.parse(readFileSync(join(fx.home, 'inspect', 'lease.json'), 'utf8'));
  assert.equal(lease.supervisor_pid, info.supervisor_pid); assert.equal(lease.worker_pgid, info.worker_pgid);
  if (action === 'cancel') await fx.command(['cancel', id]);
  if (action === 'crash') process.kill(info.supervisor_pid, 'SIGKILL');
  const terminal = await fx.wait(id);
  assert.equal(terminal.state, action === 'crash' ? 'failed' : action === 'cancel' ? 'cancelled' : 'timeout');
  assert.equal(existsSync(join(fx.home, 'inspect', 'lease.json')), false);
  assert.throws(() => process.kill(info.worker_pgid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  parentFiles.forEach((path, i) => assert.deepEqual(readFileSync(path), before[i]));
});

test('AC-30 parent cancellation and cleanup do not kill its independent inspect', async t => {
  const fx = tmpRepo(t, 'inspect_hold', { acceptance_criteria: [] });
  mkdirSync(join(fx.root, 'roles'), { recursive: true });
  writeFileSync(join(fx.root, 'roles', 'inspector.json'), JSON.stringify({ schema: 'gbdev.role.v1', name: 'inspector', provider: 'fake' }));
  const parent = await fx.launch();
  await eventually(() => fx.getJob(parent.job_id).state === 'running' ? true : undefined);
  const output = await fx.command(['inspect', parent.job_id, '--question', 'Remain independent']);
  assert.equal(output.envelope.ok, true); if (!output.envelope.ok) return;
  const id = (output.envelope.result as { job_id: string }).job_id;
  await eventually(() => fx.getJob(id).state === 'running' ? true : undefined);
  const before = readFileSync(join(fx.jobDir(id), 'job.json'));
  await fx.command(['cancel', parent.job_id]);
  const cleaned = await fx.command(['cleanup', parent.job_id]); assert.equal(cleaned.envelope.ok, true);
  assert.deepEqual(readFileSync(join(fx.jobDir(id), 'job.json')), before);
  const info = JSON.parse(readFileSync(join(fx.jobDir(id), 'process.json'), 'utf8'));
  process.kill(info.worker_pgid, 0);
  await fx.command(['cancel', id]);
  assert.equal(existsSync(join(fx.home, 'inspect', 'lease.json')), false);
});

test('AC-30 stale status PID and reused live supervisor/group identities are not reclaimed', async t => {
  const fx = runFixture(t), store = new JobStore(fx.paths);
  const status = job('j_20261031_1203_affe');
  status.kind = 'inspect'; status.repo = fx.repo; status.worktree = fx.repo; status.base_sha = fx.base;
  status.role = 'inspector'; status.sandbox = 'read-only'; status.state = 'running'; status.pid = 2147483646;
  status.state_history.push({ state: 'running', at: status.updated_at, by: 'test' });
  status.inspection = { workspace_owned: true, detached: true, question: 'q', paths: [], diff: false, tests: false,
    target: { kind: 'job', id: 'j_20261031_1203_aaaa', job_id: 'j_20261031_1203_aaaa', run_id: null, task_id: null, pipeline_id: null },
    snapshot: { mode: 'committed', target_sha: fx.base, diff_base_sha: fx.base, captured_at: localIso(), uncommitted_included: false } };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  writeFileSync(paths.processInfo, JSON.stringify({ supervisor_pid: 42420, worker_pgid: 42421 }));
  mkdirSync(join(fx.paths.home, 'inspect'), { recursive: true });
  writeFileSync(inspectLeasePath(fx.paths), JSON.stringify({ job_id: status.job_id, provider: 'fake', supervisor_pid: 42420, worker_pgid: 42421, started_at: status.created_at }));
  const before = readFileSync(paths.job);
  // Inject a reused/live PID. No destructive signal may be sent based on stale status.pid.
  let supervisorLive = true;
  t.mock.method(process, 'kill', (pid: number, signal: number | string) => {
    assert.equal(signal, 0, 'identity uncertainty must not send a termination signal');
    if (pid === 42420 && supervisorLive || pid === -42421) return true;
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  await reconcile(store, status.job_id);
  await locked(store, () => reclaimDeadInspectLease(store));
  supervisorLive = false; // A residual or reused group still prevents premature release.
  await locked(store, () => reclaimDeadInspectLease(store));
  assert.deepEqual(readFileSync(paths.job), before);
  assert.equal(existsSync(inspectLeasePath(fx.paths)), true);
});


test('AC-20/21 reused lane retains recorded job/task SHA and merging run exposes only verified SHA', t => {
  const fx = runFixture(t), store = new JobStore(fx.paths);
  writeFileSync(join(fx.repo, 'src', 'history.txt'), 'historical content\nsecond line\n');
  const historical = fx.commit(fx.repo, 'task alpha');
  const run = minimalRun(fx.repo, fx.base);
  const pipelineId = 'p_20261031_1203_ab12';
  const pipelineDir = join(fx.paths.home, 'pipelines', pipelineId); mkdirSync(pipelineDir, { recursive: true });
  writeFileSync(join(pipelineDir, 'pipeline.json'), JSON.stringify({
    schema: 'gbdev.pipeline-run.v1', pipeline_id: pipelineId, state: 'succeeded', repo: fx.repo,
    workspace: { mode: 'shared_run_worktree', worktree: fx.repo, branch: 'main' }, integration: null,
    base_sha: fx.base, diff_base_sha: fx.base, head_sha: historical, steps: [], state_history: [], pending_questions: [], warnings: [], jobs_used: 1, created_at: localIso(),
  }));
  const parent = job('j_20261031_1203_ab15'); parent.repo = fx.repo; parent.worktree = fx.repo; parent.base_sha = fx.base;
  parent.pipeline_id = pipelineId; parent.state = 'succeeded'; parent.state_history.push({ state: 'succeeded', at: parent.updated_at, by: 'test' });
  store.create(parent); writeFileSync(jobPaths(fx.paths, parent.job_id).result, JSON.stringify({ gbdev_observed: { head_after: historical } }));
  run.tasks.push({ task_id: 'alpha', state: 'integrated', lane: 'lane-1', branch: 'main', depends_on: [],
    attempts: [{ pipeline_id: pipelineId, kind: 'initial', state: 'succeeded', outcome: 'completed' }],
    head_sha: historical, base_sha: fx.base, merge_seq: [], merged_sha: historical, integration_fixes: 0, scope_exceeded: [], decision_id: null });
  writeFileSync(join(fx.repo, 'src', 'history.txt'), 'LANE_REUSED_SENTINEL\n');
  const reused = fx.commit(fx.repo, 'task beta reuses lane');
  run.integration.verified_sha = historical; run.integration.head_sha = reused;
  run.integration.merging = { seq: 1, task_id: 'beta', phase: 'gating', started_at: localIso() };
  mkdirSync(join(fx.paths.home, 'runs', run.run_id), { recursive: true }); writeRun(store, run);
  for (const resolved of [resolveInspectTarget(store, parent.job_id), resolveInspectTarget(store, run.run_id, 'alpha'), resolveInspectTarget(store, run.run_id)]) {
    assert.equal(resolved.target_sha, historical); assert.equal(resolved.diff_base_sha, fx.base);
    const snapshot = join(fx.root, `history-${resolved.target.job_id ?? resolved.target.task_id ?? 'run'}`);
    addDetachedWorktree(fx.repo, snapshot, resolved.target_sha);
    assert.equal(readFileSync(join(snapshot, 'src', 'history.txt'), 'utf8'), 'historical content\nsecond line\n');
    cleanupInspectWorktree(fx.repo, snapshot);
  }
});
