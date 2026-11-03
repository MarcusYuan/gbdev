import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { jobTempEnv } from './jobTemp.js';
import { head } from './git.js';
import { atomicWriteJson } from './jobStore.js';
import { groupAlive, terminateGroup } from './proc.js';
import { optionalText } from './runtime.js';
import {
  captureWorkspaceSnapshot, workspaceGenerationFingerprint, type SnapshotOptions, type WorkspaceSnapshot,
} from './workspaceSnapshot.js';

export const DEFAULT_CHECK_TIMEOUT_MIN = 10;

export type CheckSource = 'criterion' | 'task_check';

export interface ObservedCheck {
  id: string;
  cmd: string;
  exit_code: number | null;
  log: string;
  execution_id?: string;
  reused_from?: string;
  checked_sha?: string;
  source?: CheckSource;
  /** Trusted catalog id when source is task_check. */
  check_id?: string;
}

export interface CheckCriterionInput {
  id: string;
  check_cmd?: string;
  /** Minutes; defaults to 10 when omitted (legacy brief check_cmd). */
  timeout_min?: number;
  source?: CheckSource;
  check_id?: string;
}

export const TASK_CHECK_LOGICAL_PREFIX = 'task_check:';

export function logicalTaskCheckId(checkId: string): string {
  return `${TASK_CHECK_LOGICAL_PREFIX}${checkId}`;
}

/** Merge acceptance criteria and frozen execution_checks into one runJobChecks plan. */
export function criteriaFromBrief(brief: {
  acceptance_criteria: { id: string; check_cmd?: string; timeout_min?: number }[];
  execution_checks?: { id: string; cmd: string; timeout_min: number }[];
}): CheckCriterionInput[] {
  const criteria: CheckCriterionInput[] = brief.acceptance_criteria.map(c => ({
    id: c.id,
    ...(c.check_cmd !== undefined ? { check_cmd: c.check_cmd } : {}),
    ...(c.timeout_min !== undefined ? { timeout_min: c.timeout_min } : {}),
  }));
  for (const check of brief.execution_checks ?? []) {
    criteria.push({
      id: logicalTaskCheckId(check.id),
      check_cmd: check.cmd,
      timeout_min: check.timeout_min,
      source: 'task_check',
      check_id: check.id,
    });
  }
  return criteria;
}

interface PlannedMember {
  id: string;
  cmd: string;
  index: number;
  logRel: string;
  logAbs: string;
  timeout_min: number;
  source?: CheckSource;
  check_id?: string;
}

interface CachedExecution {
  execution_id: string;
  firstId: string;
  /** Index into the results array for the physically executed member. */
  firstResultIndex: number;
  exit_code: number | null;
  primaryLogAbs: string;
  checked_sha: string;
  shared: boolean;
}

export function environmentFingerprint(env: NodeJS.ProcessEnv): string {
  const hash = createHash('sha256');
  for (const key of Object.keys(env).sort()) {
    hash.update(key);
    hash.update('=');
    hash.update(env[key] ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function freezeCheckEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...source };
}

export function executionIdentityKey(parts: {
  canonical_cwd: string;
  executable: string;
  argv: string[];
  env_fingerprint: string;
  head_sha: string;
  workspace_generation: string;
}): string {
  const hash = createHash('sha256');
  hash.update(parts.canonical_cwd);
  hash.update('\0');
  hash.update(parts.executable);
  hash.update('\0');
  for (const arg of parts.argv) {
    hash.update(arg);
    hash.update('\0');
  }
  hash.update(parts.env_fingerprint);
  hash.update('\0');
  hash.update(parts.head_sha);
  hash.update('\0');
  hash.update(parts.workspace_generation);
  return hash.digest('hex');
}

/** Group key for timeout aggregation — excludes HEAD / workspace generation. */
export function timeoutGroupKey(parts: {
  canonical_cwd: string;
  executable: string;
  argv: string[];
  env_fingerprint: string;
}): string {
  return executionIdentityKey({ ...parts, head_sha: '', workspace_generation: '' });
}

export function safeCheckLogNames(criteria: { id: string; check_cmd?: string }[]): Map<number, string> {
  const logNames = new Set<string>();
  const byIndex = new Map<number, string>();
  for (const [index, criterion] of criteria.entries()) {
    if (!criterion.check_cmd) continue;
    let name = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(criterion.id) ? criterion.id : `criterion-${index}`;
    while (logNames.has(name)) name += `-${index}`;
    logNames.add(name);
    byIndex.set(index, name);
  }
  return byIndex;
}

function spawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Explicit object for child_process; drop undefined values Node would reject.
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Isolated process group; cancel/timeout always clears check_pgid and reaps descendants. */
export async function runCheckProcess(
  cmd: string,
  cwd: string,
  logAbs: string,
  cancelRequest: string,
  processInfo: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  deadlineAt?: number,
  onPhysicalStart?: (cmd: string) => void,
): Promise<number | null> {
  const fd = openSync(logAbs, 'w', 0o600);
  try {
    const effectiveTimeoutMs = Math.min(timeoutMs, deadlineAt === undefined ? Infinity : deadlineAt - Date.now());
    // Match a timed-out process result without launching after the absolute deadline.
    if (effectiveTimeoutMs <= 0) return null;
    return await new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', cmd], {
        cwd, detached: true, stdio: ['ignore', fd, fd], env: spawnEnv(env),
      });
      onPhysicalStart?.(cmd);
      const info = JSON.parse(optionalText(processInfo) ?? '{}') as Record<string, unknown>;
      atomicWriteJson(processInfo, { ...info, check_pgid: child.pid ?? null });
      let termination: Promise<void> | undefined;
      const stop = () => {
        if (child.pid && !termination) {
          termination = terminateGroup(child.pid);
          void termination.catch(() => {});
        }
      };
      const timer = setTimeout(stop, Math.max(1, effectiveTimeoutMs));
      const cancellation = setInterval(() => {
        if (optionalText(cancelRequest) !== null) stop();
      }, 100);
      child.once('error', error => {
        writeFileSync(fd, `\n${error.message}\n`);
      });
      child.once('close', async code => {
        clearTimeout(timer);
        clearInterval(cancellation);
        try {
          await termination;
          if (child.pid && groupAlive(child.pid)) await terminateGroup(child.pid);
          atomicWriteJson(processInfo, { ...info, check_pgid: null });
          resolve(code);
        } catch (error) { reject(error); }
      });
    });
  } finally { closeSync(fd); }
}

function markShared(results: ObservedCheck[], cached: CachedExecution): void {
  cached.shared = true;
  const first = results[cached.firstResultIndex];
  if (first) {
    first.execution_id = cached.execution_id;
    first.checked_sha = cached.checked_sha;
    delete first.reused_from;
  }
}

export interface RunJobChecksOptions {
  criteria: CheckCriterionInput[];
  cwd: string;
  jobDir: string;
  cancelRequest: string;
  processInfo: string;
  /** Snapshot taken immediately before the check phase; used for initial generation. */
  workspace?: WorkspaceSnapshot | null;
  /** Applied to every generation capture, including the initial snapshot. */
  snapshotOptions?: SnapshotOptions;
  /** Absolute Unix time in milliseconds; bounds each physical check's timeout. */
  deadlineAt?: number;
  onCheck?: (check: ObservedCheck) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Test seam: observe physical spawn count. */
  onPhysicalStart?: (cmd: string) => void;
}

/**
 * Run acceptance checks for one job finalize. Dedupes identical execution identities
 * within this call only — never across jobs/attempts.
 */
export async function runJobChecks(options: RunJobChecksOptions): Promise<ObservedCheck[]> {
  const {
    criteria, cwd, jobDir, cancelRequest, processInfo, workspace,
    onCheck, onPhysicalStart,
  } = options;
  mkdirSync(join(jobDir, 'checks'), { recursive: true });
  const env = freezeCheckEnv({ ...(options.env ?? process.env), ...jobTempEnv(jobDir) });
  const envFingerprint = environmentFingerprint(env);
  const canonicalCwd = realpathSync(cwd);
  const executable = '/bin/sh';
  const logNames = safeCheckLogNames(criteria);

  const members: PlannedMember[] = [];
  for (const [index, criterion] of criteria.entries()) {
    if (!criterion.check_cmd) continue;
    const name = logNames.get(index)!;
    members.push({
      id: criterion.id,
      cmd: criterion.check_cmd,
      index,
      logRel: `checks/${name}.log`,
      logAbs: join(jobDir, 'checks', `${name}.log`),
      timeout_min: criterion.timeout_min ?? DEFAULT_CHECK_TIMEOUT_MIN,
      ...(criterion.source ? { source: criterion.source } : {}),
      ...(criterion.check_id ? { check_id: criterion.check_id } : {}),
    });
  }

  const minTimeoutByGroup = new Map<string, number>();
  for (const member of members) {
    const group = timeoutGroupKey({
      canonical_cwd: canonicalCwd,
      executable,
      argv: ['-c', member.cmd],
      env_fingerprint: envFingerprint,
    });
    const prev = minTimeoutByGroup.get(group);
    const next = member.timeout_min;
    minTimeoutByGroup.set(group, prev === undefined ? next : Math.min(prev, next));
  }

  let headSha = head(cwd);
  let generation: string | null = null;
  try {
    generation = workspace
      ? workspaceGenerationFingerprint(workspace)
      : workspaceGenerationFingerprint(await captureWorkspaceSnapshot(cwd, {
        job_id: 'check-phase', phase: 'after_worker',
      }, { ...options.snapshotOptions, settleRacy: false }));
  } catch { /* Failed or truncated observation cannot establish a cacheable generation. */ }

  const cache = new Map<string, CachedExecution>();
  const results: ObservedCheck[] = [];
  let cancelled = optionalText(cancelRequest) !== null;

  const refreshGeneration = async (): Promise<void> => {
    try {
      const nextHead = head(cwd);
      const snap = await captureWorkspaceSnapshot(cwd, {
        job_id: 'check-phase', phase: 'after_checks',
      }, { ...options.snapshotOptions, settleRacy: false });
      const nextGen = workspaceGenerationFingerprint(snap);
      if (nextGen === null || nextHead !== headSha || nextGen !== generation) {
        cache.clear();
      }
      headSha = nextHead;
      generation = nextGen;
    } catch {
      // Unreadable workspace must not allow stale reuse.
      cache.clear();
      try { headSha = head(cwd); } catch { /* keep prior head */ }
      generation = null;
    }
  };

  for (const member of members) {
    if (cancelled || optionalText(cancelRequest) !== null) {
      cancelled = true;
      writeFileSync(member.logAbs, '', { mode: 0o600 });
      const skipped: ObservedCheck = {
        id: member.id, cmd: member.cmd, exit_code: null, log: member.logRel,
        ...(member.source ? { source: member.source } : {}),
        ...(member.check_id ? { check_id: member.check_id } : {}),
      };
      results.push(skipped);
      await onCheck?.(skipped);
      continue;
    }

    const argv = ['-c', member.cmd];
    const key = executionIdentityKey({
      canonical_cwd: canonicalCwd,
      executable,
      argv,
      env_fingerprint: envFingerprint,
      head_sha: headSha,
      workspace_generation: generation ?? '',
    });
    const cached = generation === null ? undefined : cache.get(key);
    if (cached) {
      copyFileSync(cached.primaryLogAbs, member.logAbs);
      markShared(results, cached);
      const reused: ObservedCheck = {
        id: member.id,
        cmd: member.cmd,
        exit_code: cached.exit_code,
        log: member.logRel,
        execution_id: cached.execution_id,
        reused_from: cached.firstId,
        checked_sha: cached.checked_sha,
        ...(member.source ? { source: member.source } : {}),
        ...(member.check_id ? { check_id: member.check_id } : {}),
      };
      results.push(reused);
      await onCheck?.(reused);
      continue;
    }

    const group = timeoutGroupKey({
      canonical_cwd: canonicalCwd,
      executable,
      argv,
      env_fingerprint: envFingerprint,
    });
    const timeoutMin = minTimeoutByGroup.get(group) ?? member.timeout_min;
    const beforeGeneration = generation;
    const beforeHead = headSha;
    const exit_code = await runCheckProcess(
      member.cmd, cwd, member.logAbs, cancelRequest, processInfo, env, timeoutMin * 60_000,
      options.deadlineAt, onPhysicalStart,
    );
    if (optionalText(cancelRequest) !== null) cancelled = true;

    const execution_id = key.slice(0, 16);
    let checked_sha = headSha;
    try { checked_sha = head(cwd); } catch { /* Check may have broken the worktree; keep prior HEAD. */ }
    const entry: CachedExecution = {
      execution_id,
      firstId: member.id,
      firstResultIndex: results.length,
      exit_code,
      primaryLogAbs: member.logAbs,
      checked_sha,
      shared: false,
    };
    const check: ObservedCheck = {
      id: member.id, cmd: member.cmd, exit_code, log: member.logRel,
      ...(member.source ? { source: member.source } : {}),
      ...(member.check_id ? { check_id: member.check_id } : {}),
    };
    results.push(check);
    await onCheck?.(check);
    await refreshGeneration();
    // Both observations must prove the same state; unknown/failed snapshots never enter the cache.
    if (!cancelled && beforeGeneration !== null && generation === beforeGeneration && headSha === beforeHead) {
      cache.set(key, entry);
    }
  }

  // Retrofit optional fields onto first members once sharing is known.
  for (const entry of cache.values()) {
    if (!entry.shared) continue;
    const first = results[entry.firstResultIndex];
    if (!first) continue;
    first.execution_id = entry.execution_id;
    first.checked_sha = entry.checked_sha;
    delete first.reused_from;
  }

  return results;
}
