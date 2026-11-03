import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { PipelineRun } from '../../src/contracts/pipelineRun.js';
import type { Run } from '../../src/contracts/run.js';
import { atomicWriteJson } from '../../src/core/jobStore.js';
import { localIso } from '../../src/core/time.js';
import { createRun, pipelinePaths } from '../../src/pipeline/store.js';
import { resolveRequest } from '../../src/contracts/pipelineRequest.js';
import { loadConfig } from '../../src/core/config.js';
import { PipelineRegistry } from '../../src/pipeline/definitions.js';
import { pipelineValue } from '../../src/run/requests.js';
import { result } from '../helpers.js';
import type { fixture } from './m3.js';

export function ownedPipeline(f: ReturnType<typeof fixture>, run: Run, role: 'reviewer' | 'fixer' = 'reviewer') {
  const id = 'p_20261101_1200_ab12', jobId = 'j_20261101_1200_ab12', at = localIso();
  const stepId = role === 'reviewer' ? 'review' : 'fix';
  const resolved = resolveRequest(pipelineValue(f.request, f.request.tasks![0]!, new PipelineRegistry(f.paths.config)), loadConfig(f.paths.config), new PipelineRegistry(f.paths.config), { internal: true });
  const p: PipelineRun = {
    schema: 'gbdev.pipeline-run.v1', pipeline_id: id, pipeline: 'implement-review', state: 'running', state_reason: null,
    outcome: null, failure_reason: null, repo: f.repo, workspace: { mode: 'per_lane', worktree: f.repo, branch: 'fixture', run_id: run.run_id, task_id: 'a', lane: 'lane-1' },
    base_sha: f.base, diff_base_sha: f.base, head_sha: f.base, round: 0, max_rounds: 2, jobs_used: 1, max_total_jobs: 12,
    current: null, steps: [{ ...resolved.snapshot.steps[stepId]!, instance: `${stepId}#1`, step_id: stepId, kind: role === 'fixer' ? 'fix' : 'step', state: 'blocked', round: 0,
      attempts: [{ attempt: 1, job_id: jobId, job_state: 'blocked', failure_reason: 'worker_blocked: fixture' }], gate: 'G4', verdict: null, head_before: f.base, head_after: f.base, handoff: null, started_at: at, finished_at: at }],
    decision: { reason: 'blocked', instance: `${stepId}#1`, allowed_actions: ['retry'], detail: 'worker_blocked: fixture' }, pending_questions: [], supervisor_pid: null,
    heartbeat_at: null, created_at: at, updated_at: at, deadline_at: localIso(new Date(Date.now() + 3600_000)), state_history: [{ state: 'running', at, by: 'gbdev', reason: null }], warnings: [],
    integration: { run_id: run.run_id, task_id: 'a', integration_branch: run.integration.branch, merge_state: 'pending', merged_sha: null, target_branch: null, approved_by_user_at: null },
  };
  const job = { ...result(), job_id: jobId, state: 'blocked' as const, failure_reason: 'worker_blocked: fixture' };
  job.worker_reported!.status = 'blocked';
  mkdirSync(join(f.paths.home, 'jobs', jobId), { recursive: true });
  atomicWriteJson(join(f.paths.home, 'jobs', jobId, 'result.json'), job);
  createRun(f.store, p, () => {
    const paths = pipelinePaths(f.store, id);
    atomicWriteJson(paths.request, resolved.request); atomicWriteJson(paths.snapshot, resolved.snapshot); atomicWriteJson(paths.definition, resolved.definition);
  });
  run.tasks[0]!.attempts = [{ pipeline_id: id, kind: 'initial', state: 'blocked', outcome: null }];
  return { pipeline: p, job, saveJob() { atomicWriteJson(join(f.paths.home, 'jobs', jobId, 'result.json'), job); } };
}
