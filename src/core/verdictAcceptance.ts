import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { isTerminal, type JobState } from '../contracts/jobStatus.js';
import type { JobResult } from '../contracts/jobResult.js';
import type { Decision, PipelineRun, PipelineStep } from '../contracts/pipelineRun.js';
import type { Run, RunAttention } from '../contracts/run.js';
import type { RoleDefinition } from '../contracts/role.js';
import { gate } from '../pipeline/gate.js';
import { readRun as readPipeline, readSnapshot, stepResult } from '../pipeline/store.js';
import { runJobs } from '../run/invariants.js';
import { runPaths } from '../run/store.js';
import type { JobStore } from './jobStore.js';

export const ACCEPT_REQUIREMENTS = ['verdict_missing_reviewed', 'note'] as const;
export type AcceptRequirement = (typeof ACCEPT_REQUIREMENTS)[number];

export interface VerdictAcceptanceMeta {
  recommended_action: 'retry' | null;
  accept_requirements: AcceptRequirement[];
}

export interface VerdictAcceptEvidence {
  instance: string;
  job_ids: string[];
  note: string;
  verdict_missing_reviewed: true;
}

function finishedAttempts(step: PipelineStep): PipelineStep['attempts'] {
  return step.attempts.filter(a => isTerminal(a.job_state as JobState));
}

/** G9 missing-verdict classification from job facts only (never note/detail text). */
export function isVerdictMissingResult(result: JobResult, output: RoleDefinition['output']): boolean {
  return gate(result, output).rule === 'G9';
}

export function stepHasUnresolvedVerdictMissing(store: JobStore, run: PipelineRun, step: PipelineStep): boolean {
  const snapshot = readSnapshot(store, run.pipeline_id);
  const role = snapshot.steps[step.step_id];
  if (!role || role.output !== 'verdict') return false;
  const finished = finishedAttempts(step);
  if (!finished.length) return false;
  const anyMissing = finished.some(a => isVerdictMissingResult(stepResult(store, a.job_id), role.output));
  if (!anyMissing) return false;
  const last = finished.at(-1)!;
  return isVerdictMissingResult(stepResult(store, last.job_id), role.output);
}

/**
 * Whether accept on this pipeline pause requires verdict_missing evidence.
 * Primary: decision/state_reason === verdict_missing.
 * Budget cut after G9: reason may be job_budget_exhausted while step still lacks verdict.
 */
export function isPipelineVerdictMissingAccept(store: JobStore, run: PipelineRun): boolean {
  const reason = run.decision?.reason ?? run.state_reason;
  if (reason === 'verdict_missing') return true;
  if (reason !== 'job_budget_exhausted') return false;
  const instance = run.decision?.instance;
  if (!instance) return false;
  const step = run.steps.find(s => s.instance === instance);
  if (!step) return false;
  return stepHasUnresolvedVerdictMissing(store, run, step);
}

export function pipelineRetryAvailable(step: PipelineStep | undefined, allowed: readonly string[] = []): boolean {
  if (!step) return false;
  return step.attempts.length < 3 && allowed.includes('retry');
}

export function verdictMissingMeta(options: { retryAvailable: boolean; kind: 'pipeline' | 'final' }): VerdictAcceptanceMeta {
  return {
    recommended_action: options.kind === 'pipeline' && options.retryAvailable ? 'retry' : null,
    accept_requirements: [...ACCEPT_REQUIREMENTS],
  };
}

/** Attach recommended_action / accept_requirements for a fresh pipeline decision. */
export function withPipelineVerdictMeta(
  store: JobStore,
  run: PipelineRun,
  decision: Decision,
  step: PipelineStep,
): Decision {
  const probe = { ...run, decision, state_reason: decision.reason };
  if (!isPipelineVerdictMissingAccept(store, probe)) return decision;
  const meta = verdictMissingMeta({
    retryAvailable: pipelineRetryAvailable(step, decision.allowed_actions),
    kind: 'pipeline',
  });
  return { ...decision, ...meta };
}

export interface FinalReviewRecord {
  job_id: string;
  verdict: 'approve' | 'revise' | 'reject' | null;
  findings: unknown[];
  round_id?: string;
  reviewed_base_sha?: string;
  reviewed_head_sha?: string;
  failure_reason?: string | null;
  review_completed?: boolean;
}

export function readFinalReview(store: JobStore, run: Run): FinalReviewRecord | null {
  const path = join(runPaths(store, run.run_id).dir, 'final-review.json');
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as FinalReviewRecord;
    if (!value || typeof value.job_id !== 'string' || !value.job_id) return null;
    if (!(value.verdict === null || value.verdict === 'approve' || value.verdict === 'revise' || value.verdict === 'reject')) return null;
    return {
      job_id: value.job_id, verdict: value.verdict, findings: Array.isArray(value.findings) ? value.findings : [],
      ...(value.round_id !== undefined ? { round_id: value.round_id } : {}),
      ...(value.reviewed_base_sha !== undefined ? { reviewed_base_sha: value.reviewed_base_sha } : {}),
      ...(value.reviewed_head_sha !== undefined ? { reviewed_head_sha: value.reviewed_head_sha } : {}),
      ...(value.failure_reason !== undefined ? { failure_reason: value.failure_reason } : {}),
      ...(value.review_completed !== undefined ? { review_completed: value.review_completed } : {}),
    };
  } catch {
    return null;
  }
}

const NON_VALID_REVIEW_FAILURES = new Set([
  'launch_failed', 'prompt_too_large', 'timeout', 'worker_stalled', 'cancelled',
]);

function isRateLimitFailure(reason: string | null | undefined): boolean {
  return !!reason && (reason === 'rate_limit' || reason === 'rate-limit' || reason === 'provider_cooldown');
}

/** Shared eligibility for pipeline and final-review acceptance evidence. */
function isValidReviewAttempt(result: JobResult, fallbackReason?: string | null): boolean {
  const reason = result.failure_reason ?? fallbackReason;
  return isTerminal(result.state) && result.state !== 'cancelled' && result.state !== 'timeout'
    && !NON_VALID_REVIEW_FAILURES.has(reason ?? '') && !isRateLimitFailure(reason);
}

/** Valid finished final-review attempts in the same round (excludes launch/stall/limit faults). */
export function finalReviewValidAttempts(store: JobStore, run: Run, roundId?: string | null): { job_id: string; attempt: number }[] {
  const final = readFinalReview(store, run);
  const targetRound = roundId ?? final?.round_id;
  return runJobs(store, run)
    .filter(j => j.step_instance?.startsWith('run:final_review#') && isTerminal(j.state))
    .filter(j => {
      try {
        const result = JSON.parse(readFileSync(join(store.paths.jobs, j.job_id, 'result.json'), 'utf8')) as JobResult;
        if (!isValidReviewAttempt(result, j.failure_reason)) return false;
        // Same-round filter when round metadata exists on the review record.
        if (targetRound && j.review_round_id !== targetRound) return false;
        return true;
      } catch {
        return false;
      }
    })
    .map(j => ({ job_id: j.job_id, attempt: j.attempt ?? 1 }))
    .sort((a, b) => a.attempt - b.attempt || a.job_id.localeCompare(b.job_id));
}

export function isFinalReviewVerdictMissing(store: JobStore, run: Run): boolean {
  const final = readFinalReview(store, run);
  return final?.verdict === null;
}

export function finalReviewFinishedAttempts(store: JobStore, run: Run): { job_id: string; attempt: number }[] {
  return runJobs(store, run)
    .filter(j => j.step_instance?.startsWith('run:final_review#') && isTerminal(j.state))
    .map(j => ({ job_id: j.job_id, attempt: j.attempt ?? 1 }))
    .sort((a, b) => a.attempt - b.attempt || a.job_id.localeCompare(b.job_id));
}

function noteOk(note: string | null | undefined): note is string {
  return typeof note === 'string' && note.trim().length > 0 && note.length <= 2000;
}

function rejectUnexpectedReviewed(reviewed: boolean | undefined, context: string): void {
  if (reviewed === true) {
    throw new GbdevError('pipeline_state_conflict', 'verdict_missing_reviewed is only valid when accepting a missing verdict', {
      reason: 'verdict_missing_reviewed_not_applicable', context,
    });
  }
}

function rejectUnexpectedReviewedRun(reviewed: boolean | undefined, context: string): void {
  if (reviewed === true) {
    throw new GbdevError('run_state_conflict', 'verdict_missing_reviewed is only valid when accepting a missing verdict', {
      reason: 'verdict_missing_reviewed_not_applicable', context,
    });
  }
}

/**
 * Prepare-stage guard for pipeline accept. Throws before any state write.
 * Returns evidence when this accept is a protected missing-verdict acceptance.
 */
export function assertPipelineVerdictAccept(
  store: JobStore,
  run: PipelineRun,
  input: { action: string; note: string | null; verdict_missing_reviewed?: boolean; decision_id?: string },
): VerdictAcceptEvidence | null {
  const reviewed = input.verdict_missing_reviewed;
  if (input.action !== 'accept') {
    rejectUnexpectedReviewed(reviewed, input.action);
    return null;
  }
  if (!isPipelineVerdictMissingAccept(store, run)) {
    rejectUnexpectedReviewed(reviewed, run.decision?.reason ?? run.state_reason ?? 'accept');
    return null;
  }
  const instance = run.decision?.instance;
  if (!instance) throw new GbdevError('pipeline_state_conflict', 'Decision instance missing', { reason: 'instance_missing' });
  const step = run.steps.find(s => s.instance === instance);
  if (!step) throw new GbdevError('pipeline_state_conflict', 'Decision instance missing', { reason: 'instance_missing' });

  const finished = finishedAttempts(step).filter(attempt => {
    try { return isValidReviewAttempt(stepResult(store, attempt.job_id), attempt.failure_reason); }
    catch { return false; }
  });
  if (!stepHasUnresolvedVerdictMissing(store, run, step)) {
    throw new GbdevError('pipeline_state_conflict', 'Latest finished result is not a missing verdict', {
      reason: 'verdict_missing_result_mismatch', unit_id: run.pipeline_id, instance, decision_id: input.decision_id ?? null,
    });
  }
  const retryAvailable = step.attempts.length < 3 && (run.decision?.allowed_actions.includes('retry') ?? false);
  if (finished.length < 2) {
    throw new GbdevError(
      'verdict_retry_required',
      'Missing verdict accept requires a completed review retry on this step instance',
      { unit_id: run.pipeline_id, instance, decision_id: input.decision_id ?? null, retry_available: retryAvailable },
      retryAvailable
        ? ['Read current pipeline status', 'Retry the review step before accepting']
        : ['Read current pipeline status', 'Retry is unavailable; choose another legal recovery or report the blocker'],
    );
  }
  if (reviewed !== true || !noteOk(input.note)) {
    throw new GbdevError(
      'verdict_evidence_required',
      'Missing verdict accept requires verdict_missing_reviewed:true and a non-empty note',
      {
        unit_id: run.pipeline_id,
        instance,
        decision_id: input.decision_id ?? null,
        required_fields: [...ACCEPT_REQUIREMENTS],
      },
      ['Deep-read the diff and check output', 'Accept with verdict_missing_reviewed:true and a concrete note'],
    );
  }
  return {
    instance,
    job_ids: finished.map(a => a.job_id),
    note: input.note.trim(),
    verdict_missing_reviewed: true,
  };
}

/**
 * Prepare-stage guard for run accept_final when final-review verdict is null.
 * Structured revise/reject accept_final is unchanged (absent/false reviewed OK; true rejected).
 */
export function assertFinalReviewVerdictAccept(
  store: JobStore,
  run: Run,
  input: { action: string; note: string | null; verdict_missing_reviewed?: boolean; decision_id: string },
): VerdictAcceptEvidence | null {
  const reviewed = input.verdict_missing_reviewed;
  if (input.action !== 'accept_final') {
    rejectUnexpectedReviewedRun(reviewed, input.action);
    return null;
  }
  const final = readFinalReview(store, run);
  if (!final) {
    // Required record missing/corrupt: do not treat as non-missing.
    throw new GbdevError('result_missing', 'final-review.json is missing or corrupt', { reason: 'final_review_missing' });
  }
  // B7: unresolved launch/prompt failures are never acceptable, even with true+note.
  const unresolved = final.failure_reason
    ?? run.attention.find(a => a.decision_id === input.decision_id)?.reason
    ?? null;
  if (unresolved === 'launch_failed' || final.failure_reason === 'launch_failed') {
    throw new GbdevError('run_state_conflict', 'Cannot accept_final after final-review launch_failed', {
      reason: 'launch_failed_not_acceptable', unit_id: run.run_id, decision_id: input.decision_id,
    });
  }
  if (unresolved === 'prompt_too_large' || final.failure_reason === 'prompt_too_large') {
    throw new GbdevError('run_state_conflict', 'Cannot accept_final after final-review prompt_too_large', {
      reason: 'prompt_too_large_not_acceptable', unit_id: run.run_id, decision_id: input.decision_id,
    });
  }
  // Also reject when the latest final-review job itself is a launch failure (legacy records).
  try {
    const latest = JSON.parse(readFileSync(join(store.paths.jobs, final.job_id, 'result.json'), 'utf8')) as JobResult;
    if (latest.failure_reason === 'launch_failed') {
      throw new GbdevError('run_state_conflict', 'Cannot accept_final after final-review launch_failed', {
        reason: 'launch_failed_not_acceptable', unit_id: run.run_id, decision_id: input.decision_id,
      });
    }
    if (latest.failure_reason === 'prompt_too_large') {
      throw new GbdevError('run_state_conflict', 'Cannot accept_final after final-review prompt_too_large', {
        reason: 'prompt_too_large_not_acceptable', unit_id: run.run_id, decision_id: input.decision_id,
      });
    }
  } catch (error) {
    if (error instanceof GbdevError) throw error;
  }
  if (final.verdict !== null) {
    rejectUnexpectedReviewedRun(reviewed, `final_review:${final.verdict}`);
    return null;
  }
  const finished = finalReviewValidAttempts(store, run, final.round_id);
  if (finished.length < 2) {
    throw new GbdevError(
      'verdict_retry_required',
      'Missing final-review verdict accept requires two completed review attempts',
      { unit_id: run.run_id, instance: 'run:final_review', decision_id: input.decision_id, retry_available: false },
      ['Read current run status', 'Final review already exhausted automatic retries; gather evidence before accept_final'],
    );
  }
  if (reviewed !== true || !noteOk(input.note)) {
    throw new GbdevError(
      'verdict_evidence_required',
      'Missing final-review verdict accept requires verdict_missing_reviewed:true and a non-empty note',
      {
        unit_id: run.run_id,
        instance: 'run:final_review',
        decision_id: input.decision_id,
        required_fields: [...ACCEPT_REQUIREMENTS],
      },
      ['Deep-read the integration diff and checks', 'Accept with verdict_missing_reviewed:true and a concrete note'],
    );
  }
  return {
    instance: 'run:final_review',
    job_ids: finished.map(a => a.job_id),
    note: input.note.trim(),
    verdict_missing_reviewed: true,
  };
}

/** Status-time projection for pipeline decision without rewriting disk. */
export function projectPipelineDecision(store: JobStore, run: PipelineRun): PipelineRun {
  if (!run.decision || run.decision.accept_requirements) return run;
  if (!isPipelineVerdictMissingAccept(store, run)) return run;
  const step = run.steps.find(s => s.instance === run.decision!.instance);
  const projected = structuredClone(run);
  const actions = run.decision.allowed_actions.filter(a => a !== 'retry' || (step?.attempts.length ?? 3) < 3);
  const decision = { ...run.decision, allowed_actions: actions };
  projected.decision = step
    ? withPipelineVerdictMeta(store, run, decision, step)
    : { ...decision, ...verdictMissingMeta({ retryAvailable: false, kind: 'pipeline' }) };
  return projected;
}

/** Status-time projection for run attention without rewriting disk. */
export function projectRunAttention(store: JobStore, run: Run): Run {
  if (!run.attention.some(a => !a.accept_requirements && (a.reason === 'task_paused' || a.reason === 'final_review_revise'))) return run;
  const projected = structuredClone(run);
  for (const item of projected.attention) {
    if (item.accept_requirements) continue;
    if (item.reason === 'final_review_revise' && isFinalReviewVerdictMissing(store, run)) {
      Object.assign(item, verdictMissingMeta({ retryAvailable: false, kind: 'final' }));
      continue;
    }
    if (item.reason === 'task_paused' && item.pipeline_id) {
      try {
        const pipeline = readPipeline(store, item.pipeline_id);
        if (!isPipelineVerdictMissingAccept(store, pipeline)) continue;
        const step = pipeline.steps.find(s => s.instance === pipeline.decision?.instance);
        item.allowed_actions = item.allowed_actions.filter(a => a !== 'retry' || (step?.attempts.length ?? 3) < 3) as RunAttention['allowed_actions'];
        Object.assign(item, verdictMissingMeta({
          retryAvailable: pipelineRetryAvailable(step, item.allowed_actions),
          kind: 'pipeline',
        }));
      } catch { /* damaged pipeline: leave attention as stored */ }
    }
  }
  return projected;
}

/** Human-readable reminder for missing-verdict accepts. */
export const VERDICT_MISSING_STATUS_HINT = '缺少结构化审查结论；接受需取证确认';

/** B7 status/dashboard copy for unresolved launch / prompt failures. */
export const LAUNCH_FAILED_STATUS_HINT =
  'launch_failed：启动均未产生有效评审输出。当前不能接受最终评审；需修复后 retry 或人工介入。';
export const PROMPT_TOO_LARGE_STATUS_HINT =
  'prompt_too_large：评审 prompt 超限。当前不能接受；需缩减输入后 retry。';
export const LAUNCH_RETRYING_STATUS_HINT = (used: number, max: number, delayMs: number) =>
  `启动失败，等待第 ${used}/${max} 次自动重试；退避 ${Math.round(delayMs / 1000)}s。`;
