import { createHash, randomBytes } from 'node:crypto';
import type { ForcedState } from './finalize.js';

export interface WorkerLaunchConfig {
  failure_threshold_ms: number;
  max_retries: number;
  backoff_initial_ms: number;
  backoff_multiplier: number;
  backoff_max_ms: number;
}

export interface ReviewPromptConfig {
  max_bytes: number;
}

export const DEFAULT_WORKER_LAUNCH: WorkerLaunchConfig = {
  failure_threshold_ms: 5000,
  max_retries: 2,
  backoff_initial_ms: 2000,
  backoff_multiplier: 4,
  backoff_max_ms: 30000,
};

export const DEFAULT_REVIEW_PROMPT: ReviewPromptConfig = {
  max_bytes: 200000,
};

export type LaunchClassification =
  | 'cancelled'
  | 'timeout'
  | 'worker_stalled'
  | 'prompt_too_large'
  | 'provider_failure'
  | 'launch_failed'
  | 'missing_result'
  | 'other';

export interface LaunchClassifyInput {
  spawned: boolean;
  closed: boolean;
  worker_duration_ms: number;
  raw_events: number;
  parseable_json_events: number;
  final_message: string | null;
  forced?: ForcedState | undefined;
  provider_failure?: string | null | undefined;
  prompt_too_large?: boolean | undefined;
  threshold_ms: number;
  workspace_policy_blocked?: boolean | undefined;
}

export interface RetryChainRecord {
  schema: 'gbdev.launch-retry-chain.v1';
  chain_id: string;
  owner: { job_id: string; pipeline_id?: string | null; run_id?: string | null; step_instance?: string | null };
  policy: WorkerLaunchConfig;
  executions_completed: number;
  launch_retries_used: number;
  missing_result_retry_used: boolean;
  pending_execution?: number | null;
  retry_not_before?: string | null;
  last_classification?: LaunchClassification | null;
  last_exit_code?: number | null;
  last_worker_duration_ms?: number | null;
  last_raw_events?: number | null;
  last_bytes?: number | null;
  last_has_final_message?: boolean | null;
  auto_retries_exhausted: boolean;
  emitted_retry_indexes: number[];
}

export function newChainId(seed?: string): string {
  const base = seed ?? randomBytes(8).toString('hex');
  return `chain-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`;
}

/** delay_ms(n) for the n-th automatic launch retry (1-based). */
export function launchBackoffDelayMs(n: number, policy: WorkerLaunchConfig): number {
  if (!Number.isSafeInteger(n) || n < 1) return policy.backoff_initial_ms;
  const raw = policy.backoff_initial_ms * (policy.backoff_multiplier ** (n - 1));
  return Math.min(policy.backoff_max_ms, raw);
}

export function classifyLaunchFailure(input: LaunchClassifyInput): LaunchClassification {
  if (input.forced === 'cancelled') return 'cancelled';
  if (input.forced === 'timeout') return 'timeout';
  if (input.forced === 'worker_stalled') return 'worker_stalled';
  if (input.prompt_too_large) return 'prompt_too_large';
  if (input.provider_failure) return 'provider_failure';
  const emptyFinal = input.final_message === null || !input.final_message.trim();
  if (
    input.spawned &&
    input.closed &&
    input.worker_duration_ms < input.threshold_ms &&
    input.raw_events === 0 &&
    input.parseable_json_events === 0 &&
    emptyFinal &&
    !input.forced
  ) {
    return 'launch_failed';
  }
  if (emptyFinal && input.raw_events === 0 && input.parseable_json_events === 0) return 'missing_result';
  return 'other';
}

export function shouldAutoRetryLaunch(
  classification: LaunchClassification,
  chain: RetryChainRecord,
  opts: { workspace_policy_blocked?: boolean } = {},
): boolean {
  if (classification !== 'launch_failed') return false;
  if (opts.workspace_policy_blocked) return false;
  if (chain.auto_retries_exhausted) return false;
  return chain.launch_retries_used < chain.policy.max_retries;
}

export function inheritChainForSuccessorJob(
  prior: RetryChainRecord,
  owner: RetryChainRecord['owner'],
): RetryChainRecord {
  return {
    ...prior,
    owner,
    pending_execution: null,
    retry_not_before: null,
    // Budget carries forward; do not reset launch retries or missing-result flag.
  };
}

export interface LaunchExecutionSummary {
  chain_id: string;
  execution_count: number;
  launch_retries_used: number;
  auto_retries_exhausted: boolean;
  last_execution_index: number | null;
  last_classification: LaunchClassification | null;
  last_worker_duration_ms: number | null;
  retry_not_before: string | null;
  prompt_bytes?: number | null;
  prompt_max_bytes?: number | null;
}

export function summaryFromChain(chain: RetryChainRecord, prompt?: { bytes?: number | null; max?: number | null }): LaunchExecutionSummary {
  return {
    chain_id: chain.chain_id,
    execution_count: chain.executions_completed,
    launch_retries_used: chain.launch_retries_used,
    auto_retries_exhausted: chain.auto_retries_exhausted,
    last_execution_index: chain.executions_completed > 0 ? chain.executions_completed : null,
    last_classification: chain.last_classification ?? null,
    last_worker_duration_ms: chain.last_worker_duration_ms ?? null,
    retry_not_before: chain.retry_not_before ?? null,
    ...(prompt?.bytes !== undefined || prompt?.max !== undefined
      ? { prompt_bytes: prompt.bytes ?? null, prompt_max_bytes: prompt.max ?? null }
      : {}),
  };
}
