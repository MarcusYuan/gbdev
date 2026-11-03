import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { runCli } from '../../src/cli.js';
import { validateEnvelope } from '../../src/contracts/envelope.js';
import { validateRun, type Run } from '../../src/contracts/run.js';
import { validatePipelineRun, type PipelineRun } from '../../src/contracts/pipelineRun.js';
import type { JobState } from '../../src/contracts/jobStatus.js';
import type { ListResult } from '../../src/contracts/inventory.js';
import { JobStore } from '../../src/core/jobStore.js';
import { resolvePaths } from '../../src/core/paths.js';
import { temporary, job } from '../helpers.js';
import { testEnv } from './run.js';

export const earlier = '2026-11-01T01:30:00-07:00', later = '2026-11-01T01:10:00-08:00';
export const deadPid = 2147483647;
export const id = (kind: 'j' | 'r' | 'p', n: number) => `${kind}_20261101_0110_${n.toString(16).padStart(4, '0')}`;
export function inventoryFixture(t: TestContext) {
  const root = temporary(t), home = join(root, 'home'); mkdirSync(home);
  testEnv(t, { HOME: root, GBDEV_HOME: home, GBDEV_CONFIG: join(root, 'config.json'), GBDEV_CLI_HOME: join(root, 'cli'), GBDEV_DASHBOARD: '0', GBDEV_NOTIFY: '0' });
  const store = new JobStore(resolvePaths());
  const save = (path: string, value: unknown) => { const full = join(home, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, JSON.stringify(value)); };
  const run = (n: number, state: Run['state'] = 'running', at = earlier): Run => {
    const r = validateRun(JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8')));
    r.run_id = id('r', n); r.repo = root; r.integration.worktree = root; r.integration.branch = `gbdev/${r.run_id}/integration`;
    for (const lane of r.lanes) lane.worktree = join(root, lane.lane);
    r.state = state; r.outcome = null; r.supervisor_pid = deadPid; r.state_reason = null;
    r.created_at = at; r.updated_at = at; r.deadline_at = '2026-11-02T00:00:00+00:00';
    r.state_history = [{ state, at, by: 'test', reason: null }]; r.attention = [];
    save(`runs/${r.run_id}/run.json`, validateRun(r)); return r;
  };
  const pipeline = (n: number, state: PipelineRun['state'] = 'running', at = earlier): PipelineRun => {
    const p = validatePipelineRun(JSON.parse(readFileSync('docs/examples/pipeline-status.json', 'utf8')).result);
    p.pipeline_id = id('p', n); p.repo = root; p.workspace = { mode: 'shared_run_worktree', worktree: root, branch: `gbdev/${p.pipeline_id}` };
    p.state = state; p.supervisor_pid = deadPid; p.created_at = at; p.updated_at = at; p.deadline_at = '2026-11-02T00:00:00+00:00';
    p.state_history = [{ state, at, by: 'test', reason: null }]; p.decision = null; p.decisions = []; p.pending_questions = [];
    for (const step of p.steps) { step.handoff = null; step.attempts = []; }
    save(`pipelines/${p.pipeline_id}/pipeline.json`, p); return p;
  };
  const makeJob = (n: number, state: JobState = 'running', at = earlier) => {
    const j = job(id('j', n)); j.repo = root; j.worktree = root; j.created_at = at; j.updated_at = at; j.pid = deadPid;
    j.state = state; j.state_history = [{ state, at, by: 'test' }]; store.create(j); return j;
  };
  return { root, home, store, save, run, pipeline, job: makeJob };
}
export async function cli(args: string[]) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  return { code, stdout, stderr };
}
export async function inventory(args: string[]) {
  const output = await cli([...args, '--json']); assert.equal(output.code, 0, output.stdout + output.stderr); assert.equal(output.stderr, '');
  const envelope = validateEnvelope(JSON.parse(output.stdout)); assert.ok(envelope.ok);
  return { schema: envelope.result_schema, result: envelope.result as ListResult };
}
export function snapshot(root: string): Record<string, { mtimeMs: number; size: number; body?: string }> {
  const out: ReturnType<typeof snapshot> = {};
  function walk(path: string) {
    const stat = statSync(path); out[path] = { mtimeMs: stat.mtimeMs, size: stat.size, ...(stat.isFile() ? { body: readFileSync(path).toString('base64') } : {}) };
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  }
  walk(root); return out;
}
