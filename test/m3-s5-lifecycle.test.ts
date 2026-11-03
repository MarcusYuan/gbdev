import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './helpers/m3.js';
import { testEnv } from './helpers/run.js';
import { cleanupRun } from '../src/run/cleanup.js';
import { landRun } from '../src/run/land.js';
import { startRun, cancelRun } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { runCli } from '../src/cli.js';
import { git, head, isAncestor, worktreeListPorcelain, deleteRunBranchCas } from '../src/core/git.js';
import { readRun, runPaths } from '../src/run/store.js';
import { mergeRecords } from '../src/run/result.js';
import { GbdevError } from '../src/contracts/error.js';
import { acquireIntegrationLock } from '../src/run/integrationLock.js';
const reason = (value: string) => (e: unknown) => e instanceof GbdevError && e.contract.code === 'land_refused' && e.contract.details.reason === value;
const refs = (repo: string) => git(repo, ['show-ref']);

test('AC-S5.2 cleanup preserves unmerged task commits, removes merged branches and integration worktree; idempotent', async t => {
  const f = fixture(t); const { run } = await f.execute();
  git(f.repo, ['switch', '-c', `gbdev/${run.run_id}/t/a-r2`]); writeFileSync(join(f.repo, 'src/unmerged.txt'), 'evidence'); const unique = f.commit(f.repo, 'unmerged evidence'); git(f.repo, ['switch', 'main']);
  const before = refs(f.repo), dry = await cleanupRun(f.store, run.run_id, false, true); assert.equal(refs(f.repo), before); assert.ok(dry.worktrees.every(w => w.would_remove));
  const result = await cleanupRun(f.store, run.run_id);
  assert.ok(result.branches.find(b => b.branch.endsWith('/t/a-r2'))?.retained_reason === 'unmerged_task_commits');
  assert.equal(git(f.repo, ['rev-parse', `gbdev/${run.run_id}/t/a-r2`]).trim(), unique);
  assert.ok(run.tasks.every(t => result.branches.find(b => b.branch === t.branch)?.deleted));
  assert.ok(result.worktrees.every(w => w.removed)); assert.equal(existsSync(run.integration.worktree), false);
  assert.equal(result.branches.find(b => b.branch === run.integration.branch)?.retained_reason, 'unmerged_integration_commits');
  for (const task of run.tasks) for (const attempt of task.attempts) assert.ok(JSON.parse(readFileSync(join(f.paths.home, 'pipelines', attempt.pipeline_id, 'pipeline.json'), 'utf8')).cleanup);
  const again = await cleanupRun(f.store, run.run_id); assert.ok(again.worktrees.every(w => !w.removed)); assert.equal(git(f.repo, ['rev-parse', `gbdev/${run.run_id}/t/a-r2`]).trim(), unique);
  assert.ok(existsSync(runPaths(f.store, run.run_id).result));
});

test('cleanup retains dirty lanes and checked-out branches even with force; deletes unmerged refs only with force', async t => {
  const f = fixture(t), { run } = await f.execute(), lane = run.lanes[0]!;
  git(lane.worktree, ['switch', '-c', `gbdev/${run.run_id}/t/kept`]); writeFileSync(join(lane.worktree, 'src/dirty.txt'), 'keep');
  git(f.repo, ['switch', '-c', `gbdev/${run.run_id}/t/old-r2`]); writeFileSync(join(f.repo, 'src/old.txt'), 'unique'); f.commit(f.repo, 'old'); git(f.repo, ['switch', 'main']);
  const result = await cleanupRun(f.store, run.run_id, true);
  assert.equal(result.worktrees.find(w => w.path === lane.worktree)?.retained_reason, 'worktree_dirty');
  assert.equal(result.branches.find(b => b.branch.endsWith('/t/kept'))?.retained_reason, 'checked_out'); assert.ok(result.branches.find(b => b.branch.endsWith('/t/old-r2'))?.deleted); assert.ok(existsSync(join(lane.worktree, 'src/dirty.txt')));
});

test('cleanup rejects nonterminal and integration lock; guarded CAS never deletes other run or target', async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false);
  await assert.rejects(cleanupRun(f.store, run.run_id), e => e instanceof GbdevError && e.contract.code === 'run_not_terminal');
  await cancelRun(f.store, run.run_id); const lock = acquireIntegrationLock(f.paths, run.run_id, 'land');
  try { await assert.rejects(cleanupRun(f.store, run.run_id), e => e instanceof GbdevError && e.contract.code === 'integration_locked'); } finally { lock.release(); }
  assert.throws(() => deleteRunBranchCas({ paths: f.paths, repo: f.repo, run_id: run.run_id, branch: 'main', worktree: run.integration.worktree }, f.base), e => e instanceof GbdevError && e.contract.code === 'guard_violation');
  await cleanupRun(f.store, run.run_id); assert.equal(head(f.repo), f.base);
});

test('AC-S5.3 CLI land without approval returns user_approval_required exit 2 and refs unchanged', async t => {
  const f = fixture(t), { run } = await f.execute(); testEnv(t, { GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config });
  const before = refs(f.repo), state = readFileSync(runPaths(f.store, run.run_id).run, 'utf8'); let output = '';
  const code = await runCli(['run', 'land', run.run_id, '--target', 'main', '--json'], { stdout: s => { output += s; }, stderr: s => { output += s; } });
  assert.equal(code, 2); assert.match(output, /user_approval_required/); assert.equal(refs(f.repo), before); assert.equal(readFileSync(runPaths(f.store, run.run_id).run, 'utf8'), state);
});

test('AC-S5.4 target advances during run; land sync merge runs full gate union then ff; idempotent', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.request.checks.push({ id: 'ac', cmd: 'test ! -f src/target.txt || test -f src/a.txt', timeout_min: 1 }); f.request.tasks![0]!.acceptance_criteria[0]!.check = 'ac';
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { try { await cancelRun(f.store, initial.run_id); } finally { await work; } };
  await until(() => readRun(f.store, initial.run_id).state === 'running'); writeFileSync(join(f.repo, 'src/target.txt'), 'target advanced'); const target = f.commit(f.repo, 'external advance');
  await work; const run = readRun(f.store, initial.run_id); assert.equal(run.state, 'succeeded', JSON.stringify(run)); assert.equal(head(f.repo), target);
  const before = refs(f.repo), dry = await landRun(f.store, run.run_id, 'main', true, true); assert.ok('sync_required' in dry && dry.sync_required); assert.equal(refs(f.repo), before);
  const landed = await landRun(f.store, run.run_id, 'main', true, false, 'Approved in temporary test repo');
  assert.ok('landed_sha' in landed); const done = readRun(f.store, run.run_id); assert.equal(head(f.repo), done.integration.verified_sha); assert.ok(isAncestor(f.repo, target, head(f.repo)));
  const record = mergeRecords(f.store, done).at(-1)!; assert.equal(record.kind, 'sync'); assert.equal(record.pre_merge_sha, run.integration.verified_sha); assert.equal(record.gate?.passed, true); assert.deepEqual(record.gate.checks.map(c => c.id), ['test', 'ac']);
  assert.equal(done.land?.from_sha, target); assert.match(done.land!.approval_note!, /Approved/); assert.match(readFileSync(runPaths(f.store, run.run_id).events, 'utf8'), /landed/);
  assert.deepEqual(await landRun(f.store, run.run_id, 'main', true), landed);
  const result = await cleanupRun(f.store, run.run_id); assert.ok(result.branches.every(b => b.deleted)); assert.equal(worktreeListPorcelain(f.repo).length, 1);
});

test('AC-S5.4 dirty checked-out target rejected before any sync or ref mutation', async t => {
  const f = fixture(t), { run } = await f.execute(); writeFileSync(join(f.repo, 'src/new.txt'), 'advance'); f.commit(f.repo, 'advance'); writeFileSync(join(f.repo, 'src/base.txt'), 'dirty');
  const before = refs(f.repo); await assert.rejects(landRun(f.store, run.run_id, 'main', true, true), reason('target_is_checked_out_dirty')); assert.equal(refs(f.repo), before); await assert.rejects(landRun(f.store, run.run_id, 'main', true), reason('target_is_checked_out_dirty')); assert.equal(refs(f.repo), before); assert.equal(head(run.integration.worktree), run.integration.verified_sha); assert.equal(readFileSync(join(f.repo, 'src/base.txt'), 'utf8'), 'dirty');
});

test('land sync conflict leaves refs and evidence untouched', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/base.txt', content: 'task side' }] };
  const { run } = await f.execute(); writeFileSync(join(f.repo, 'src/base.txt'), 'target side'); f.commit(f.repo, 'target conflict'); const before = refs(f.repo);
  await assert.rejects(landRun(f.store, run.run_id, 'main', true), reason('sync_conflict')); assert.equal(refs(f.repo), before);
});

test('land sync gate failure rolls integration back, leaves target unchanged and records failed evidence', async t => {
  const f = fixture(t); f.request.checks[0]!.cmd = 'test ! -f src/reject.txt || { echo sync-rejected; exit 1; }'; const { run } = await f.execute(); writeFileSync(join(f.repo, 'src/reject.txt'), 'reject sync'); const target = f.commit(f.repo, 'bad target');
  await assert.rejects(landRun(f.store, run.run_id, 'main', true), e => { assert.ok(reason('gate_failed_on_sync')(e)); assert.match(JSON.stringify((e as GbdevError).contract.details.logs), /sync-rejected/); return true; });
  assert.equal(head(f.repo), target); assert.equal(head(run.integration.worktree), run.integration.verified_sha); const record = mergeRecords(f.store, run).at(-1)!; assert.equal(record.kind, 'sync'); assert.equal(record.result, 'rolled_back_gate_failed'); assert.equal(record.rolled_back_to, run.integration.verified_sha);
});

test('land rejects nonexistent, run namespace, symbolic targets and non-succeeded run', async t => {
  const f = fixture(t), { run } = await f.execute();
  git(f.repo, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/main']);
  for (const target of ['missing', run.integration.branch, 'alias', '--bad']) await assert.rejects(landRun(f.store, run.run_id, target, true), e => e instanceof GbdevError && e.contract.code === 'run_invalid');
  const other = await startRun(f.store, f.request, false); await assert.rejects(landRun(f.store, other.run_id, 'main', true), reason('run_not_succeeded')); await cancelRun(f.store, other.run_id);
});

test('land unchecked-out target uses CAS; after cleanup sync recreates integration worktree', async t => {
  const f = fixture(t), { run } = await f.execute(); await cleanupRun(f.store, run.run_id);
  writeFileSync(join(f.repo, 'src/target.txt'), 'advanced'); const target = f.commit(f.repo, 'advance'); git(f.repo, ['branch', 'delivery', target]);
  await landRun(f.store, run.run_id, 'delivery', true); const done = readRun(f.store, run.run_id); assert.equal(git(f.repo, ['rev-parse', 'delivery']).trim(), done.integration.verified_sha); assert.equal(head(f.repo), target); assert.ok(existsSync(done.integration.worktree));
});

test('land target moves during sync gate: CAS guard refuses and preserves externally moved target', async t => {
  const f = fixture(t); f.request.checks[0]!.cmd = 'test ! -f src/advance.txt || sleep 1'; const { run } = await f.execute(); writeFileSync(join(f.repo, 'src/advance.txt'), 'advance'); const target = f.commit(f.repo, 'advance'); git(f.repo, ['branch', 'delivery', target]);
  const landing = landRun(f.store, run.run_id, 'delivery', true); const observed = landing.then(() => null, e => e);
  await until(() => readFileSync(runPaths(f.store, run.run_id).events, 'utf8').includes('"kind":"sync"'));
  const moved = f.commit(f.repo, 'external later'); git(f.repo, ['update-ref', 'refs/heads/delivery', moved, target]);
  assert.ok(reason('target_moved')(await observed)); assert.equal(git(f.repo, ['rev-parse', 'delivery']).trim(), moved); assert.equal(readRun(f.store, run.run_id).integration.landed_sha, null);
});

test('land untracked target collision is refused by ff-only without losing user files', async t => {
  const f = fixture(t), { run } = await f.execute(); writeFileSync(join(f.repo, 'src/a.txt'), 'user untracked'); const before = refs(f.repo);
  await assert.rejects(landRun(f.store, run.run_id, 'main', true), reason('ff_failed')); assert.equal(refs(f.repo), before); assert.equal(readFileSync(join(f.repo, 'src/a.txt'), 'utf8'), 'user untracked');
});
