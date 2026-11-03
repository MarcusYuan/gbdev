import { captureWorkspaceSnapshotSync, WORKSPACE_BEFORE } from '../src/core/workspaceSnapshot.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { extractWorkerResult, normalizeWorkerResult, validateWorkerResult, type Finding } from '../src/contracts/workerResult.js';
import { buildWorkerResultSchema } from '../src/contracts/workerResultSchema.js';
import { codex } from '../src/providers/codex.js';
import { brief, errorCode, job, temporary, worker } from './helpers.js';
import { tmpRepo } from './helpers/tmpRepo.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { finalize } from '../src/core/finalize.js';

const finding = (fields: Partial<Finding> = {}): Finding => ({ id: 'F1', severity: 'major', file: null, line: null, message: 'A finding', suggestion: null, ...fields });
const report = (review: unknown) => ({ ...worker(), review });

// Frozen from b3bebcd's M1 writer before changing schema generation. No runtime regeneration.
for (const output of ['change', 'report', 'verdict'] as const) test(`AC-S2.1 standalone ${output} schema matches frozen M1 bytes`, t => {
  const dir = temporary(t), expected = readFileSync(resolve('test/fixtures/worker-result.m1.schema.json'));
  codex.prepareJob!(dir, { pipelineStep: false, output });
  assert.deepEqual(readFileSync(join(dir, 'worker-result.schema.json')), expected);
  codex.prepareJob!(dir);
  assert.deepEqual(readFileSync(join(dir, 'worker-result.schema.json')), expected);
});

function inspectSchema(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false);
    assert.deepEqual(node.required, Object.keys(node.properties as object));
  }
  for (const child of Object.values(node)) inspectSchema(child);
}
for (const output of ['change', 'report', 'verdict'] as const) test(`AC-S2.2 pipeline ${output} schema is recursively strict and role-specific`, t => {
  const dir = temporary(t);
  codex.prepareJob!(dir, { pipelineStep: true, output });
  const schema = JSON.parse(readFileSync(join(dir, 'worker-result.schema.json'), 'utf8'));
  inspectSchema(schema);
  assert.deepEqual(Object.keys(schema.properties.handoff.properties), ['decided', 'rejected', 'risks', 'remaining']);
  assert.equal('review' in schema.properties, output === 'verdict');
  if (output === 'verdict') {
    const fields = schema.properties.review.properties.findings.items.properties;
    assert.deepEqual(fields.file.type, ['string', 'null']);
    assert.deepEqual(fields.line.type, ['integer', 'null']);
    assert.deepEqual(fields.suggestion.type, ['string', 'null']);
    assert.equal(fields.line.minimum, 1);
  }
  assert.equal('handoff' in buildWorkerResultSchema().properties, false);
});

for (const [input, expected] of [
  ['APPROVE', 'approve'], ['ITERATE', 'revise'], ['REJECT', 'reject'], ['REVISE', 'revise'],
  ['aPpRoVe', 'approve'], ['iTeRaTe', 'revise'], ['rEjEcT', 'reject'], ['rEvIsE', 'revise'], ['iterate', 'revise'],
]) test(`AC-S2.3 verdict ${input} → ${expected}`, () => {
  const warnings: string[] = [];
  const parsed = extractWorkerResult(JSON.stringify(report({ verdict: input, findings: [finding()] })), warnings);
  assert.equal(parsed.review!.verdict, expected);
  assert.deepEqual(warnings, [`review.verdict: ${input} converted to ${expected}`]);
});
for (const [input, expected] of [['high', 'major'], ['low', 'minor'], ['medium', 'minor'], ['info', 'nit']]) {
  test(`AC-S2.3 severity ${input} → ${expected}`, () => {
    const warnings: string[] = [];
    const parsed = normalizeWorkerResult(report({ verdict: 'revise', findings: [{ ...finding(), severity: input }] }), warnings);
    assert.equal(parsed.review!.findings[0]!.severity, expected);
    assert.deepEqual(warnings, [`review.findings[0].severity: ${input} converted to ${expected}`]);
  });
}
test('AC-S2.3 missing finding ids are assigned by position with per-id warnings', () => {
  const { id: _id, ...item } = finding();
  const warnings: string[] = [];
  const parsed = normalizeWorkerResult(report({ verdict: 'revise', findings: [item, item] }), warnings);
  assert.deepEqual(parsed.review!.findings.map(f => f.id), ['F1', 'F2']);
  assert.deepEqual(warnings, ['review.findings[0].id: missing id defaulted to F1', 'review.findings[1].id: missing id defaulted to F2']);
});

test('S2 canonical handoff/review and M1 reports round-trip without warnings or mutation', () => {
  for (const verdict of ['approve', 'revise', 'reject'] as const) {
    const input = { ...worker(), handoff: { decided: ['choice', ''], rejected: [], risks: [], remaining: [] },
      review: { verdict, findings: ['critical', 'major', 'minor', 'nit'].map((severity, i) => finding({ id: `F${i + 1}`, severity: severity as Finding['severity'], file: '', suggestion: '' })) } };
    const before = structuredClone(input), warnings: string[] = [];
    assert.deepEqual(extractWorkerResult(JSON.stringify(input), warnings), input);
    assert.deepEqual(input, before);
    assert.deepEqual(warnings, []);
  }
  const warnings: string[] = [];
  assert.deepEqual(normalizeWorkerResult(worker(), warnings), worker());
  assert.deepEqual(warnings, []);
});

for (const handoff of [null, [], {}, { decided: [], rejected: [], risks: [] },
  { decided: [1], rejected: [], risks: [], remaining: [] }, { decided: '', rejected: [], risks: [], remaining: [] }]) {
  test(`S2 rejects malformed handoff ${JSON.stringify(handoff)}`, () => {
    assert.throws(() => extractWorkerResult(JSON.stringify({ ...worker(), handoff })), errorCode('result_invalid'));
  });
}
for (const review of [null, [], {}, { verdict: 'approve' }, { verdict: 'revise', findings: null },
  ...['accept', 'approved', '', ' approve ', 'toString', 1, null].map(verdict => ({ verdict, findings: [] })),
]) test(`AC-S2.3 rejects malformed review ${JSON.stringify(review)}`, () => {
  assert.throws(() => extractWorkerResult(JSON.stringify(report(review))), errorCode('result_invalid'));
});
for (const [field, bad] of Object.entries({ id: 'C1', severity: 'urgent', file: 42, line: 0, message: ' ', suggestion: false })) {
  test(`S2 rejects invalid/missing finding ${field}`, () => {
    assert.throws(() => extractWorkerResult(JSON.stringify(report({ verdict: 'revise', findings: [{ ...finding(), [field]: bad }] }))), errorCode('result_invalid'));
    const item: Record<string, unknown> = { ...finding() }; delete item[field];
    if (field !== 'id') assert.throws(() => normalizeWorkerResult(report({ verdict: 'revise', findings: [item] })), errorCode('config_invalid'));
  });
}
for (const id of ['F', 'F1000', 'f1', 'F-1', '', null]) test(`S2 rejects invalid finding id ${id}`, () => {
  assert.throws(() => normalizeWorkerResult(report({ verdict: 'revise', findings: [{ ...finding(), id }] })), errorCode('config_invalid'));
});
for (const line of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) test(`S2 rejects invalid finding line ${line}`, () => {
  assert.throws(() => normalizeWorkerResult(report({ verdict: 'revise', findings: [{ ...finding(), line }] })), errorCode('config_invalid'));
});
test('S2 duplicate explicit or generated finding ids are invalid', () => {
  const { id: _id, ...missing } = finding();
  for (const findings of [[finding(), finding()], [finding({ id: 'F2' }), missing]]) {
    assert.throws(() => normalizeWorkerResult(report({ verdict: 'revise', findings })), errorCode('config_invalid'));
  }
});
test('S2 nested unknown fields are ignored with warnings; required handoff arrays are not defaulted', () => {
  const warnings: string[] = [];
  const parsed = normalizeWorkerResult({ ...worker(), handoff: { decided: [], rejected: [], risks: [], remaining: [], extra: true },
    review: { verdict: 'approve', findings: [{ ...finding({ severity: 'nit' }), extra: true }], extra: true } }, warnings);
  assert.equal(warnings.length, 3);
  assert.equal('extra' in parsed.handoff!, false);
  assert.equal('extra' in parsed.review!, false);
  assert.equal('extra' in parsed.review!.findings[0]!, false);
  assert.throws(() => validateWorkerResult({ ...worker(), handoff: {} }), errorCode('config_invalid'));
});

test('AC-S2.3 illegal verdict becomes worker_result_invalid in M1 finalization', async t => {
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [] });
  const store = new JobStore(resolvePaths(h.env));
  // Prepare a completed read-only worker result without launching any provider.
  const status = { ...job(), state: 'running' as const, pid: process.pid,
    role: 'reviewer', sandbox: 'read-only' as const, repo: h.repo, worktree: h.repo, base_sha: h.git('rev-parse', 'HEAD').trim(),
    state_history: [{ state: 'running' as const, at: '2026-10-26T10:00:00-07:00', by: 'gbdev' }] };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE), captureWorkspaceSnapshotSync(h.repo, { job_id: status.job_id, phase: 'before_worker' }));
  atomicWriteJson(paths.finalMessage, report({ verdict: 'nonsense', findings: [] }));
  const done = await finalize(store, status, { ...brief(h.repo), sandbox: 'read-only', role: 'reviewer', acceptance_criteria: [] }, 0);
  assert.equal(done.state, 'failed');
  assert.match(done.failure_reason!, /^worker_result_invalid:.*review.verdict/);
  assert.deepEqual(done.failure_reasons, [done.failure_reason]);
  assert.equal(done.worker_reported, null);
  assert.match(readFileSync(paths.finalMessage, 'utf8'), /nonsense/);
});
