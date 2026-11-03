import { notifyEvent } from '../notify/enqueue.js';
import { dashboardEvent } from '../dashboard/trigger.js';
import { closeSync, fstatSync, openSync, readSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { GbdevError } from '../contracts/error.js';
import { type JobEvent } from '../contracts/event.js';
import { type JobState, type JobStatus } from '../contracts/jobStatus.js';
import { JOB_ID_PATTERN } from './ids.js';
import { JobStore } from './jobStore.js';
import { acquireLock } from './lock.js';
import { jobPaths } from './paths.js';
import { basename } from 'node:path';
import { localIso } from './time.js';

/** Serialize mutations. Only initial start setup may perform subprocess work here. */
export async function locked<T>(store: JobStore, operation: () => T | Promise<T>): Promise<T> {
  const until = Date.now() + 10_000;
  for (;;) {
    let lock;
    try { lock = acquireLock(store.paths.lock); }
    catch (error) {
      if (!(error instanceof GbdevError) || error.contract.code !== 'busy' || Date.now() >= until) throw error;
      await delay(20);
      continue;
    }
    try {
      const result = operation();
      // Do not retain a synchronous transaction's lock across unrelated microtasks.
      if (result && typeof (result as { then?: unknown }).then === 'function') return await result;
      return result;
    } finally { lock.release(); }
  }
}

/** Unlike status listing, concurrency checks must not truncate at 50 jobs. */
export function allJobs(store: JobStore): JobStatus[] {
  try {
    return readdirSync(store.paths.jobs, { withFileTypes: true })
      .filter(item => item.isDirectory() && JOB_ID_PATTERN.test(item.name)).map(item => store.read(item.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Called while holding the global lock so event sequence and status stay ordered. */
export function event(store: JobStore, status: JobStatus, type: JobEvent['type'], data: Record<string, unknown>, source: JobEvent['source'] = 'gbdev'): void {
  const at = localIso();
  const seq = (status.last_event?.seq ?? 0) + 1;
  const fd = openSync(jobPaths(store.paths, status.job_id).events, 'a+', 0o600);
  try {
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    if (size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) writeSync(fd, '\n');
    writeSync(fd, `${JSON.stringify({ schema: 'gbdev.event.v1', job_id: status.job_id, ...(status.branch.match(/^gbdev\/(r_\d{8}_\d{4}_[a-f0-9]{4})\//) ? { run_id: status.branch.split('/')[1]!, ...(status.task_id || status.branch.includes('/t/') ? { task_id: status.task_id ?? status.branch.split('/')[3]!.replace(/-r[0-9]+$/, '') } : {}), ...(/^lane-[1-4]$/.test(basename(status.worktree)) ? { lane: basename(status.worktree) } : {}) } : {}), seq, at, source, type, data } satisfies JobEvent)}\n`);
  } finally { closeSync(fd); }
  status.last_event = { seq, type, at };
  status.updated_at = at;
  store.write(status);
  dashboardEvent(store.paths.home, type, data);
  notifyEvent(store, { kind: 'job', id: status.job_id, state: status.state, pipeline_id: status.pipeline_id ?? null, run_id: status.run_id ?? status.branch.match(/^gbdev\/(r_\d{8}_\d{4}_[a-f0-9]{4})\//)?.[1] ?? (status.task_id ? 'owned' : null) }, type, data, seq, at, status);
}

export function transition(store: JobStore, status: JobStatus, state: JobState, by = 'gbdev', failureReason?: string | null, failureReasons: string[] = []): JobStatus {
  if (status.state !== state) {
    status.failure_reason = failureReason ?? (['failed', 'timeout', 'blocked'].includes(state) ? state === 'failed' ? 'worker_crashed' : state : null);
    status.failure_reasons = failureReasons;
    status.state = state;
    status.state_history.push({ state, at: localIso(), by });
    event(store, status, 'state_change', { state, by, failure_reason: status.failure_reason });
  }
  return status;
}

export function optionalText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
