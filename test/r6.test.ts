import { captureWorkspaceSnapshotSync, WORKSPACE_BEFORE } from '../src/core/workspaceSnapshot.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validateBrief } from '../src/contracts/brief.js';
import { validateCleanupResult, validateDoctorResult } from '../src/contracts/commandResults.js';
import { ERROR_RETRYABLE } from '../src/contracts/error.js';
import { validateConfig } from '../src/core/config.js';
import { finalize } from '../src/core/finalize.js';
import { JobStore } from '../src/core/jobStore.js';
import { isProcessAlive } from '../src/core/lock.js';
import { resolvePaths } from '../src/core/paths.js';
import { groupAlive } from '../src/core/proc.js';
import { renderPrompt } from '../src/core/prompt.js';
import { brief, errorCode, job, temporary } from './helpers.js';
import { eventually, tmpRepo, unwrap } from './helpers/tmpRepo.js';

for (const route of ['no-commits', 'merged', 'force'] as const) {
  for (const checkout of ['main', 'other-worktree'] as const) {
    test(`I1: ${route} branch checked out in ${checkout} is retained in dry-run and cleanup`, async t => {
      const h = tmpRepo(t, route === 'no-commits' ? 'needs_input' : 'dirty_exit', { acceptance_criteria: [] });
      const done = await h.wait((await h.launch()).job_id);
      const tip = h.git('rev-parse', done.branch).trim();
      if (route === 'merged') h.git('branch', 'integrated', done.branch);
      h.git('worktree', 'remove', done.worktree);
      if (checkout === 'main') h.git('checkout', done.branch);
      else h.git('worktree', 'add', join(h.root, 'other worktree'), done.branch);
      const flags = route === 'force' ? ['--force-branch'] : [];
      const plan = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id, '--dry-run', ...flags])).envelope));
      assert.equal(plan.would_delete_branch, false);
      assert.equal(plan.branch_retained, true);
      assert.equal(plan.branch_retained_reason, 'checked_out');
      const output = await h.command(['cleanup', done.job_id, ...flags]);
      assert.equal(output.exit, 0);
      assert.deepEqual(validateCleanupResult(unwrap(output.envelope)), {
        job_id: done.job_id, worktree_removed: false, branch_deleted: false,
        branch_retained: true, branch_retained_reason: 'checked_out',
      });
      assert.equal(h.git('rev-parse', done.branch).trim(), tip);
    });
  }
}

test('I1: removes own worktree but retains a branch also checked out elsewhere', async t => {
  const h = tmpRepo(t, 'needs_input', { acceptance_criteria: [] });
  const done = await h.wait((await h.launch()).job_id);
  h.git('worktree', 'add', '--force', join(h.root, 'other'), done.branch);
  const plan = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id, '--dry-run'])).envelope));
  assert.equal(plan.would_remove_worktree, true);
  assert.equal(plan.would_delete_branch, false);
  const cleaned = validateCleanupResult(unwrap((await h.command(['cleanup', done.job_id])).envelope));
  assert.equal(cleaned.worktree_removed, true);
  assert.equal(cleaned.branch_retained_reason, 'checked_out');
  assert.equal(h.git('rev-parse', done.branch).trim(), done.base_sha);
});

for (const sandbox of ['read-only', 'workspace-write'] as const) {
  test(`I4: nonempty final without worker JSON in ${sandbox}`, async t => {
    const h = tmpRepo(t, 'no_json', { sandbox, acceptance_criteria: [{ id: 'AC1', text: 'Pass', check_cmd: 'true' }] });
    const done = await h.wait((await h.launch()).job_id);
    const result = h.result(done.job_id);
    assert.equal(done.state, sandbox === 'read-only' ? 'succeeded' : 'failed');
    assert.equal(result.state, done.state);
    assert.equal(result.failure_reason, sandbox === 'read-only' ? null : 'worker_result_missing');
    assert.equal(result.worker_reported, null);
    assert.equal(result.worker_exit_code, 0);
    assert.deepEqual(result.worker_result_warnings, sandbox === 'read-only' ? ['worker_result_missing'] : []);
    assert.equal(result.gbdev_observed.checks[0]!.exit_code, 0);
    assert.match(readFileSync(result.paths.final_message, 'utf8'), /No structured report/);
    const events = readFileSync(result.paths.events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.type === 'warning' && event.data.code === 'result_missing'));
    assert.equal(JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'brief.json'), 'utf8')).stall_timeout_s, sandbox === 'read-only' ? 900 : 600);
    const prompt = readFileSync(join(h.jobDir(done.job_id), 'prompt.md'), 'utf8');
    if (sandbox === 'read-only') assert.match(prompt, /Even for a read-only review, the last paragraph MUST be this json block/);
    else assert.doesNotMatch(prompt, /Even for a read-only review/);
  });
}

for (const boundary of ['empty', 'missing', 'invalid', 'modified', 'failed-check', 'nonzero-exit', 'provider-error'] as const) {
  test(`I4: read-only missing-report exception refuses ${boundary}`, async t => {
    const h = tmpRepo(t, 'no_json', { sandbox: 'read-only', acceptance_criteria: [] });
    const store = new JobStore(resolvePaths(h.env));
    const status = { ...job(), state: 'running' as const, repo: h.repo, worktree: h.repo,
      state_history: [{ state: 'running' as const, at: job().created_at, by: 'gbdev' }],
      provider: boundary === 'provider-error' ? 'cursor' as const : 'fake' as const,
      sandbox: 'read-only' as const, base_sha: h.git('rev-parse', 'HEAD').trim() };
    store.create(status);
    const dir = h.jobDir(status.job_id);
    writeFileSync(join(dir, WORKSPACE_BEFORE), JSON.stringify(captureWorkspaceSnapshotSync(h.repo, { job_id: status.job_id, phase: 'before_worker' })));
    const message = boundary === 'empty' ? ' \n' : boundary === 'invalid' ? '```json\n{bad}\n```' : 'A useful review.';
    if (boundary !== 'missing') writeFileSync(join(dir, 'final.md'), message);
    if (boundary === 'modified') writeFileSync(join(h.repo, 'src', 'changed.txt'), 'changed');
    if (boundary === 'provider-error') writeFileSync(join(dir, 'raw.json'), JSON.stringify({ subtype: 'error', is_error: true }));
    const task = { ...h.task, acceptance_criteria: boundary === 'failed-check' ? [{ id: 'AC1', text: 'Fail', check_cmd: 'exit 7' }] : [] };
    const result = await finalize(store, status, task, boundary === 'nonzero-exit' ? 23 : 0);
    assert.equal(result.state, 'failed');
    assert.equal(result.worker_reported, null);
    assert.equal(result.worker_result_warnings.includes('worker_result_missing'), boundary === 'failed-check');
    if (boundary === 'invalid') assert.match(result.failure_reason!, /^worker_result_invalid:/);
    else assert.equal(result.failure_reason, boundary === 'nonzero-exit' ? 'worker_exit_nonzero:23' :
      boundary === 'provider-error' ? 'provider_error: error' : boundary === 'failed-check' ? 'check_failed:AC1' : 'worker_result_missing');
  });
}

test('I5: stall timeout validates nonnegative integer seconds and config defaults', t => {
  const repo = temporary(t);
  const defaults = validateConfig({ version: 1, allowed_repos: [repo] });
  assert.equal(defaults.default_stall_timeout_s, 600);
  for (const seconds of [0, 1, 600]) {
    assert.equal(validateConfig({ version: 1, default_stall_timeout_s: seconds }).default_stall_timeout_s, seconds);
    assert.equal(validateBrief({ ...brief(repo), stall_timeout_s: seconds }, defaults).stall_timeout_s, seconds);
  }
  for (const invalid of [-1, 0.5, '10', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateConfig({ version: 1, default_stall_timeout_s: invalid }), errorCode('config_invalid'));
    assert.throws(() => validateBrief({ ...brief(repo), stall_timeout_s: invalid }, defaults), errorCode('config_invalid'));
  }
  assert.match(renderPrompt({ ...brief(repo), sandbox: 'read-only' }), /last paragraph MUST/);
  assert.equal(ERROR_RETRYABLE.worker_stalled, true);
});

for (const source of ['brief', 'role'] as const) {
  test(`I5: ${source} watchdog kills silent fake provider process group with worker_stalled`, async t => {
    const h = tmpRepo(t, 'slow', { acceptance_criteria: [], ...(source === 'brief' ? { stall_timeout_s: 1 } : {}) });
    if (source === 'role') {
      mkdirSync(join(h.root, 'roles'));
      writeFileSync(join(h.root, 'roles', 'executor.json'), JSON.stringify({ schema: 'gbdev.role.v1', name: 'executor', default_stall_timeout_s: 1 }));
    }
    const started = await h.launch();
    const done = await h.wait(started.job_id);
    const result = h.result(done.job_id);
    assert.equal(done.state, 'failed');
    assert.equal(done.failure_reason, 'worker_stalled');
    assert.equal(result.failure_reason, 'worker_stalled');
    assert.ok(result.duration_s < 15, `stalled job took ${result.duration_s}s`);
    const pids = JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'fake-processes.json'), 'utf8'));
    assert.equal(groupAlive(pids.worker), false);
    await eventually(() => !isProcessAlive(pids.worker) && !isProcessAlive(pids.descendant) ? true : undefined);
    assert.ok(readFileSync(result.paths.events, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .some(event => event.type === 'warning' && event.data.code === 'worker_stalled' && event.data.retryable === true));
    assert.equal(JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'brief.json'), 'utf8')).stall_timeout_s, 1);
  });
}

for (const mode of ['stdout', 'stderr', 'disabled'] as const) {
  test(`I5: ${mode} keeps a live fake provider from being marked stalled`, async t => {
    const stallSeconds = 8, runtimeMs = (stallSeconds + 2) * 1000;
    const h = tmpRepo(t, 'no_json', { provider: 'cursor', sandbox: 'read-only', stall_timeout_s: mode === 'disabled' ? 0 : stallSeconds, acceptance_criteria: [] });
    const bin = join(h.root, 'output-provider.mjs');
    // Allow scheduler jitter while keeping the provider alive beyond the stall
    // window. Silent-provider tests above retain the smaller one-second window.
    writeFileSync(bin, `#!${process.execPath}
console.log(JSON.stringify({ type: 'started', session_id: 'live-session' }));
${mode === 'disabled' ? '' : `const heartbeat = setInterval(() => process.${mode}.write('heartbeat\\n'), 100);`}
setTimeout(() => {
  ${mode === 'disabled' ? '' : 'clearInterval(heartbeat);'}
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Review complete.' }));
}, ${runtimeMs});
`, { mode: 0o700 });
    writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { cursor: { bin } }, default_stall_timeout_s: stallSeconds }));
    const done = await h.wait((await h.launch()).job_id);
    assert.equal(done.state, 'succeeded', JSON.stringify({ result: h.result(done.job_id),
      raw: readFileSync(join(h.jobDir(done.job_id), 'raw.json'), 'utf8'),
      log: readFileSync(join(h.jobDir(done.job_id), 'worker.log'), 'utf8'),
      supervisor: readFileSync(join(h.jobDir(done.job_id), 'supervisor.log'), 'utf8') }));
    assert.equal(h.result(done.job_id).failure_reason, null);
    assert.ok(h.result(done.job_id).duration_s >= runtimeMs / 1000, 'provider must outlive the enabled stall window');
    if (mode !== 'disabled') assert.match(readFileSync(join(h.jobDir(done.job_id), mode === 'stdout' ? 'raw.json' : 'worker.log'), 'utf8'), /heartbeat/);
    const events = readFileSync(join(h.jobDir(done.job_id), 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(!events.some(event => event.type === 'warning' && event.data.code === 'worker_stalled'));
  });
}

test('nit: doctor git version uses git helper with hooks disabled', async t => {
  const h = tmpRepo(t);
  const realGit = execFileSync('/usr/bin/which', ['git'], { env: h.env, encoding: 'utf8' }).trim();
  const bin = join(h.root, 'git-bin');
  const log = join(h.root, 'git-args.json');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const child = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(child.status ?? 1);
`, { mode: 0o700 });
  h.env.PATH = bin; // Keep doctor from finding any real model clients.
  const output = await h.command(['doctor']);
  const checks = validateDoctorResult(unwrap(output.envelope)).checks;
  assert.equal(checks.find(check => check.name === 'git')!.ok, true);
  const calls: string[][] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls[0]!.slice(-3), ['-c', 'core.hooksPath=/dev/null', '--version']);
  assert.ok(calls.some(args => args.includes('merge-tree')));
  for (const args of calls) assert.ok(args.includes('core.hooksPath=/dev/null'));
  assert.equal(existsSync(log), true);
});
