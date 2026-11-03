import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localIso, type Clock, realClock } from './time.js';
import {
  type LaunchClassification,
  type RetryChainRecord,
  type WorkerLaunchConfig,
  DEFAULT_WORKER_LAUNCH,
  launchBackoffDelayMs,
  newChainId,
  shouldAutoRetryLaunch,
  inheritChainForSuccessorJob,
} from './retryPolicy.js';
import { atomicWriteJson } from './jobStore.js';
import { jobPaths, type GbdevPaths } from './paths.js';

export interface LaunchAttemptFacts {
  execution: number;
  worker_duration_ms: number;
  exit_code: number | null;
  raw_events: number;
  bytes: number;
  has_final_message: boolean;
  classification: LaunchClassification;
  raw_name: string;
}

export function launchAttemptsDir(paths: ReturnType<typeof jobPaths>): string {
  return join(paths.dir, 'launch-attempts');
}

export function chainPath(paths: ReturnType<typeof jobPaths>): string {
  return join(paths.dir, 'launch-retry-chain.json');
}

export function loadRetryChain(paths: ReturnType<typeof jobPaths>): RetryChainRecord | null {
  const path = chainPath(paths);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RetryChainRecord;
  } catch {
    return null;
  }
}

export function saveRetryChain(paths: ReturnType<typeof jobPaths>, chain: RetryChainRecord): void {
  atomicWriteJson(chainPath(paths), chain);
}

export function ensureRetryChain(
  paths: ReturnType<typeof jobPaths>,
  owner: RetryChainRecord['owner'],
  policy: WorkerLaunchConfig = DEFAULT_WORKER_LAUNCH,
  inherited?: RetryChainRecord | null,
): RetryChainRecord {
  const existing = loadRetryChain(paths);
  if (existing) return existing;
  if (inherited) {
    const next = { ...inherited, owner, pending_execution: null, retry_not_before: null };
    saveRetryChain(paths, next);
    return next;
  }
  const chain: RetryChainRecord = {
    schema: 'gbdev.launch-retry-chain.v1',
    chain_id: newChainId(owner.job_id),
    owner,
    policy: { ...policy },
    executions_completed: 0,
    launch_retries_used: 0,
    missing_result_retry_used: false,
    pending_execution: null,
    retry_not_before: null,
    last_classification: null,
    auto_retries_exhausted: false,
    emitted_retry_indexes: [],
  };
  saveRetryChain(paths, chain);
  return chain;
}

/** Snapshot current top-level outputs into launch-attempts/<n>/. */
export function archiveLaunchAttempt(
  storePaths: GbdevPaths,
  jobId: string,
  facts: LaunchAttemptFacts,
  provider: 'cursor' | 'codex' | 'fake' | string,
): void {
  const paths = jobPaths(storePaths, jobId);
  const dest = join(launchAttemptsDir(paths), String(facts.execution));
  mkdirSync(dest, { recursive: true });
  const rawSrc = provider === 'cursor' ? paths.rawJson : paths.rawJsonl;
  const rawName = facts.raw_name;
  try {
    if (existsSync(rawSrc)) copyFileSync(rawSrc, join(dest, rawName));
  } catch { /* best-effort */ }
  try {
    if (existsSync(paths.workerLog)) copyFileSync(paths.workerLog, join(dest, 'worker.log'));
  } catch { /* best-effort */ }
  try {
    if (existsSync(paths.finalMessage)) copyFileSync(paths.finalMessage, join(dest, 'final.md'));
  } catch { /* best-effort */ }
  atomicWriteJson(join(dest, 'execution.json'), {
    schema: 'gbdev.launch-execution.v1',
    ...facts,
    archived_at: localIso(),
  });
}

/** Clear top-level final message / raw / log for the next execution (after archiving). */
export function resetExecutionOutputs(storePaths: GbdevPaths, jobId: string, provider: string): void {
  const paths = jobPaths(storePaths, jobId);
  const raw = provider === 'cursor' ? paths.rawJson : paths.rawJsonl;
  writeFileSync(raw, '');
  writeFileSync(paths.workerLog, '');
  if (existsSync(paths.finalMessage)) {
    try { rmSync(paths.finalMessage); } catch { writeFileSync(paths.finalMessage, ''); }
  }
  // Drop any leftover session markers that could pollute classification.
  for (const name of ['session.json', 'cursor-session.json']) {
    const p = join(paths.dir, name);
    if (existsSync(p)) {
      try { rmSync(p); } catch { /* ignore */ }
    }
  }
}

export interface ScheduledLaunchRetry {
  chain: RetryChainRecord;
  retry_index: number;
  delay_ms: number;
  retry_not_before: string;
  event_data: Record<string, unknown>;
}

/** Persist scheduled retry before waiting. Dedupes by (chain_id, retry_index). */
export function scheduleLaunchRetry(
  paths: ReturnType<typeof jobPaths>,
  chain: RetryChainRecord,
  facts: LaunchAttemptFacts,
  provider: string,
  clock: Clock = realClock,
): ScheduledLaunchRetry | null {
  if (!shouldAutoRetryLaunch(facts.classification, chain)) {
    chain.auto_retries_exhausted = facts.classification === 'launch_failed';
    chain.last_classification = facts.classification;
    chain.last_exit_code = facts.exit_code;
    chain.last_worker_duration_ms = facts.worker_duration_ms;
    chain.last_raw_events = facts.raw_events;
    chain.last_bytes = facts.bytes;
    chain.last_has_final_message = facts.has_final_message;
    chain.executions_completed = Math.max(chain.executions_completed, facts.execution);
    chain.pending_execution = null;
    chain.retry_not_before = null;
    saveRetryChain(paths, chain);
    return null;
  }
  const retry_index = chain.launch_retries_used + 1;
  if (chain.emitted_retry_indexes.includes(retry_index)) {
    // Recovery: already scheduled this index; keep waiting until retry_not_before.
    const delay_ms = launchBackoffDelayMs(retry_index, chain.policy);
    return {
      chain,
      retry_index,
      delay_ms,
      retry_not_before: chain.retry_not_before ?? localIso(new Date(clock.now() + delay_ms)),
      event_data: {},
    };
  }
  const delay_ms = launchBackoffDelayMs(retry_index, chain.policy);
  const retry_not_before = localIso(new Date(clock.now() + delay_ms));
  const next_execution = facts.execution + 1;
  chain.launch_retries_used = retry_index;
  chain.executions_completed = facts.execution;
  chain.pending_execution = next_execution;
  chain.retry_not_before = retry_not_before;
  chain.last_classification = facts.classification;
  chain.last_exit_code = facts.exit_code;
  chain.last_worker_duration_ms = facts.worker_duration_ms;
  chain.last_raw_events = facts.raw_events;
  chain.last_bytes = facts.bytes;
  chain.last_has_final_message = facts.has_final_message;
  chain.emitted_retry_indexes = [...chain.emitted_retry_indexes, retry_index];
  if (retry_index >= chain.policy.max_retries) {
    // Exhaustion is decided after the next (final) execution fails; mark pending still.
  }
  saveRetryChain(paths, chain);
  const event_data = {
    chain_id: chain.chain_id,
    provider,
    reason: 'launch_failed' as const,
    failed_execution: facts.execution,
    next_execution,
    retry_index,
    max_retries: chain.policy.max_retries,
    delay_ms,
    retry_not_before,
    worker_duration_ms: facts.worker_duration_ms,
    exit_code: facts.exit_code,
    raw_events: facts.raw_events,
    bytes: facts.bytes,
    has_final_message: facts.has_final_message,
  };
  return { chain, retry_index, delay_ms, retry_not_before, event_data };
}

export function markLaunchRetriesExhausted(paths: ReturnType<typeof jobPaths>, chain: RetryChainRecord, facts: LaunchAttemptFacts): RetryChainRecord {
  chain.auto_retries_exhausted = true;
  chain.executions_completed = facts.execution;
  chain.pending_execution = null;
  chain.retry_not_before = null;
  chain.last_classification = facts.classification;
  chain.last_exit_code = facts.exit_code;
  chain.last_worker_duration_ms = facts.worker_duration_ms;
  chain.last_raw_events = facts.raw_events;
  chain.last_bytes = facts.bytes;
  chain.last_has_final_message = facts.has_final_message;
  saveRetryChain(paths, chain);
  return chain;
}

export function markExecutionSuccess(paths: ReturnType<typeof jobPaths>, chain: RetryChainRecord, execution: number): RetryChainRecord {
  chain.executions_completed = execution;
  chain.pending_execution = null;
  chain.retry_not_before = null;
  chain.last_classification = 'other';
  chain.auto_retries_exhausted = false;
  saveRetryChain(paths, chain);
  return chain;
}

/** Wait until retry_not_before (or delay), honouring abort/deadline. Returns false if aborted. */
export async function waitLaunchBackoff(
  retry_not_before: string,
  clock: Clock,
  signal?: AbortSignal,
  deadlineAtMs?: number,
): Promise<boolean> {
  for (;;) {
    if (signal?.aborted) return false;
    const now = clock.now();
    if (deadlineAtMs !== undefined && now >= deadlineAtMs) return false;
    const target = Date.parse(retry_not_before);
    const remaining = Number.isFinite(target) ? target - now : 0;
    if (remaining <= 0) return true;
    const slice = Math.min(remaining, deadlineAtMs !== undefined ? Math.max(1, deadlineAtMs - now) : remaining, 1000);
    try {
      await clock.sleep(slice, signal);
    } catch {
      if (signal?.aborted) return false;
      throw new Error('launch backoff wait failed');
    }
  }
}

export function isArgTooLongError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & { message?: string };
  if (!err) return false;
  if (err.code === 'ENAMETOOLONG' || err.code === 'E2BIG') return true;
  const msg = String(err.message ?? err);
  return /argument list too long|ENAMETOOLONG|E2BIG|file name too long/i.test(msg);
}

/** Called only when a missing-result successor is actually created, under the store lock. */
export function inheritMissingResultRetry(
  priorPaths: ReturnType<typeof jobPaths>,
  nextPaths: ReturnType<typeof jobPaths>,
  owner: RetryChainRecord['owner'],
): RetryChainRecord | null {
  const prior = loadRetryChain(priorPaths);
  if (!prior) return null; // Legacy jobs have no B7 budget to inherit.
  if (prior.missing_result_retry_used) throw new Error('missing_result_retry_exhausted');
  prior.missing_result_retry_used = true;
  saveRetryChain(priorPaths, prior);
  return ensureRetryChain(nextPaths, owner, prior.policy, inheritChainForSuccessorJob(prior, owner));
}
