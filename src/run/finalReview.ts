import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Run } from '../contracts/run.js';
import type { RunRequest } from '../contracts/runRequest.js';
import type { RoleSnapshot } from '../contracts/pipelineRequest.js';
import type { TaskBrief } from '../contracts/brief.js';
import type { JobStatus } from '../contracts/jobStatus.js';
import type { RunResult } from '../contracts/runResult.js';
import type { PipelineSlotHooks } from '../pipeline/supervisor.js';
import { inheritMissingResultRetry, loadRetryChain } from '../core/launchRetry.js';
import { createJobId } from '../core/ids.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { localIso } from '../core/time.js';
import { runJobs } from './invariants.js';
import { isRetryableRateLimit } from './scheduler.js';
import { event, locked, optionalText } from '../core/runtime.js';
import { superviseJob } from '../core/supervise.js';
import { gate } from '../pipeline/gate.js';
import { stepResult } from '../pipeline/store.js';
import { git, headAsync, dirtyAsync } from '../core/git.js';
import { assembleFinalReviewPrompt } from './promptAssembly.js';
import { evidenceDir, measureUtf8Bytes, truncateUtf8, writeDiffArtifact } from '../core/promptBudget.js';
import { effectiveReviewPrompt, loadConfig } from '../core/config.js';
import { GbdevError } from '../contracts/error.js';
import { runPaths } from './store.js';

export function buildBoundedFinalPrompt(input: {
  brief: TaskBrief;
  instructionsText: string;
  notes: readonly (string | null | undefined)[];
  diff: string;
  tasksJson: string;
  artifact: ReturnType<typeof writeDiffArtifact>;
  includeRetryNotice: boolean;
  maxBytes: number;
  provider: string;
  jobId: string;
  previousJobId?: string;
  previousFinalText?: string | null;
  previousHeadSha?: string | null;
}): string {
  const retryFields = {
    ...(input.previousJobId ? {
      previousJobId: input.previousJobId,
      previousFinalText: input.previousFinalText,
      previousHeadSha: input.previousHeadSha,
    } : {}),
  };
  const fullUntrusted = input.diff + '\n' + input.tasksJson;
  const full = assembleFinalReviewPrompt({
    brief: input.brief, instructionsText: input.instructionsText, notes: input.notes,
    untrusted: fullUntrusted, includeRetryNotice: input.includeRetryNotice,
    ...retryFields,
  });
  if (measureUtf8Bytes(full) <= input.maxBytes) return full;

  const shrink = (preview: string) => {
    const ref = {
      notice: '内嵌 diff 已截断；完整审查必须读取所列 diff 文件，不能仅根据预览作出结论。',
      path: input.artifact.path,
      base_sha: input.artifact.base_sha,
      head_sha: input.artifact.head_sha,
      bytes: input.artifact.bytes,
      sha256: input.artifact.sha256,
      preview,
    };
    return assembleFinalReviewPrompt({
      brief: input.brief, instructionsText: input.instructionsText, notes: input.notes,
      untrusted: `<<<DIFF_FILE_REF>>>\n${JSON.stringify(ref)}\n<<<END_DIFF_FILE_REF>>>\n` + input.tasksJson,
      includeRetryNotice: input.includeRetryNotice,
      ...retryFields,
    });
  };

  let lo = 0, hi = measureUtf8Bytes(input.diff), best: string | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = shrink(truncateUtf8(input.diff, mid));
    if (measureUtf8Bytes(candidate) <= input.maxBytes) { best = candidate; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best) return best;
  const zero = shrink('');
  if (measureUtf8Bytes(zero) <= input.maxBytes) return zero;
  throw new GbdevError('prompt_too_large', 'Final review prompt exceeds configured UTF-8 byte limit', {
    provider: input.provider, job_id: input.jobId,
    prompt_bytes: measureUtf8Bytes(zero), max_bytes: input.maxBytes, diff_externalized: true,
  });
}

export async function finalReview(store: JobStore, run: Run, request: RunRequest, snapshot: RoleSnapshot, hooks: PipelineSlotHooks, signal: AbortSignal): Promise<NonNullable<RunResult['final_review']>> {
  const role = Object.values(snapshot.steps)[0]!;
  let last: NonNullable<RunResult['final_review']> | undefined;
  let retryMissingResult = false;
  const prior = runJobs(store, run).filter(j => j.step_instance?.startsWith('run:final_review#')).length;
  const baseSha = run.base_sha;
  const headSha = run.integration.verified_sha;
  const round_id = `final:${run.run_id}:${baseSha}:${headSha}:${prior + 1}`;
  const config = (() => { try { return loadConfig(store.paths.config); } catch { return loadConfig(); } })();
  const maxBytes = effectiveReviewPrompt(config).max_bytes;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (retryMissingResult && last && loadRetryChain(jobPaths(store.paths, last.job_id))?.missing_result_retry_used) return last;
    await hooks.acquireSlot(role.provider, signal);
    try {
      const id = createJobId(), at = localIso();
      const brief: TaskBrief = { schema: 'gbdev.task-brief.v1', brief_id: `${run.run_id}:final_review:${attempt}`, repo: run.repo, base_ref: run.base_sha, role: role.role, provider: role.provider, model: role.model, sandbox: 'read-only', timeout_min: role.timeout_min, stall_timeout_s: role.stall_timeout_s,
        network: request.network ?? true, goal: request.goal, context: request.context, constraints: request.constraints, allowed_paths: request.allowed_paths, acceptance_criteria: request.acceptance_criteria.map(c => ({ id: c.id, text: c.text })), required_evidence: [], parent_job_id: last?.job_id ?? null, answers: [] };
      const job: JobStatus = { schema: 'gbdev.job-status.v1', job_id: id, run_id: run.run_id, state: 'starting', provider: role.provider, role: role.role, sandbox: 'read-only', repo: run.repo, worktree: run.integration.worktree, branch: run.integration.branch, base_sha: run.integration.verified_sha,
        pid: process.pid, session_id: null, created_at: at, updated_at: at, deadline_at: localIso(new Date(Date.now() + role.timeout_min * 60_000)), state_history: [{ state: 'starting', at, by: 'gbdev' }], last_event: null, parent_job_id: brief.parent_job_id, pipeline_id: null, step_instance: `run:final_review#${prior + attempt}`, review_round_id: round_id, attempt, failure_reason: null, failure_reasons: [] };
      const notes = hooks.orchestratorNotes?.() ?? [];
      const pipelines = run.tasks.flatMap(t => t.attempts.map(a => {
        const path = join(store.paths.home, 'pipelines', a.pipeline_id, 'result.json');
        if (!existsSync(path)) return { pipeline_id: a.pipeline_id };
        const result = JSON.parse(readFileSync(path, 'utf8'));
        if (notes.includes(result.state_reason)) result.state_reason = null;
        return result;
      }));
      const diff = await git(run.repo, ['diff', `${baseSha}..${headSha}`, '--'], 120_000, signal);
      const tasksJson = JSON.stringify({ tasks: run.tasks, pipelines });
      const evidenceRoot = evidenceDir(runPaths(store, run.run_id).dir, 'evidence', 'final-review', round_id.replace(/[^a-zA-Z0-9:_-]/g, '_'));
      const artifact = writeDiffArtifact(evidenceRoot, 'integration.diff', diff, baseSha, headSha);

      let prompt: string;
      try {
        prompt = buildBoundedFinalPrompt({
          brief, instructionsText: snapshot.instructions_text[role.role]!, notes,
          diff, tasksJson, artifact, includeRetryNotice: last?.verdict === null,
          maxBytes, provider: role.provider, jobId: id,
          ...(last ? {
            previousJobId: last.job_id,
            previousFinalText: optionalText(jobPaths(store.paths, last.job_id).finalMessage),
            previousHeadSha: headSha,
          } : {}),
        });
      } catch (error) {
        if (error instanceof GbdevError && error.contract.code === 'prompt_too_large') {
          const promptBytes = Number(error.contract.details.prompt_bytes ?? 0);
          await locked(store, () => {
            const failed = {
              ...job, state: 'failed' as const, failure_reason: 'prompt_too_large', failure_reasons: ['prompt_too_large'],
              state_history: [...job.state_history, { state: 'failed' as const, at: localIso(), by: 'gbdev' }],
              prompt_bytes: promptBytes, prompt_max_bytes: maxBytes,
            };
            store.create(failed);
            const p = jobPaths(store.paths, id);
            atomicWriteJson(p.brief, brief);
            atomicWriteJson(`${p.dir}/provider.json`, { bin: role.bin, writable_roots: [], schema_options: { pipelineStep: true, output: 'verdict' } });
            writeFileSync(p.prompt, '');
            writeFileSync(role.provider === 'cursor' ? p.rawJson : p.rawJsonl, '');
            writeFileSync(p.workerLog, '');
            atomicWriteJson(p.result, {
              schema: 'gbdev.job-result.v1', job_id: id, session_id: null, state: 'failed', worker_exit_code: null,
              duration_s: 0, worker_reported: null, worker_result_warnings: [], failure_reason: 'prompt_too_large', failure_reasons: ['prompt_too_large'],
              gbdev_observed: { head_before: headSha, head_after: headSha, commits: [], files_changed: [], outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null, checks: [], policy_violations: [] },
              paths: { final_message: p.finalMessage, diff: p.diff, events: p.events, worker_log: p.workerLog },
              prompt_bytes: promptBytes, prompt_max_bytes: maxBytes,
            });
            event(store, store.read(id), 'state_change', { state: 'failed', reason: 'prompt_too_large', run_id: run.run_id });
          });
          return {
            job_id: id, verdict: null, findings: [],
            round_id, reviewed_base_sha: baseSha, reviewed_head_sha: headSha,
            failure_reason: 'prompt_too_large', review_completed: false,
          };
        }
        throw error;
      }

      await locked(store, () => {
        store.create(job); hooks.onJobCreated?.(); const p = jobPaths(store.paths, id);
        if (retryMissingResult && last) inheritMissingResultRetry(jobPaths(store.paths, last.job_id), p, {
          job_id: id, run_id: run.run_id, pipeline_id: null, step_instance: job.step_instance ?? null,
        });
        atomicWriteJson(p.brief, brief); atomicWriteJson(`${p.dir}/provider.json`, { bin: role.bin, writable_roots: [], schema_options: { pipelineStep: true, output: 'verdict' } });
        writeFileSync(p.prompt, prompt);
        writeFileSync(role.provider === 'cursor' ? p.rawJson : p.rawJsonl, ''); writeFileSync(p.workerLog, ''); event(store, job, 'state_change', { state: 'starting', run_id: run.run_id });
      });
      await superviseJob(id, store, signal);
      if (await headAsync(run.integration.worktree, signal) !== run.integration.verified_sha || await dirtyAsync(run.integration.worktree, signal)) throw new Error('integration_corrupt');
      const result = stepResult(store, id), review = result.worker_reported?.review;
      const limited = isRetryableRateLimit(result, optionalText(jobPaths(store.paths, id).workerLog) ?? '');
      if (limited) await hooks.onRateLimit(role.provider);
      retryMissingResult = !limited && gate(result, 'verdict').rule === 'G9';
      const failure = result.failure_reason;
      last = {
        job_id: id,
        verdict: result.state === 'succeeded' ? review?.verdict ?? null : null,
        findings: review?.findings ?? [],
        round_id,
        reviewed_base_sha: baseSha,
        reviewed_head_sha: headSha,
        failure_reason: result.state === 'succeeded' ? null : failure,
        review_completed: result.state === 'succeeded' && !!review?.verdict,
      };
      if (failure === 'launch_failed' || failure === 'prompt_too_large') {
        last.review_completed = false;
        return last;
      }
      if (last.verdict && last.verdict !== 'reject' || signal.aborted) return last;
    } finally { await hooks.releaseSlot(role.provider); }
  }
  return {
    ...last!,
    round_id,
    reviewed_base_sha: baseSha,
    reviewed_head_sha: headSha,
    failure_reason: last!.failure_reason ?? (last!.verdict === null ? 'verdict_missing' : null),
    review_completed: !!last!.verdict,
  };
}
