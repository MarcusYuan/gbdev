import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunRequest, runRequestSchema } from '../src/contracts/runRequest.js';
import { validateTaskGraph, taskGraphSchema, type TaskGraphContext } from '../src/contracts/taskGraph.js';
import { validateRun, runSchema, type RunAttention } from '../src/contracts/run.js';
import { validateMergeRecord, mergeRecordSchema } from '../src/contracts/mergeRecord.js';
import { validateRunResult, runResultSchema } from '../src/contracts/runResult.js';
import { validateRunResume, runResumeSchema } from '../src/contracts/runResume.js';
import { buildWorkerResultSchema } from '../src/contracts/workerResultSchema.js';
import { ERROR_RETRYABLE, errorExitCode } from '../src/contracts/error.js';
import { validateConfig } from '../src/core/config.js';
import { DEFAULT_PARALLEL, DEFAULT_RUN, validateParallel, validateRunDefaults } from '../src/core/runConfig.js';
import { createRunId } from '../src/core/ids.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { errorCode, temporary, worker } from './helpers.js';
import { normalizeWorkerResult } from '../src/contracts/workerResult.js';
import { schemaErrors, type JsonSchema } from '../src/contracts/runValidation.js';
import { validateEvent, EVENT_TYPES } from '../src/contracts/event.js';
import { localIso } from '../src/core/time.js';
const fixture = (name: string): any => JSON.parse(readFileSync(`test/fixtures/m3-${name}.json`, 'utf8'));
function context(root: string): TaskGraphContext { return { max_tasks: 12, allowed_paths: ['src/**', 'test/**', 'lib/**'], checks: [{ id: 'test' }, { id: 'build' }], default_task_pipeline: 'implement-review', registry: new PipelineRegistry(join(root, 'config.json')) }; }
const attention = (): RunAttention => ({ decision_id: 'd4', scope: 'task', task_id: 'health', reason: 'merge_conflict_unresolved', allowed_actions: ['retry_resolve', 'rebuild_task', 'drop_task'], detail: '', pipeline_id: null, merge_seq: 2, pending_questions: [], created_at: localIso() });
const resumeRun = () => ({ run_id: 'r_20261027_0911_5be0', attention: [attention()] });

test('M3 AC-S1.1 six SPEC examples validate and JSON Schema files match executable definitions', t => {
  const root = temporary(t), ctx = context(root), req = fixture('run-request'); req.repo = root;
  assert.equal(validateRunRequest(req, validateConfig({ version: 1, allowed_repos: [root] }), ctx.registry).lanes, 2);
  validateTaskGraph(fixture('task-graph'), ctx); validateRun(fixture('run')); validateMergeRecord(fixture('merge-record')); validateRunResult(fixture('run-result')); validateRunResume(fixture('run-resume'), resumeRun());
  for (const [name, shape] of [['run-request', runRequestSchema], ['task-graph', taskGraphSchema], ['run', runSchema], ['merge-record', mergeRecordSchema], ['run-result', runResultSchema], ['run-resume', runResumeSchema]] as const) {
    const stored = JSON.parse(readFileSync(`src/contracts/gbdev.${name}.v1.schema.json`, 'utf8'));
    assert.deepEqual(stored, { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `gbdev.${name}.v1`, ...shape });
  }
});
for (const [label, patch] of [
  ['unknown field', { unknown: true }], ['network', { network: 'true' }], ['bad checks', { checks: [{ id: 'Test', cmd: '', timeout_min: 61 }] }], ['missing check reference', { integration_checks: ['missing'] }], ['check_cmd injection', { acceptance_criteria: [{ id: 'A', text: 'x', check: null, check_cmd: 'evil' }] }], ['tasks/decompose mismatch', { tasks: [] }], ['lanes upper bound', { lanes: 5 }], ['readonly template', { default_task_pipeline: 'review-only' }], ['unknown override step', { task_pipeline_overrides: { nope: {} } }], ['override sandbox', { task_pipeline_overrides: { review: { sandbox: 'workspace-write' } } }],
] as const) test(`M3 AC-S1.1 run-request rejects ${label}`, t => {
  const root = temporary(t), ctx = context(root); assert.throws(() => validateRunRequest({ ...fixture('run-request'), repo: root, ...patch }, validateConfig({ version: 1, allowed_repos: [root] }), ctx.registry), errorCode('run_invalid'));
});
for (const [label, mutate] of [
  ['cycle', (g: any) => { g.tasks[0].depends_on = ['lib-sum']; }], ['duplicate id', (g: any) => { g.tasks[1].id = 'health'; }], ['self dependency', (g: any) => { g.tasks[0].depends_on = ['health']; }], ['unknown dependency', (g: any) => { g.tasks[0].depends_on = ['missing']; }], ['scope escape', (g: any) => { g.tasks[0].file_scope = ['../secret']; }], ['command injection', (g: any) => { g.tasks[0].acceptance_criteria[0].cmd = 'evil'; }], ['unknown check', (g: any) => { g.tasks[0].acceptance_criteria[0].check = 'missing'; }], ['readonly template', (g: any) => { g.tasks[0].pipeline = 'review-only'; }], ['unknown field', (g: any) => { g.tasks[0].oops = 1; }], ['max tasks', (g: any) => { g.tasks.push(...g.tasks); }],
] as const) test(`M3 AC-S1.1 task-graph rejects ${label}`, t => { const g = fixture('task-graph'); mutate(g); assert.throws(() => validateTaskGraph(g, context(temporary(t))), errorCode('run_invalid')); });
for (const [name, validate, patches] of [
  ['run', validateRun, [{ state: 'merging' }, { executor_host: 'cloud' }, { slots: { max_workers: 5 } }, { attention: [{ ...attention(), unknown: true }] }]],
  ['merge-record', validateMergeRecord, [{ seq: 0 }, { result: 'success' }, { gate: { checks: [], passed: 'yes', log_dir: 'x' } }, { precheck: { clean: true, conflict_files: ['x'], tree: null } }]],
  ['run-result', validateRunResult, [{ state: 'running' }, { diff_stat: { files: -1, insertions: 0, deletions: 0 } }, { landing: { eligible: true, target_hint: null, landed_sha: null, extra: true } }]],
] as const) for (const [i, patch] of patches.entries()) test(`M3 AC-S1.1 ${name} negative ${i + 1}`, () => assert.throws(() => validate({ ...fixture(name), ...patch }), errorCode('run_invalid')));
for (const [label, patch, code] of [
  ['unknown action', { action: 'cancel' }, 'run_invalid'], ['long note', { note: 'x'.repeat(2001) }, 'run_invalid'], ['stale decision', { decision_id: 'old' }, 'run_state_conflict'], ['wrong task', { task_id: null }, 'run_state_conflict'], ['disallowed action', { action: 'accept_final' }, 'run_state_conflict'], ['unknown field', { extra: true }, 'run_invalid'],
] as const) test(`M3 AC-S1.1 run-resume rejects ${label}`, () => assert.throws(() => validateRunResume({ ...fixture('run-resume'), ...patch }, resumeRun()), errorCode(code)));

test('M3 Cursor restriction has exit 2 precedence in requests, graphs and resume', t => {
  const root = temporary(t), ctx = context(root), config = validateConfig({ version: 1, allowed_repos: [root] });
  const graph = fixture('task-graph'); graph.tasks[0].provider = 'cursor'; graph.tasks[0].model = 'other';
  assert.throws(() => validateTaskGraph(graph, ctx), errorCode('cursor_model_not_allowed'));
  assert.throws(() => validateRunRequest({ ...fixture('run-request'), repo: root, task_pipeline_overrides: { review: { provider: 'cursor', cursor_model: 'other' } } }, config, ctx.registry), errorCode('cursor_model_not_allowed'));
  assert.throws(() => validateRunResume({ ...fixture('run-resume'), task_graph: graph }, resumeRun(), ctx), errorCode('cursor_model_not_allowed'));
  assert.equal(errorExitCode('cursor_model_not_allowed'), 2);
});
test('M3 run defaults apply; provided graph and custom check timeout normalize without I/O', t => {
  const root = temporary(t), ctx = context(root), req = fixture('run-request'); req.repo = root; req.decompose = 'provided'; req.tasks = fixture('task-graph').tasks;
  for (const key of ['lanes', 'max_tasks', 'max_total_jobs', 'timeout_min', 'max_integration_fixes', 'task_pipeline_overrides']) delete req[key]; delete req.checks[0].timeout_min;
  const result = validateRunRequest(req, validateConfig({ version: 1, allowed_repos: [root] }), ctx.registry);
  assert.equal(result.checks[0]!.timeout_min, 10); assert.equal(result.lanes, 2); assert.equal(result.tasks!.length, 3);
});
test('M3 config defaults, M1 isolation and unchanged concurrency error', t => {
  const registry = context(temporary(t)).registry;
  assert.deepEqual(validateParallel(), DEFAULT_PARALLEL); assert.deepEqual(validateRunDefaults({}, registry), DEFAULT_RUN);
  assert.deepEqual(validateConfig({ version: 1, parallel: { nonsense: true }, run_defaults: 3 }), validateConfig({ version: 1 }));
  assert.deepEqual(validateConfig({ version: 1 }, registry).run_defaults, DEFAULT_RUN);
  assert.throws(() => validateConfig({ version: 1, concurrency: 2 }, registry), /M1 concurrency must be 1/);
});
for (const patch of [{ max_workers: 0 }, { max_workers: 5 }, { max_workers: 2 }, { provider_limits: { codex: 4 } }, { provider_limits: { unknown: 1 } }, { max_workers: null }, { unknown: 1 }, { rate_limit_cooldown_s: -1 }]) test(`M3 parallel rejects ${JSON.stringify(patch)}`, () => assert.throws(() => validateParallel(patch), errorCode('config_invalid')));
for (const [key, low, high] of [['lanes', 0, 5], ['max_tasks', 0, 17], ['max_total_jobs', 0, 121], ['timeout_min', 59, 1441], ['max_integration_fixes', -1, 4], ['max_resolver_attempts', -1, 3], ['max_conflict_files', 0, 51], ['gate_timeout_min', 4, 121]] as const) test(`M3 run_defaults bounds ${key}`, t => { const registry = context(temporary(t)).registry; for (const value of [low, high, 1.5, null]) assert.throws(() => validateRunDefaults({ [key]: value }, registry), errorCode('config_invalid')); });
test('M3 config rejects unknown keys, nonexistent/readonly templates and bad enums', t => { const registry = context(temporary(t)).registry; for (const patch of [{ unknown: 1 }, { default_task_pipeline: 'missing' }, { default_task_pipeline: 'review-only' }, { final_review: 'executor' }, { overlap_policy: 'guess' }]) assert.throws(() => validateRunDefaults(patch, registry), errorCode('config_invalid')); });
for (const output of ['change', 'report', 'verdict'] as const) test(`M3 AC-S1.1 M2 ${output} worker schema is byte identical without M3 options`, () => {
  const baseline = readFileSync(`test/fixtures/worker-result.m2.${output}.schema.json`, 'utf8');
  assert.equal(JSON.stringify(buildWorkerResultSchema({ pipelineStep: true, output }), null, 2) + '\n', baseline);
  assert.equal(JSON.stringify(buildWorkerResultSchema({ pipelineStep: true, output, taskGraph: false, mergeResolution: false }), null, 2) + '\n', baseline);
});
test('M3 worker taskGraph/resolution strict object schemas and runtime preservation', () => {
  function strict(s: any): void { if (!s || typeof s !== 'object') return; if (s.type === 'object') { assert.equal(s.additionalProperties, false); assert.deepEqual(s.required, Object.keys(s.properties)); } for (const v of Object.values(s)) if (v && typeof v === 'object') strict(v); }
  const plan = buildWorkerResultSchema({ pipelineStep: false, output: 'report', taskGraph: true }), resolution = buildWorkerResultSchema({ pipelineStep: false, output: 'change', mergeResolution: true }); strict(plan); strict(resolution);
  const value = { ...worker(), task_graph: fixture('task-graph'), resolution: { files: [{ path: 'src/a', strategy: 'both', note: '' }], unresolved: ['src/b'] } };
  assert.deepEqual(normalizeWorkerResult(value).resolution, value.resolution); assert.deepEqual(normalizeWorkerResult(value).task_graph, value.task_graph);
  assert.throws(() => normalizeWorkerResult({ ...value, resolution: { files: [], unresolved: [3] } }));
  assert.ok(schemaErrors({ ...worker(), handoff: { decided: [], rejected: [], risks: [], remaining: [] } }, plan as JsonSchema).length);
});
test('M3 errors exactly match retryable and exit table; event type and optional binding', () => {
  for (const [code, retryable, exit] of [['run_not_found', false, 1], ['run_invalid', false, 2], ['run_not_settled', true, 1], ['run_not_terminal', true, 1], ['run_state_conflict', false, 1], ['integration_locked', true, 1], ['user_approval_required', false, 2], ['land_refused', false, 1], ['guard_violation', false, 1], ['pipeline_owned_by_run', false, 1], ['job_owned_by_run', false, 1]] as const) { assert.equal(ERROR_RETRYABLE[code], retryable); assert.equal(errorExitCode(code), exit); }
  for (const type of EVENT_TYPES) validateEvent({ schema: 'gbdev.event.v1', job_id: null, run_id: createRunId(), task_id: 'health', lane: 'lane-1', seq: 1, at: localIso(), source: 'gbdev', type, data: {} });
  assert.match(createRunId(new Date(2026, 9, 26, 9, 5)), /^r_20261026_0905_[a-f0-9]{4}$/);
});

test('M3 run-resume answer and plan approval enforce contextual references', t => {
  const ctx = context(temporary(t)), decision = { ...attention(), scope: 'run' as const, task_id: null, reason: 'plan_invalid' as const, allowed_actions: ['approve_plan' as const] };
  const input = { ...fixture('run-resume'), action: 'approve_plan', task_id: null, task_graph: fixture('task-graph') };
  assert.equal(validateRunResume(input, { ...resumeRun(), attention: [decision] }, ctx).task_graph!.tasks.length, 3);
  assert.throws(() => validateRunResume({ ...input, task_graph: null }, { ...resumeRun(), attention: [decision] }, ctx), errorCode('run_invalid'));
  const question = { id: 'Q1', question: 'Which?', options: [], default: null, blocking: true };
  const paused = { ...attention(), reason: 'task_paused' as const, allowed_actions: ['answer' as const], pending_questions: [question] };
  for (const answers of [null, [{ question_id: 'wrong', answer: 'x' }], [{ question_id: 'Q1', answer: 'x' }, { question_id: 'Q1', answer: 'x' }]]) assert.throws(() => validateRunResume({ ...fixture('run-resume'), action: 'answer', answers }, { ...resumeRun(), attention: [paused] }), errorCode('run_invalid'));
  assert.equal(validateRunResume({ ...fixture('run-resume'), action: 'answer', answers: [{ question_id: 'Q1', answer: 'x' }] }, { ...resumeRun(), attention: [paused] }).answers!.length, 1);
});
test('M3 task graph reports individual semantic errors and actual cycle members', t => {
  const ctx = context(temporary(t)), graph = fixture('task-graph');
  graph.tasks[0].depends_on = ['version']; graph.tasks[1].depends_on = ['health'];
  graph.tasks[0].file_scope = ['outside/**']; graph.tasks[1].acceptance_criteria[0].check = 'missing';
  assert.throws(() => validateTaskGraph(graph, ctx), (error: any) => { const errors: string[] = error.contract.details.errors; assert.ok(errors.some(e => e.includes('not covered'))); assert.ok(errors.some(e => e.includes('unknown check'))); assert.equal(errors.find(e => e.startsWith('Dependency cycle:')), 'Dependency cycle: health, version'); return true; });
  const valid = fixture('task-graph'); assert.throws(() => validateTaskGraph(valid, { ...ctx, max_tasks: 2 }), errorCode('run_invalid'));
  valid.tasks[0].file_scope = ['src/**']; assert.doesNotThrow(() => validateTaskGraph(valid, ctx));
});

test('M3 closed schemas reject prototype-named unknown fields at every level', t => {
  const ctx = context(temporary(t));
  for (const key of ['constructor', 'toString', '__proto__']) {
    const extra = JSON.parse(`{"${key}": "unexpected"}`);
    assert.throws(() => validateRun({ ...fixture('run'), ...extra }), errorCode('run_invalid'));
    assert.throws(() => validateMergeRecord({ ...fixture('merge-record'), ...extra }), errorCode('run_invalid'));
    const graph = fixture('task-graph'); graph.tasks[0] = { ...graph.tasks[0], ...extra };
    assert.throws(() => validateTaskGraph(graph, ctx), errorCode('run_invalid'));
  }
});
