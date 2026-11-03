import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunRequest } from '../src/contracts/runRequest.js';
import { loadConfig } from '../src/core/config.js';
import { validateRunDefaults } from '../src/core/runConfig.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { valueForDefinition } from '../src/run/requests.js';
import { resolveRequest } from '../src/contracts/pipelineRequest.js';
import { renderStepPrompt, type StepPromptContext } from '../src/pipeline/prompt.js';
import { fixture } from './helpers/m3.js';
import { brief } from './helpers.js';
import { startRun } from '../src/commands/run.js';
import { runPaths } from '../src/run/store.js';
import { runJobs } from '../src/run/invariants.js';
import { jobPaths } from '../src/core/paths.js';
import { mergeRecords } from '../src/run/result.js';

const context: StepPromptContext = { pipeline: 'implement-review', instance: 'implement#1', index: 1, total: 2, round: 0, max_rounds: 2, kind: 'step', diff_base_sha: 'abc', role: { output: 'change', instructions_text: 'role' }, prior_handoffs: [] };

test('O11 omission derives cheap checks in integration order; explicit lists/home defaults win; legacy [] stays []', t => {
  const f = fixture(t), registry = new PipelineRegistry(f.paths.config), config = loadConfig(f.paths.config);
  const { task_checks: _checks, ...raw } = f.request;
  const value = { ...raw, checks: [{ id: 'slow', cmd: 'true', timeout_min: 6 }, { id: 'missing', cmd: 'true' }, { id: 'fmt', cmd: 'true', timeout_min: 5 }, { id: 'quick', cmd: 'true', timeout_min: 1 }], integration_checks: ['quick', 'slow', 'fmt', 'missing'] };
  const normalize = (extra = {}, defaults = validateRunDefaults({}, registry)) => validateRunRequest({ ...value, ...extra }, config, registry, defaults);
  assert.deepEqual(normalize().task_checks, ['quick', 'fmt']);
  assert.equal(normalize().checks.find(c => c.id === 'missing')!.timeout_min, 10);
  assert.deepEqual(normalize({ task_checks: [] }).task_checks, []);
  assert.deepEqual(normalize({ task_checks: ['slow', 'fmt'] }).task_checks, ['slow', 'fmt']);
  for (const ids of [[], ['slow']]) {
    const defaults = validateRunDefaults({ task_checks: ids }, registry);
    assert.deepEqual(normalize({}, defaults).task_checks, ids);
    assert.deepEqual(normalize({ task_checks: ['fmt'] }, defaults).task_checks, ['fmt']);
  }
  assert.throws(() => validateRunDefaults({ task_checks: ['fmt', 'fmt'] }, registry));
  const req = normalize(), prepared = resolveRequest(valueForDefinition(req, req.tasks![0]!, registry.resolve('implement-review')), config, registry, { internal: true });
  assert.deepEqual(prepared.request.execution_checks!.map(c => c.id), ['quick', 'fmt']);
  assert.deepEqual(prepared.request.gate_checks!.map(c => c.id), value.integration_checks);
});

test('O11 normalized request and one audit warning are persisted, home [] does not default', async t => {
  const f = fixture(t);
  const { task_checks: _checks, ...raw } = f.request;
  const run = await startRun(f.store, raw, false);
  assert.deepEqual(JSON.parse(readFileSync(runPaths(f.store, run.run_id).request, 'utf8')).task_checks, ['test']);
  assert.deepEqual(run.warnings.filter(w => w.startsWith('task_checks_defaulted:')), ['task_checks_defaulted:["test"]']);
  const cfg = JSON.parse(readFileSync(f.paths.config, 'utf8')); cfg.run_defaults = { task_checks: [] };
  writeFileSync(f.paths.config, JSON.stringify(cfg));
  const dry = await startRun(f.store, raw, false, true);
  assert.ok(!dry.warnings.some(w => w.startsWith('task_checks_defaulted:')));
});

test('O11 informational gate prompts for executor/fixer/reviewer; absent and empty are byte-identical', () => {
  for (const role of ['executor', 'fixer', 'reviewer']) {
    const b = { ...brief('/example'), role, sandbox: role === 'reviewer' ? 'read-only' as const : 'workspace-write' as const };
    const c = { ...context, role: { ...context.role, output: role === 'reviewer' ? 'verdict' as const : 'change' as const } };
    const old = renderStepPrompt(b, c);
    assert.equal(renderStepPrompt({ ...b, gate_checks: [], execution_checks: [] }, c), old);
    const prompt = renderStepPrompt({ ...b, gate_checks: [{ id: 'fmt', cmd: 'cargo fmt --check' }] }, c);
    assert.match(prompt, /合并 gate 将运行的检查/); assert.match(prompt, /fmt: cargo fmt --check/);
    assert.match(prompt, /如沙箱限制无法运行，请在报告中说明而不是 blocked/);
  }
});

test('O11 omitted task_checks causes fmt failure in task stage and G6 fix before any merge rollback', async t => {
  const f = fixture(t); f.request.tasks = f.request.tasks!.slice(0, 1); f.request.lanes = 1;
  delete (f.request as { task_checks?: string[] }).task_checks;
  f.request.checks = [{ id: 'fmt', cmd: 'if test -f src/a.txt && grep -q BAD src/a.txt; then exit 1; fi', timeout_min: 5 }];
  f.request.integration_checks = ['fmt'];
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'BAD\n' }] };
  f.fakePlan['fix#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'good\n' }] };
  f.fakePlan['review#2'] = 'review_approve';
  const { run } = await f.execute();
  assert.equal(run.state, 'succeeded');
  const jobs = runJobs(f.store, run), implement = jobs.find(j => j.role === 'executor')!;
  assert.equal(JSON.parse(readFileSync(jobPaths(f.paths, implement.job_id).result, 'utf8')).failure_reason, 'check_failed:task_check:fmt');
  assert.equal(jobs.filter(j => j.role === 'executor').length, 1); assert.ok(jobs.some(j => j.role === 'fixer'));
  assert.equal(run.integration.rollbacks, 0); assert.equal(mergeRecords(f.store, run).length, 1);
  for (const j of jobs.filter(j => ['executor', 'fixer', 'reviewer'].includes(j.role))) assert.match(readFileSync(jobPaths(f.paths, j.job_id).prompt, 'utf8'), /合并 gate 将运行的检查/);
  assert.match(readFileSync(join(f.paths.home, 'pipelines', run.tasks[0]!.attempts[0]!.pipeline_id, 'events.jsonl'), 'utf8'), /G6/);
});
