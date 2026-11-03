import { assertSchema, closed, enumeration, nullable, nonempty, runIdSchema, taskIdSchema, laneSchema, dateSchema } from './runValidation.js';
import type { JobState } from './jobStatus.js';
import type { SnapshotStep } from './pipelineRequest.js';
import type { WorkerResult, Review } from './workerResult.js';
import { GbdevError } from './error.js';
export const RUN_STATES = ['queued', 'starting', 'running', 'needs_input', 'blocked', 'needs_decision', 'succeeded', 'failed', 'cancelled'] as const;
export type RunState = typeof RUN_STATES[number];
export const activeRun = (state: RunState): boolean => ['queued', 'starting', 'running'].includes(state);
export const terminalRun = (state: RunState): boolean => ['succeeded', 'failed', 'cancelled'].includes(state);
export const ALLOWED_RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['starting', 'failed'], starting: ['running', 'failed'],
  running: ['needs_input', 'blocked', 'needs_decision', 'succeeded', 'failed', 'cancelled'],
  needs_input: ['running', 'cancelled'], blocked: ['running', 'cancelled'],
  needs_decision: ['running', 'succeeded', 'cancelled'], succeeded: [], failed: [], cancelled: [],
};
export interface Decision {
  reason: string; instance: string; allowed_actions: string[]; detail: string;
  summary?: string;
  recommended_action?: 'retry' | null;
  accept_requirements?: Array<'verdict_missing_reviewed' | 'note'>;
}
/** A scheduler answer, attributed to the attempt that asked the question (not its retry). */
export interface DeciderDecision {
  instance: string; attempt: number; question_id: string; question: string; answer: string; at: string;
}
export function validateDecisions(value: unknown): DeciderDecision[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(d => !d || typeof d !== 'object' ||
    typeof d.instance !== 'string' || !/^[a-z][a-z0-9-]{0,23}#[1-9][0-9]*$/.test(d.instance) ||
    !Number.isSafeInteger(d.attempt) || d.attempt < 1 ||
    typeof d.question_id !== 'string' || !d.question_id.trim() || typeof d.question !== 'string' ||
    typeof d.answer !== 'string' || !d.answer.trim() || typeof d.at !== 'string' || !Number.isFinite(Date.parse(d.at)))) {
    throw new GbdevError('config_invalid', 'Invalid decider decisions');
  }
  return value as DeciderDecision[];
}
export interface PipelineStep extends Pick<SnapshotStep, 'role' | 'provider' | 'sandbox'> {
  instance: string; step_id: string; kind: 'step' | 'fix'; state: 'pending' | 'running' | 'succeeded' | 'failed' | 'needs_input' | 'blocked' | 'cancelled' | 'skipped'; round: number;
  attempts: { attempt: number; job_id: string; job_state: JobState; failure_reason: string | null }[];
  gate: string | null; verdict: Review['verdict'] | null; head_before: string | null; head_after: string | null; handoff: string | null; started_at: string | null; finished_at: string | null;
}
export interface PipelineRun {
  paused_since?: string; paused_ms?: number;
  cleanup?: import('../run/cleanup.js').RunCleanup;
  schema: 'gbdev.pipeline-run.v1'; pipeline_id: string; pipeline: string; state: RunState; state_reason: string | null;
  outcome: 'approved' | 'completed' | 'accepted_by_decider' | null; failure_reason: string | null; repo: string;
  workspace: { mode: 'shared_run_worktree'; worktree: string; branch: string } | { mode: 'per_lane'; worktree: string; branch: string; run_id: string; task_id: string; lane: string };
  base_sha: string; diff_base_sha: string; head_sha: string; round: number; max_rounds: number; jobs_used: number; max_total_jobs: number;
  current: { instance: string; job_id: string; job_state: JobState; attempt: number } | null;
  steps: PipelineStep[]; decision: Decision | null; pending_questions: WorkerResult['open_questions']; supervisor_pid: number | null;
  decisions?: DeciderDecision[];
  heartbeat_at: string | null; created_at: string; updated_at: string; deadline_at: string;
  state_history: { state: RunState; at: string; by: string; reason: string | null }[];
  warnings: string[]; integration: null | { run_id: string; task_id: string; integration_branch: string; merge_state: 'pending' | 'merged' | 'rolled_back' | 'dropped'; merged_sha: string | null; target_branch: string | null; approved_by_user_at: string | null }; dry_run?: true;
}
export function assertRunTransition(from: RunState, to: RunState): void {
  if (!ALLOWED_RUN_TRANSITIONS[from].includes(to)) throw new GbdevError('internal_error', `Illegal pipeline transition: ${from} -> ${to}`);
}
export function validatePipelineId(id: string): void {
  if (!/^p_[0-9]{8}_[0-9]{4}_[a-f0-9]{4}$/.test(id)) throw new GbdevError('usage_error', 'Invalid pipeline_id');
}

export function validatePipelineRun(value: unknown): PipelineRun {
  const r = value as PipelineRun;
  if (!r || r.schema !== 'gbdev.pipeline-run.v1' || !RUN_STATES.includes(r.state)) throw new GbdevError('config_invalid', 'Invalid pipeline run');
  if (r.pipeline_id === 'p_dry_run') { if (r.dry_run !== true || r.state !== 'queued') throw new GbdevError('config_invalid', 'Invalid dry run'); }
  else validatePipelineId(r.pipeline_id);
  if (!r.workspace || !['shared_run_worktree', 'per_lane'].includes(r.workspace.mode) || !Array.isArray(r.steps) || !Array.isArray(r.state_history) || !Array.isArray(r.pending_questions) || !Array.isArray(r.warnings) || (r.workspace.mode === 'shared_run_worktree' && r.integration !== null) ||
      !Number.isSafeInteger(r.jobs_used) || r.jobs_used < 0 || typeof r.repo !== 'string' || typeof r.base_sha !== 'string' || typeof r.head_sha !== 'string' || typeof r.created_at !== 'string' || !Number.isFinite(Date.parse(r.created_at))) throw new GbdevError('config_invalid', 'Invalid pipeline run fields');
  if (r.paused_since !== undefined && (typeof r.paused_since !== 'string' || !Number.isFinite(Date.parse(r.paused_since))) || r.paused_ms !== undefined && (!Number.isSafeInteger(r.paused_ms) || r.paused_ms < 0)) throw new GbdevError('config_invalid', 'Invalid pipeline pause budget');
  if (r.decision?.summary !== undefined && (typeof r.decision.summary !== 'string' || r.decision.summary.length > 300)) throw new GbdevError('config_invalid', 'Invalid decision summary');
  if (r.workspace.mode === 'per_lane') {
    try {
      assertSchema(r.workspace, closed({ mode: enumeration('per_lane'), worktree: nonempty, branch: nonempty, run_id: runIdSchema, task_id: taskIdSchema, lane: laneSchema }));
      assertSchema(r.integration, closed({ run_id: runIdSchema, task_id: taskIdSchema, integration_branch: nonempty, merge_state: enumeration('pending', 'merged', 'rolled_back', 'dropped'), merged_sha: nullable(nonempty), target_branch: nullable(nonempty), approved_by_user_at: nullable(dateSchema) }));
      if (r.integration!.run_id !== r.workspace.run_id || r.integration!.task_id !== r.workspace.task_id) throw new Error('Binding mismatch');
    } catch { throw new GbdevError('config_invalid', 'Invalid per_lane pipeline binding'); }
  }
  for (const s of r.steps) if (!s || !/^[a-z][a-z0-9-]{0,23}#[1-9][0-9]*$/.test(s.instance) || !['pending', 'running', 'succeeded', 'failed', 'needs_input', 'blocked', 'cancelled', 'skipped'].includes(s.state) || !Array.isArray(s.attempts)) throw new GbdevError('config_invalid', 'Invalid pipeline step');
  return { ...r, decisions: validateDecisions(r.decisions) };
}
