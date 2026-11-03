import assert from 'node:assert/strict';
import test from 'node:test';
import { finalOutcome, finalState } from '../src/core/finalize.js';
import { fallbackMatchesGlob, matchesAllowed } from '../src/core/glob.js';
import { renderPrompt } from '../src/core/prompt.js';
import { brief, worker } from './helpers.js';

test('glob: native and fallback cover recursive/single stars, root files, dotfiles and literal metacharacters', () => {
  const cases: [string, string, boolean][] = [
    ['src/a.ts', 'src/**', true], ['src/deep/a.ts', 'src/**', true],
    ['src/a.ts', 'src/*.ts', true], ['src/deep/a.ts', 'src/*.ts', false],
    ['a.ts', '**/*.ts', true], ['src/deep/a.ts', '**/*.ts', true],
    ['src/.hidden', 'src/**', false], ['src/.hidden', 'src/.*', true],
    ['src/.hidden/a.ts', 'src/**', false], ['outside.txt', 'src/**', false],
    ['src2/a.ts', 'src/**', false], ['src/a+b.ts', 'src/a+b.ts', true],
    ['src/aaab.ts', 'src/a+b.ts', false], ['a.ts', '*.ts', true],
  ];
  for (const [path, pattern, expected] of cases) {
    assert.equal(matchesAllowed(path, [pattern]), expected, `native ${path} ${pattern}`);
    assert.equal(fallbackMatchesGlob(path, pattern), expected, `fallback ${path} ${pattern}`);
    assert.equal(matchesAllowed(path, [pattern], false), expected);
  }
  assert.equal(matchesAllowed('test/a.ts', ['src/**', 'test/**']), true);
  assert.equal(matchesAllowed('test/a.ts', []), false);
});

const success = worker();
const needs = { ...success, status: 'needs_input' as const };
const blocked = { ...success, status: 'blocked' as const };
const failedChecks = [{ id: 'AC1', exit_code: 7 }, { id: 'AC2', exit_code: 1 }];
const cases: { name: string; args: Parameters<typeof finalOutcome>; state: string; reason: string | null; reasons: string[] }[] = [
  { name: 'forced worker_stalled overrides worker signal', args: [0, needs, [], 'worker_stalled', [], null], state: 'failed', reason: 'worker_stalled', reasons: [] },
  { name: 'forced timeout overrides all facts', args: [1, needs, ['readonly_modified'], 'timeout', failedChecks, 'provider_error: error'], state: 'timeout', reason: 'timeout', reasons: ["provider_error: error", "worker_exit_nonzero:1", "policy_violations: readonly_modified", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'forced cancellation overrides blocking', args: [1, blocked, [], 'cancelled', failedChecks, 'provider_error: error'], state: 'cancelled', reason: null, reasons: ["provider_error: error", "worker_exit_nonzero:1", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'supervisor forced failure overrides worker signal', args: [0, needs, [], 'failed', failedChecks, 'provider_error: error'], state: 'failed', reason: 'worker_crashed', reasons: ["provider_error: error", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'needs_input + failed check remains needs_input', args: [1, needs, ['readonly_modified'], undefined, failedChecks, 'provider_error: error'], state: 'needs_input', reason: null, reasons: ["provider_error: error", "worker_exit_nonzero:1", "policy_violations: readonly_modified", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'blocked overrides exit, policies, provider and checks', args: [1, blocked, ['outside_allowed_paths'], undefined, failedChecks, 'provider_error: error'], state: 'blocked', reason: 'worker_blocked: no detail', reasons: ["provider_error: error", "worker_exit_nonzero:1", "policy_violations: outside_allowed_paths", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'explicit provider failure overrides exit and parse error', args: [23, null, ['readonly_modified'], undefined, failedChecks, 'provider_error: execution', 'worker_result_invalid: bad'], state: 'failed', reason: 'provider_error: execution', reasons: ["provider_error: execution", "worker_exit_nonzero:23", "worker_result_invalid: bad", "policy_violations: readonly_modified", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'nonzero exit overrides missing report, policies and checks', args: [23, null, ['readonly_modified'], undefined, failedChecks], state: 'failed', reason: 'worker_exit_nonzero:23', reasons: ["worker_exit_nonzero:23", "worker_result_missing", "policy_violations: readonly_modified", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'signal exit is not success', args: [null, success, []], state: 'failed', reason: 'worker_exit_nonzero:null', reasons: ["worker_exit_nonzero:null"] },
  { name: 'missing report overrides policies and checks', args: [0, null, ['readonly_modified'], undefined, failedChecks], state: 'failed', reason: 'worker_result_missing', reasons: ["worker_result_missing", "policy_violations: readonly_modified", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'invalid report reason is retained without explicit provider failure', args: [0, null, [], undefined, failedChecks, null, 'worker_result_invalid: tests[0].cmd'], state: 'failed', reason: 'worker_result_invalid: tests[0].cmd', reasons: ["worker_result_invalid: tests[0].cmd", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'observed violations override reported violations, failure and checks', args: [0, { ...success, status: 'failed', policy_violations: ['reported'] }, ['outside_allowed_paths', 'readonly_modified'], undefined, failedChecks], state: 'failed', reason: 'policy_violations: outside_allowed_paths, readonly_modified', reasons: ["policy_violations: outside_allowed_paths, readonly_modified", "policy_violations: reported", "worker_reported_failed", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'worker policy violations override worker failure and checks', args: [0, { ...success, status: 'failed', policy_violations: ['reported'] }, [], undefined, failedChecks], state: 'failed', reason: 'policy_violations: reported', reasons: ["policy_violations: reported", "worker_reported_failed", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'worker failure overrides checks', args: [0, { ...success, status: 'failed' }, [], undefined, failedChecks], state: 'failed', reason: 'worker_reported_failed', reasons: ["worker_reported_failed", "check_failed:AC1", "check_failed:AC2"] },
  { name: 'first failed check determines reason', args: [0, success, [], undefined, [{ id: 'PASS', exit_code: 0 }, ...failedChecks]], state: 'failed', reason: 'check_failed:AC1', reasons: ["check_failed:AC1", "check_failed:AC2"] },
  { name: 'terminated check fails', args: [0, success, [], undefined, [{ id: 'AC1', exit_code: null }]], state: 'failed', reason: 'check_failed:AC1', reasons: ["check_failed:AC1"] },
  { name: 'otherwise succeeds', args: [0, success, [], undefined, [{ id: 'AC1', exit_code: 0 }]], state: 'succeeded', reason: null, reasons: [] },
];
for (const { name, args, state, reason, reasons } of cases) {
  test(`SPEC §8.7: ${name}`, () => {
    const outcome = finalOutcome(...args);
    assert.equal(outcome.state, state);
    assert.equal(outcome.failure_reason, reason);
    assert.deepEqual(outcome.failure_reasons, reasons);
    assert.equal(finalState(...args.slice(0, 6) as Parameters<typeof finalState>), state);
  });
}

test('prompt: carries the entire brief, follow-up answers, worker boundaries and final-report instructions', () => {
  const task = { ...brief('/repo'), answers: [{ question_id: 'Q1', answer: 'A' }] };
  const prompt = renderPrompt(task);
  assert.ok(prompt.includes(JSON.stringify(task, null, 2)));
  assert.match(prompt, /Do not access the network or install packages/);
  assert.match(prompt, /LAST fenced json block/);
  assert.match(prompt, /gbdev.worker-result.v1/);
});
