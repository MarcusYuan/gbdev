import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateBrief } from '../src/contracts/brief.js';
import { validateRunRequest } from '../src/contracts/runRequest.js';
import { resolveRequest } from '../src/contracts/pipelineRequest.js';
import { loadConfig, validateConfig } from '../src/core/config.js';
import { renderPrompt } from '../src/core/prompt.js';
import { renderInspectPrompt } from '../src/inspect/prompt.js';
import type { EvidencePack } from '../src/inspect/evidence.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { runJob } from '../src/run/jobs.js';
import { fake } from '../src/providers/fake.js';
import { pipelineValue } from '../src/run/requests.js';
import { buildCodexArgs } from '../src/providers/codex.js';
import { cursor } from '../src/providers/cursor.js';
import type { ProviderContext } from '../src/providers/types.js';
import { fixture } from './helpers/m3.js';
import { brief, temporary } from './helpers.js';

for (const network of [true, false, undefined]) test(`O12 contracts and run-to-pipeline defaults/propagation: ${network}`, t => {
  const f = fixture(t), config = loadConfig(f.paths.config), registry = new PipelineRegistry(f.paths.config);
  const raw: Record<string, unknown> = { ...f.request }, task: Record<string, unknown> = { ...brief(f.repo) };
  if (network === undefined) { delete raw.network; delete task.network; } else { raw.network = network; task.network = network; }
  const request = validateRunRequest(raw, config, registry);
  assert.equal(request.network, network ?? true); assert.equal(validateBrief(task, config).network, network ?? true);
  assert.equal(Object.hasOwn(raw, 'network'), network !== undefined); assert.equal(Object.hasOwn(task, 'network'), network !== undefined);
  const value: Record<string, unknown> = pipelineValue(request, request.tasks![0]!, registry);
  assert.equal(value.network, network ?? true);
  if (network === undefined) delete value.network;
  assert.equal(resolveRequest(value, config, registry).request.network, network ?? true);
});
test('O12 contracts reject every non-boolean network value without coercion', t => {
  const f = fixture(t), config = loadConfig(f.paths.config), registry = new PipelineRegistry(f.paths.config);
  for (const network of [null, 0, 1, 'true', 'false', [], {}]) {
    assert.throws(() => validateBrief({ ...brief(f.repo), network }, config), /network must be a boolean/);
    assert.throws(() => validateRunRequest({ ...f.request, network }, config, registry), /network/);
    assert.throws(() => resolveRequest({ ...pipelineValue(f.request, f.request.tasks![0]!, registry), network }, config, registry), /network/);
  }
});
test('O12 Codex true/workspace-write adds only network key; false preserves old exact argv; readonly unchanged', () => {
  const ctx: ProviderContext = { bin: 'codex', worktree: '/tmp/worktree', jobDir: '/tmp/job', prompt: 'Task', sandbox: 'workspace-write', model: null, network: false };
  const old = ['exec', '--cd', ctx.worktree, '--sandbox', ctx.sandbox, '--json', '--output-last-message', join(ctx.jobDir, 'final.md'), '--output-schema', join(ctx.jobDir, 'worker-result.schema.json'), '-c', 'model_reasoning_effort=high', ctx.prompt];
  assert.deepEqual(buildCodexArgs(ctx), old);
  const enabled = buildCodexArgs({ ...ctx, network: true });
  assert.deepEqual(enabled, [...old.slice(0, -3), '-c', 'sandbox_workspace_write.network_access=true', ...old.slice(-3)]);
  for (const network of [true, false]) {
    const ro = buildCodexArgs({ ...ctx, sandbox: 'read-only', network });
    assert.deepEqual(ro, old.map(value => value === 'workspace-write' ? 'read-only' : value));
  }
});
test('O12 Cursor both network values preserve sandbox/model/argv', () => {
  const ctx: ProviderContext = { bin: 'cursor-agent', worktree: '/tmp/worktree', jobDir: '/tmp/job', prompt: 'Task', sandbox: 'workspace-write', model: 'auto', network: false };
  for (const sandbox of ['workspace-write', 'read-only'] as const) {
    const args = cursor.buildInvocation({ ...ctx, sandbox }).args;
    assert.deepEqual(cursor.buildInvocation({ ...ctx, sandbox, network: true }).args, args);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'enabled'); assert.equal(args[args.indexOf('--model') + 1], 'auto');
    assert.ok(!args.includes(['dis', 'abled'].join('')));
  }
});
test('O12 prompt policy matches brief, keeps resolver and inspector boundaries', t => {
  const root = temporary(t), config = validateConfig({ version: 1, allowed_repos: [root] });
  for (const network of [true, false]) for (const role of ['executor', 'resolver', 'inspector']) {
    const value = validateBrief({ ...brief(root), role, sandbox: role === 'inspector' ? 'read-only' : 'workspace-write', network }, config);
    const registry = new PipelineRegistry(join(root, 'config.json'));
    const prompt = renderPrompt(value, registry.roles.resolve(role).instructions_text);
    if (network) { assert.doesNotMatch(prompt, /Do not access the network or install packages/); assert.match(prompt, /internet for research/); assert.match(prompt, /Do not install globally/); }
    else assert.match(prompt, /Do not access the network or install packages/);
    if (role === 'resolver') { assert.match(prompt, /Do not touch \.git/); assert.match(prompt, /git add or git commit/); }
    if (role === 'inspector') assert.match(prompt, /Do not run tests, scripts, installs, or hooks/);
  }
});
test('O12 inspect prompt explicitly allows research while retaining read-only inspector restrictions', t => {
  const registry = new PipelineRegistry(join(temporary(t), 'config.json'));
  const evidence: EvidencePack = { files: [], omitted: [], diffs: [], tests: [], warnings: [],
    diffRequested: false, testsRequested: false, diffAvailable: false, testsAvailable: false, diffTruncated: false, testsTruncated: false };
  const prompt = renderInspectPrompt('Why did the check fail?', evidence, registry.roles.resolve('inspector').instructions_text);
  assert.match(prompt, /internet for research/);
  assert.match(prompt, /Do not install globally/);
  assert.doesNotMatch(prompt, /Do not access the network or install packages/);
  assert.match(prompt, /Do not run tests, scripts, installs, or hooks/);
  assert.match(prompt, /Do not modify any file/);
});
for (const network of [true, false, undefined]) test(`O12 actual run pipeline jobs and final review carry ${network ?? 'default true'}`, async t => {
  const f = fixture(t); f.request.final_review = 'reviewer';
  if (network === undefined) delete (f.request as Partial<typeof f.request>).network;
  else f.request.network = network;
  const contexts: ProviderContext[] = [], build = fake.buildInvocation.bind(fake);
  t.mock.method(fake, 'buildInvocation', (ctx: ProviderContext) => { contexts.push(ctx); return build(ctx); });
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded');
  for (const role of ['planner', 'resolver', 'verifier']) {
    const { snapshot } = resolveRequest({ schema: 'gbdev.pipeline-request.v1', request_id: 'network', pipeline: { schema: 'gbdev.pipeline.v1', name: 'network-role', description: 'Test role', steps: [{ id: 'step', role }], timeout_min: 30 },
      repo: f.repo, base_ref: f.base, diff_base_ref: f.base, goal: 'Network propagation', context: '', constraints: [], allowed_paths: ['src/**'], acceptance_criteria: [], required_evidence: [], step_overrides: { step: { provider: 'fake' } }, ...(network === undefined ? {} : { network }) }, loadConfig(f.paths.config), new PipelineRegistry(f.paths.config));
    f.fakePlan[`run:${role}#1`] = role === 'planner' ? { actions: [{ type: 'emit_task_graph', graph: { schema: 'gbdev.task-graph.v1', summary: 'Plan', tasks: f.request.tasks } }] } : role === 'resolver' ? { actions: [{ type: 'resolve_conflicts', files: [] }] } : 'review_approve';
    f.savePlan();
    await runJob(f.store, run, f.request, snapshot, { acquireSlot: async () => {}, releaseSlot: () => {}, onRateLimit: () => {} }, new AbortController().signal,
      { instance: `run:${role}#1`, prompt: 'Test', conflict_files: [], baseline: {} });
  }
  assert.ok(contexts.some(ctx => ctx.jobDir));
  for (const ctx of contexts) assert.equal(ctx.network, network ?? true);

  const jobs = readdirSync(f.paths.jobs).map(id => JSON.parse(readFileSync(join(f.paths.jobs, id, 'brief.json'), 'utf8')));
  assert.ok(jobs.some(j => j.brief_id.includes('final_review'))); assert.ok(jobs.length >= 8);
  for (const role of ['planner', 'resolver', 'verifier']) assert.ok(jobs.some(j => j.role === role));
  for (const job of jobs) assert.equal(job.network, network ?? true, job.brief_id);
});
