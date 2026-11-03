import type { WorkerResult } from './workerResult.js';
import { assertSchema, bool, closed, dateSchema, enumeration, laneSchema, list, nullable, nonempty, number, runIdSchema, runInvalid, stringsSchema, taskIdSchema, textSchema, type JsonSchema } from './runValidation.js';
export const RUN_STATES = ['queued', 'starting', 'planning', 'plan_review', 'running', 'needs_decision', 'finalizing', 'succeeded', 'failed', 'cancelled'] as const;
export const TASK_STATES = ['pending', 'ready', 'running', 'paused', 'merge_queued', 'merging', 'integrated', 'needs_decision', 'dropped', 'cancelled', 'failed'] as const;
export const RUN_ACTIONS = ['approve_plan', 'replan', 'answer', 'retry', 'extra_round', 'accept', 'retry_task', 'rebuild_task', 'drop_task', 'retry_resolve', 'extra_fix', 'add_fix_task', 'accept_final', 'extend_budget', 'resume_run'] as const;
export const DECISION_REASONS = ['plan_review', 'plan_invalid', 'task_paused', 'task_failed', 'lane_broken', 'merge_conflict_unresolved', 'integration_gate_failed', 'final_review_revise', 'final_review_rejected', 'run_budget_exhausted', 'supervisor_crashed', 'integration_corrupt', 'launch_failed', 'prompt_too_large'] as const;
export type RunState = typeof RUN_STATES[number];
export type TaskState = typeof TASK_STATES[number];
export type RunAction = typeof RUN_ACTIONS[number];
export type RunOutcome = 'integrated' | 'integrated_partial' | 'accepted_by_decider' | null;
export interface RunAttention {
  decision_id: string; scope: 'run' | 'task' | 'merge'; task_id: string | null; reason: typeof DECISION_REASONS[number];
  allowed_actions: RunAction[]; detail: string; pipeline_id: string | null; merge_seq: number | null;
  pending_questions: WorkerResult['open_questions']; created_at: string;
  summary?: string;
  recommended_action?: 'retry' | null;
  accept_requirements?: Array<'verdict_missing_reviewed' | 'note'>;
}
export interface RunTask { task_id: string; state: TaskState; state_reason?: string | null; lane: string | null; branch: string | null; depends_on: string[]; attempts: { pipeline_id: string; kind: 'initial' | 'retry' | 'integration_fix' | 'rebuild' | 'final_fix'; state: string; outcome: string | null }[]; head_sha: string | null; base_sha: string | null; merge_seq: number[]; merged_sha: string | null; integration_fixes: number; scope_exceeded: string[]; decision_id: string | null }
export interface Run { paused_since?: string; paused_ms?: number; land?: { target: string; from_sha: string; landed_sha: string; approved_by_user_at: string; approval_note: string | null }; schema: 'gbdev.run.v1'; run_id: string; state: RunState; state_reason: string | null; outcome: RunOutcome; failure_reason: string | null; repo: string; base_ref: string; base_sha: string; executor_host: 'local'; lanes: { lane: string; host: 'local'; state: 'preparing' | 'idle' | 'busy' | 'broken'; worktree: string; task_id: string | null; branch: string | null; pipeline_id: string | null; tasks_done: number; verified_sha?: string }[]; integration: { branch: string; worktree: string; verified_sha: string; head_sha: string; merging: { seq: number; task_id: string; phase: 'precheck' | 'merging' | 'resolving' | 'gating' | 'verifying' | 'rolling_back'; started_at: string } | null; merges: number; rollbacks: number; target_branch: string | null; landed_sha: string | null; approved_by_user_at: string | null }; tasks: RunTask[]; progress: Record<'total' | Exclude<TaskState, 'cancelled'>, number>; merge_queue: string[]; attention: RunAttention[]; slots: { max_workers: number; in_use: number; by_provider: { codex: number; cursor: number; fake?: number }; cooldown_until: Partial<Record<'codex' | 'cursor' | 'fake', string>> }; budget: { jobs_used: number; max_total_jobs: number; max_tasks: number; extended: boolean }; plan: { source: 'planner' | 'provided'; approved_at: string | null; approved_by: string | null; plan_attempts: number }; supervisor_pid: number | null; heartbeat_at: string | null; created_at: string; updated_at: string; deadline_at: string; state_history: { state: RunState; at: string; by: string; reason: string | null }[]; warnings: string[] }
export const outcomeSchema = nullable(enumeration('integrated', 'integrated_partial', 'accepted_by_decider'));
export const questionSchema = closed({ id: nonempty, question: nonempty, options: stringsSchema, default: nullable(textSchema), blocking: bool });
export const attentionSchema = closed({
  decision_id: nonempty, scope: enumeration('run', 'task', 'merge'), task_id: nullable(taskIdSchema), reason: enumeration(...DECISION_REASONS),
  allowed_actions: list(enumeration(...RUN_ACTIONS)), detail: textSchema, pipeline_id: nullable(nonempty), merge_seq: nullable(number(1)),
  pending_questions: list(questionSchema), created_at: dateSchema,
  summary: { ...textSchema, maxLength: 300 },
  recommended_action: nullable(enumeration('retry')),
  accept_requirements: list(enumeration('verdict_missing_reviewed', 'note')),
}, ['summary', 'recommended_action', 'accept_requirements']);
const nullableText = nullable(nonempty);
export const runSchema: JsonSchema = closed({
  paused_since: dateSchema, paused_ms: number(),
  land: closed({ target: nonempty, from_sha: nonempty, landed_sha: nonempty, approved_by_user_at: dateSchema, approval_note: nullable(textSchema) }),
  schema: { type: 'string', const: 'gbdev.run.v1' }, run_id: runIdSchema, state: enumeration(...RUN_STATES), state_reason: nullableText, outcome: outcomeSchema, failure_reason: nullableText, repo: nonempty, base_ref: nonempty, base_sha: nonempty, executor_host: enumeration('local'),
  lanes: list(closed({ lane: laneSchema, host: enumeration('local'), state: enumeration('preparing', 'idle', 'busy', 'broken'), worktree: nonempty, task_id: nullable(taskIdSchema), branch: nullableText, pipeline_id: nullableText, tasks_done: number(), verified_sha: nonempty }, ['verified_sha']), 0, 4),
  integration: closed({ branch: nonempty, worktree: nonempty, verified_sha: nonempty, head_sha: nonempty, merging: nullable(closed({ seq: number(1), task_id: taskIdSchema, phase: enumeration('precheck', 'merging', 'resolving', 'gating', 'verifying', 'rolling_back'), started_at: dateSchema })), merges: number(), rollbacks: number(), target_branch: nullableText, landed_sha: nullableText, approved_by_user_at: nullable(dateSchema) }),
  tasks: list(closed({ task_id: taskIdSchema, state: enumeration(...TASK_STATES), state_reason: nullableText, lane: nullable(laneSchema), branch: nullableText, depends_on: list(taskIdSchema), attempts: list(closed({ pipeline_id: nonempty, kind: enumeration('initial', 'retry', 'integration_fix', 'rebuild', 'final_fix'), state: enumeration('queued', 'starting', 'running', 'needs_input', 'blocked', 'needs_decision', 'succeeded', 'failed', 'cancelled'), outcome: nullable(enumeration('approved', 'completed', 'accepted_by_decider')) })), head_sha: nullableText, base_sha: nullableText, merge_seq: list(number(1)), merged_sha: nullableText, integration_fixes: number(0, 3), scope_exceeded: stringsSchema, decision_id: nullableText }, ['state_reason']), 0, 16),
  progress: closed(Object.fromEntries(['total', ...TASK_STATES.filter(s => s !== 'cancelled')].map(k => [k, number()]))), merge_queue: list(taskIdSchema), attention: list(attentionSchema),
  slots: closed({ max_workers: number(1, 4), in_use: number(0, 4), by_provider: closed({ codex: number(0, 4), cursor: number(0, 4), fake: number(0, 4) }, ['fake']), cooldown_until: closed({ codex: dateSchema, cursor: dateSchema, fake: dateSchema }, ['codex', 'cursor', 'fake']) }),
  budget: closed({ jobs_used: number(), max_total_jobs: number(1, 120), max_tasks: number(1, 16), extended: bool }), plan: closed({ source: enumeration('planner', 'provided'), approved_at: nullable(dateSchema), approved_by: nullableText, plan_attempts: number(0, 3) }), supervisor_pid: nullable(number(1)), heartbeat_at: nullable(dateSchema), created_at: dateSchema, updated_at: dateSchema, deadline_at: dateSchema, state_history: list(closed({ state: enumeration(...RUN_STATES), at: dateSchema, by: nonempty, reason: nullableText })), warnings: stringsSchema,
}, ['land', 'paused_since', 'paused_ms']);
export function validateRun(value: unknown): Run {
  assertSchema(value, runSchema); const run = structuredClone(value) as Run;
  if (run.state !== 'succeeded' && run.outcome !== null) runInvalid(['outcome is only available for succeeded runs']);
  if (new Set(run.tasks.map(t => t.task_id)).size !== run.tasks.length || new Set(run.lanes.map(l => l.lane)).size !== run.lanes.length) runInvalid(['Duplicate tasks/lanes']);
  if (!run.integration.merging && run.integration.head_sha !== run.integration.verified_sha) runInvalid(['Stable integration HEAD must equal verified_sha']);
  return run;
}
