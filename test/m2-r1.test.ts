import { validateSeedFindings } from '../src/contracts/seedFindings.js';
import { validatePipelineResume } from '../src/contracts/pipelineResume.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { cleanupBranch } from '../src/commands/cleanup.js';
import { validateBrief } from '../src/contracts/brief.js';
import { validateCleanupResult, validateDoctorResult } from '../src/contracts/commandResults.js';
import { validateWorkerResult } from '../src/contracts/workerResult.js';
import { validateEnvelope } from '../src/contracts/envelope.js';
import { GbdevError } from '../src/contracts/error.js';
import { validateJobStatus } from '../src/contracts/jobStatus.js';
import { validateJobResult } from '../src/contracts/jobResult.js';
import { resolveRequest } from '../src/contracts/pipelineRequest.js';
import { validatePipeline } from '../src/contracts/pipeline.js';
import { validateRole } from '../src/contracts/role.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { FAKE_SCENARIOS } from '../src/providers/fake.js';
import { validateConfig } from '../src/core/config.js';
import { finalOutcome } from '../src/core/finalize.js';
import { JobStore } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { job, result, worker } from './helpers.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';

for (const route of ['no-commits', 'merged', 'force'] as const) {
  for (const destination of ['main', 'other-worktree'] as const) {
    test(`M2 R1.1: ${route} rechecks checkout in ${destination} after removing job worktree`, async t => {
      const h = tmpRepo(t, route === 'no-commits' ? 'needs_input' : 'dirty_exit', { acceptance_criteria: [] });
      const done = await h.wait((await h.launch()).job_id);
      const tip = h.git('rev-parse', done.branch).trim();
      if (route === 'merged') h.git('branch', 'integrated', done.branch);
      const other = join(h.root, 'other worktree');
      if (destination === 'other-worktree') h.git('worktree', 'add', '--detach', other, 'HEAD');
      let hookCalled = false;
      const cleaned = cleanupBranch({ status: done, forceBranch: route === 'force',
        beforeBranchDelete: () => {
          hookCalled = true;
          assert.equal(existsSync(done.worktree), false);
          h.git('-C', destination === 'main' ? h.repo : other, 'checkout', done.branch);
        } });
      assert.equal(hookCalled, true);
      assert.deepEqual(cleaned, { job_id: done.job_id, worktree_removed: true, branch_deleted: false,
        branch_retained: true, branch_retained_reason: 'checked_out' });
      assert.equal(h.git('rev-parse', done.branch).trim(), tip);
    });
  }
}

test('M2 R1.1: old-value check survives the new checkout guard; dry-run never invokes race hook', async t => {
  const h = tmpRepo(t, 'dirty_exit', { acceptance_criteria: [] });
  const done = await h.wait((await h.launch()).job_id);
  let hookCalled = false;
  const beforeBranchDelete = () => {
    hookCalled = true;
    h.git('update-ref', `refs/heads/${done.branch}`, done.base_sha);
  };
  const plan = cleanupBranch({ status: done, forceBranch: true, dryRun: true, beforeBranchDelete });
  assert.equal(plan.would_delete_branch, true);
  assert.equal(hookCalled, false);
  assert.equal(existsSync(done.worktree), true);
  assert.throws(() => cleanupBranch({ status: done, forceBranch: true, beforeBranchDelete }), (error: unknown) => {
    assert.ok(error instanceof GbdevError);
    assert.equal(error.contract.code, 'internal_error');
    assert.equal(error.contract.details.retry_safe, true);
    assert.equal(error.contract.details.worktree_removed, true);
    assert.equal(error.contract.details.branch_retained_reason, 'delete_failed_retry_safe');
    return true;
  });
  assert.equal(hookCalled, true);
  assert.equal(h.git('rev-parse', done.branch).trim(), done.base_sha);
});

// Run deadline probes sequentially so wall-clock assertions exclude concurrent process-startup contention.
test('M2 R1.2: doctor SIGKILL deadlines remain ten seconds including optional tmux', async t => {
  for (const target of ['git', 'codex', 'codex_login', 'cursor', 'cursor_login', 'tmux']) {
    await t.test(target, async t => {
      const h = tmpRepo(t);
      const realGit = execFileSync('/usr/bin/which', ['git'], { env: h.env, encoding: 'utf8' }).trim();
      const bin = join(h.root, 'bin');
      mkdirSync(bin);
      for (const name of ['git', 'codex', 'cursor-agent', 'tmux']) {
        const key = name === 'cursor-agent' ? 'cursor' : name;
        // Fast shell builtins for healthy checks avoid Node startup contention;
        // the hanging process ignores TERM so the deadline must use SIGKILL.
        const nodeBin = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
        writeFileSync(join(bin, name), `#!/bin/sh
check=${key}
case " $* " in *" status "*) check=${key}_login ;; esac
if [ "$check" = "${target}" ]; then
  exec ${nodeBin} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
fi
${name === 'git' ? `case " $* " in *" --version "*) ;; *) exec '${realGit.replaceAll("'", "'\\''")}' "$@" ;; esac` : ''}
echo '${name === 'git' ? 'git version 2.50.1' : 'stub 1.0'}'
`, { mode: 0o700 });
      }
      writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: {
        codex: { bin: join(bin, 'codex') }, cursor: { bin: join(bin, 'cursor-agent') },
      } }));
      h.env.PATH = bin;
      h.env.GBDEV_TMUX_BIN = join(bin, 'tmux'); // Explicit stub opt-in under M4's test guard.
      const started = Date.now();
      const output = await h.command(['doctor']);
      const elapsed = Date.now() - started;
      assert.equal(output.exit, 0);
      assert.equal(output.stderr, '');
      assert.ok(elapsed >= 9_500 && elapsed < 15_000, `deadline took ${elapsed}ms`);
      const checks = validateDoctorResult(unwrap(output.envelope)).checks;
      const check = checks.find(check => check.name === target)!;
      assert.deepEqual({ name: check.name, ok: check.ok, detail: check.detail }, { name: target, ok: false, detail: { timed_out: true } });
      for (const check of checks.filter(check => check.name !== target)) {
        if (target === 'git' && check.name === 'git_merge_tree') assert.equal(check.ok, false);
        // M6 launcher is non-blocking; missing shared launcher is expected in temp HOME fixtures.
        else if (check.name === 'launcher') assert.equal(check.ok, false, 'launcher');
        else assert.equal(check.ok, true, check.name);
      }
    });
  }
});

test('M2 R1.2: git helper exposes internal_error/git_timeout with a caller timeout', t => {
  const h = tmpRepo(t);
  const bin = join(h.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`, { mode: 0o700 });
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { git } from ${JSON.stringify(new URL('../src/core/git.js', import.meta.url).href)};
    try { git(${JSON.stringify(h.repo)}, ['--version'], 100); process.exitCode = 2; }
    catch (error) { console.log(JSON.stringify(error.contract)); }
  `], { env: { ...h.env, PATH: bin }, encoding: 'utf8', timeout: 3000 });
  assert.equal(output.status, 0);
  assert.equal(output.stderr, '');
  const error = JSON.parse(output.stdout);
  assert.equal(error.code, 'internal_error');
  assert.match(error.message, /SIGKILL.*index\.lock\/HEAD\.lock.*does not remove locks/);
  assert.deepEqual(error.details, { git_timeout: true, timeout_ms: 100 });
});

test('M2 R1.3: SPEC job directory documents all provider and supervisor artifacts', () => {
  const section = readFileSync(resolve('docs/specs/SPEC.md'), 'utf8').split('## 5.')[1]!.split('## 6.')[0]!;
  for (const file of ['raw.jsonl', 'raw.json', 'supervisor.log', 'worker-result.schema.json']) assert.ok(section.includes(file), file);
  assert.match(section, /raw\.json\s+.*cursor.*JSONL/);
});

for (const reason of ['checked_out', 'unmerged_job_commits', 'delete_failed_retry_safe'] as const) {
  test(`M2 R1.4: cleanup JSON and human output explain ${reason}`, async t => {
    const h = tmpRepo(t, 'dirty_exit', { acceptance_criteria: [] });
    const done = await h.wait((await h.launch()).job_id);
    h.git('worktree', 'remove', done.worktree);
    const flags = reason === 'delete_failed_retry_safe' ? ['--force-branch'] : [];
    if (reason === 'checked_out') h.git('checkout', done.branch);
    if (reason === 'delete_failed_retry_safe') writeFileSync(join(h.repo, '.git', 'refs', 'heads', `${done.branch}.lock`), 'lock');
    const output = await h.command(['cleanup', done.job_id, ...flags]);
    if (reason === 'delete_failed_retry_safe') {
      assert.equal(output.exit, 1);
      assert.equal(output.envelope.ok, false);
      if (output.envelope.ok) throw new Error('Expected internal_error');
      assert.equal(output.envelope.error.code, 'internal_error');
      assert.equal(output.envelope.error.details.branch_retained_reason, reason);
      assert.equal(output.envelope.error.details.branch_retained, true);
      assert.equal(output.envelope.error.details.retry_safe, true);
    } else {
      assert.equal(output.exit, 0);
      assert.equal(validateCleanupResult(unwrap(output.envelope)).branch_retained_reason, reason);
      const plan = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id, '--dry-run'])).envelope));
      assert.equal(plan.branch_retained_reason, reason);
    }
    const human = spawnSync(process.execPath, [resolve('dist/cli.js'), 'cleanup', done.job_id, ...flags], { env: h.env, encoding: 'utf8' });
    assert.equal(human.status, output.exit);
    assert.match(human.stdout + human.stderr, new RegExp(`branch kept: ${reason}`));
    assert.equal((human.stdout + human.stderr).includes('use --force-branch only with user approval'), reason === 'unmerged_job_commits');
    assert.ok(h.git('rev-parse', done.branch).trim());
  });
}

const failedChecks = [{ id: 'PASS', exit_code: 0 }, { id: 'AC1', exit_code: 1 }, { id: 'AC2', exit_code: null }];
test('M2 R1.5: ordered failure_reasons retains all matching 3a–3f/4 facts', () => {
  assert.deepEqual(finalOutcome(7, { ...worker(), status: 'failed', policy_violations: ['reported'] }, ['readonly_modified'],
    undefined, failedChecks, 'provider_error: failed').failure_reasons, [
    'provider_error: failed', 'worker_exit_nonzero:7', 'policy_violations: readonly_modified',
    'policy_violations: reported', 'worker_reported_failed', 'check_failed:AC1', 'check_failed:AC2',
  ]);
  assert.deepEqual(finalOutcome(7, null, ['outside_allowed_paths'], undefined, failedChecks, 'provider_error: failed',
    'worker_result_invalid: summary').failure_reasons, [
    'provider_error: failed', 'worker_exit_nonzero:7', 'worker_result_invalid: summary',
    'policy_violations: outside_allowed_paths', 'check_failed:AC1', 'check_failed:AC2',
  ]);
});

for (const signal of ['timeout', 'cancelled', 'failed', 'worker_stalled', 'needs_input', 'blocked'] as const) {
  test(`M2 R1.5: ${signal} keeps priority without losing check/exit facts`, () => {
    const reported = signal === 'needs_input' || signal === 'blocked' ? { ...worker(), status: signal } : worker();
    const forced = signal === 'needs_input' || signal === 'blocked' ? undefined : signal;
    const outcome = finalOutcome(7, reported, [], forced, failedChecks);
    assert.equal(outcome.state, signal === 'worker_stalled' ? 'failed' : signal);
    assert.deepEqual(outcome.failure_reasons, ['worker_exit_nonzero:7', 'check_failed:AC1', 'check_failed:AC2']);
  });
}

test('M2 R1.5: read-only missing report + failed check exposes check_failed in result and status', async t => {
  const h = tmpRepo(t, 'no_json', { sandbox: 'read-only', acceptance_criteria: [{ id: 'AC1', text: 'Fails', check_cmd: 'exit 7' }] });
  const done = await h.wait((await h.launch()).job_id);
  const value = h.result(done.job_id);
  for (const record of [done, value]) {
    assert.equal(record.state, 'failed');
    assert.equal(record.failure_reason, 'check_failed:AC1');
    assert.deepEqual(record.failure_reasons, ['worker_result_missing', 'check_failed:AC1']);
  }
  assert.deepEqual(value.worker_result_warnings, ['worker_result_missing']);
  assert.deepEqual(JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'job.json'), 'utf8')).failure_reasons, value.failure_reasons);
});

for (const boundary of ['writable', 'invalid', 'exit', 'provider', 'policy'] as const) {
  test(`M2 R1.5: missing-report/check exception does not override ${boundary}`, () => {
    const outcome = finalOutcome(boundary === 'exit' ? 7 : 0, null, boundary === 'policy' ? ['readonly_modified'] : [],
      undefined, failedChecks, boundary === 'provider' ? 'provider_error: failed' : null,
      boundary === 'invalid' ? 'worker_result_invalid: json' : 'worker_result_missing', false, boundary !== 'writable');
    const expected = boundary === 'exit' ? 'worker_exit_nonzero:7' : boundary === 'provider' ? 'provider_error: failed'
      : boundary === 'invalid' ? 'worker_result_invalid: json' : 'worker_result_missing';
    assert.equal(outcome.failure_reason, expected);
    assert.ok(outcome.failure_reasons.includes('check_failed:AC1'));
  });
}

test('M2 R1.5: successful read-only delivery has empty failure_reasons', async t => {
  const h = tmpRepo(t, 'no_json', { sandbox: 'read-only', acceptance_criteria: [] });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.failure_reasons, []);
  assert.deepEqual(h.result(done.job_id).failure_reasons, []);
});

for (const state of ['failed', 'blocked', 'timeout', 'succeeded'] as const) {
  test(`M2 R1.5/R1.6: legacy ${state} fields default on read without rewriting files`, async t => {
    const h = tmpRepo(t);
    const store = new JobStore(resolvePaths(h.env));
    const oldStatus = { ...job(), repo: h.repo, worktree: h.repo, state,
      state_history: [{ state, at: job().created_at, by: 'gbdev' }], failure_reason: state === 'succeeded' ? null : `old_${state}` };
    store.create(structuredClone(oldStatus));
    const oldResult = { ...result(), state, failure_reason: oldStatus.failure_reason };
    const jobFile = join(h.jobDir(oldStatus.job_id), 'job.json');
    const resultFile = join(h.jobDir(oldStatus.job_id), 'result.json');
    const statusBytes = JSON.stringify(oldStatus), resultBytes = JSON.stringify(oldResult);
    writeFileSync(jobFile, statusBytes);
    writeFileSync(resultFile, resultBytes);
    const statusRead = validateJobStatus(unwrap((await h.command(['status', oldStatus.job_id])).envelope));
    const resultRead = validateJobResult(unwrap((await h.command(['result', oldStatus.job_id])).envelope));
    assert.deepEqual(statusRead.failure_reasons, state === 'failed' ? [`old_${state}`] : []);
    assert.deepEqual(resultRead.failure_reasons, statusRead.failure_reasons);
    assert.equal(statusRead.pipeline_id, null);
    assert.equal(statusRead.step_instance, null);
    assert.equal(statusRead.attempt, null);
    assert.equal(readFileSync(jobFile, 'utf8'), statusBytes);
    assert.equal(readFileSync(resultFile, 'utf8'), resultBytes);
  });
}

test('M2 R1.6: omitted check_cmd validates, executes no checks, and standalone metadata stays null', async t => {
  const h = tmpRepo(t, 'no_json', { sandbox: 'read-only', acceptance_criteria: [{ id: 'AC1', text: 'Read-only assessment' }] });
  validateBrief(h.task, validateConfig({ version: 1, allowed_repos: [h.repo] }));
  const started = await h.launch();
  const done = await h.wait(started.job_id);
  const cancelled = validateJobStatus(unwrap((await h.command(['cancel', done.job_id])).envelope));
  for (const status of [started, done, cancelled, h.getJob(done.job_id)]) {
    assert.equal(status.pipeline_id, null);
    assert.equal(status.step_instance, null);
    assert.equal(status.attempt, null);
  }
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(h.result(done.job_id).gbdev_observed.checks, []);
  assert.deepEqual(readdirSync(join(h.jobDir(done.job_id), 'checks')), []);
});

test('M2 R1.6: metadata round trips and rejects invalid types/attempts', t => {
  const h = tmpRepo(t);
  const store = new JobStore(resolvePaths(h.env));
  const status = { ...job(), pipeline_id: 'p_20261026_1011_9c2e', step_instance: 'implement#1', attempt: 1 };
  store.create(status);
  assert.deepEqual(store.read(status.job_id), status);
  status.attempt = 2;
  store.write(status);
  assert.equal(store.read(status.job_id).attempt, 2);
  for (const change of [{ pipeline_id: 7 }, { step_instance: '' }, { attempt: 0 }, { attempt: 1.5 }, { failure_reasons: [''] }]) {
    assert.throws(() => validateJobStatus({ ...status, ...change }));
  }
});

test('M2 R1.2: default/worktree timeouts and timeout errors propagate through Git entrypoints', t => {
  const h = tmpRepo(t);
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { git, addWorktree, resolveBase } from ${JSON.stringify(new URL('../src/core/git.js', import.meta.url).href)};
    const calls = [];
    childProcess.execFileSync = (bin, args, options) => { calls.push({ bin, args, options }); return 'sha'; };
    syncBuiltinESMExports();
    git(${JSON.stringify(h.repo)}, ['status']);
    addWorktree(${JSON.stringify(h.repo)}, 'test-branch', ${JSON.stringify(join(h.root, 'worktree'))}, 'sha');
    assert.deepEqual(calls.map(call => call.options.timeout), [120000, 300000]);
    assert.ok(calls.every(call => call.options.killSignal === 'SIGKILL'));
    assert.ok(calls.every(call => call.bin === 'git' && call.args.includes('core.hooksPath=/dev/null')));
    childProcess.execFileSync = () => { throw Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }); };
    syncBuiltinESMExports();
    for (const run of [() => git(${JSON.stringify(h.repo)}, ['status']),
      () => resolveBase(${JSON.stringify(h.repo)}, 'HEAD'),
      () => addWorktree(${JSON.stringify(h.repo)}, 'test-branch', ${JSON.stringify(join(h.root, 'worktree'))}, 'sha')]) {
      assert.throws(run, error => error.contract.code === 'internal_error' && error.contract.details.git_timeout === true);
    }
  `], { env: h.env, encoding: 'utf8', timeout: 3000 });
  assert.equal(output.status, 0, output.stderr);
});

test('M2 R1: README JSON examples remain valid v1 contracts', t => {
  const h = tmpRepo(t);
  const config = validateConfig({ version: 1, allowed_repos: [h.repo] });
  const blocks = [...readFileSync(resolve('docs/reference.md'), 'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.ok(blocks.length >= 5);
  for (const [, text] of blocks) {
    const value = JSON.parse(text!);
    if (value.schema === 'gbdev.task-brief.v1') validateBrief({ ...value, repo: h.repo }, config);
    else if (value.schema === 'gbdev.role.v1') validateRole({ ...builtinRoles().find(role => role.name === value.name), ...value });
    else if (value.schema === 'gbdev.pipeline.v1') validatePipeline(value, new PipelineRegistry(h.config).roles);
    else if (value.schema === 'gbdev.pipeline-request.v1') resolveRequest({ ...value, repo: h.repo, step_overrides: { implement: { provider: 'fake' }, review: { provider: 'fake' }, fix: { provider: 'fake' } } }, config, new PipelineRegistry(h.config));
    else if (Object.keys(value).every(k => /^[a-z][a-z0-9-]*#[1-9][0-9]*$/.test(k)) && Object.keys(value).length > 0) assert.ok(Object.values(value).every(s => (FAKE_SCENARIOS as readonly unknown[]).includes(s)));
    else if (value.schema === 'gbdev.pipeline-resume.v1') validatePipelineResume(value, value.pipeline_id);
    else if (value.schema === 'gbdev.job-result.v1') validateJobResult(value);
    else if (value.schema === 'gbdev.worker-result.v1') validateWorkerResult(value);
    else if (value.contract_version) validateEnvelope(value);
    else if ('source' in value && 'findings' in value) validateSeedFindings(value);
    else validateConfig(value, new PipelineRegistry(h.config));
  }
});
