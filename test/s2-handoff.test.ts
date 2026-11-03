import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { generateHandoff, writeHandoff, type HandoffContext } from '../src/pipeline/handoff.js';
import { result, temporary, worker } from './helpers.js';
import type { Finding } from '../src/contracts/workerResult.js';

const context: HandoffContext = { pipeline_id: 'p_20261026_1011_9c2e', seq: 3, instance: 'review#2',
  role: 'reviewer', output: 'verdict', created_at: '2026-10-26T12:00:00-07:00' };
const finding = (i = 1): Finding => ({ id: `F${i}`, severity: 'minor', file: 'src/code.ts', line: 1, message: 'Issue', suggestion: null });

test('S2 handoff uses observed facts, worker tests, explicit metadata and copies without mutation', () => {
  const input = result();
  input.worker_reported = { ...worker(), files_changed: ['fake-file'], commits: ['fake-commit'],
    handoff: { decided: ['choice'], rejected: ['alternative'], risks: ['risk'], remaining: ['next'] },
    review: { verdict: 'approve', findings: [finding()] } };
  input.worker_result_warnings = ['a normalization'];
  const before = structuredClone(input);
  const out = generateHandoff(input, context);
  assert.equal(out.schema, 'gbdev.handoff.v1');
  assert.equal(out.job_id, input.job_id);
  assert.equal(out.pipeline_id, context.pipeline_id);
  assert.equal(out.seq, 3);
  assert.equal(out.instance, 'review#2');
  assert.equal(out.role, 'reviewer');
  assert.equal(out.created_at, context.created_at);
  assert.equal(out.summary, input.worker_reported.summary);
  for (const key of ['files_changed', 'commits', 'head_before', 'head_after', 'checks'] as const) assert.deepEqual(out[key], input.gbdev_observed[key]);
  for (const key of ['decided', 'rejected', 'risks', 'remaining'] as const) assert.deepEqual(out[key], input.worker_reported.handoff![key]);
  assert.deepEqual(out.tests, input.worker_reported.tests);
  assert.deepEqual(out.verdict, { ...input.worker_reported.review, normalized_from: null });
  assert.deepEqual(out.warnings, input.worker_result_warnings);
  assert.equal(out.truncated, false);
  out.tests[0]!.cmd = 'mutated'; out.checks[0]!.id = 'mutated'; out.files_changed.push('mutated');
  out.verdict!.findings[0]!.message = 'mutated'; out.decided.push('mutated'); out.warnings.push('mutated');
  assert.deepEqual(input, before);
});

test('S2 handoff tolerates missing reports and preserves failed job state/reason', () => {
  const input = { ...result(), worker_reported: null, state: 'failed' as const, failure_reason: 'worker_result_missing' };
  const out = generateHandoff(input, context);
  assert.equal(out.job_state, 'failed'); assert.equal(out.failure_reason, 'worker_result_missing');
  assert.equal(out.summary, ''); assert.deepEqual(out.tests, []); assert.equal(out.verdict, null);
  for (const key of ['decided', 'rejected', 'risks', 'remaining'] as const) assert.deepEqual(out[key], []);
  assert.equal(out.truncated, false);
  assert.deepEqual(generateHandoff(result(), context).remaining, []);
});
for (const output of ['change', 'report'] as const) test(`S2 ${output} handoff excludes even a supplied review`, () => {
  const input = result(); input.worker_reported!.review = { verdict: 'approve', findings: [] };
  assert.equal(generateHandoff(input, { ...context, output }).verdict, null);
});
for (const key of ['summary', 'decided', 'rejected', 'risks', 'remaining'] as const) test(`S2 handoff ${key} clips at 300 characters and arrays at 10`, () => {
  const input = result();
  input.worker_reported!.handoff = { decided: [], rejected: [], risks: [], remaining: [] };
  if (key === 'summary') input.worker_reported!.summary = 'x'.repeat(301);
  else input.worker_reported!.handoff![key] = Array(11).fill('x'.repeat(301));
  const out = generateHandoff(input, context);
  assert.equal(out.truncated, true);
  if (key === 'summary') assert.equal(out.summary.length, 300);
  else { assert.equal(out[key].length, 10); assert.ok(out[key].every(text => text.length === 300)); }
});
test('S2 handoff exact limits do not mark truncated', () => {
  const input = result(); input.worker_reported!.summary = 'x'.repeat(300);
  input.worker_reported!.handoff = { decided: Array(10).fill('x'.repeat(300)), rejected: [], risks: [], remaining: [] };
  input.worker_reported!.review = { verdict: 'revise', findings: Array.from({ length: 50 }, (_, i) => ({ ...finding(i + 1), message: 'm'.repeat(500) })) };
  assert.equal(generateHandoff(input, context).truncated, false);
});
test('S2 handoff findings clip at 50 and messages at 500; inconsistency checks all original findings', () => {
  const input = result();
  input.worker_reported!.review = { verdict: 'approve', findings: Array.from({ length: 51 }, (_, i) => ({ ...finding(i + 1), message: 'm'.repeat(501) })) };
  input.worker_reported!.review.findings[50]!.severity = 'critical';
  const before = structuredClone(input), out = generateHandoff(input, context);
  assert.equal(out.truncated, true);
  assert.equal(out.verdict!.findings.length, 50);
  assert.equal(out.verdict!.findings[0]!.id, 'F51');
  assert.equal(out.verdict!.findings[0]!.severity, 'critical');
  assert.ok(out.verdict!.findings.every(f => f.message.length === 500));
  assert.equal(out.verdict!.verdict, 'revise');
  assert.equal(out.verdict!.normalized_from, 'approve');
  assert.deepEqual(out.warnings, ['verdict_inconsistent']);
  assert.deepEqual(input, before);
});
for (const severity of ['critical', 'major'] as const) test(`S2 handoff approve + ${severity} normalizes without changing worker report`, () => {
  const input = result(); input.worker_reported!.review = { verdict: 'approve', findings: [{ ...finding(), severity }] };
  const out = generateHandoff(input, context);
  assert.equal(out.verdict!.verdict, 'revise'); assert.equal(out.verdict!.normalized_from, 'approve');
  assert.equal(input.worker_reported!.review.verdict, 'approve');
});
test('S2 handoff writer uses specified filename, atomic JSON and private permissions', t => {
  const dir = join(temporary(t), 'handoffs'), out = generateHandoff(result(), context);
  const file = writeHandoff(dir, out);
  assert.equal(file, join(dir, '03-review-2.json'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), out);
  assert.deepEqual(readdirSync(dir), ['03-review-2.json']);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writeHandoff(dir, { ...out, instance: '../escape#1' }));
  assert.throws(() => writeHandoff(dir, { ...out, seq: 0 }));
});
