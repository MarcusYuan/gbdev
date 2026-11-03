import { isTerminal, type JobStatus } from '../contracts/jobStatus.js';
import { failureResult } from '../core/finalize.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { isProcessAlive } from '../core/lock.js';
import { jobPaths } from '../core/paths.js';
import { terminateGroup } from '../core/proc.js';
import { event, locked, optionalText, transition } from '../core/runtime.js';
import { inspectReservationJobId, releaseInspectReservation } from '../core/workerReservations.js';

/** Recover orphaned inspect groups before attempting another real worker admission. */
export function reconcileInspectReservation(store: JobStore): Promise<JobStatus> | undefined {
  const id = inspectReservationJobId(store);
  return id ? reconcile(store, id) : undefined;
}

export async function reconcile(store: JobStore, jobId: string): Promise<JobStatus> {
  return locked(store, async () => {
    const status = store.read(jobId);
    const recorded = status.kind === 'inspect' ? JSON.parse(optionalText(jobPaths(store.paths, jobId).processInfo) ?? '{}') as { supervisor_pid?: number } : null;
    const supervisor = recorded?.supervisor_pid ?? status.pid;
    if (!isTerminal(status.state) && (supervisor === null || !isProcessAlive(supervisor))) {
      const paths = jobPaths(store.paths, jobId);
      const info = optionalText(paths.processInfo);
      if (info) {
        const { worker_pgid, check_pgid } = JSON.parse(info) as { worker_pgid: number | null; check_pgid?: number | null };
        if (worker_pgid !== null) await terminateGroup(worker_pgid);
        if (check_pgid) await terminateGroup(check_pgid);
      }
      // Recover legacy events metadata before appending (the last line may lack a newline).
      const result = failureResult(store, status, null);
      event(store, status, 'warning', { code: 'worker_crashed', message: 'Supervisor process no longer exists' });
      atomicWriteJson(paths.result, result);
      transition(store, status, 'failed', 'gbdev', result.failure_reason, result.failure_reasons);
      if (status.kind === 'inspect') releaseInspectReservation(store, jobId);
    }
    return status;
  });
}

export async function status(store: JobStore, jobId?: string): Promise<JobStatus | JobStatus[]> {
  if (jobId) return reconcile(store, jobId);
  const jobs: JobStatus[] = [];
  for (const job of store.list()) jobs.push(await reconcile(store, job.job_id));
  return jobs;
}
