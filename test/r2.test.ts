import { captureWorkspaceSnapshotSync, WORKSPACE_BEFORE } from '../src/core/workspaceSnapshot.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { extractWorkerResult, validateWorkerResult } from '../src/contracts/workerResult.js';
import { workerResultSchema } from '../src/contracts/workerResultSchema.js';
import { finalize } from '../src/core/finalize.js';
import { JobStore } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { renderPrompt } from '../src/core/prompt.js';
import { cursorMetadata, providerFailureReason } from '../src/providers/cursor.js';
import { brief, job, temporary, worker } from './helpers.js';
import { providerStub } from './helpers/providerStub.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';

function stubJob(t: Parameters<typeof tmpRepo>[0], provider: 'codex' | 'cursor', env: NodeJS.ProcessEnv = {}) {
  const h = tmpRepo(t, 'ok', { provider, acceptance_criteria: [] }, env);
  const stub = providerStub(h.root);
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { codex: { bin: stub }, cursor: { bin: stub } } }));
  return h;
}

for (const status of ['needs_input', 'blocked'] as const) {
  test(`D1: ${status} survives failed checks, worker exit and explicit Cursor error; checks remain recorded`, async t => {
    const report = { ...worker(), status, blockers: [{ kind: 'env', detail: 'Need scheduler help' }] };
    const h = stubJob(t, 'cursor', { GBDEV_STUB_REPORT: JSON.stringify(report), GBDEV_STUB_EXIT: '23', GBDEV_STUB_IS_ERROR: '1' });
    writeFileSync(h.briefFile, JSON.stringify({ ...h.task, acceptance_criteria: [{ id: 'AC1', text: 'Fail', check_cmd: 'exit 7' }] }));
    const done = await h.wait((await h.launch()).job_id);
    const result = h.result(done.job_id);
    assert.equal(done.state, status);
    assert.equal(result.state, status);
    assert.equal(result.worker_exit_code, 23);
    assert.equal(done.failure_reason, status === 'blocked' ? 'worker_blocked: Need scheduler help' : null);
    assert.equal(result.failure_reason, done.failure_reason);
    assert.deepEqual(result.gbdev_observed.checks, [{ id: 'AC1', cmd: 'exit 7', exit_code: 7, log: 'checks/AC1.log' }]);
  });
}

test('D2: Cursor success without subtype succeeds and persists session_id in job.json', async t => {
  const h = stubJob(t, 'cursor', { GBDEV_STUB_OMIT_SUBTYPE: '1' });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded');
  assert.equal(h.result(done.job_id).failure_reason, null);
  const persisted = JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'job.json'), 'utf8'));
  assert.equal(persisted.session_id, 'stub-session-id');
});

for (const raw of ['', '{broken', '{}', '{"is_error":false}', '{"subtype":null}', '{"subtype":123}']) {
  test(`D2: no explicit failure metadata in ${JSON.stringify(raw)} returns null`, t => {
    const dir = temporary(t);
    writeFileSync(join(dir, 'raw.json'), raw);
    assert.deepEqual(cursorMetadata(dir), { session_id: null, failure_reason: null });
  });
}

for (const [raw, reason] of [
  [{ is_error: true, subtype: 'success' }, 'provider_error: is_error'],
  [{ is_error: true }, 'provider_error: is_error'],
  [{ is_error: true, subtype: 'execution_error' }, 'provider_error: execution_error'],
  [{ is_error: false, subtype: 'execution_error' }, 'provider_error: execution_error'],
] as const) {
  test(`D2: explicit Cursor failure ${JSON.stringify(raw)} has an accurate reason`, t => {
    const dir = temporary(t);
    writeFileSync(join(dir, 'raw.json'), JSON.stringify(raw));
    assert.equal(cursorMetadata(dir).failure_reason, reason);
  });
}

for (const invalid of [false, true]) {
  test(`D2: corrupt raw.json cannot override worker_result_${invalid ? 'invalid' : 'missing'} during finalization`, async t => {
    const h = tmpRepo(t);
    const store = new JobStore(resolvePaths(h.env));
    const status = { ...job(), repo: h.repo, worktree: h.repo, base_sha: h.git('rev-parse', 'HEAD').trim(), provider: 'cursor' as const };
    store.create(status);
    const dir = h.jobDir(status.job_id);
    writeFileSync(join(dir, WORKSPACE_BEFORE), JSON.stringify(captureWorkspaceSnapshotSync(h.repo, { job_id: status.job_id, phase: 'before_worker' })));
    writeFileSync(join(dir, 'raw.json'), '{broken');
    if (invalid) writeFileSync(join(dir, 'final.md'), JSON.stringify({ ...worker(), summary: 42 }));
    const result = await finalize(store, status, { ...h.task, provider: 'cursor', acceptance_criteria: [] }, 0);
    assert.equal(result.state, 'failed');
    assert.match(result.failure_reason!, invalid ? /^worker_result_invalid: .*summary/ : /^worker_result_missing$/);
    assert.equal(store.read(status.job_id).failure_reason, result.failure_reason);
  });
}

test('D2: Codex stderr containing Workspace Trust Required does not affect success', async t => {
  const h = stubJob(t, 'codex', { GBDEV_STUB_TRUST_LOG: '1' });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded');
  assert.equal(h.result(done.job_id).failure_reason, null);
  assert.match(readFileSync(join(h.jobDir(done.job_id), 'worker.log'), 'utf8'), /Workspace Trust Required/);
  assert.equal(providerFailureReason('codex', h.jobDir(done.job_id)), null);
});

test('D4: failed Codex login reports nonzero exit code without stdout/stderr identity', async t => {
  const h = stubJob(t, 'codex', { GBDEV_STUB_LOGIN_EXIT: '7' });
  const output = await h.command(['doctor']);
  const { checks } = unwrap(output.envelope) as { checks: { name: string; ok: boolean; detail: string }[] };
  assert.deepEqual(checks.find(c => c.name === 'codex_login'), { name: 'codex_login', ok: false, detail: 'exit_code=7' });
  assert.doesNotMatch(output.stdout, /Logged in|ChatGPT|second line/);
});

test('D5: Codex prompt requires integer counts matching the strict output schema', () => {
  const prompt = renderPrompt(brief('/repo'));
  assert.match(prompt, /passed and failed are required non-negative integer counts \(not booleans\)/);
  const example = extractWorkerResult(prompt);
  for (const entry of example.tests) {
    assert.ok(Number.isInteger(entry.passed) && Number(entry.passed) >= 0);
    assert.ok(Number.isInteger(entry.failed) && Number(entry.failed) >= 0);
  }
  const testsSchema = (workerResultSchema.properties.tests as {
    items: { required: string[]; properties: Record<string, unknown> };
  }).items;
  assert.deepEqual(testsSchema.required, ['cmd', 'exit_code', 'passed', 'failed']);
  assert.deepEqual(testsSchema.properties.passed, { type: 'integer', minimum: 0 });
  assert.deepEqual(testsSchema.properties.failed, { type: 'integer', minimum: 0 });
});

test('D5: runtime validation stays permissive for Cursor omitted counts and boolean passed', () => {
  for (const counts of [{}, { passed: true }, { passed: false, failed: 1 }]) {
    const report = { ...worker(), tests: [{ cmd: 'npm test', exit_code: 0, ...counts }] };
    assert.deepEqual(validateWorkerResult(report), report);
    assert.deepEqual(extractWorkerResult(JSON.stringify(report)), report);
  }
});

test('D6: invalid failed count reports the precise tests array index', () => {
  const report = { ...worker(), tests: [{ cmd: 'first', exit_code: 0 }, { cmd: 'second', exit_code: 1, failed: -1 }] };
  assert.throws(() => validateWorkerResult(report), /tests\[1\]\.failed/);
  assert.throws(() => extractWorkerResult(JSON.stringify(report)), /tests\[1\]\.failed/);
});
