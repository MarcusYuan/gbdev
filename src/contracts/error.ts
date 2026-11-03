import type { Run } from './run.js';
export const ERROR_RETRYABLE = {
  notify_unavailable: true, notify_ack_invalid: false, key_name_missing: false,
  dashboard_unavailable: true,
  run_not_found: false, run_invalid: false, run_not_settled: true, run_not_terminal: true,
  run_state_conflict: false, integration_locked: true, user_approval_required: false,
  land_refused: false, guard_violation: false, pipeline_owned_by_run: false, job_owned_by_run: false,
  pipeline_not_found: false,
  pipeline_invalid: false,
  pipeline_not_settled: true,
  pipeline_not_terminal: true,
  pipeline_state_conflict: false,
  job_owned_by_pipeline: false,
  usage_error: false,
  role_not_found: false,
  role_invalid: false,
  role_fixed: false,
  verdict_retry_required: false,
  verdict_evidence_required: false,
  inspect_path_invalid: false,
  inspect_target_unavailable: false,
  inspect_result_invalid: false,
  inspect_output_too_large: false,
  cursor_model_not_allowed: false,
  config_invalid: false,
  repo_not_allowed: false,
  repo_no_commits: false,
  busy: true,
  provider_not_found: false,
  provider_not_logged_in: false,
  worktree_failed: false,
  job_not_found: false,
  job_not_terminal: true,
  wait_timeout: true,
  worker_crashed: false,
  worker_stalled: true,
  launch_failed: true,
  prompt_too_large: false,
  result_missing: false,
  result_invalid: false,
  cleanup_refused: false,
  launcher_conflict: false,
  home_conflict: false,
  internal_error: false,
  workspace_snapshot_invalid: false,
} as const;

export type ErrorCode = keyof typeof ERROR_RETRYABLE;
export interface ErrorDetails extends Record<string, unknown> { running_run_id?: string; run?: Run }
export interface ErrorContract {
  schema: 'gbdev.error.v1';
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details: ErrorDetails;
  next_steps: string[];
}

export class GbdevError extends Error {
  readonly contract: ErrorContract;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}, nextSteps: string[] = []) {
    super(message);
    this.name = 'GbdevError';
    this.contract = { schema: 'gbdev.error.v1', code, message, retryable: ERROR_RETRYABLE[code], details, next_steps: nextSteps };
  }
}

export function toErrorContract(error: unknown): ErrorContract {
  if (error instanceof GbdevError) return error.contract;
  return new GbdevError('internal_error', error instanceof Error ? error.message : 'Unknown internal error').contract;
}

export function errorExitCode(code: ErrorCode): 1 | 2 {
  return code === 'run_invalid' || code === 'user_approval_required' || code === 'pipeline_invalid' || code === 'role_invalid' || code === 'role_fixed' || code === 'usage_error' || code === 'config_invalid' || code === 'cursor_model_not_allowed' || code === 'inspect_path_invalid' ? 2 : 1;
}

export function validateError(value: unknown): ErrorContract {
  // Kept dependency-free so validation helpers can themselves raise GbdevError.
  const v = value as Partial<ErrorContract> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.schema !== 'gbdev.error.v1' ||
      typeof v.code !== 'string' || !Object.hasOwn(ERROR_RETRYABLE, v.code) ||
      typeof v.message !== 'string' || !v.message.trim() || v.retryable !== ERROR_RETRYABLE[v.code] ||
      !v.details || typeof v.details !== 'object' || Array.isArray(v.details) ||
      !Array.isArray(v.next_steps) || !v.next_steps.every(s => typeof s === 'string' && s.trim().length > 0)) {
    throw new GbdevError('config_invalid', 'Invalid gbdev.error.v1');
  }
  return value as ErrorContract;
}
