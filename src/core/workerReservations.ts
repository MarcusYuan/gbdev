import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Provider } from '../contracts/brief.js';
import { GbdevError } from '../contracts/error.js';
import { isTerminal, type JobStatus } from '../contracts/jobStatus.js';
import { atomicWriteJson, JobStore } from './jobStore.js';
import { isProcessAlive } from './lock.js';
import { inspectLeasePath, jobPaths } from './paths.js';
import { groupAlive } from './proc.js';
import { allJobs, optionalText, transition } from './runtime.js';
import { readRunConfigFields, validateParallel, type ParallelConfig } from './runConfig.js';
import { activeRun, allRuns } from '../run/store.js';

interface InspectLease {
  job_id: string;
  provider: Provider;
  supervisor_pid: number | null;
  worker_pgid: number | null;
  started_at: string;
}

function readLease(store: JobStore): InspectLease | null {
  const raw = optionalText(inspectLeasePath(store.paths));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as InspectLease;
    if (!value || typeof value.job_id !== 'string' || typeof value.provider !== 'string') return null;
    return value;
  } catch { return null; }
}

function writeLease(store: JobStore, lease: InspectLease): void {
  const path = inspectLeasePath(store.paths);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  atomicWriteJson(path, lease);
}

function processIdentity(store: JobStore, jobId: string): { supervisor_pid?: number | null; worker_pgid?: number | null } {
  try { return JSON.parse(optionalText(jobPaths(store.paths, jobId).processInfo) ?? '{}') as { supervisor_pid?: number | null; worker_pgid?: number | null }; }
  catch { return {}; }
}

function young(at: string | undefined): boolean {
  const age = Date.now() - Date.parse(at ?? '');
  return Number.isFinite(age) && age >= 0 && age < 60_000;
}

function jobLive(store: JobStore, job: JobStatus, lease?: InspectLease | null): boolean {
  if (isTerminal(job.state)) return false;
  const info = processIdentity(store, job.job_id);
  const supervisor = info.supervisor_pid ?? job.pid ?? lease?.supervisor_pid ?? null;
  const worker = info.worker_pgid ?? lease?.worker_pgid ?? null;
  if (typeof supervisor === 'number' && isProcessAlive(supervisor)) return true;
  if (typeof worker === 'number' && groupAlive(worker)) return true;
  return supervisor === null && worker === null && young(job.updated_at);
}

/** Caller holds the global lock. Never overwrite another job's reservation. */
export function updateInspectReservation(store: JobStore, jobId: string, supervisorPid: number, workerPgid: number | null): void {
  const lease = readLease(store);
  if (lease?.job_id === jobId) writeLease(store, { ...lease, supervisor_pid: supervisorPid, worker_pgid: workerPgid });
}

/** Read-only fast path: ordinary scheduling does not scan jobs without a lease. */
export function inspectReservationJobId(store: JobStore): string | null {
  const lease = readLease(store);
  if (!lease) return null;
  try {
    const job = store.read(lease.job_id);
    return job.kind === 'inspect' && !isTerminal(job.state) ? job.job_id : null;
  } catch { return null; }
}

function leaseLive(store: JobStore, lease: InspectLease): boolean {
  try { return jobLive(store, store.read(lease.job_id), lease); }
  catch {
    if (lease.supervisor_pid !== null && isProcessAlive(lease.supervisor_pid)) return true;
    if (lease.worker_pgid !== null && groupAlive(lease.worker_pgid)) return true;
    return lease.supervisor_pid === null && lease.worker_pgid === null && young(lease.started_at);
  }
}

/** Zero-cost legacy capacity semantics when there is no inspect lease. Caller holds the global lock. */
export function activeInspectProvider(store: JobStore): Provider | null {
  if (!readLease(store)) return null;
  reclaimDeadInspectLease(store);
  const lease = readLease(store);
  return lease && leaseLive(store, lease) ? lease.provider : null;
}

export function assertStartInspectCapacity(store: JobStore, provider: Provider): void {
  if (activeInspectProvider(store) === null) return;
  const parallel = inspectParallel(store), occupancy = workerOccupancy(store);
  if (occupancy.total >= parallel.max_workers || occupancy.byProvider[provider] >= (parallel.provider_limits[provider] ?? parallel.max_workers)) {
    throw new GbdevError('busy', 'Provider capacity is full', { reason: 'provider_capacity' });
  }
}

function failInspectJob(store: JobStore, job: JobStatus): void {
  if (isTerminal(job.state)) return;
  const paths = jobPaths(store.paths, job.job_id);
  atomicWriteJson(paths.result, {
    schema: 'gbdev.job-result.v1', job_id: job.job_id, state: 'failed', session_id: job.session_id ?? null,
    worker_exit_code: null, duration_s: 0, worker_reported: null, worker_result_warnings: [],
    failure_reason: 'worker_crashed', failure_reasons: ['worker_crashed'], inspection: null,
    gbdev_observed: { head_before: job.base_sha, head_after: job.base_sha, commits: [], files_changed: [],
      outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null, checks: [], policy_violations: [] },
    paths: { final_message: paths.finalMessage, diff: paths.diff, events: paths.events, worker_log: paths.workerLog },
  });
  transition(store, job, 'failed', 'gbdev', 'worker_crashed', ['worker_crashed']);
}

/** Drop a lease only after the recorded supervisor and worker group are both gone. */
export function reclaimDeadInspectLease(store: JobStore, exceptJobId?: string): void {
  const lease = readLease(store);
  if (lease && lease.job_id !== exceptJobId) {
    let job: JobStatus | undefined;
    try { job = store.read(lease.job_id); } catch { job = undefined; }
    const live = leaseLive(store, lease);
    if (!live) {
      if (job) failInspectJob(store, job);
      releaseInspectReservation(store, lease.job_id);
    }
  }
  for (const job of allJobs(store)) {
    if (job.kind !== 'inspect' || job.job_id === exceptJobId || isTerminal(job.state) || jobLive(store, job, lease?.job_id === job.job_id ? lease : null)) continue;
    failInspectJob(store, job);
    releaseInspectReservation(store, job.job_id);
  }
}

export function releaseInspectReservation(store: JobStore, jobId: string): void {
  const lease = readLease(store);
  if (!lease || lease.job_id !== jobId) return;
  try { unlinkSync(inspectLeasePath(store.paths)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function inspectParallel(store: JobStore): ParallelConfig {
  const fields = readRunConfigFields(store.paths.config);
  return validateParallel(fields.parallel);
}

export function workerOccupancy(store: JobStore): { total: number; byProvider: Record<Provider, number> } {
  const jobs = allJobs(store).filter(job => job.kind !== 'inspect' && !isTerminal(job.state));
  const byProvider: Record<Provider, number> = { codex: 0, cursor: 0, fake: 0 };
  for (const job of jobs) byProvider[job.provider] += 1;
  let total = jobs.length;
  let runs;
  try { runs = allRuns(store).filter(run => activeRun(run.state)); }
  catch { throw new GbdevError('busy', 'Cannot read worker reservations', { reason: 'provider_capacity' }); }
  for (const run of runs) {
    const pipelines = new Set(run.tasks.flatMap(task => task.attempts.map(attempt => attempt.pipeline_id)));
    const owned = jobs.filter(job => job.run_id === run.run_id || pipelines.has(job.pipeline_id ?? '') || job.branch === run.integration.branch);
    total += Math.max(0, run.slots.in_use - owned.length);
    for (const provider of ['codex', 'cursor', 'fake'] as const) {
      byProvider[provider] += Math.max(0, (run.slots.by_provider[provider] ?? 0) - owned.filter(job => job.provider === provider).length);
    }
  }
  const lease = readLease(store);
  if (lease) {
    if (leaseLive(store, lease)) {
      total += 1;
      if (lease.provider in byProvider) byProvider[lease.provider] += 1;
    }
  }
  return { total, byProvider };
}

function providerCooling(store: JobStore, provider: Provider): boolean {
  try {
    return allRuns(store).some(run => {
      if (!activeRun(run.state)) return false;
      const until = run.slots.cooldown_until[provider];
      return typeof until === 'string' && Date.parse(until) > Date.now();
    });
  } catch { return false; }
}

/** Caller holds the global lock. One inspect per home, counted against provider capacity. */
export function acquireInspectAdmission(store: JobStore, provider: Provider, jobId: string): void {
  reclaimDeadInspectLease(store, jobId);
  const lease = readLease(store);
  if (lease && lease.job_id !== jobId) {
    if (leaseLive(store, lease)) {
      throw new GbdevError('busy', 'An inspect job is active', { running_job_id: lease.job_id });
    }
  }
  const active = allJobs(store).find(job => job.kind === 'inspect' && job.job_id !== jobId && jobLive(store, job));
  if (active) throw new GbdevError('busy', 'An inspect job is active', { running_job_id: active.job_id });
  if (providerCooling(store, provider)) throw new GbdevError('busy', 'Provider is cooling down', { reason: 'provider_cooldown' });
  const parallel = inspectParallel(store);
  const occupancy = workerOccupancy(store);
  const limit = parallel.provider_limits[provider] ?? parallel.max_workers;
  if (occupancy.total >= parallel.max_workers || occupancy.byProvider[provider] >= limit) {
    throw new GbdevError('busy', 'Provider capacity is full', { reason: 'provider_capacity' });
  }
  writeLease(store, { job_id: jobId, provider, supervisor_pid: null, worker_pgid: null, started_at: new Date().toISOString() });
}
