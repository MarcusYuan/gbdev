import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, cleanUntracked, git, gitGuarded, head, isAncestor, mergeAbort, mergeNoCommit, mergeNoFf, mergeTreeCheck, resetHard, switchDetach, updateRefCas, worktreeListPorcelain, type GitGuardContext } from '../src/core/git.js';
import { resolvePaths } from '../src/core/paths.js';
import { temporary, errorCode } from './helpers.js';
function fixtureSwitch(repo: string, branch: string, sha: string) { git(repo, ['switch', '-c', branch, sha]); }
function repoFixture(t: TestContext) {
  const root = temporary(t), repo = join(root, 'repo'), paths = resolvePaths({ GBDEV_HOME: join(root, 'home'), GBDEV_CONFIG: join(root, 'config.json') });
  mkdirSync(repo); git(repo, ['init', '--initial-branch=main']);
  const commit = (cwd: string, message: string) => { git(cwd, ['add', '-A']); git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', message]); return head(cwd); };
  writeFileSync(join(repo, 'conflict file.txt'), 'base\n'); writeFileSync(join(repo, 'line\n中文.txt'), 'base\n');
  const base = commit(repo, 'base'), run_id = 'r_20261027_0911_5be0', branch = `gbdev/${run_id}/integration`, worktree = join(paths.worktrees, 'repo', run_id, 'integration');
  addWorktree(repo, branch, worktree, base);
  const context: GitGuardContext = { run_id, repo, branch, worktree, paths };
  return { root, repo, base, worktree, context, commit };
}
test('M3 AC-S1.2 gitGuarded refuses user/foreign branches, traversal, prefix siblings, symlink escapes and false checked-out branch', t => {
  const f = repoFixture(t), outside = join(f.root, 'outside'); mkdirSync(outside);
  const link = join(f.context.paths!.worktrees, 'repo', f.context.run_id, 'escape'); symlinkSync(outside, link);
  for (const patch of [{ branch: 'main' }, { branch: 'gbdev/j_20261027_0911_5be0' }, { branch: 'gbdev/r_20261027_0911_abcd/integration' }, { branch: `${f.context.branch}/../main` }, { worktree: f.repo }, { worktree: f.worktree + '/../..' }, { worktree: f.worktree.replace(f.context.run_id, f.context.run_id + '-evil') }, { worktree: link }, { branch: `gbdev/${f.context.run_id}/t/other` }]) {
    assert.throws(() => gitGuarded({ ...f.context, ...patch }, { operation: 'resetHard', sha: f.base }), errorCode('guard_violation'));
  }
  assert.equal(head(f.repo), f.base); assert.equal(head(f.worktree), f.base);
});
test('M3 AC-S1.3 mergeTreeCheck distinguishes clean/conflict and preserves exact Unicode/newline filenames', t => {
  const f = repoFixture(t); fixtureSwitch(f.repo, 'clean', f.base); writeFileSync(join(f.repo, 'new.txt'), 'new\n'); const clean = f.commit(f.repo, 'clean');
  const preview = mergeTreeCheck(f.repo, f.base, clean); assert.equal(preview.clean, true); assert.deepEqual(preview.conflict_files, []); assert.match(preview.tree!, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  fixtureSwitch(f.repo, 'ours', f.base); for (const file of ['conflict file.txt', 'line\n中文.txt']) writeFileSync(join(f.repo, file), 'ours\n'); const ours = f.commit(f.repo, 'ours');
  fixtureSwitch(f.repo, 'theirs', f.base); for (const file of ['conflict file.txt', 'line\n中文.txt']) writeFileSync(join(f.repo, file), 'theirs\n'); const theirs = f.commit(f.repo, 'theirs');
  const conflict = mergeTreeCheck(f.repo, ours, theirs); assert.equal(conflict.clean, false); assert.equal(conflict.tree, null); assert.deepEqual(conflict.conflict_files.sort(), ['conflict file.txt', 'line\n中文.txt'].sort()); assert.equal(head(f.repo), theirs);
  assert.throws(() => mergeTreeCheck(f.repo, 'missing', theirs));
});
test('M3 guarded reset/clean/CAS/detach and no-ff merge use real temporary worktrees', t => {
  const f = repoFixture(t); fixtureSwitch(f.repo, 'source', f.base); writeFileSync(join(f.repo, 'added.txt'), 'added'); const source = f.commit(f.repo, 'source');
  assert.equal(isAncestor(f.repo, f.base, source), true); assert.equal(isAncestor(f.repo, source, f.base), false); assert.throws(() => isAncestor(f.repo, 'missing', source));
  const merged = mergeNoFf(f.context, source, 'gbdev: merge task (test)'); assert.equal(git(f.worktree, ['rev-list', '--parents', '-n', '1', merged]).trim().split(' ').length, 3);
  resetHard(f.context, f.base); writeFileSync(join(f.worktree, 'trash'), 'trash'); writeFileSync(join(f.worktree, '.gitignore'), 'cache\n'); f.commit(f.worktree, 'ignore'); writeFileSync(join(f.worktree, 'cache'), 'cache'); cleanUntracked(f.context); assert.equal(readFileSync(join(f.worktree, 'cache'), 'utf8'), 'cache');
  const ref = `gbdev/${f.context.run_id}/t/cas`; git(f.worktree, ['branch', ref, f.base]); const cas = { ...f.context, branch: ref }; updateRefCas(cas, source, f.base); assert.throws(() => updateRefCas(cas, f.base, f.base)); assert.equal(git(f.repo, ['rev-parse', ref]).trim(), source); updateRefCas(cas, null, source);
  const entries = worktreeListPorcelain(f.repo); assert.ok(entries.some(e => e.branch === `refs/heads/${f.context.branch}` && realpathSync(e.worktree) === realpathSync(f.worktree)));
  switchDetach(f.context, f.base); assert.ok(worktreeListPorcelain(f.repo).some(e => realpathSync(e.worktree) === realpathSync(f.worktree) && e.detached));
  assert.throws(() => resetHard(f.context, f.base), errorCode('guard_violation'));
});
test('M3 mergeNoCommit reports conflict and guarded mergeAbort restores clean HEAD', t => {
  const f = repoFixture(t); writeFileSync(join(f.worktree, 'conflict file.txt'), 'ours\n'); const ours = f.commit(f.worktree, 'ours');
  fixtureSwitch(f.repo, 'source', f.base); writeFileSync(join(f.repo, 'conflict file.txt'), 'theirs\n'); const theirs = f.commit(f.repo, 'theirs');
  assert.deepEqual(mergeNoCommit(f.context, theirs), { clean: false, conflict_files: ['conflict file.txt'] }); mergeAbort(f.context); assert.equal(head(f.worktree), ours); assert.equal(git(f.worktree, ['status', '--porcelain']), '');
});
