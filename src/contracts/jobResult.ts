import { validateJobId } from '../core/ids.js';
import { JOB_STATES, legacyFailureReason, type JobState } from './jobStatus.js';
import { validateInspectResult, type InspectResult } from './inspect.js';
import { type WorkerResult, validateWorkerResult } from './workerResult.js';
import { array, boolean, integer, invalid, nullableString, object, oneOf, schema, string, strings } from './validation.js';
import type { LaunchClassification } from '../core/retryPolicy.js';
import type { WorkspaceIssue } from '../core/workspaceSnapshot.js';
import type { PolicyAssessment } from '../core/policy.js';

export interface LaunchExecutionSummaryFields {
  chain_id?: string;
  execution_count?: number;
  launch_retries_used?: number;
  auto_retries_exhausted?: boolean;
  last_execution_index?: number | null;
  last_classification?: LaunchClassification | null;
  last_worker_duration_ms?: number | null;
  retry_not_before?: string | null;
  prompt_bytes?: number | null;
  prompt_max_bytes?: number | null;
}

/** M8 B6: provenance for the text written to final.md (optional; absent on pre-B6 results). */
export interface WorkerResultSource {
  kind: 'terminal_result' | 'assistant_final';
  event_index: number;
  raw_file: string;
}

export interface JobResult extends LaunchExecutionSummaryFields {
  schema: 'gbdev.job-result.v1';
  job_id: string;
  state: JobState;
  worker_exit_code: number | null;
  duration_s: number;
  worker_reported: WorkerResult | null;
  worker_result_warnings: string[];
  failure_reason: string | null;
  session_id?: string | null;
  failure_reasons?: string[];
  /** Optional structured-delivery provenance (Cursor B6 recovery). */
  worker_result_source?: WorkerResultSource;
  gbdev_observed: {
    head_before: string;
    head_after: string;
    commits: string[];
    files_changed: string[];
    outside_allowed_paths: string[];
    worktree_dirty_at_exit: boolean;
    snapshot_commit: string | null;
    checks: {
      id: string;
      cmd: string;
      exit_code: number | null;
      log: string;
      execution_id?: string;
      reused_from?: string;
      checked_sha?: string;
      source?: 'criterion' | 'task_check';
      check_id?: string;
    }[];
    policy_violations: string[];
    workspace_baseline?: string;
    job_files_changed?: string[];
    inherited_dirty_paths?: string[];
    check_files_changed?: string[];
    workspace_issues?: WorkspaceIssue[];
    policy_assessment?: PolicyAssessment;
  };
  paths: { final_message: string; diff: string; events: string; worker_log: string };
  /** Present only for inspect jobs. Null means the inspection did not produce a valid result. */
  inspection?: InspectResult | null;
}

const LAUNCH_CLASSIFICATIONS = ['cancelled', 'timeout', 'worker_stalled', 'prompt_too_large', 'provider_failure', 'launch_failed', 'missing_result', 'other'] as const;

function validateLaunchSummary(v: Record<string, unknown>): void {
  if (v.chain_id !== undefined) string(v.chain_id, 'chain_id');
  for (const key of ['execution_count', 'launch_retries_used', 'prompt_bytes', 'prompt_max_bytes', 'last_worker_duration_ms'] as const) {
    if (v[key] === undefined || v[key] === null) continue;
    integer(v[key], key, 0);
  }
  if (v.auto_retries_exhausted !== undefined) boolean(v.auto_retries_exhausted, 'auto_retries_exhausted');
  if (v.last_execution_index !== undefined && v.last_execution_index !== null) integer(v.last_execution_index, 'last_execution_index', 1);
  if (v.last_classification !== undefined && v.last_classification !== null) oneOf(v.last_classification, LAUNCH_CLASSIFICATIONS, 'last_classification');
  if (v.retry_not_before !== undefined && v.retry_not_before !== null) string(v.retry_not_before, 'retry_not_before');
}

export function validateJobResult(value: unknown): JobResult {
  const v = object(value, 'job-result');
  schema(v, 'gbdev.job-result.v1');
  validateJobId(v.job_id);
  oneOf(v.state, JOB_STATES, 'state');
  if (v.worker_exit_code !== null) integer(v.worker_exit_code, 'worker_exit_code', -2_147_483_648, 2_147_483_647);
  if (typeof v.duration_s !== 'number' || !Number.isFinite(v.duration_s) || v.duration_s < 0) invalid('duration_s must be finite and nonnegative');
  // Additive R1 fields must not make persisted pre-R1 v1 results unreadable.
  if (v.worker_result_warnings === undefined) v.worker_result_warnings = [];
  if (v.failure_reason === undefined) v.failure_reason = legacyFailureReason(v.state);
  strings(v.worker_result_warnings, 'worker_result_warnings');
  nullableString(v.failure_reason, 'failure_reason');
  if (v.failure_reasons === undefined) v.failure_reasons = v.state === 'failed' && v.failure_reason ? [v.failure_reason] : [];
  strings(v.failure_reasons, 'failure_reasons');
  if (v.session_id === undefined) v.session_id = null;
  nullableString(v.session_id, 'session_id');
  if (['failed', 'timeout', 'blocked'].includes(String(v.state)) && !v.failure_reason) invalid('failure_reason required for failed/timeout/blocked');
  if (v.worker_reported !== null) validateWorkerResult(v.worker_reported);
  const observed = object(v.gbdev_observed, 'gbdev_observed');
  string(observed.head_before, 'head_before');
  string(observed.head_after, 'head_after');
  for (const key of ['commits', 'files_changed', 'outside_allowed_paths', 'policy_violations']) strings(observed[key], key);
  boolean(observed.worktree_dirty_at_exit, 'worktree_dirty_at_exit');
  nullableString(observed.snapshot_commit, 'snapshot_commit');
  array(observed.checks, 'checks').forEach((item, i) => {
    const check = object(item, `checks[${i}]`);
    for (const key of ['id', 'cmd', 'log'] as const) string(check[key], `check.${key}`);
    if (check.exit_code !== null) integer(check.exit_code, 'check.exit_code', -2_147_483_648, 2_147_483_647);
    for (const key of ['execution_id', 'reused_from', 'checked_sha', 'check_id'] as const) {
      if (check[key] !== undefined) string(check[key], `check.${key}`);
    }
    if (check.source !== undefined) oneOf(check.source, ['criterion', 'task_check'] as const, 'check.source');
  });
  if (observed.workspace_baseline !== undefined) string(observed.workspace_baseline, 'workspace_baseline');
  for (const key of ['job_files_changed', 'inherited_dirty_paths', 'check_files_changed'] as const) {
    if (observed[key] !== undefined) strings(observed[key], key);
  }
  if (observed.workspace_issues !== undefined) {
    array(observed.workspace_issues, 'workspace_issues').forEach((item, i) => {
      const issue = object(item, `workspace_issues[${i}]`);
      string(issue.code, 'workspace_issues.code');
      string(issue.path, 'workspace_issues.path');
      nullableString(issue.owner_job_id, 'workspace_issues.owner_job_id');
      oneOf(issue.source_phase, ['worker', 'check', 'unknown'] as const, 'workspace_issues.source_phase');
      boolean(issue.repairable, 'workspace_issues.repairable');
    });
  }
  if (observed.policy_assessment !== undefined) {
    const assessment = object(observed.policy_assessment, 'policy_assessment');
    if (assessment.policy_version !== 1) invalid('policy_assessment.policy_version must be 1');
    array(assessment.warnings, 'policy_assessment.warnings').forEach((item, i) => {
      const warning = object(item, `policy_assessment.warnings[${i}]`);
      integer(warning.violation_index, 'policy_assessment.warnings.violation_index', 0);
      string(warning.category, 'policy_assessment.warnings.category');
      nullableString(warning.path, 'policy_assessment.warnings.path');
      if (warning.text !== undefined) string(warning.text, 'policy_assessment.warnings.text');
      if (warning.reason !== undefined) string(warning.reason, 'policy_assessment.warnings.reason');
      string(warning.evidence_ref, 'policy_assessment.warnings.evidence_ref');
    });
    array(assessment.repairable, 'policy_assessment.repairable').forEach((item, i) => {
      const entry = object(item, `policy_assessment.repairable[${i}]`);
      string(entry.code, 'policy_assessment.repairable.code');
      string(entry.path, 'policy_assessment.repairable.path');
      string(entry.owner_job_id, 'policy_assessment.repairable.owner_job_id');
      string(entry.evidence_ref, 'policy_assessment.repairable.evidence_ref');
      if (entry.content_hash !== undefined && entry.content_hash !== null) string(entry.content_hash, 'policy_assessment.repairable.content_hash');
    });
    strings(assessment.fatal, 'policy_assessment.fatal');
  }
  const paths = object(v.paths, 'paths');
  for (const key of ['final_message', 'diff', 'events', 'worker_log']) string(paths[key], `paths.${key}`);
  if (v.inspection !== undefined && v.inspection !== null) validateInspectResult(v.inspection);
  if (v.worker_result_source !== undefined) {
    const source = object(v.worker_result_source, 'worker_result_source');
    oneOf(source.kind, ['terminal_result', 'assistant_final'] as const, 'worker_result_source.kind');
    integer(source.event_index, 'worker_result_source.event_index', 0);
    string(source.raw_file, 'worker_result_source.raw_file');
  }
  validateLaunchSummary(v);
  return value as JobResult;
}
