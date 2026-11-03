import { isTerminal, type JobStatus } from '../contracts/jobStatus.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { locked } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { reconcile } from './status.js';
import { wait } from './wait.js';

export async function cancel(store: JobStore, jobId: string): Promise<JobStatus> {
  const current = await reconcile(store, jobId);
  if (isTerminal(current.state)) return current;
  await locked(store, () => {
    const status = store.read(jobId);
    if (isTerminal(status.state)) return;
    atomicWriteJson(jobPaths(store.paths, jobId).cancelRequest, { at: localIso(), by: 'grok-bot' });
    // During starting the PID may still belong to caffeinate, or Node may not have
    // installed signal handlers yet. The durable request is consumed on startup.
    if (status.pid && status.state === 'running') {
      try { process.kill(status.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  });
  return wait(store, jobId, 11 * 60_000);
}
