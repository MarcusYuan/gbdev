import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, RunTask } from '../contracts/run.js';
import type { RunRequest } from '../contracts/runRequest.js';
import type { RoleSnapshot } from '../contracts/pipelineRequest.js';
import type { TaskBrief } from '../contracts/brief.js';
import type { JobStatus } from '../contracts/jobStatus.js';
import type { TaskGraph } from '../contracts/taskGraph.js';
import type { MergeResolution } from '../contracts/mergeResolution.js';
import type { PipelineSlotHooks } from '../pipeline/supervisor.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { createJobId } from '../core/ids.js';
import { jobPaths } from '../core/paths.js';
import { localIso } from '../core/time.js';
import { locked } from '../core/runtime.js';
import { superviseJob } from '../core/supervise.js';
import { fragment } from '../roles/fragments.js';
import { stepResult } from '../pipeline/store.js';
import { headAsync, git } from '../core/git.js';
import { isRetryableRateLimit } from './scheduler.js';
import { runEvent } from './store.js';
import { assembleRunJobPrompt } from './promptAssembly.js';
/** Run-owned jobs use the same supervision/slot policy as pipeline steps. */
export async function runJob(store: JobStore, run: Run, request: RunRequest, snapshot: RoleSnapshot, hooks: PipelineSlotHooks, signal: AbortSignal,
  options: { note?: string | null; instance: string; prompt: string; task?: RunTask; worktree?: string; branch?: string; conflict_files?: string[]; baseline?: Record<string, string> }) {
  const role = Object.values(snapshot.steps)[0]!;
  for (let retry = 0; ; retry++) {
    await hooks.acquireSlot(role.provider, signal);
    try {
      const id = createJobId(), at = localIso(), worktree = options.worktree ?? run.integration.worktree, branch = options.branch ?? run.integration.branch;
      const base = await headAsync(worktree, signal), resolving = role.role === 'resolver', planning = role.role === 'planner';
      const brief: TaskBrief = { schema: 'gbdev.task-brief.v1', brief_id: `${run.run_id}:${options.instance}`, repo: run.repo, base_ref: base, role: role.role, provider: role.provider, model: role.model, sandbox: role.sandbox, timeout_min: role.timeout_min, stall_timeout_s: role.stall_timeout_s,
        network: request.network ?? true, goal: planning ? request.goal : resolving ? fragment('resolver-goal') : fragment('verifier-goal'), context: request.context, constraints: request.constraints, allowed_paths: request.allowed_paths, acceptance_criteria: [], required_evidence: [], parent_job_id: null, answers: [] };
      const job: JobStatus = { schema: 'gbdev.job-status.v1', job_id: id, kind: planning ? 'run_planner' : resolving ? 'merge_resolution' : 'run_verifier', run_id: run.run_id, ...(options.task ? { task_id: options.task.task_id } : {}), state: 'starting', provider: role.provider, role: role.role, sandbox: role.sandbox, repo: run.repo, worktree, branch, base_sha: base,
        pid: process.pid, session_id: null, created_at: at, updated_at: at, deadline_at: localIso(new Date(Date.now() + role.timeout_min * 60_000)), state_history: [{ state: 'starting', at, by: 'gbdev' }], last_event: null, parent_job_id: null, pipeline_id: null, step_instance: options.instance, attempt: retry + 1, failure_reason: null, failure_reasons: [] };
      const extraFields: Record<string, unknown> = {};
      if (planning) extraFields.task_graph = {
        schema: 'gbdev.task-graph.v1', summary: 'Describe the task decomposition', tasks: [{
          id: 'task-1', title: 'Task title', goal: 'Describe the change', context: '', depends_on: [],
          file_scope: ['src/example.ts'], acceptance_criteria: [{ id: 'AC1', text: 'Describe acceptance', check: null }],
          pipeline: null, size: 'S', notes: null,
        }],
      } satisfies TaskGraph;
      if (resolving) extraFields.resolution = {
        files: [{ path: 'src/example.ts', strategy: 'both', note: 'Describe how both sides intent is preserved' }], unresolved: [],
      } satisfies MergeResolution;
      const prompt = assembleRunJobPrompt({
        brief,
        instructionsText: snapshot.instructions_text[role.role]!,
        roleOutput: role.output,
        planning,
        resolving,
        extraFields,
        notes: [...(hooks.orchestratorNotes?.(options.task?.task_id) ?? []), options.note],
        evidence: options.prompt,
      });
      await locked(store, () => {
        store.create(job); hooks.onJobCreated?.(); const p = jobPaths(store.paths, id);
        atomicWriteJson(p.brief, brief); atomicWriteJson(join(p.dir, 'provider.json'), { bin: role.bin, writable_roots: resolving ? [worktree] : [], schema_options: { pipelineStep: true, output: role.output, policyIncidents: true, ...(resolving ? { mergeResolution: true } : planning ? { taskGraph: true } : {}) } });
        if (resolving) atomicWriteJson(join(p.dir, 'resolution.json'), { conflict_files: options.conflict_files, baseline: options.baseline });
        writeFileSync(p.prompt, prompt); writeFileSync(role.provider === 'cursor' ? p.rawJson : p.rawJsonl, ''); writeFileSync(p.workerLog, '');
        if (!planning) runEvent(store, run, resolving ? 'resolver_started' : 'verifier_started', { job_id: id, instance: options.instance }, options.task, worktree.match(/lane-[1-4]$/)?.[0]);
      });
      await superviseJob(id, store, signal);
      const result = stepResult(store, id);
      if (isRetryableRateLimit(result, '')) {
        await hooks.onRateLimit(role.provider); if (!planning && !retry && !signal.aborted) continue;
      }
      if (!resolving && ((await headAsync(worktree, signal)) !== base || (await git(worktree, ['status', '--porcelain'], 120_000, signal)))) throw new Error(planning ? 'planner_modified_worktree' : 'integration_corrupt');
      return { job_id: id, result };
    } finally { await hooks.releaseSlot(role.provider); }
  }
}
