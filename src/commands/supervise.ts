import { type JobStore } from '../core/jobStore.js';
import { superviseJob } from '../core/supervise.js';

/** Internal CLI adapter; all lifecycle behavior lives in the reusable supervisor. */
export async function supervise(store: JobStore, jobId: string): Promise<void> {
  await superviseJob(jobId, store);
}
