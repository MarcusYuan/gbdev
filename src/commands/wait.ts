import { setTimeout as delay } from 'node:timers/promises';
import { GbdevError } from '../contracts/error.js';
import { isTerminal, type JobStatus } from '../contracts/jobStatus.js';
import { JobStore } from '../core/jobStore.js';
import { reconcile } from './status.js';

export async function wait(store: JobStore, jobId: string, timeoutMs: number): Promise<JobStatus> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const status = await reconcile(store, jobId);
    if (isTerminal(status.state)) return status;
    const remaining = until - Date.now();
    if (remaining <= 0) throw new GbdevError('wait_timeout', 'Timed out waiting; job is still active', { job_id: jobId });
    await delay(Math.min(500, remaining));
  }
}
