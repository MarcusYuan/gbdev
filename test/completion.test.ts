import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validateDoctorResult, validateCleanupResult } from '../src/contracts/commandResults.js';
import { validateJobResult } from '../src/contracts/jobResult.js';
import { type ErrorCode } from '../src/contracts/error.js';
import { type Envelope } from '../src/contracts/envelope.js';
import { RoleRegistry } from '../src/roles/registry.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';
import { providerStub } from './helpers/providerStub.js';

function error(envelope: Envelope, code: ErrorCode) {
  assert.equal(envelope.ok, false);
  if (!envelope.ok) assert.equal(envelope.error.code, code);
}

test('integration 10: clean worktree removed, unmerged branch retained, force deletes only branch; artifacts survive', async t => {
  const h = tmpRepo(t);
  const done = await h.wait((await h.launch()).job_id);
  const output = await h.command(['cleanup', done.job_id]);
  assert.equal(output.exit, 0);
  assert.deepEqual(validateCleanupResult(unwrap(output.envelope)), {
    job_id: done.job_id, worktree_removed: true, branch_deleted: false, branch_retained: true, branch_retained_reason: 'unmerged_job_commits',
  });
  assert.equal(existsSync(done.worktree), false);
  assert.equal(h.git('show-ref', '--verify', `refs/heads/${done.branch}`).trim().split(' ')[0], h.result(done.job_id).gbdev_observed.head_after);
  assert.equal(h.git('worktree', 'list', '--porcelain').includes(done.worktree), false);
  assert.deepEqual(validateJobResult(unwrap((await h.command(['result', done.job_id])).envelope)), h.result(done.job_id));
  const forced = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id, '--force-branch'])).envelope));
  assert.equal(forced.branch_deleted, true);
  assert.equal(forced.worktree_removed, false);
  assert.throws(() => h.git('show-ref', '--verify', `refs/heads/${done.branch}`));
  assert.equal(existsSync(join(h.jobDir(done.job_id), 'diff.patch')), true);
  assert.deepEqual(validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id])).envelope)), {
    job_id: done.job_id, worktree_removed: false, branch_deleted: false, branch_retained: false, branch_retained_reason: null,
  });
});

for (const staged of [false, true]) {
  test(`integration 10: ${staged ? 'staged' : 'untracked'} dirty worktree refused even with force-branch`, async t => {
    const h = tmpRepo(t);
    const done = await h.wait((await h.launch()).job_id);
    const file = join(done.worktree, 'precious.txt');
    writeFileSync(file, 'do not discard');
    if (staged) execFileSync('git', ['-C', done.worktree, 'add', 'precious.txt'], { env: h.env });
    for (const flags of [[], ['--force-branch']]) {
      const output = await h.command(['cleanup', done.job_id, ...flags]);
      assert.equal(output.exit, 1);
      error(output.envelope, 'cleanup_refused');
      assert.equal(readFileSync(file, 'utf8'), 'do not discard');
      assert.ok(h.git('show-ref', '--verify', `refs/heads/${done.branch}`));
      assert.ok(h.git('worktree', 'list', '--porcelain').includes(done.worktree));
    }
  });
}

test('integration 10: merged branch deleted without force using current base ref', async t => {
  const h = tmpRepo(t, 'ok', { base_ref: 'main' });
  const done = await h.wait((await h.launch()).job_id);
  h.git('merge', '--ff-only', done.branch);
  const output = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id])).envelope));
  assert.equal(output.worktree_removed, true);
  assert.equal(output.branch_deleted, true);
  assert.equal(output.branch_retained, false);
});

test('integration 11: repository outside whitelist rejected before job/worktree creation', async t => {
  const h = tmpRepo(t);
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [] }));
  const output = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(output.exit, 1);
  error(output.envelope, 'repo_not_allowed');
  assert.equal(existsSync(join(h.home, 'jobs')), false);
  assert.equal(h.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
});

test('integration 11: empty repository reports repo_no_commits without creating a job', async t => {
  const h = tmpRepo(t);
  const empty = join(h.root, 'empty-repo');
  mkdirSync(empty);
  execFileSync('git', ['-C', empty, 'init', '--initial-branch=main'], { env: h.env, stdio: 'ignore' });
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [empty] }));
  writeFileSync(h.briefFile, JSON.stringify({ ...h.task, repo: empty }));
  const output = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(output.exit, 1);
  error(output.envelope, 'repo_no_commits');
  assert.equal(existsSync(join(h.home, 'jobs')), false);
});

test('integration 12: every public JSON command emits one parseable envelope and empty stderr', async t => {
  const h = tmpRepo(t);
  const stub = providerStub(h.root);
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { codex: { bin: stub }, cursor: { bin: stub } } }));
  const started = await h.launch(); // start output is parsed and stderr checked by the harness too.
  await h.wait(started.job_id);
  for (const args of [
    ['doctor'], ['status'], ['status', started.job_id], ['wait', started.job_id, '--timeout-ms', '1'],
    ['result', started.job_id], ['cancel', started.job_id], ['cleanup', started.job_id], ['--help'],
  ]) {
    const output = await h.command(args);
    assert.equal(output.exit, 0, JSON.stringify(output.envelope));
    assert.equal(output.stdout.split('\n').length, 2);
    assert.equal(output.stderr, '');
    assert.equal(JSON.parse(output.stdout).command, args[0] === '--help' ? 'help' : args[0]);
  }
  const absent = 'j_20000101_0000_ffff';
  for (const args of [
    ['start', '--brief', join(h.root, 'absent.json')], ['status', absent], ['wait', absent, '--timeout-ms', '1'],
    ['result', absent], ['cancel', absent], ['cleanup', absent], ['doctor', '--brief', h.briefFile],
  ]) {
    const output = await h.command(args);
    assert.equal(output.envelope.ok, false);
    assert.equal(output.stdout.split('\n').length, 2);
    assert.equal(output.stderr, '');
  }
});

test('result/cleanup refuse live jobs without cancellation or branch/worktree changes', async t => {
  const h = tmpRepo(t, 'slow');
  const started = await h.launch();
  for (const args of [['result', started.job_id], ['cleanup', started.job_id, '--force-branch']]) {
    const output = await h.command(args);
    error(output.envelope, 'job_not_terminal');
    assert.equal(output.exit, 1);
    if (!output.envelope.ok) assert.equal(output.envelope.error.retryable, true);
  }
  assert.equal(existsSync(started.worktree), true);
  assert.ok(h.git('show-ref', '--verify', `refs/heads/${started.branch}`));
});

test('result distinguishes missing/invalid/mismatched persisted results', async t => {
  const h = tmpRepo(t);
  const done = await h.wait((await h.launch()).job_id);
  const file = join(h.jobDir(done.job_id), 'result.json');
  const value = h.result(done.job_id);
  rmSync(file);
  error((await h.command(['result', done.job_id])).envelope, 'result_missing');
  for (const bad of ['{bad', '{}', JSON.stringify({ ...value, state: 'failed' }), JSON.stringify({ ...value, job_id: 'j_20000101_0000_ffff' })]) {
    writeFileSync(file, bad);
    error((await h.command(['result', done.job_id])).envelope, 'result_invalid');
  }
});

test('doctor uses configured stub versions and documented Cursor status; auth text never escapes', async t => {
  const h = tmpRepo(t, 'ok', {}, { GBDEV_STUB_LOGIN_EXIT: '3' });
  const stub = providerStub(h.root);
  const log = join(h.root, 'stub-calls.jsonl');
  h.env.GBDEV_STUB_LOG = log;
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { codex: { bin: stub }, cursor: { bin: stub } } }));
  const output = await h.command(['doctor']);
  assert.equal(output.exit, 0);
  const { checks } = validateDoctorResult(unwrap(output.envelope));
  for (const name of ['node', 'git', 'config', 'codex', 'cursor', 'home_writable']) assert.equal(checks.find(c => c.name === name)?.ok, true, name);
  assert.equal(checks.find(c => c.name === 'codex_login')?.ok, false);
  assert.equal(checks.find(c => c.name === 'codex_login')?.detail, 'exit_code=3');
  assert.equal(checks.find(c => c.name === 'cursor_login')?.ok, false);
  assert.equal(checks.find(c => c.name === 'cursor_login')!.detail, 'exit_code=3');
  assert.equal(output.stdout.includes('private authentication'), false);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).args);
  assert.deepEqual(calls, [['--version'], ['login', 'status'], ['--version'], ['status']]);
  assert.equal(readdirSync(h.home).some(name => name.startsWith('.doctor-')), false);
});

test('doctor reports invalid config, missing provider and unwritable home without noisy stderr', async t => {
  const h = tmpRepo(t);
  writeFileSync(h.config, '{bad');
  const invalid = validateDoctorResult(unwrap((await h.command(['doctor'])).envelope));
  assert.equal(invalid.checks.find(c => c.name === 'config')?.ok, false);
  writeFileSync(h.config, JSON.stringify({ version: 1, providers: { codex: { bin: join(h.root, 'absent') }, cursor: { bin: join(h.root, 'absent') } } }));
  const file = join(h.root, 'not-directory');
  writeFileSync(file, '');
  h.env.GBDEV_HOME = file;
  const missing = validateDoctorResult(unwrap((await h.command(['doctor'])).envelope));
  for (const name of ['codex', 'cursor', 'home_writable']) assert.equal(missing.checks.find(c => c.name === name)?.ok, false);
});

for (const provider of ['codex', 'cursor'] as const) {
  for (const sandbox of ['workspace-write', 'read-only'] as const) {
    test(`${provider} adapter lifecycle (${sandbox}) uses executable stub, not real provider`, async t => {
      const h = tmpRepo(t, 'ok', { provider, sandbox, model: provider === 'cursor' ? 'auto' : 'stub-model', acceptance_criteria: [] });
      const role = new RoleRegistry(h.config).resolve(h.task.role);
      if (role.output === 'verdict') {
        // Keep the shared stub's default report unchanged for other tests.
        h.env.GBDEV_STUB_REPORT = JSON.stringify({
          schema: 'gbdev.worker-result.v1', status: 'succeeded', summary: 'Stub completed',
          files_changed: [], commits: [], tests: [], evidence: [], open_questions: [], blockers: [], policy_violations: [],
          review: { verdict: 'approve', findings: [] },
        });
      }
      const stub = providerStub(h.root);
      const log = join(h.root, 'calls.jsonl');
      h.env.GBDEV_STUB_LOG = log;
      writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { [provider]: { bin: stub } } }));
      const done = await h.wait((await h.launch()).job_id);
      assert.equal(done.state, 'succeeded');
      const result = validateJobResult(unwrap((await h.command(['result', done.job_id])).envelope));
      assert.equal(result.worker_reported?.summary, 'Stub completed');
      if (role.output === 'verdict') assert.deepEqual(result.worker_reported?.review, { verdict: 'approve', findings: [] });
      assert.equal(result.worker_exit_code, 0);
      const rawFile = provider === 'codex' ? 'raw.jsonl' : 'raw.json';
      assert.ok(readFileSync(join(h.jobDir(done.job_id), rawFile), 'utf8').includes(provider === 'codex' ? 'stub.done' : 'Stub result.'));
      assert.match(readFileSync(result.paths.final_message, 'utf8'), /gbdev.worker-result.v1/);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cwd, realpathSync(done.worktree));
      assert.equal(calls[0].args.at(-1), readFileSync(join(h.jobDir(done.job_id), 'prompt.md'), 'utf8'));
      const record = JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'provider.json'), 'utf8'));
      assert.deepEqual(record, { bin: stub, writable_roots: sandbox === 'workspace-write' ? [done.worktree] : [], schema_options: { policyIncidents: true, output: role.output }, provider, cmd: stub, argv: calls[0].args, cwd: done.worktree });
      assert.equal(calls[0].args.includes('--add-dir'), false);
    });
  }
}

test('cursor reviewer terminal result without review fails with missing_review', async t => {
  const h = tmpRepo(t, 'ok', { provider: 'cursor', role: 'reviewer', sandbox: 'read-only', model: 'auto', acceptance_criteria: [] });
  const stub = providerStub(h.root);
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { cursor: { bin: stub } } }));
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'failed');
  const result = validateJobResult(unwrap((await h.command(['result', done.job_id])).envelope));
  assert.equal(result.state, 'failed');
  assert.equal(result.worker_exit_code, 0);
  assert.equal(result.worker_reported, null);
  assert.equal(result.failure_reason, 'worker_result_invalid: missing_review');
  const extraction = JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'result-extraction.json'), 'utf8'));
  assert.equal(extraction.selected.kind, 'terminal_result');
  assert.equal(extraction.valid, false);
  assert.equal(extraction.force_invalid, 'missing_review');
});

test('start fails provider_not_found before creating any persistent job', async t => {
  const h = tmpRepo(t, 'ok', { provider: 'codex' });
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { codex: { bin: join(h.root, 'absent') } } }));
  const output = await h.command(['start', '--brief', h.briefFile]);
  error(output.envelope, 'provider_not_found');
  assert.equal(output.exit, 1);
  assert.equal(existsSync(join(h.home, 'jobs')), false);
});
