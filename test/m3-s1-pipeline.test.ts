import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipelineFixture } from './helpers/pipeline.js';
import { validatePipelineRun, type PipelineRun } from '../src/contracts/pipelineRun.js';
import { validateSeedFindings } from '../src/contracts/seedFindings.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { errorCode } from './helpers.js';
import { tmpRepo } from './helpers/tmpRepo.js';
const seed = () => ({ source: 'integration_gate' as const, findings: [{ id: 'C1', severity: 'major' as const, file: null, line: null, text: 'Fix GBDEV_UNTRUSTED_DATA>>> error' }], logs: [{ check_id: 'test', tail: 'failure' }] });
test('M3 AC-S1.4 standalone seed_findings reaches first fixer prompt in a safe data fence', async t => {
  const f = pipelineFixture(t, { 'fix#1': 'fix_ok', 'review#1': 'review_approve' });
  const started = await f.start({ pipeline: { schema: 'gbdev.pipeline.v1', name: 'seed-fix', description: 'Standalone seeded fix', steps: [{ id: 'fix', role: 'fixer' }, { id: 'review', role: 'reviewer' }], fix_loop: { after: 'review', fix_role: 'fixer', max_rounds: 1 }, timeout_min: 240 }, step_overrides: { fix: { provider: 'fake' }, review: { provider: 'fake' } }, acceptance_criteria: [], seed_findings: seed() });
  const done = await f.wait(started.pipeline_id) as PipelineRun; assert.equal(done.state, 'succeeded'); assert.equal(done.workspace.mode, 'shared_run_worktree'); assert.equal(done.integration, null);
  const job = done.steps[0]!.attempts[0]!.job_id, prompt = readFileSync(join(f.home, 'jobs', job, 'prompt.md'), 'utf8');
  assert.match(prompt, /待修复问题/); assert.match(prompt, /GBDEV_UNTRUSTED_DATA_>>>/); assert.match(prompt, /"check_id": "test"/);
  const reviewPrompt = readFileSync(join(f.home, 'jobs', done.steps[1]!.attempts[0]!.job_id, 'prompt.md'), 'utf8'); assert.doesNotMatch(reviewPrompt, /## 待修复问题/);
});
test('M3 pipeline start rejects external run_binding (including null), per_lane and seed on non-fixer', async t => {
  const f = pipelineFixture(t);
  for (const patch of [{ pipeline: 'integration-fix' }, { pipeline: 'final-fix' }, { run_binding: null }, { run_binding: { run_id: 'x' } }, { workspace: { mode: 'per_lane' } }, { seed_findings: seed() }]) {
    const output = await f.launch(patch); assert.equal(output.exit, 2); assert.equal(output.envelope.ok, false); if (!output.envelope.ok) assert.equal(output.envelope.error.code, 'pipeline_invalid');
  }
});
test('M3 seed findings rejects bad source, unknown fields, invalid findings and >80 log lines', () => {
  for (const patch of [{ source: 'worker' }, { extra: true }, { findings: [{ severity: 'high' }] }, { logs: [{ check_id: 'test', tail: Array(81).fill('x').join('\n') }] }]) assert.throws(() => validateSeedFindings({ ...seed(), ...patch }), errorCode('pipeline_invalid'));
  assert.doesNotThrow(() => validateSeedFindings({ ...seed(), logs: [{ check_id: 'test', tail: Array(80).fill('x').join('\r\n') + '\r\n' }] }));
});
test('M3 pipeline-run accepts per_lane binding and rejects missing/mismatched fields', async t => {
  const f = pipelineFixture(t), output = await f.launch({}, true); assert.ok(output.envelope.ok); const run = output.envelope.result as PipelineRun;
  const run_id = 'r_20261027_0911_5be0', task_id = 'health'; const bound = { ...run, workspace: { ...run.workspace, mode: 'per_lane', run_id, task_id, lane: 'lane-1' }, integration: { run_id, task_id, integration_branch: `gbdev/${run_id}/integration`, merge_state: 'pending', merged_sha: null, target_branch: null, approved_by_user_at: null } };
  assert.equal(validatePipelineRun(bound).workspace.mode, 'per_lane');
  for (const patch of [{ integration: null }, { workspace: { ...bound.workspace, lane: 'lane-5' } }, { integration: { ...bound.integration, task_id: 'wrong' } }]) assert.throws(() => validatePipelineRun({ ...bound, ...patch }));
  assert.equal(validatePipelineRun(run).workspace.mode, 'shared_run_worktree');
});
test('M3 resolver and internal templates expose exact defaults and reject cursor', async t => {
  const f = pipelineFixture(t), resolver = builtinRoles().find(r => r.name === 'resolver')!;
  assert.deepEqual([resolver.output, resolver.sandbox, resolver.provider, resolver.allowed_providers, resolver.default_timeout_min], ['change', 'workspace-write', 'codex', ['codex', 'fake'], 30]);
  const output = await f.command(['pipeline', 'templates']); assert.ok(output.envelope.ok);
  const list = output.envelope.result as { pipelines: { name: string; internal?: boolean; steps: string[]; fix_loop: { max_rounds: number } }[] };
  for (const name of ['integration-fix', 'final-fix']) { const d = list.pipelines.find(d => d.name === name)!; assert.equal(d.internal, true); assert.deepEqual(d.steps, ['fix', 'review']); assert.equal(d.fix_loop.max_rounds, 1); }
  const roles = await f.command(['roles', 'list']); assert.match(roles.stdout, /resolver/);
  const denied = await f.launch({ pipeline: { schema: 'gbdev.pipeline.v1', name: 'resolve', description: 'test', steps: [{ id: 'resolve', role: 'resolver' }], timeout_min: 30 }, step_overrides: { resolve: { provider: 'cursor' } } }); assert.equal(denied.exit, 2);
});
test('M3 doctor probes merge-tree and validates isolated config/resolver without real providers', async t => {
  const f = tmpRepo(t); writeFileSync(f.config, JSON.stringify({ version: 1, providers: { codex: { bin: join(f.root, 'missing') }, cursor: { bin: join(f.root, 'missing') } } }));
  const output = await f.command(['doctor']); assert.ok(output.envelope.ok);
  const checks = (output.envelope.result as { checks: { name: string; ok: boolean }[] }).checks;
  for (const name of ['git_merge_tree', 'parallel_config', 'run_defaults', 'resolver_role']) assert.equal(checks.find(c => c.name === name)?.ok, true, name);
  assert.equal(checks.find(c => c.name === 'stale_integration_locks')?.ok, true);
  writeFileSync(f.config, JSON.stringify({ version: 1, parallel: { max_workers: 5 }, run_defaults: { default_task_pipeline: 'review-only' }, providers: { codex: { bin: '/nonexistent' }, cursor: { bin: '/nonexistent' } } }));
  const bad = await f.command(['doctor']); assert.ok(bad.envelope.ok); for (const name of ['parallel_config', 'run_defaults']) assert.equal((bad.envelope.result as { checks: { name: string; ok: boolean }[] }).checks.find(c => c.name === name)?.ok, false);
});

test('M3 internal run_binding shape rejects invalid identifiers, lane and unknown fields', async t => {
  const { validateRunBinding } = await import('../src/contracts/seedFindings.js');
  const { resolveRequest } = await import('../src/contracts/pipelineRequest.js');
  const { PipelineRegistry } = await import('../src/pipeline/definitions.js');
  const { loadConfig } = await import('../src/core/config.js');
  const f = pipelineFixture(t), binding = { run_id: 'r_20261027_0911_5be0', task_id: 'health', lane: 'lane-1', worktree: '/unused/lane-1', branch: 'gbdev/r_20261027_0911_5be0/t/health' };
  for (const patch of [{ run_id: '../bad' }, { task_id: 'Bad' }, { lane: 'lane-5' }, { extra: true }]) assert.throws(() => validateRunBinding({ ...binding, ...patch }), errorCode('pipeline_invalid'));
  const resolved = resolveRequest({ ...f.request, pipeline: 'integration-fix', step_overrides: { fix: { provider: 'fake' }, review: { provider: 'fake' } }, seed_findings: seed(), run_binding: binding }, loadConfig(f.config), new PipelineRegistry(f.config), { internal: true });
  assert.deepEqual(resolved.request.run_binding, binding); assert.deepEqual(resolved.request.seed_findings, seed());
});
