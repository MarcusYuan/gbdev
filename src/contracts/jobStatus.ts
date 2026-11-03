import { ROLE_NAME } from './role.js';
import { validateBranchName, validateJobId } from '../core/ids.js';
import { PROVIDERS, SANDBOXES, type Provider, type Role, type Sandbox } from './brief.js';
import { validateJobInspectionMeta, type JobInspectionMeta } from './inspect.js';
import { array, integer, invalid, nullableString, object, oneOf, schema, string, strings, timestamp } from './validation.js';

export const JOB_STATES = ['queued', 'starting', 'running', 'needs_input', 'blocked', 'succeeded', 'failed', 'cancelled', 'timeout', 'reviewed', 'integrated', 'discarded'] as const;
export type JobState = typeof JOB_STATES[number];
export const ACTIVE_STATES: readonly JobState[] = ['queued', 'starting', 'running'];

export function isTerminal(state: JobState): boolean {
  return !ACTIVE_STATES.includes(state);
}

/** Historical v1 records predate failure metadata; do not invent a root cause. */
export function legacyFailureReason(state: JobState): string | null {
  if (state === 'timeout') return 'timeout';
  if (state === 'failed' || state === 'blocked') return 'legacy_failure_reason_missing';
  return null;
}

export interface JobStatus {
  kind?: 'merge_resolution' | 'run_verifier' | 'run_planner' | 'inspect';
  inspection?: JobInspectionMeta;
  run_id?: string; task_id?: string;
  schema: 'gbdev.job-status.v1';
  job_id: string;
  state: JobState;
  provider: Provider;
  role: Role;
  sandbox: Sandbox;
  repo: string;
  worktree: string;
  branch: string;
  base_sha: string;
  pid: number | null;
  created_at: string;
  updated_at: string;
  deadline_at: string;
  state_history: { state: JobState; at: string; by: string }[];
  last_event: { seq: number; type: string; at: string } | null;
  parent_job_id: string | null;
  failure_reason?: string | null;
  session_id?: string | null;
  failure_reasons?: string[];
  pipeline_id?: string | null;
  step_instance?: string | null;
  attempt?: number | null;
  /** Optional B7 launch-execution summary (additive; absent on legacy records). */
  review_round_id?: string;
  chain_id?: string;
  execution_count?: number;
  launch_retries_used?: number;
  auto_retries_exhausted?: boolean;
  last_execution_index?: number | null;
  last_classification?: string | null;
  last_worker_duration_ms?: number | null;
  retry_not_before?: string | null;
  prompt_bytes?: number | null;
  prompt_max_bytes?: number | null;
}

export function validateJobStatus(value: unknown): JobStatus {
  const v = object(value, 'job-status');
  schema(v, 'gbdev.job-status.v1');
  validateJobId(v.job_id);
  oneOf(v.state, JOB_STATES, 'state');
  oneOf(v.provider, PROVIDERS, 'provider');
  string(v.role, 'role');
  if (!ROLE_NAME.test(v.role)) invalid('Invalid role name');
  oneOf(v.sandbox, SANDBOXES, 'sandbox');
  for (const key of ['repo', 'worktree', 'base_sha'] as const) string(v[key], key);
  validateBranchName(v.branch);
  if (v.pid !== null) integer(v.pid, 'pid', 1);
  for (const key of ['created_at', 'updated_at', 'deadline_at'] as const) timestamp(v[key], key);
  const history = array(v.state_history, 'state_history');
  if (history.length === 0) invalid('state_history must not be empty');
  history.forEach((item, i) => {
    const entry = object(item, `state_history[${i}]`);
    oneOf(entry.state, JOB_STATES, 'history.state');
    timestamp(entry.at, 'history.at');
    string(entry.by, 'history.by');
  });
  if (object(history.at(-1), 'last history entry').state !== v.state) invalid('state must match the last state_history entry');
  if (v.last_event !== null) {
    const last = object(v.last_event, 'last_event');
    integer(last.seq, 'last_event.seq', 1);
    string(last.type, 'last_event.type');
    timestamp(last.at, 'last_event.at');
  }
  if (v.failure_reason === undefined && ['failed', 'timeout', 'blocked'].includes(v.state)) v.failure_reason = legacyFailureReason(v.state);
  if (v.failure_reason !== undefined) nullableString(v.failure_reason, 'failure_reason');
  if (v.failure_reasons === undefined) v.failure_reasons = v.state === 'failed' && v.failure_reason ? [v.failure_reason] : [];
  strings(v.failure_reasons, 'failure_reasons');
  if (v.session_id === undefined) v.session_id = null;
  nullableString(v.session_id, 'session_id');
  for (const key of ['pipeline_id', 'step_instance'] as const) {
    if (v[key] === undefined) v[key] = null;
    nullableString(v[key], key);
  }
  if (v.attempt === undefined) v.attempt = null;
  if (v.attempt !== null) integer(v.attempt, 'attempt', 1);
  nullableString(v.parent_job_id, 'parent_job_id');
  if (v.parent_job_id !== null) validateJobId(v.parent_job_id);
  if (v.kind !== undefined) oneOf(v.kind, ['merge_resolution', 'run_verifier', 'run_planner', 'inspect'], 'kind');
  if (v.inspection !== undefined && v.kind !== 'inspect') invalid('inspection is only valid when kind is inspect');
  if (v.kind === 'inspect') {
    if (v.run_id || v.task_id || v.parent_job_id || v.pipeline_id || v.step_instance || v.attempt) invalid('inspect jobs have empty owner fields');
    validateJobInspectionMeta(v.inspection);
  }
  if (v.review_round_id !== undefined) string(v.review_round_id, 'review_round_id');
  if (v.chain_id !== undefined) string(v.chain_id, 'chain_id');
  for (const key of ['execution_count', 'launch_retries_used', 'prompt_bytes', 'prompt_max_bytes', 'last_worker_duration_ms'] as const) {
    if (v[key] !== undefined && v[key] !== null) integer(v[key], key, 0);
  }
  if (v.auto_retries_exhausted !== undefined) {
    if (typeof v.auto_retries_exhausted !== 'boolean') invalid('auto_retries_exhausted must be boolean');
  }
  if (v.last_execution_index !== undefined && v.last_execution_index !== null) integer(v.last_execution_index, 'last_execution_index', 1);
  if (v.last_classification !== undefined && v.last_classification !== null) string(v.last_classification, 'last_classification');
  if (v.retry_not_before !== undefined && v.retry_not_before !== null) string(v.retry_not_before, 'retry_not_before');
  return value as JobStatus;
}
