import assert from 'node:assert/strict';
import test from 'node:test';
import { gate, findingsFingerprint, DECISION_ACTIONS } from '../src/pipeline/gate.js';
import { validatePipelineResume } from '../src/contracts/pipelineResume.js';
import { result } from './helpers.js';
import type { Finding } from '../src/contracts/workerResult.js';
const finding: Finding = { id: 'F1', severity: 'major', file: 'src/a.ts', line: 1, message: 'Fix this issue', suggestion: null };
test('S4 pure gate G6/G8/G9/G10/G11/G12/G13 and independent FIX_NO_CHANGES rule', () => {
  const r = result();
  assert.equal(gate({ ...r, state: 'failed', failure_reason: 'check_failed:AC1' }, 'change', false, { hasFixLoop: true }).action, 'fix');
  r.gbdev_observed.head_after = r.gbdev_observed.head_before;
  assert.equal(gate(r, 'change', false, { kind: 'fix' }).rule, 'FIX_NO_CHANGES');
  assert.equal(gate(r, 'change', false, { kind: 'fix' }).reason, 'fix_no_changes');
  for (const state of ['succeeded', 'failed'] as const) {
    const noVerdict = { ...r, state, worker_reported: null, failure_reason: state === 'failed' ? 'worker_result_invalid: review.verdict' : null };
    assert.deepEqual(gate(noVerdict, 'verdict'), { rule: 'G9', action: 'retry' });
    assert.equal(gate(noVerdict, 'verdict', false, { verdictRetried: true }).reason, 'verdict_missing');
    assert.equal(gate(noVerdict, 'verdict', false, { attempts: 3 }).reason, 'verdict_missing');
  }
  r.worker_reported!.review = { verdict: 'revise', findings: [] };
  assert.equal(gate(r, 'verdict').rule, 'G9');
  r.worker_reported!.review.findings = [finding];
  assert.equal(gate(r, 'verdict', false, { hasFixLoop: true }).action, 'fix');
  assert.equal(gate(r, 'verdict', false, { hasFixLoop: true, previousFindings: [finding] }).reason, 'findings_repeated');
  r.worker_reported!.review.verdict = 'approve';
  const normalized = gate(r, 'verdict', false, { hasFixLoop: true });
  assert.equal(normalized.rule, 'G10'); assert.equal(normalized.action, 'fix'); assert.deepEqual(normalized.warnings, ['verdict_inconsistent']);
  assert.equal(r.worker_reported!.review.verdict, 'approve'); // Gate must not mutate M1 evidence.
  r.worker_reported!.review.verdict = 'reject'; assert.equal(gate(r, 'verdict').rule, 'G12');
  r.worker_reported!.review = { verdict: 'approve', findings: [{ ...finding, severity: 'minor' }] };
  assert.equal(gate(r, 'verdict').rule, 'G13');
});
test('S4 fingerprints normalize severity/file/message, ignore id/line/suggestion, ignore nonblocking findings', () => {
  assert.equal(findingsFingerprint([finding]), findingsFingerprint([{ ...finding, id: 'F9', line: 9, message: ' FIX   THIS\nISSUE ', suggestion: 'Different' }]));
  assert.notEqual(findingsFingerprint([finding]), findingsFingerprint([{ ...finding, file: 'other.ts' }]));
  assert.notEqual(findingsFingerprint([finding]), findingsFingerprint([{ ...finding, severity: 'critical' }]));
  assert.equal(findingsFingerprint([{ ...finding, severity: 'nit' }]), null);
  assert.equal(findingsFingerprint([{ ...finding, message: 'a'.repeat(80) + 'x' }]), findingsFingerprint([{ ...finding, message: 'a'.repeat(80) + 'y' }]));
  assert.equal(findingsFingerprint([finding, { ...finding, file: 'z.ts' }]), findingsFingerprint([{ ...finding, file: 'z.ts' }, finding]));
});
test('S4 needs_decision exact action table and strict resume shape', () => {
  assert.deepEqual(DECISION_ACTIONS, { needs_input: ['answer'], blocked: ['retry'], max_rounds_exceeded: ['extra_round', 'accept'], findings_repeated: ['extra_round', 'accept'], review_rejected: ['extra_round', 'accept'], fix_no_changes: ['retry', 'accept'], verdict_missing: ['retry', 'accept'], step_failed: ['retry'], step_cancelled: ['retry'], job_budget_exhausted: ['accept'], launch_failed: ['retry'], prompt_too_large: ['retry'], workspace_unresolved: ['retry', 'accept'] });
  const id = 'p_20261026_1011_abcd', input = { schema: 'gbdev.pipeline-resume.v1', pipeline_id: id, action: 'retry', answers: [], note: null };
  for (const patch of [{ action: 'delete' }, { schema: 'bad' }, { pipeline_id: 'different' }, { answers: null }, { note: 10 }, { note: 'a'.repeat(2001) }, { extra: true }, { answers: [{ question_id: 'Q1', answer: 'A' }] }, { verdict_missing_reviewed: 'yes' }]) {
    // null answers are invalid, not an omitted array. Illegal verdict_missing_reviewed type is rejected.
    assert.throws(() => validatePipelineResume({ ...input, ...patch }, id));
  }
  assert.equal(validatePipelineResume({ ...input, action: 'accept', verdict_missing_reviewed: true, note: 'evidence' }, id).verdict_missing_reviewed, true);
  for (const answers of [[{ question_id: 'Q1', answer: ' ' }], [{ question_id: 'Q1', answer: 'a' }, { question_id: 'Q1', answer: 'b' }]]) assert.throws(() => validatePipelineResume({ ...input, action: 'answer', answers }, id));
});
