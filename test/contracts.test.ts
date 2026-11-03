import assert from 'node:assert/strict';
import test from 'node:test';
import { validateJobStatus, isTerminal, JOB_STATES } from '../src/contracts/jobStatus.js';
import { validateEvent } from '../src/contracts/event.js';
import { validateJobResult } from '../src/contracts/jobResult.js';
import { extractWorkerResult, normalizeWorkerResult, validateWorkerResult, WORKER_STATUSES } from '../src/contracts/workerResult.js';
import { GbdevError, ERROR_RETRYABLE, errorExitCode, toErrorContract, validateError } from '../src/contracts/error.js';
import { envelopeExitCode, failureEnvelope, serializeEnvelope, successEnvelope, validateEnvelope } from '../src/contracts/envelope.js';
import { errorCode, job, result, worker } from './helpers.js';

const fenced = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

test('worker result: validates all statuses and passes questions/blockers through unchanged', () => {
  for (const status of WORKER_STATUSES) assert.equal(validateWorkerResult({ ...worker(), status }).status, status);
  const value = { ...worker(), status: 'needs_input', open_questions: [
    { id: 'Q1', question: 'Which API?', options: ['A', 'B'], default: 'A', blocking: true },
    { id: 'Q2', question: 'Any constraints?', options: [], default: null, blocking: false },
  ], blockers: [{ kind: 'permission', detail: 'Need access' }] };
  assert.deepEqual(validateWorkerResult(value), value);
});

test('worker result: takes the last json block, including CRLF and longer fences', () => {
  const last = { ...worker(), summary: 'Last result' };
  assert.deepEqual(extractWorkerResult(`Prose\n${fenced({ wrong: true })}\ntext\n${fenced(last)}\n`), last);
  assert.deepEqual(extractWorkerResult(fenced(worker()).replace(/\n/g, '\r\n')), worker());
  assert.deepEqual(extractWorkerResult(`\`\`\`\`json\n${JSON.stringify(last)}\n\`\`\`\``), last);
  assert.deepEqual(extractWorkerResult(`${fenced(worker())}\n\`\`\`text\nnot json\n\`\`\``), worker());
});

test('worker result: missing vs invalid report errors, unclosed final block rejected', () => {
  for (const text of ['', 'plain text', '```text\n{}\n```']) {
    assert.throws(() => extractWorkerResult(text), errorCode('result_missing'));
  }
  for (const text of ['{"schema":"gbdev.worker-result.v1"}', '```json\n{broken}\n```', fenced({}),
    `${fenced(worker())}\n\`\`\`json\n{`]) {
    assert.throws(() => extractWorkerResult(text), errorCode('result_invalid'));
  }
  // A json-looking fence inside a non-json block must not be treated as a report.
  assert.throws(() => extractWorkerResult('````text\n```json\n{}\n```\n````'), errorCode('result_missing'));
});

for (const [key, value] of Object.entries({
  schema: 'wrong', status: 'timeout', summary: '', files_changed: [false], commits: null,
  tests: [{ cmd: 'npm test', exit_code: 0.5 }], evidence: [{ criterion_id: 'AC1' }],
  open_questions: [{ id: 'Q1', question: '?', options: ['A'], default: 'B', blocking: true }],
  blockers: [{ kind: 'network', detail: 'No access' }], policy_violations: [42],
})) {
  test(`worker result: rejects invalid and missing ${key}`, () => {
    assert.throws(() => validateWorkerResult({ ...worker(), [key]: value }), errorCode('config_invalid'));
    const missing: Record<string, unknown> = { ...worker() };
    delete missing[key];
    assert.throws(() => validateWorkerResult(missing), errorCode('config_invalid'));
  });
}

test('job status: validates full records and all retained state enum values', () => {
  const value = job();
  assert.deepEqual(validateJobStatus(value), value);
  for (const state of JOB_STATES) {
    assert.equal(validateJobStatus({ ...value, state, state_history: [{ state, at: value.created_at, by: 'gbdev' }] }).state, state);
    assert.equal(isTerminal(state), !['queued', 'starting', 'running'].includes(state));
  }
  const running = { ...value, state: 'running', pid: process.pid,
    last_event: { seq: 1, type: 'state_change', at: value.created_at },
    state_history: [...value.state_history, { state: 'running', at: value.updated_at, by: 'gbdev' }] };
  assert.deepEqual(validateJobStatus(running), running);
});

test('job status: rejects corrupt states, missing fields, malformed timestamps and mismatched history', () => {
  for (const [key, value] of Object.entries({
    schema: 'wrong', job_id: '../bad', state: 'invented', provider: 'other', role: '', sandbox: 'disabled',
    repo: '', worktree: null, branch: '../escape', base_sha: '', pid: -1, created_at: '2026-10-25T18:31:02Z',
    updated_at: '2026-02-30T10:00:00+00:00', deadline_at: '2026-10-25T24:00:00+00:00',
    state_history: [], last_event: { seq: 0, at: job().created_at, type: 'check' }, parent_job_id: '../bad',
  })) {
    assert.throws(() => validateJobStatus({ ...job(), [key]: value }), errorCode('config_invalid'), key);
    const missing: Record<string, unknown> = { ...job() };
    delete missing[key];
    assert.throws(() => validateJobStatus(missing), errorCode('config_invalid'), key);
  }
  assert.throws(() => validateJobStatus({ ...job(), state: 'running' }), errorCode('config_invalid'));
});

test('event: validates normalized events and rejects malformed fields', () => {
  const event = { schema: 'gbdev.event.v1', job_id: job().job_id, seq: 41, at: job().created_at,
    source: 'worker', type: 'worker_output', data: { count: 3 } };
  assert.deepEqual(validateEvent(event), event);
  for (const [key, value] of Object.entries({ schema: 'wrong', job_id: 'bad', seq: 0, at: 'yesterday', source: 'other', type: 'raw', data: [] })) {
    assert.throws(() => validateEvent({ ...event, [key]: value }), errorCode('config_invalid'));
  }
});

test('job result: preserves worker self-report separately from observed facts, nullable exits/reports', () => {
  assert.deepEqual(validateJobResult(result()), { ...result(), failure_reasons: [] });
  const crashed = { ...result(), worker_exit_code: null, worker_reported: null, duration_s: 0 };
  assert.deepEqual(validateJobResult(structuredClone(crashed)), { ...crashed, failure_reasons: [] });
  for (const value of [
    { ...result(), schema: 'wrong' }, { ...result(), worker_reported: {} }, { ...result(), worker_exit_code: 0.5 },
    { ...result(), duration_s: Infinity }, { ...result(), duration_s: -1 },
    { ...result(), paths: {} }, { ...result(), gbdev_observed: { ...result().gbdev_observed, checks: [{ id: 'AC1', cmd: 'npm test', exit_code: '0', log: 'x' }] } },
    { ...result(), gbdev_observed: { ...result().gbdev_observed, worktree_dirty_at_exit: 'false' } },
  ]) assert.throws(() => validateJobResult(value), errorCode('config_invalid'));
});

test('errors: every error code has the specified retryability and exit code', () => {
  assert.equal(ERROR_RETRYABLE.role_fixed, false);
  for (const [code, retryable] of Object.entries(ERROR_RETRYABLE)) {
    const error = new GbdevError(code as keyof typeof ERROR_RETRYABLE, 'Something failed', { detail: 1 }, ['Retry']);
    assert.equal(error.contract.retryable, retryable);
    assert.deepEqual(validateError(error.contract), error.contract);
    assert.equal(errorExitCode(error.contract.code), ['usage_error', 'config_invalid', 'cursor_model_not_allowed', 'role_invalid', 'role_fixed', 'pipeline_invalid', 'run_invalid', 'user_approval_required', 'inspect_path_invalid'].includes(code) ? 2 : 1);
    assert.throws(() => validateError({ ...error.contract, retryable: !retryable }), errorCode('config_invalid'));
  }
  assert.equal(toErrorContract(new Error('unexpected')).code, 'internal_error');
  assert.equal(toErrorContract(null).code, 'internal_error');
  assert.throws(() => validateError({ ...new GbdevError('busy', 'busy').contract, code: 'toString' }), errorCode('config_invalid'));
});

test('envelopes: JSON object plus one newline, success/error discrimination, exit-code mapping', () => {
  const good = successEnvelope('status', 'gbdev.job-status.v1', job());
  assert.deepEqual(validateEnvelope(good), good);
  assert.deepEqual(validateEnvelope(successEnvelope('status', 'gbdev.job-status.v1', [job()] )).ok, true);
  assert.equal(envelopeExitCode(good), 0);
  const serialized = serializeEnvelope(good);
  assert.equal(serialized.endsWith('\n'), true);
  assert.equal(serialized.split('\n').length, 2);
  assert.deepEqual(JSON.parse(serialized), good);
  for (const code of ['usage_error', 'config_invalid', 'busy', 'internal_error'] as const) {
    const bad = failureEnvelope('start', new GbdevError(code, 'Failure'));
    assert.deepEqual(validateEnvelope(bad), bad);
    assert.equal(envelopeExitCode(bad), ['usage_error', 'config_invalid', 'cursor_model_not_allowed', 'role_invalid', 'pipeline_invalid', 'run_invalid', 'user_approval_required'].includes(code) ? 2 : 1);
  }
  for (const bad of [null, {}, { ...good, contract_version: 1 }, { ...good, result: {} },
    { ...good, result_schema: 'unknown' }, { ...good, error: {} },
    { ...failureEnvelope('start', new Error('bad')), result: {} }]) {
    assert.throws(() => validateEnvelope(bad), errorCode('config_invalid'));
  }
});


test('inspection normalization is explicitly opt-in, including fenced results', () => {
  const inspection = { answer: 'Evidence', excerpts: [] };
  const input = { ...worker(), inspection };
  for (const options of [undefined, { inspection: false }]) {
    const warnings: string[] = [];
    assert.deepEqual(normalizeWorkerResult(input, warnings, options), worker());
    assert.deepEqual(warnings, ['worker-result.inspection: ignored unknown field']);
    assert.deepEqual(extractWorkerResult(fenced(input), [], options), worker());
  }
  assert.deepEqual(normalizeWorkerResult(input, [], { inspection: true }), input);
  assert.deepEqual(extractWorkerResult(fenced(input), [], { inspection: true }), input);
});
