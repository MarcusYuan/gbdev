import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { providerOutputSchema } from '../src/providers/outputSchema.js';
import { codex, codexFailureReason } from '../src/providers/codex.js';
import { fake } from '../src/providers/fake.js';
import { buildWorkerResultSchema, type WorkerSchemaOptions } from '../src/contracts/workerResultSchema.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { builtinPipelines } from '../src/pipeline/definitions.js';
import { temporary, worker } from './helpers.js';
import { validateWorkerResult } from '../src/contracts/workerResult.js';
import { fixture } from './helpers/m3.js';
import { testEnv } from './helpers/run.js';
import { providerStub } from './helpers/providerStub.js';
import { jobPaths } from '../src/core/paths.js';
import { runJobs } from '../src/run/invariants.js';
import { jsonFile, runPaths } from '../src/run/store.js';
import { mergeRecords } from '../src/run/result.js';
import { git } from '../src/core/git.js';

const forbidden = ['uniqueItems', 'patternProperties', 'propertyNames', 'minProperties', 'maxProperties', 'contains', 'minContains', 'maxContains', 'if', 'then', 'else', 'not', 'dependentRequired', 'dependentSchemas', 'dependencies', 'unevaluatedProperties', 'unevaluatedItems', 'additionalItems', 'allOf', 'oneOf'];
function strictSchema(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  for (const key of forbidden) assert.ok(!Object.hasOwn(node, key), `Forbidden schema keyword: ${key}`);
  if (node.type === 'object' || Array.isArray(node.type) && node.type.includes('object')) {
    assert.equal(node.additionalProperties, false);
    assert.deepEqual([...(node.required as string[])].sort(), Object.keys(node.properties as object).sort());
  }
  for (const child of Object.values(node)) strictSchema(child);
}
const roles = builtinRoles();
const cases: [string, WorkerSchemaOptions][] = [
  ['run planner', { pipelineStep: true, output: 'report', taskGraph: true }],
  ['run resolver', { pipelineStep: true, output: 'change', mergeResolution: true }],
  ['run verifier', { pipelineStep: true, output: 'verdict' }],
  ['final reviewer', { pipelineStep: true, output: 'verdict' }],
  ['final verifier', { pipelineStep: true, output: 'verdict' }],
  ...roles.map(role => [`standalone ${role.name}`, { pipelineStep: false, output: role.output }] as [string, WorkerSchemaOptions]),
  ...builtinPipelines().flatMap(p => [...p.steps, ...(p.fix_loop ? [{ id: 'fix-loop', role: p.fix_loop.fix_role }] : [])].map(step =>
    [`${p.name}/${step.id} (${step.role})`, { pipelineStep: true, output: roles.find(r => r.name === step.role)!.output }] as [string, WorkerSchemaOptions])),
];
for (const [name, options] of cases) test(`D8 provider schema file: ${name}`, t => {
  const dir = temporary(t), internal = buildWorkerResultSchema(options), before = JSON.stringify(internal);
  for (const adapter of [codex, fake]) {
    adapter.prepareJob!(dir, options);
    const bytes = readFileSync(join(dir, 'worker-result.schema.json'));
    strictSchema(JSON.parse(bytes.toString()));
    assert.equal(JSON.stringify(internal), before, 'provider projection must not mutate the internal schema');
    if (!options.taskGraph && !options.mergeResolution) {
      const baseline = options.pipelineStep ? `m2.${options.output}` : 'm1';
      // M2 frozen fixtures include one LF; the existing provider writer does not.
      const expected = readFileSync(`test/fixtures/worker-result.${baseline}.schema.json`, 'utf8');
      assert.equal(bytes.toString(), options.pipelineStep ? expected.slice(0, -1) : expected);
      assert.equal(bytes.toString(), JSON.stringify(internal, null, 2), 'unchanged provider bytes');
    }
  }
});

test('D8 recursive projection strips unsupported constraints without corrupting property names or literal values', () => {
  const constraints = Object.fromEntries(forbidden.map(key => [key, true]));
  const leaf = { type: 'array', ...constraints, items: { type: 'string' } };
  const input = { type: 'object', properties: { not: leaf }, required: ['not'], additionalProperties: false,
    $defs: { example: leaf }, anyOf: [{ type: 'null' }, { type: 'array', items: leaf }],
    const: { not: 'literal', uniqueItems: true }, enum: [{ contains: 'literal' }] };
  const original = structuredClone(input);
  const result = providerOutputSchema(input) as typeof input;
  assert.deepEqual(result.properties.not, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(result.$defs.example, result.properties.not);
  assert.deepEqual(result.anyOf[1]!.items, result.properties.not);
  assert.deepEqual(result.const, input.const); assert.deepEqual(result.enum, input.enum);
  assert.deepEqual(input, original); assert.deepEqual(providerOutputSchema(result), result);
});

test('D8 planner duplicate depends_on remains plan_invalid after provider projection', async t => {
  const f = fixture(t), graph = { schema: 'gbdev.task-graph.v1', summary: 'duplicate dependency', tasks: f.request.tasks! };
  graph.tasks[1]!.depends_on = ['a', 'a']; f.request.decompose = 'planner'; f.request.tasks = null;
  assert.throws(() => validateWorkerResult({ ...worker(), task_graph: graph }), /depends_on: duplicate entries/);
  for (const n of [1, 2]) f.fakePlan[`run:planner#${n}`] = { actions: [{ type: 'emit_task_graph', graph }] };
  const { run } = await f.execute();
  assert.equal(run.state, 'needs_decision'); assert.equal(run.attention[0]!.reason, 'plan_invalid');
  assert.match(run.attention[0]!.detail, /worker_result_invalid/);
  assert.equal(run.plan.plan_attempts, 2); assert.equal(run.tasks.length, 0);
  for (const job of runJobs(f.store, run)) {
    const paths = jobPaths(f.paths, job.job_id);
    strictSchema(jsonFile(join(paths.dir, 'worker-result.schema.json')));
    assert.doesNotMatch(readFileSync(paths.prompt, 'utf8'), /uniqueItems/);
  }
  for (const n of [1, 2]) assert.match(jsonFile<{ errors: string[] }>(join(runPaths(f.store, run.run_id).dir, 'plans', `plan-${n}.json`)).errors.join(' '), /worker_result_invalid/);
  f.invariants(run.run_id);
});

for (const outside of [false, true]) test(`D9 refreshed integration-fix excludes other task changes but retains own scope violations: ${outside}`, async t => {
  const f = fixture(t);
  f.request.checks[0]!.cmd = 'test ! -f src/a.txt || test ! -f src/b.txt || test "$(cat src/b.txt)" = fixed';
  f.fakePlan['b/implement#1'] = { sleep_ms: 1500, actions: [
    { type: 'write_file', path: 'src/b.txt', content: 'b\n' },
    ...(outside ? [{ type: 'write_file', path: 'src/outside.txt', content: 'original task violation\n' }] : []),
  ] };
  f.fakePlan['b/fix#1'] = { actions: [{ type: 'write_file', path: 'src/b.txt', content: 'fixed\n' }] };
  const { run, result } = await f.execute(); assert.equal(run.state, 'succeeded', JSON.stringify(run));
  const records = mergeRecords(f.store, run), failed = records.find(r => r.result === 'rolled_back_gate_failed')!;
  assert.equal(records[0]!.task_id, 'a'); assert.equal(failed.task_id, 'b');
  const task = run.tasks.find(t => t.task_id === 'b')!;
  assert.equal(task.attempts[1]!.kind, 'integration_fix'); assert.equal(task.base_sha, failed.pre_merge_sha);
  assert.match(git(f.repo, ['log', '--format=%s', task.head_sha!, '--']), /refresh b onto integration/);
  assert.deepEqual(task.scope_exceeded, outside ? ['src/outside.txt'] : []);
  assert.deepEqual(result.tasks.find(t => t.task_id === 'b')!.scope_exceeded, task.scope_exceeded);
  assert.equal(result.warnings.includes('scope_exceeded:b'), outside);
  const pipeline = jsonFile<{ diff_base_sha: string }>(join(f.paths.home, 'pipelines', task.attempts[1]!.pipeline_id, 'pipeline.json'));
  assert.equal(pipeline.diff_base_sha, failed.pre_merge_sha);
  f.invariants(run.run_id);
});

for (const type of ['turn.failed', 'error']) test(`D10 ${type} extracts only bounded structured messages and redacts prompt echoes`, t => {
  const dir = temporary(t), secret = 'Private prompt contents must not be copied';
  writeFileSync(join(dir, 'prompt.md'), secret);
  const message = `Invalid schema: uniqueItems is not permitted. ${secret}\n${'细'.repeat(400)}`;
  const event = type === 'turn.failed' ? { type, error: { message, prompt: 'nested-private' } } : { type, message, prompt: 'nested-private' };
  writeFileSync(join(dir, 'raw.jsonl'), `not-json\n${JSON.stringify({ type: 'item.completed', message: 'private prose' })}\n${JSON.stringify(event)}\n{partial`);
  const reason = codexFailureReason(dir)!;
  assert.match(reason, /provider_error: Invalid schema: uniqueItems is not permitted/);
  assert.doesNotMatch(reason, /Private prompt|nested-private|private prose/);
  assert.equal(Array.from(reason.slice('provider_error: '.length)).length, 300);
  writeFileSync(join(dir, 'raw.jsonl'), JSON.stringify(event) + '\n' + JSON.stringify({ type: 'turn.completed' }));
  assert.equal(codexFailureReason(dir), null, 'recovered transient errors must not fail a completed turn');
  writeFileSync(join(dir, 'raw.jsonl'), JSON.stringify({ type: 'turn.failed', error: { prompt: secret } }));
  assert.equal(codexFailureReason(dir), null);
});

test('D10 fake Codex structured failure reaches both plan errors and decision detail without prompt', async t => {
  const f = fixture(t), bin = providerStub(f.root);
  writeFileSync(f.paths.config, JSON.stringify({ version: 1, allowed_repos: [f.repo], providers: { codex: { bin }, cursor: { bin } } }));
  f.request.decompose = 'planner'; f.request.tasks = null;
  // Make internal planner select the Codex adapter backed solely by our local stub.
  f.request.task_pipeline_overrides.fix = { provider: 'codex' };
  f.request.goal = 'Private planner prompt contents';
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.parallel = { rate_limit_cooldown_s: 0 }; writeFileSync(f.paths.config, JSON.stringify(config));
  testEnv(t, { GBDEV_STUB_CODEX_ERROR: 'Invalid schema: depends_on.uniqueItems is not permitted when strict is true.', GBDEV_STUB_EXIT: '1' });
  const { run } = await f.execute();
  assert.equal(run.state, 'needs_decision'); assert.equal(run.attention[0]!.reason, 'plan_invalid');
  assert.match(run.attention[0]!.detail, /provider_error: Invalid schema: depends_on.uniqueItems/);
  assert.doesNotMatch(run.attention[0]!.detail, /Private planner prompt/);
  assert.equal(run.plan.plan_attempts, 0);
  assert.equal(run.budget.jobs_used, 4);
  for (const n of [1, 2, 3, 4]) {
    const plan = jsonFile<{ errors: string[]; job_id: string }>(join(runPaths(f.store, run.run_id).dir, 'plans', `plan-${n}.json`));
    assert.match(plan.errors.join(' '), /uniqueItems is not permitted when strict is true/);
    const result = jsonFile<{ failure_reasons: string[] }>(jobPaths(f.paths, plan.job_id).result);
    assert.ok(result.failure_reasons.includes('worker_exit_nonzero:1'));
    assert.ok(result.failure_reasons.some(s => s.startsWith('provider_error: Invalid schema')));
  }
  f.invariants(run.run_id);
});
