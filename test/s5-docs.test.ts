import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateEnvelope } from '../src/contracts/envelope.js';
import { validateRole, validateRoleList, validateResolvedRole } from '../src/contracts/role.js';
import { validatePipeline } from '../src/contracts/pipeline.js';
import { validatePipelineRun } from '../src/contracts/pipelineRun.js';
import { validatePipelineResult } from '../src/contracts/pipelineResult.js';
import { validatePipelineResume } from '../src/contracts/pipelineResume.js';
import { validateCleanupResult } from '../src/contracts/commandResults.js';
import { resolveRequest } from '../src/contracts/pipelineRequest.js';
import { loadConfig } from '../src/core/config.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { RoleRegistry } from '../src/roles/registry.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { tmpRepo } from './helpers/tmpRepo.js';

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('S5 all documented command envelopes validate against their actual result contracts', () => {
  const files = readdirSync('docs/examples').filter(file => file.endsWith('.json'));
  const commands = new Set<string>();
  for (const file of files) {
    const envelope = validateEnvelope(json(join('docs/examples', file)));
    assert.equal(envelope.ok, true, file);
    if (!envelope.ok) continue;
    commands.add(envelope.command);
    const result = envelope.result;
    switch (envelope.result_schema) {
      case 'gbdev.role-list.v1': validateRoleList(result); break;
      case 'gbdev.role.v1': validateResolvedRole(result); break;
      case 'gbdev.pipeline-list.v1': {
        const list = result as { schema: string; pipelines: { name: string; steps: string[]; fix_loop: unknown }[]; invalid: unknown[] };
        assert.equal(list.schema, envelope.result_schema); assert.equal(list.pipelines.length, 4); assert.deepEqual(list.invalid, []);
        assert.deepEqual(list.pipelines.find(p => p.name === 'review-only')!.steps, ['review']);
        assert.equal(list.pipelines.find(p => p.name === 'review-only')!.fix_loop, null);
        break;
      }
      case 'gbdev.pipeline-run.v1':
        for (const run of Array.isArray(result) ? result : [result]) validatePipelineRun(run);
        break;
      case 'gbdev.pipeline-result.v1': {
        const r = validatePipelineResult(result);
        assert.equal(Object.hasOwn(r, 'summary'), false);
        assert.ok(r.steps.every(step => typeof step.summary === 'string'));
        break;
      }
      case 'gbdev.cleanup.v1': {
        const cleanup = validateCleanupResult(result);
        assert.equal(cleanup.job_id, null);
        assert.equal(typeof cleanup.pipeline_id, 'string');
        break;
      }
      default: assert.fail(`Undocumented schema ${envelope.result_schema}`);
    }
  }
  assert.deepEqual([...commands].sort(), ['roles', ...['templates', 'start', 'status', 'wait', 'result', 'resume', 'cancel', 'cleanup'].map(c => `pipeline ${c}`)].sort());
  assert.equal(json('docs/examples/roles-list.json').result_schema, 'gbdev.role-list.v1');
  assert.equal(json('docs/examples/roles-show.json').result_schema, 'gbdev.role.v1');
});

test('S5 smoke requests resolve using isolated repo/binaries only; S2 placeholder and S4 constraints explicit', t => {
  const f = tmpRepo(t), config = loadConfig(f.config);
  // Resolution only checks executable availability/builds argv; this Node path is never invoked as a provider.
  config.providers.codex.bin = process.execPath; config.providers.cursor.bin = process.execPath;
  const registry = new PipelineRegistry(f.config);
  const files = readdirSync('docs/smoke').filter(file => file.endsWith('.json'));
  assert.equal(files.length, 6);
  for (const file of files) {
    const request = json(join('docs/smoke', file));
    assert.equal(request.repo, '/path/to/gbdev-smoke');
    assert.equal(request.base_ref, file.startsWith('s2-') ? 'REPLACE_WITH_S1_BRANCH' : 'master');
    if (file.startsWith('s2-')) assert.equal(request.diff_base_ref, 'master');
    const resolved = resolveRequest({ ...request, repo: f.repo }, config, registry);
    assert.equal(resolved.request.network, false);
    if (file.startsWith('s4-')) {
      assert.equal(resolved.request.max_rounds, 1);
      assert.equal(resolved.snapshot.steps.verify!.provider, 'codex');
      assert.ok(request.acceptance_criteria.some((c: { text: string }) => c.text.includes('TypeError')));
    }
    assert.ok(Object.values(resolved.snapshot.steps).every(step => step.provider !== 'fake'));
  }
});

test('S5 README M2 input/output JSON and linked example paths stay valid', t => {
  const f = tmpRepo(t), config = loadConfig(f.config), registry = new PipelineRegistry(f.config);
  config.providers.codex.bin = process.execPath; config.providers.cursor.bin = process.execPath;
  const readme = readFileSync('docs/reference.md', 'utf8').split('## M1 JSON 契约示例')[0]!;
  for (const match of readme.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const value = JSON.parse(match[1]!);
    switch (value.schema) {
      case 'gbdev.role.v1':
        if (value.name === 'reviewer') validateRole({ ...builtinRoles().find(role => role.name === 'reviewer'), ...value });
        else validateRole(value);
        break;
      case 'gbdev.pipeline.v1': validatePipeline(value, new RoleRegistry(f.config)); break;
      case 'gbdev.pipeline-request.v1': resolveRequest({ ...value, repo: f.repo }, config, registry); break;
      case 'gbdev.pipeline-resume.v1': validatePipelineResume(value, value.pipeline_id); break;
      default: if (value.contract_version) validateEnvelope(value);
    }
  }
  for (const file of ['README.md', 'docs/reference.md']) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!.split('#')[0]!;
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const path = file.startsWith('docs/') ? `docs/${target}` : target;
      assert.ok(existsSync(path), `${file}: ${target}`);
    }
  }
});
