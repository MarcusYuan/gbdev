import type { TestContext } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startRun } from '../../src/commands/run.js';
import { superviseRun } from '../../src/run/supervisor.js';
import { jsonFile, readRun, runPaths } from '../../src/run/store.js';
import { assertRunInvariants } from '../../src/run/invariants.js';
import { mergeRecords } from '../../src/run/result.js';
import { DEFAULT_PARALLEL } from '../../src/core/runConfig.js';
import { JobStore } from '../../src/core/jobStore.js';
import { fake } from '../../src/providers/fake.js';
import { validateRunResult } from '../../src/contracts/runResult.js';
import type { RunRequest } from '../../src/contracts/runRequest.js';
import { runFixture, testEnv } from './run.js';
export function fixture(t: TestContext) {
  const f = runFixture(t), store = new JobStore(f.paths), plan = join(f.root, 'fake-plan.json');
  testEnv(t, { GBDEV_FAKE_PLAN: plan, GBDEV_FAKE_SCENARIO: 'ok', GBDEV_TIMEOUT_SCALE: '60000' });
  const build = fake.buildInvocation.bind(fake);
  t.mock.method(fake, 'buildInvocation', (...args: Parameters<typeof build>) => { const v = build(...args); v.args[0] = resolve('test/fixtures/fake-worker.js'); return v; });
  const tasks = ['a', 'b'].map(id => ({ id, title: id, goal: `Implement ${id}`, context: '', depends_on: [] as string[], file_scope: [`src/${id}.txt`], acceptance_criteria: [{ id: 'AC1', text: 'works', check: null }], pipeline: null, size: 'S' as const, notes: null }));
  const request: RunRequest = { schema: 'gbdev.run-request.v1', request_id: 'test-run', repo: f.repo, base_ref: 'main', goal: 'Two changes', context: '', constraints: [], allowed_paths: ['src/**'], checks: [{ id: 'test', cmd: 'true', timeout_min: 1 }], integration_checks: ['test'], task_checks: [], acceptance_criteria: [], decompose: 'provided', tasks, lanes: 2, overlap_policy: 'serialize', default_task_pipeline: 'implement-review', task_pipeline_overrides: { implement: { provider: 'fake' }, review: { provider: 'fake' }, fix: { provider: 'fake' } }, final_review: 'none', worktree_setup_cmd: null, max_tasks: 12, max_total_jobs: 60, max_integration_fixes: 1, timeout_min: 60, network: false };
  const fakePlan: Record<string, unknown> = { 'a/implement#1': { sleep_ms: 200, actions: [{ type: 'write_file', path: 'src/a.txt', content: 'a\n' }] }, 'b/implement#1': { sleep_ms: 500, actions: [{ type: 'write_file', path: 'src/b.txt', content: 'b\n' }] }, 'review#1': 'review_approve', 'fix#1': { actions: [{ type: 'write_file', path: 'src/fixed.txt', content: 'fixed\n' }] }, 'run:final_review#1': 'review_approve' };
  const savePlan = () => writeFileSync(plan, JSON.stringify(fakePlan)); savePlan();
  const execute = async () => { savePlan(); const initial = await startRun(store, request, false); await superviseRun(store, initial.run_id); const run = readRun(store, initial.run_id); return { run, result: validateRunResult(jsonFile(runPaths(store, run.run_id).result)) }; };
  const invariants = (id: string) => { const run = readRun(store, id); assertRunInvariants(store, run, mergeRecords(store, run), DEFAULT_PARALLEL, { 'refs/heads/main': f.base }); };
  return { ...f, store, request, fakePlan, savePlan, execute, invariants };
}
export async function until(condition: () => boolean, timeout = 45_000) { const end = Date.now() + timeout; while (!condition()) { if (Date.now() >= end) throw new Error('Test wait timed out'); await delay(20); } }
