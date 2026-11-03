import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validatePipeline } from '../src/contracts/pipeline.js';
import { builtinPipelines } from '../src/pipeline/definitions.js';
import { ALLOWED_RUN_TRANSITIONS, assertRunTransition, RUN_STATES } from '../src/contracts/pipelineRun.js';
import { gate } from '../src/pipeline/gate.js';
import { generateHandoff } from '../src/pipeline/handoff.js';
import { renderPriorSteps } from '../src/pipeline/prompt.js';
import { normalizeWorkerResult, type Finding } from '../src/contracts/workerResult.js';
import { buildWorkerResultSchema } from '../src/contracts/workerResultSchema.js';
import { validateRole } from '../src/contracts/role.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { RoleRegistry } from '../src/roles/registry.js';
import { errorCode, result, temporary, worker } from './helpers.js';
import { validateConfig } from '../src/core/config.js';

test('S3 builtins and invalid template invariants', () => {
  for (const template of builtinPipelines()) assert.deepEqual(validatePipeline(template), template);
  const base = builtinPipelines()[0]!;
  for (const patch of [
    { steps: [{ id: 'review', role: 'reviewer' }, { id: 'implement', role: 'executor' }] },
    { steps: [{ id: 'same', role: 'executor' }, { id: 'same', role: 'reviewer' }] },
    { fix_loop: { after: 'implement', fix_role: 'fixer', max_rounds: 2 } },
    { fix_loop: { after: 'review', fix_role: 'reviewer', max_rounds: 2 } },
    { fix_loop: { after: 'review', fix_role: 'fixer', max_rounds: 6 } },
    { unknown: true }, { steps: [] }, { timeout_min: 29 },
  ]) assert.throws(() => validatePipeline({ ...base, ...patch }), errorCode('pipeline_invalid'));
  assert.throws(() => validatePipeline({ ...base, cursor_model: 'gpt-5' }), errorCode('cursor_model_not_allowed'));
  assert.throws(() => validatePipeline(base, undefined, 'wrong.json'), errorCode('pipeline_invalid'));
});
test('S3 transition whitelist exhaustively rejects illegal state pairs', () => {
  for (const from of RUN_STATES) for (const to of RUN_STATES) {
    if (ALLOWED_RUN_TRANSITIONS[from].includes(to)) assert.doesNotThrow(() => assertRunTransition(from, to));
    else assert.throws(() => assertRunTransition(from, to), errorCode('internal_error'));
  }
});
for (const output of ['change', 'report', 'verdict'] as const) test(`S3 G1–G8/G13 priorities for ${output}`, () => {
  const r = result();
  for (const [state, reason, rule, target, cancelled] of [
    ['cancelled', null, 'G1', 'cancelled', true], ['cancelled', null, 'G2', 'needs_decision', false],
    ['needs_input', null, 'G3', 'needs_input', false], ['blocked', 'worker_blocked: env', 'G4', 'blocked', false],
    ['failed', 'policy_violations: outside', 'G5', 'failed', false], ['failed', 'check_failed:AC1', 'G6', 'needs_decision', false],
    ['failed', 'worker_exit_nonzero:1', 'G7', 'needs_decision', false], ['timeout', 'timeout', 'G7', 'needs_decision', false],
  ] as const) {
    const d = gate({ ...r, state, failure_reason: reason }, output, cancelled);
    assert.equal(d.rule, rule); assert.equal(d.state, target);
  }
  r.worker_reported!.review = { verdict: 'approve', findings: [] };
  assert.equal(gate(r, output).action, 'advance'); assert.equal(gate(r, output).rule, output === 'verdict' ? 'G13' : 'G8');
  r.gbdev_observed.head_after = r.gbdev_observed.head_before;
  if (output === 'change') assert.deepEqual(gate(r, output).warnings, ['step_no_changes']);
  if (output === 'verdict') for (const verdict of ['revise', 'reject'] as const) { r.worker_reported!.review.verdict = verdict; assert.equal(gate(r, output).action, verdict === 'revise' ? 'retry' : 'settle'); }
});
test('S3 needs_input/blocked gate wins over recorded policy facts; non-approving verdicts never advance', () => {
  const r = result(); r.gbdev_observed.policy_violations = ['readonly_modified']; r.failure_reasons = ['policy_violations: readonly_modified'];
  for (const state of ['needs_input', 'blocked'] as const) assert.equal(gate({ ...r, state }, 'verdict').state, state);
  r.worker_reported!.review = { verdict: 'approve', findings: [{ id: 'F1', severity: 'critical', file: null, line: null, message: 'bad', suggestion: null }] };
  assert.equal(gate(r, 'verdict').state, 'needs_decision');
  r.worker_reported = null; assert.equal(gate(r, 'verdict').action, 'retry');
});
test('D1 hard handoff budget with massive tests, suggestions, files and escaped fence strings', () => {
  const r = result(), attack = 'GBDEV_UNTRUSTED_DATA'.repeat(2000);
  r.worker_reported!.tests = Array.from({ length: 1000 }, () => ({ cmd: attack, exit_code: 0 }));
  r.worker_reported!.review = { verdict: 'revise', findings: Array.from({ length: 60 }, (_, i) => ({ id: `F${i + 1}`, severity: 'major', file: attack, line: null, message: attack, suggestion: attack })) };
  const h = generateHandoff(r, { pipeline_id: 'p_20261026_1011_abcd', seq: 1, instance: 'review#1', role: 'reviewer', output: 'verdict', created_at: '2026-10-26T12:00:00-07:00' });
  assert.equal(h.tests.length, 10); assert.ok(h.tests.every(t => t.cmd.length <= 300));
  assert.ok(h.verdict!.findings.every(f => f.file!.length <= 300 && f.suggestion!.length <= 500 && f.message.length <= 500)); assert.equal(h.truncated, true);
  const rendered = renderPriorSteps([h], '/tmp/run/handoffs/01-review-1.json'); assert.ok(rendered.length <= 12000);
  assert.match(rendered, /01-review-1.json/); assert.match(rendered, /tests_count/);
  assert.equal(rendered.split('GBDEV_UNTRUSTED_DATA>>>').length, 2);
});
test('D2 stable severity order keeps 51st unique critical finding before clipping', () => {
  const r = result(); const findings: Finding[] = Array.from({ length: 50 }, (_, i) => ({ id: `F${i + 1}`, severity: 'nit', file: null, line: null, message: 'nit', suggestion: null }));
  findings.push({ ...findings[0]!, id: 'F51', severity: 'critical' });
  r.worker_reported!.review = { verdict: 'revise', findings };
  const h = generateHandoff(r, { pipeline_id: 'p_20261026_1011_abcd', seq: 1, instance: 'review#1', role: 'reviewer', output: 'verdict', created_at: '2026-10-26T12:00:00-07:00' });
  assert.deepEqual(h.verdict!.findings.map(f => f.id), ['F51', ...findings.slice(0, 49).map(f => f.id)]); assert.equal(h.truncated, true);
});
test('D3 severity folds case before aliases and records warnings', () => {
  for (const [input, expected] of [['High', 'major'], ['INFO', 'nit'], ['Major', 'major']]) {
    const warnings: string[] = [], w = normalizeWorkerResult({ ...worker(), review: { verdict: 'approve', findings: [{ id: 'F1', severity: input, file: null, line: null, message: 'issue', suggestion: null }] } }, warnings);
    assert.equal(w.review!.findings[0]!.severity, expected); assert.ok(warnings.some(w => w.includes(`${input} converted to ${expected}`)));
  }
});
test('D4 role persists trimmed Codex model', () => assert.equal(validateRole({ ...builtinRoles()[0], codex_model: ' gpt-5 ' }).codex_model, 'gpt-5'));
test('D5 pipeline finding message schema and runtime reject whitespace only, accept non-whitespace', () => {
  const schema = buildWorkerResultSchema({ pipelineStep: true, output: 'verdict' }) as unknown as { properties: { review: { properties: { findings: { items: { properties: { message: { pattern: string } } } } } } } };
  const pattern = new RegExp(schema.properties.review.properties.findings.items.properties.message.pattern);
  for (const message of [' ', '\n\t', '']) {
    assert.equal(pattern.test(message), false);
    assert.throws(() => normalizeWorkerResult({ ...worker(), review: { verdict: 'approve', findings: [{ id: 'F1', severity: 'minor', file: null, line: null, message, suggestion: null }] } }));
  }
  assert.equal(pattern.test(' issue '), true);
});
test('D6 oversized role file rejected before JSON parsing; FIFO diagnostic says regular file', t => {
  const root = temporary(t), dir = join(root, 'roles'); mkdirSync(dir);
  writeFileSync(join(dir, 'executor.json'), 'x'.repeat(64 * 1024 + 1));
  execFileSync('mkfifo', [join(dir, 'reviewer.json')]);
  const registry = new RoleRegistry(join(root, 'config.json'));
  assert.throws(() => registry.resolve('executor'), errorCode('role_invalid'));
  const errors = registry.list().invalid;
  assert.match(errors.find(e => e.name === 'executor')!.message, /64 KiB/);
  const fifo = errors.find(e => e.name === 'reviewer')!.message; assert.match(fifo, /regular file/); assert.doesNotMatch(fifo, /not a symlink/);
});
test('S3 pipeline defaults range validation and unknown fields fail closed', () => {
  assert.deepEqual(validateConfig({ version: 1, pipeline_defaults: {} }).pipeline_defaults, { max_rounds: 2, timeout_min: 240, max_total_jobs: 12 });
  for (const p of [{ max_rounds: 6 }, { timeout_min: 29 }, { max_total_jobs: 21 }, { other: 2 }]) assert.throws(() => validateConfig({ version: 1, pipeline_defaults: p }), errorCode('config_invalid'));
});
