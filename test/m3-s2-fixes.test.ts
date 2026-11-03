import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkerResultSchema } from '../src/contracts/workerResultSchema.js';
import { codexNullable, closed, enumeration, schemaErrors, type JsonSchema } from '../src/contracts/runValidation.js';
import { taskGraphSchema, validateTaskGraph } from '../src/contracts/taskGraph.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { addWorktree, FULL_SHA, git, gitGuarded, head, mergeNoCommit, mergeNoFf, resetHard, switchCreate, updateRefCas } from '../src/core/git.js';
import { GbdevError } from '../src/contracts/error.js';
import { validateParallel } from '../src/core/runConfig.js';
import { errorCode, worker } from './helpers.js';
import { runFixture } from './helpers/run.js';
function strict(schema: unknown): void {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as JsonSchema;
  for (const key of ['anyOf', 'oneOf', 'allOf']) assert.equal(Object.hasOwn(s, key), false, key);
  if (s.type === 'object' || Array.isArray(s.type) && s.type.includes('object')) { assert.equal(s.additionalProperties, false); assert.deepEqual(s.required, Object.keys(s.properties!)); }
  Object.values(s).forEach(strict);
}
test('F1 recursive Codex schemas forbid combinators and require every closed object property; task graph round-trip', t => {
  const f = runFixture(t);
  for (const options of [{ taskGraph: true }, { mergeResolution: true }, { taskGraph: true, mergeResolution: true }]) for (const pipelineStep of [false, true]) strict(buildWorkerResultSchema({ ...options, pipelineStep, output: 'report' }));
  strict(taskGraphSchema); strict(codexNullable(closed({ strategy: codexNullable(enumeration('ours', 'theirs')) })));
  assert.deepEqual(schemaErrors(null, codexNullable(enumeration('x'))), []);
  assert.deepEqual(schemaErrors(null, codexNullable(closed({}))), []);
  const graph = JSON.parse(readFileSync('test/fixtures/m3-task-graph.json', 'utf8'));
  const output = JSON.parse(JSON.stringify({ ...worker(), task_graph: graph }));
  assert.deepEqual(schemaErrors(output, buildWorkerResultSchema({ pipelineStep: false, output: 'report', taskGraph: true }) as JsonSchema), []);
  assert.deepEqual(validateTaskGraph(output.task_graph, { max_tasks: 12, allowed_paths: ['src/**', 'test/**', 'lib/**'], checks: [{ id: 'build' }, { id: 'test' }], default_task_pipeline: 'implement-review', registry: new PipelineRegistry(f.paths.config) }), graph);
});
test('F2 standalone planner omits handoff; pipeline planner includes handoff; M2 byte fixtures unchanged', () => {
  assert.equal(Object.hasOwn(buildWorkerResultSchema({ pipelineStep: false, taskGraph: true, output: 'report' }).properties, 'handoff'), false);
  assert.equal(Object.hasOwn(buildWorkerResultSchema({ pipelineStep: true, taskGraph: true, output: 'report' }).properties, 'handoff'), true);
  for (const output of ['change', 'report', 'verdict'] as const) assert.equal(JSON.stringify(buildWorkerResultSchema({ pipelineStep: true, output }), null, 2) + '\n', readFileSync(`test/fixtures/worker-result.m2.${output}.schema.json`, 'utf8'));
});
function guardedFixture(t: Parameters<typeof runFixture>[0]) {
  const f = runFixture(t), branch = `gbdev/${f.run_id}/integration`, worktree = join(f.paths.worktrees, 'repo', f.run_id, 'integration');
  addWorktree(f.repo, branch, worktree, f.base);
  return { ...f, context: { ...f, branch, worktree } };
}
test('F3 guarded merge and switch reject main repository, main/master names and foreign worktrees', t => {
  const f = guardedFixture(t);
  for (const patch of [{ worktree: f.repo }, { branch: 'main' }, { branch: 'master' }]) {
    const ctx = { ...f.context, ...patch };
    assert.throws(() => mergeNoFf(ctx, f.base, 'bad'), errorCode('guard_violation'));
    assert.throws(() => mergeNoCommit(ctx, f.base), errorCode('guard_violation'));
    assert.throws(() => switchCreate(ctx, `gbdev/${f.run_id}/t/a`, f.base), errorCode('guard_violation'));
  }
  for (const branch of ['main', 'master', 'gbdev/r_20261027_0911_abcd/t/a']) assert.throws(() => switchCreate(f.context, branch, f.base), errorCode('guard_violation'));
  assert.equal(head(f.repo), f.base);
});
test('F4 guarded update-ref --no-deref replaces/deletes alias without modifying main', t => {
  const f = guardedFixture(t), branch = `gbdev/${f.run_id}/t/alias`, context = { ...f.context, branch };
  const next = f.commit(f.context.worktree, 'next');
  git(f.repo, ['symbolic-ref', `refs/heads/${branch}`, 'refs/heads/main']);
  updateRefCas(context, next, f.base);
  assert.equal(git(f.repo, ['rev-parse', branch]).trim(), next); assert.equal(head(f.repo), f.base);
  git(f.repo, ['symbolic-ref', `refs/heads/${branch}`, 'refs/heads/main']);
  gitGuarded(context, { operation: 'updateRefCas', sha: null, expected: f.base });
  assert.equal(head(f.repo), f.base); assert.throws(() => git(f.repo, ['show-ref', '--verify', `refs/heads/${branch}`]));
});
test('F5 ownership errors remain guard_violation; actual git failures keep original error/status', t => {
  const f = guardedFixture(t);
  assert.throws(() => resetHard({ ...f.context, worktree: f.repo }, f.base), errorCode('guard_violation'));
  assert.throws(() => resetHard(f.context, 'f'.repeat(40)), (e: unknown) => !(e instanceof GbdevError) && (e as { status: number }).status === 128 && !String(e).includes('Cannot verify worktree ownership'));
  const branch = `gbdev/${f.run_id}/t/exists`; git(f.repo, ['branch', branch]);
  assert.throws(() => switchCreate(f.context, branch, f.base), (e: unknown) => !(e instanceof GbdevError) && (e as { status: number }).status === 128);
});
test('F6 only 40/64 lowercase hex SHAs accepted, not intermediate lengths', t => {
  const f = guardedFixture(t);
  for (let n = 39; n <= 65; n++) { assert.equal(FULL_SHA.test('a'.repeat(n)), n === 40 || n === 64); if (n !== 40 && n !== 64) assert.throws(() => resetHard(f.context, 'a'.repeat(n)), errorCode('guard_violation')); }
  for (const value of ['A'.repeat(40), 'g'.repeat(64)]) assert.equal(FULL_SHA.test(value), false);
});
test('F7 canonical symlink worktrees root is accepted, missing roots fail closed', t => {
  const f = runFixture(t), real = join(f.root, 'actual-worktrees'), alias = join(f.root, 'alias'); mkdirSync(real); symlinkSync(real, alias);
  const paths = { ...f.paths, worktrees: alias }, branch = `gbdev/${f.run_id}/integration`, worktree = join(alias, 'repo', f.run_id, 'integration');
  addWorktree(f.repo, branch, worktree, f.base);
  const context = { ...f, paths, branch, worktree };
  assert.doesNotThrow(() => resetHard(context, f.base));
  assert.throws(() => resetHard({ ...context, paths: { ...paths, worktrees: join(f.root, 'missing') } }, f.base), errorCode('guard_violation'));
  rmSync(alias); assert.throws(() => resetHard(context, f.base), errorCode('guard_violation'));
});
test('F decision cooldown seconds is bounded at 3600', () => {
  assert.equal(validateParallel({ rate_limit_cooldown_s: 3600 }).rate_limit_cooldown_s, 3600);
  assert.throws(() => validateParallel({ rate_limit_cooldown_s: 3601 }), errorCode('config_invalid'));
});

test('F3/F4 symbolic run branch cannot redirect a merge/reset into main', t => {
  const f = guardedFixture(t), branch = `gbdev/${f.run_id}/t/alias`;
  git(f.repo, ['symbolic-ref', `refs/heads/${branch}`, 'refs/heads/main']);
  git(f.context.worktree, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  const context = { ...f.context, branch };
  assert.throws(() => resetHard(context, f.base), errorCode('guard_violation'));
  assert.throws(() => mergeNoFf(context, f.base, 'must refuse alias'), errorCode('guard_violation'));
  assert.equal(head(f.repo), f.base);
});
