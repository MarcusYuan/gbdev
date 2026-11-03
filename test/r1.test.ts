import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { validateJobStatus } from '../src/contracts/jobStatus.js';
import { validateJobResult } from '../src/contracts/jobResult.js';
import { extractWorkerResult } from '../src/contracts/workerResult.js';
import { validateConfig } from '../src/core/config.js';
import { renderPrompt } from '../src/core/prompt.js';
import { codex } from '../src/providers/codex.js';
import { cursorMetadata, extractCursorResult } from '../src/providers/cursor.js';
import { brief, errorCode, job, result, temporary, worker } from './helpers.js';
import { providerStub } from './helpers/providerStub.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';

const variant = {
  schema: 'gbdev.worker-result.v1', status: 'succeeded', summary: 'Real worker shape',
  commits: [{ hash: '123456789abcdef', message: 'feat: hello', extra: true }],
  tests: [{ command: 'npm test', status: 'passed', detail: 'ok' }, { check: 'AC1', status: 'failed' }],
  evidence: [{ type: 'test', command: 'npm test', output: 'passed', detail: 'Details' }],
  extra: 'ignored',
};

test('P1: normalize real object commits, command/check tests, evidence, missing arrays and unknown fields', () => {
  const warnings: string[] = [];
  const value = extractWorkerResult(JSON.stringify(variant), warnings);
  assert.deepEqual(value.commits, ['1234567 feat: hello']);
  assert.deepEqual(value.tests, [
    { cmd: 'npm test', exit_code: 0, passed: true }, { cmd: 'AC1', exit_code: 1, passed: false },
  ]);
  assert.deepEqual(value.evidence, [{ criterion_id: 'unspecified', kind: 'test', ref: 'npm test', note: 'Details\npassed' }]);
  for (const field of ['files_changed', 'open_questions', 'blockers', 'policy_violations'] as const) assert.deepEqual(value[field], []);
  for (const fragment of ['commits[0]', 'command converted', 'check converted', 'status converted', 'provider evidence', 'missing array', 'ignored unknown']) {
    assert.ok(warnings.some(x => x.includes(fragment)), fragment);
  }
  assert.equal('extra' in value, false);
  const canonicalWarnings: string[] = [];
  assert.deepEqual(extractWorkerResult(JSON.stringify(worker()), canonicalWarnings), worker());
  assert.deepEqual(canonicalWarnings, []);
});

test('P1: prompt includes complete element examples and Codex writes recursively strict schema', t => {
  const prompt = renderPrompt(brief('/repo'));
  const example = extractWorkerResult(prompt);
  for (const key of ['commits', 'tests', 'evidence', 'open_questions', 'blockers', 'policy_violations'] as const) assert.equal(example[key].length, 1, key);
  const dir = temporary(t);
  codex.prepareJob!(dir);
  const schema = JSON.parse(readFileSync(join(dir, 'worker-result.schema.json'), 'utf8'));
  const inspect = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(node.required.sort(), Object.keys(node.properties).sort());
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect); else inspect(value);
    }
  };
  inspect(schema);
  assert.equal(schema.properties.schema.const, 'gbdev.worker-result.v1');
});

function stubJob(t: Parameters<typeof tmpRepo>[0], provider: 'codex' | 'cursor', extraEnv: NodeJS.ProcessEnv = {}) {
  const h = tmpRepo(t, 'ok', { provider, acceptance_criteria: [{ id: 'AC1', text: 'Pass check', check_cmd: 'exit 0' }] }, extraEnv);
  const stub = providerStub(h.root);
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { codex: { bin: stub }, cursor: { bin: stub } } }));
  return h;
}

test('P1: exit zero + normalized succeeded report + passing AC succeeds with warnings in result', async t => {
  const h = stubJob(t, 'codex', { GBDEV_STUB_REPORT: JSON.stringify({ ...variant, tests: variant.tests.slice(0, 1) }) });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded');
  const result = h.result(done.job_id);
  assert.equal(result.failure_reason, null);
  assert.equal(done.failure_reason, null);
  assert.equal(result.worker_exit_code, 0);
  assert.equal(result.worker_reported?.commits[0], '1234567 feat: hello');
  assert.ok(result.worker_result_warnings.length > 0);
  assert.ok(existsSync(join(h.jobDir(done.job_id), 'worker-result.schema.json')));
});

for (const scenario of ['no_json', 'crash', 'blocked'] as const) {
  test(`P1: ${scenario} has visible failure_reason in both status and result`, async t => {
    const h = tmpRepo(t, scenario, { acceptance_criteria: [] });
    const done = await h.wait((await h.launch()).job_id);
    const result = h.result(done.job_id);
    assert.equal(done.state, scenario === 'blocked' ? 'blocked' : 'failed');
    assert.ok(done.failure_reason);
    assert.equal(result.failure_reason, done.failure_reason);
    if (scenario === 'no_json') assert.equal(done.failure_reason, 'worker_result_missing');
  });
}

test('P1: invalid worker field is explained in status and result', async t => {
  const h = stubJob(t, 'codex', { GBDEV_STUB_REPORT: JSON.stringify({ ...worker(), tests: [{ command: 123, status: 'passed' }] }) });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'failed');
  assert.match(done.failure_reason!, /^worker_result_invalid: .*tests\[0\]\.cmd/);
  assert.equal(h.result(done.job_id).failure_reason, done.failure_reason);
  assert.equal(h.result(done.job_id).worker_reported, null);
});

test('P1: failed AC overrides a successful report with check_failed:AC1', async t => {
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [{ id: 'AC1', text: 'Fails', check_cmd: 'exit 7' }] });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'failed');
  assert.equal(done.failure_reason, 'check_failed:AC1');
  assert.equal(h.result(done.job_id).failure_reason, 'check_failed:AC1');
  assert.equal(h.result(done.job_id).worker_reported?.status, 'succeeded');
});

test('P1: exit zero cannot hide worker failure', async t => {
  const h = stubJob(t, 'codex', { GBDEV_STUB_REPORT: JSON.stringify({ ...worker(), status: 'failed' }) });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'failed');
  assert.equal(done.failure_reason, 'worker_reported_failed');
  assert.equal(h.result(done.job_id).failure_reason, done.failure_reason);
});

test('P1/O13: exit zero with unobserved worker policy self-report succeeds with warning', async t => {
  const h = stubJob(t, 'codex', { GBDEV_STUB_REPORT: JSON.stringify({ ...worker(), policy_violations: ['reported_violation'] }) });
  const done = await h.wait((await h.launch()).job_id);
  const result = h.result(done.job_id);
  assert.equal(done.state, 'succeeded');
  assert.equal(result.state, 'succeeded');
  assert.equal(done.failure_reason, null);
  assert.equal(result.failure_reason, null);
  assert.equal(result.worker_exit_code, 0);
  assert.ok(result.worker_result_warnings.includes('policy_self_report:reported_violation'));
});

test('P1: exit zero cannot hide gbdev-observed worker policy violations', async t => {
  const h = stubJob(t, 'codex', { GBDEV_STUB_REPORT: JSON.stringify(worker()) });
  appendFileSync(join(h.root, 'stub-bin', 'provider-stub.mjs'), '\nwriteFileSync("outside.txt", "worker change");\n');
  const done = await h.wait((await h.launch()).job_id);
  const result = h.result(done.job_id);
  assert.equal(done.state, 'failed');
  assert.equal(result.state, 'failed');
  assert.equal(result.worker_exit_code, 0);
  assert.equal(result.worker_reported?.status, 'succeeded');
  assert.deepEqual(result.worker_reported?.policy_violations, []);
  assert.deepEqual(result.gbdev_observed.outside_allowed_paths, ['outside.txt']);
  assert.ok(result.gbdev_observed.policy_violations.includes('outside_allowed_paths'));
  assert.match(done.failure_reason!, /^policy_violations:/);
  assert.equal(result.failure_reason, done.failure_reason);
});

test('P2: Workspace Trust Required in worker.log gets provider_trust_required', async t => {
  const h = stubJob(t, 'cursor', { GBDEV_STUB_TRUST_ERROR: '1' });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'failed');
  assert.equal(done.failure_reason, 'provider_trust_required');
  assert.equal(h.result(done.job_id).failure_reason, done.failure_reason);
});

for (const model of [null, 'auto', 'other', '', 12]) {
  test(`P3: start Cursor model=${JSON.stringify(model)} enforces auto before job creation`, async t => {
    const h = stubJob(t, 'cursor');
    writeFileSync(h.briefFile, JSON.stringify({ ...h.task, model }));
    const output = await h.command(['start', '--brief', h.briefFile]);
    if (model === null || model === 'auto') {
      assert.equal(output.exit, 0);
      const done = await h.wait((unwrap(output.envelope) as { job_id: string }).job_id);
      assert.equal(done.state, 'succeeded');
    } else {
      assert.equal(output.exit, 2);
      assert.equal(output.envelope.ok, false);
      if (!output.envelope.ok) assert.equal(output.envelope.error.code, 'cursor_model_not_allowed');
      assert.equal(existsSync(join(h.home, 'jobs')), false);
      assert.equal(h.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
    }
  });
}

test('P3: config cursor model accepts only auto, including when bin is omitted', () => {
  for (const model of ['auto', undefined]) assert.doesNotThrow(() => validateConfig({ version: 1, providers: { cursor: { model } } }));
  for (const model of [null, 'other', '', 42]) assert.throws(() => validateConfig({ version: 1, providers: { cursor: { model } } }), errorCode('cursor_model_not_allowed'));
});

test('P4: confirmed Cursor fixture extracts .result and session metadata', t => {
  const raw = readFileSync(resolve('test/fixtures/cursor-result.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(extractWorkerResult(extractCursorResult(parsed)!).status, 'succeeded');
  const dir = temporary(t);
  writeFileSync(join(dir, 'raw.json'), raw);
  assert.deepEqual(cursorMetadata(dir), { session_id: 'cursor-real-shape-session', failure_reason: null });
});

for (const env of [{ GBDEV_STUB_IS_ERROR: '1' }, { GBDEV_STUB_SUBTYPE: 'error_during_execution' }]) {
  test(`P4: Cursor error envelope is failed even with successful worker report (${JSON.stringify(env)})`, async t => {
    const h = stubJob(t, 'cursor', env);
    const done = await h.wait((await h.launch()).job_id);
    assert.equal(done.state, 'failed');
    assert.equal(done.session_id, 'stub-session-id');
    assert.equal(done.failure_reason, `provider_error: ${env.GBDEV_STUB_SUBTYPE ?? 'is_error'}`);
    assert.equal(h.result(done.job_id).failure_reason, done.failure_reason);
  });
}

test('P5: doctor runs codex login status and reports only non-sensitive exit metadata', async t => {
  const h = stubJob(t, 'codex');
  const { checks } = unwrap((await h.command(['doctor'])).envelope) as { checks: { name: string; ok: boolean; detail: string }[] };
  assert.deepEqual(checks.find(c => c.name === 'codex_login'), { name: 'codex_login', ok: true, detail: 'exit_code=0' });
});

for (const provider of ['codex', 'cursor'] as const) {
  test(`P6: cleanup ${provider} job dry-run preserves all bytes/refs, then removes worktree and branch`, async t => {
    const h = stubJob(t, provider);
    const done = await h.wait((await h.launch()).job_id);
    const statusBefore = readFileSync(join(h.jobDir(done.job_id), 'job.json'), 'utf8');
    const resultBefore = readFileSync(join(h.jobDir(done.job_id), 'result.json'), 'utf8');
    const worktrees = h.git('worktree', 'list', '--porcelain');
    const branches = h.git('show-ref', '--heads');
    for (const force of [[], ['--force-branch']]) {
      const plan = unwrap((await h.command(['cleanup', done.job_id, '--dry-run', ...force])).envelope) as Record<string, unknown>;
      assert.equal(plan.dry_run, true);
      assert.equal(plan.worktree_removed, false);
      assert.equal(plan.branch_deleted, false);
      assert.equal(plan.would_remove_worktree, true);
      assert.equal(plan.would_delete_branch, true); // stub makes no commits, so branch is merged
      assert.equal(plan.branch_retained, false);
      assert.equal(h.git('worktree', 'list', '--porcelain'), worktrees);
      assert.equal(h.git('show-ref', '--heads'), branches);
      assert.equal(readFileSync(join(h.jobDir(done.job_id), 'job.json'), 'utf8'), statusBefore);
    }
    const cleaned = unwrap((await h.command(['cleanup', done.job_id, '--force-branch'])).envelope) as Record<string, unknown>;
    assert.equal(cleaned.worktree_removed, true);
    assert.equal(cleaned.branch_deleted, true);
    assert.equal(existsSync(done.worktree), false);
    assert.throws(() => h.git('show-ref', '--verify', `refs/heads/${done.branch}`));
    assert.equal(readFileSync(join(h.jobDir(done.job_id), 'result.json'), 'utf8'), resultBefore);
  });
}

test('P6: dry-run plans an unmerged branch accurately and refuses dirty worktrees', async t => {
  const h = tmpRepo(t);
  const done = await h.wait((await h.launch()).job_id);
  for (const force of [false, true]) {
    const plan = unwrap((await h.command(['cleanup', done.job_id, '--dry-run', ...(force ? ['--force-branch'] : [])])).envelope) as Record<string, unknown>;
    assert.equal(plan.would_delete_branch, force);
    assert.equal(plan.branch_retained, !force);
    assert.equal(plan.would_remove_worktree, true);
    assert.equal(existsSync(done.worktree), true);
    assert.ok(h.git('show-ref', '--verify', `refs/heads/${done.branch}`));
  }
  writeFileSync(join(done.worktree, 'keep.txt'), 'keep');
  const output = await h.command(['cleanup', done.job_id, '--dry-run', '--force-branch']);
  assert.equal(output.exit, 1);
  if (!output.envelope.ok) assert.equal(output.envelope.error.code, 'cleanup_refused');
  assert.equal(readFileSync(join(done.worktree, 'keep.txt'), 'utf8'), 'keep');
});


test('P1 compatibility: old failed/timeout/blocked v1 records expose missing metadata without inventing causes', () => {
  for (const state of ['failed', 'timeout', 'blocked'] as const) {
    const status = validateJobStatus({ ...job(), state, state_history: [{ state, at: job().created_at, by: 'gbdev' }] });
    const old: Record<string, unknown> = { ...result(), state };
    delete old.failure_reason;
    delete old.worker_result_warnings;
    const value = validateJobResult(old);
    assert.equal(status.failure_reason, state === 'timeout' ? 'timeout' : 'legacy_failure_reason_missing');
    assert.equal(value.failure_reason, status.failure_reason);
    assert.deepEqual(value.worker_result_warnings, []);
    assert.equal(value.state, state);
  }
});

test('P1 compatibility: CLI reads legacy result/status without rewriting persisted artifacts or rejudging state', async t => {
  const h = tmpRepo(t);
  const done = await h.wait((await h.launch()).job_id);
  const jobFile = join(h.jobDir(done.job_id), 'job.json');
  const resultFile = join(h.jobDir(done.job_id), 'result.json');
  const oldStatus: Record<string, unknown> = { ...done, state: 'failed',
    state_history: [...done.state_history.slice(0, -1), { ...done.state_history.at(-1), state: 'failed' }] };
  const oldResult: Record<string, unknown> = { ...h.result(done.job_id), state: 'failed' };
  delete oldStatus.failure_reason;
  delete oldResult.failure_reason;
  delete oldResult.worker_result_warnings;
  const jobBytes = JSON.stringify(oldStatus);
  const resultBytes = JSON.stringify(oldResult);
  writeFileSync(jobFile, jobBytes);
  writeFileSync(resultFile, resultBytes);
  const status = unwrap((await h.command(['status', done.job_id])).envelope) as { failure_reason: string };
  const value = unwrap((await h.command(['result', done.job_id])).envelope) as { failure_reason: string; worker_result_warnings: string[] };
  assert.equal(status.failure_reason, 'legacy_failure_reason_missing');
  assert.equal(value.failure_reason, status.failure_reason);
  assert.deepEqual(value.worker_result_warnings, []);
  assert.equal(readFileSync(jobFile, 'utf8'), jobBytes);
  assert.equal(readFileSync(resultFile, 'utf8'), resultBytes);
});
