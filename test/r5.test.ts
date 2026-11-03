import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { validateCleanupResult } from '../src/contracts/commandResults.js';
import { validateJobStatus } from '../src/contracts/jobStatus.js';
import { JobStore } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { job } from './helpers.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';

test('H1: worktree creation and no-commit ref deletion bypass repository hooks', async t => {
  const h = tmpRepo(t, 'needs_input', { acceptance_criteria: [] });
  const hooks = join(h.repo, '.git', 'hooks');
  for (const name of ['post-checkout', 'reference-transaction']) {
    writeFileSync(join(hooks, name), `#!/bin/sh\nprintf executed > "${join(h.root, name)}"\nexit 1\n`, { mode: 0o700 });
  }
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'needs_input');
  const cleaned = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id])).envelope));
  assert.equal(cleaned.worktree_removed, true);
  assert.equal(cleaned.branch_deleted, true);
  for (const name of ['post-checkout', 'reference-transaction']) assert.equal(existsSync(join(h.root, name)), false);
});

for (const provider of ['cursor', 'codex'] as const) {
  for (const filename of ['raw.json', 'raw.jsonl', 'events.jsonl']) {
    test(`H3: reconcile recovers ${provider} session_id from only ${filename} into status and result`, async t => {
      const h = tmpRepo(t, 'needs_input', { provider, acceptance_criteria: [] });
      const store = new JobStore(resolvePaths(h.env));
      const status = { ...job(), provider, repo: h.repo, worktree: h.repo, base_sha: h.git('rev-parse', 'HEAD').trim() };
      store.create(status);
      const dir = h.jobDir(status.job_id);
      writeFileSync(join(dir, 'brief.json'), JSON.stringify(h.task));
      const metadata = provider === 'cursor' ? { session_id: 'recovered-cursor' } : { type: 'thread.started', thread_id: 'recovered-codex' };
      // Pretty-printed single objects and truncated JSONL are both real stdout shapes.
      const raw = filename === 'raw.json' ? JSON.stringify(metadata, null, 2) :
        filename === 'events.jsonl' ? JSON.stringify(metadata) : JSON.stringify(metadata) + '\n{partial';
      writeFileSync(join(dir, filename), raw);
      assert.equal(store.read(status.job_id).session_id, null);
      const reconciled = validateJobStatus(unwrap((await h.command(['status', status.job_id])).envelope));
      assert.equal(reconciled.state, 'failed');
      assert.equal(reconciled.session_id, `recovered-${provider}`);
      assert.equal(store.read(status.job_id).session_id, `recovered-${provider}`);
      assert.equal(h.result(status.job_id).session_id, `recovered-${provider}`);
      assert.equal(h.result(status.job_id).failure_reason, 'worker_crashed');
      assert.equal(readFileSync(join(dir, filename), 'utf8').startsWith(raw), true);
      if (filename === 'events.jsonl') {
        const records = readFileSync(join(dir, filename), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(records[0], metadata);
        assert.ok(records.some(record => record.type === 'warning'));
        assert.ok(records.some(record => record.type === 'state_change'));
      }
    });
  }
  for (const output of ['missing', 'malformed', 'unreadable'] as const) {
    test(`H3: reconcile tolerates ${output} ${provider} metadata and keeps session_id null`, async t => {
      const h = tmpRepo(t, 'needs_input', { provider, acceptance_criteria: [] });
      const store = new JobStore(resolvePaths(h.env));
      const status = { ...job(), provider, repo: h.repo, worktree: h.repo, base_sha: h.git('rev-parse', 'HEAD').trim() };
      store.create(status);
      const dir = h.jobDir(status.job_id);
      writeFileSync(join(dir, 'brief.json'), JSON.stringify(h.task));
      const raw = join(dir, provider === 'cursor' ? 'raw.json' : 'raw.jsonl');
      if (output === 'malformed') writeFileSync(raw, '{partial');
      if (output === 'unreadable') mkdirSync(raw); // readFile fails even when tests run as root.
      const reconciled = validateJobStatus(unwrap((await h.command(['status', status.job_id])).envelope));
      assert.equal(reconciled.state, 'failed');
      assert.equal(reconciled.session_id, null);
      assert.equal(h.result(status.job_id).session_id, null);
    });
  }
}

async function cleanupFixture(t: TestContext, hasCommits: boolean) {
  const h = tmpRepo(t, hasCommits ? 'dirty_exit' : 'needs_input', {
    acceptance_criteria: [], ...(hasCommits ? {} : { sandbox: 'read-only', role: 'reviewer' }),
  });
  // Job base is a commit that main later abandons, as in the real cleanup failure.
  writeFileSync(join(h.repo, 'src', 'base.txt'), 'job base\n');
  h.git('add', '-A');
  h.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'chore: job base');
  const base = h.git('rev-parse', 'HEAD').trim();
  writeFileSync(h.briefFile, JSON.stringify({ ...h.task, base_ref: base }));
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, hasCommits ? 'succeeded' : 'needs_input');
  assert.equal(h.result(done.job_id).gbdev_observed.snapshot_commit !== null, hasCommits);
  h.git('reset', '--hard', 'HEAD~1');
  assert.equal(h.git('for-each-ref', `--contains=${base}`, '--format=%(refname)', 'refs/heads/').trim(), `refs/heads/${done.branch}`);
  return { h, done };
}

for (const hasCommits of [false, true]) {
  for (const force of [false, true]) {
    test(`H4: abandoned base, ${hasCommits ? 'unmerged snapshot' : 'no job commits'}, force=${force}: dry-run matches cleanup`, async t => {
      const { h, done } = await cleanupFixture(t, hasCommits);
      const flags = force ? ['--force-branch'] : [];
      const shouldDelete = !hasCommits || force;
      const before = h.git('show-ref');
      const plan = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id, '--dry-run', ...flags])).envelope));
      assert.equal(plan.would_remove_worktree, true);
      assert.equal(plan.would_delete_branch, shouldDelete);
      assert.equal(plan.branch_retained, !shouldDelete);
      assert.equal(plan.worktree_removed, false);
      assert.equal(plan.branch_deleted, false);
      assert.equal(existsSync(done.worktree), true);
      assert.equal(h.git('show-ref'), before);
      const output = await h.command(['cleanup', done.job_id, ...flags]);
      assert.equal(output.exit, 0);
      assert.deepEqual(validateCleanupResult(unwrap(output.envelope)), {
        job_id: done.job_id, worktree_removed: true, branch_deleted: shouldDelete, branch_retained: !shouldDelete,
        branch_retained_reason: shouldDelete ? null : 'unmerged_job_commits',
      });
      assert.equal(existsSync(done.worktree), false);
      assert.equal(h.git('worktree', 'list', '--porcelain').includes(done.worktree), false);
      if (shouldDelete) assert.throws(() => h.git('show-ref', '--verify', `refs/heads/${done.branch}`));
      else assert.equal(h.git('rev-parse', done.branch).trim(), h.result(done.job_id).gbdev_observed.snapshot_commit);
    });
  }
}

test('H4: job commits contained in another local branch can be deleted even when HEAD no longer contains base', async t => {
  const { h, done } = await cleanupFixture(t, true);
  h.git('branch', 'integrated', done.branch);
  h.git('config', `branch.${done.branch}.remote`, '.');
  h.git('config', `branch.${done.branch}.merge`, 'refs/heads/main');
  const configBefore = readFileSync(join(h.repo, '.git', 'config'), 'utf8');
  const plan = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id, '--dry-run'])).envelope));
  assert.equal(plan.would_delete_branch, true);
  const output = await h.command(['cleanup', done.job_id]);
  assert.equal(output.exit, 0);
  assert.equal(validateCleanupResult(unwrap(output.envelope)).branch_deleted, true);
  assert.equal(h.git('rev-parse', 'integrated').trim(), h.result(done.job_id).gbdev_observed.snapshot_commit);
  assert.equal(readFileSync(join(h.repo, '.git', 'config'), 'utf8'), configBefore);
});

test('H4: ref deletion failure after worktree removal reports partial progress, not cleanup_refused', async t => {
  const { h, done } = await cleanupFixture(t, false);
  writeFileSync(join(h.repo, '.git', 'refs', 'heads', `${done.branch}.lock`), 'locked\n');
  const output = await h.command(['cleanup', done.job_id]);
  assert.equal(output.exit, 1);
  assert.equal(output.envelope.ok, false);
  if (!output.envelope.ok) {
    assert.equal(output.envelope.error.code, 'internal_error');
    assert.equal(output.envelope.error.details.worktree_removed, true);
    assert.equal(output.envelope.error.details.retry_safe, true);
  }
  assert.equal(existsSync(done.worktree), false);
  assert.equal(h.git('rev-parse', done.branch).trim(), done.base_sha);
});

test('H4: Git worktree removal refusal preserves tree/ref and reports cleanup_refused', async t => {
  const { h, done } = await cleanupFixture(t, false);
  h.git('worktree', 'lock', done.worktree);
  const output = await h.command(['cleanup', done.job_id, '--force-branch']);
  assert.equal(output.exit, 1);
  assert.equal(output.envelope.ok, false);
  if (!output.envelope.ok) {
    assert.equal(output.envelope.error.code, 'cleanup_refused');
    assert.equal(output.envelope.error.details.worktree_removed, false);
  }
  assert.equal(existsSync(done.worktree), true);
  assert.equal(h.git('rev-parse', done.branch).trim(), done.base_sha);
});

for (const force of [false, true]) {
test(`${force ? 'I2: force' : 'H4: no-commit'} deletion validates the old ref value and retains a concurrently moved branch`, async t => {
  const { h, done } = await cleanupFixture(t, force);
  const newTip = h.git('rev-parse', 'main').trim();
  const realGit = execFileSync('/usr/bin/which', ['git'], { env: h.env, encoding: 'utf8' }).trim();
  const bin = join(h.root, 'bin');
  mkdirSync(bin);
  // Interpose only the deletion, after preflight and worktree removal have completed.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('update-ref') && args.includes('-d')) {
  const moved = spawnSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(h.repo)}, '-c', 'core.hooksPath=/dev/null', 'update-ref', ${JSON.stringify(`refs/heads/${done.branch}`)}, ${JSON.stringify(newTip)}], { stdio: 'inherit' });
  if (moved.status !== 0) process.exit(moved.status ?? 1);
}
const child = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`, { mode: 0o700 });
  h.env.PATH = `${bin}:${h.env.PATH}`;
  const output = await h.command(['cleanup', done.job_id, ...(force ? ['--force-branch'] : [])]);
  assert.equal(output.exit, 1);
  assert.equal(output.envelope.ok, false);
  if (!output.envelope.ok) {
    assert.equal(output.envelope.error.code, 'internal_error');
    assert.equal(output.envelope.error.details.worktree_removed, true);
    assert.equal(output.envelope.error.details.retry_safe, true);
    assert.match(String(output.envelope.error.details.detail), /expected|is at/);
  }
  assert.equal(existsSync(done.worktree), false);
  assert.equal(h.git('rev-parse', done.branch).trim(), newTip);
});
}
