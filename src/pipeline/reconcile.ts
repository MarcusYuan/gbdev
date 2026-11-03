import { activeRun } from '../contracts/pipelineRun.js';
import { isTerminal } from '../contracts/jobStatus.js';
import { JobStore } from '../core/jobStore.js';
import { isProcessAlive } from '../core/lock.js';
import { locked } from '../core/runtime.js';
import { reconcile } from '../commands/status.js';
import { allJobs } from '../core/runtime.js';
import { allRuns, readRun, transitionRun } from './store.js';
export async function reconcilePipeline(store: JobStore, id: string) {
  let run = await locked(store, () => readRun(store, id));
  if (!activeRun(run.state)) return run;
  if (run.supervisor_pid && isProcessAlive(run.supervisor_pid)) {
    if (run.current) { const job = store.read(run.current.job_id); run.current.job_state = job.state; run.steps.find(s => s.instance === run.current!.instance)!.attempts.at(-1)!.job_state = job.state; }
    return run;
  }
  // M1 reconcile owns process-group cleanup, metadata recovery and job finalization.
  for (const job of allJobs(store)) if (job.pipeline_id === id && !isTerminal(job.state)) await reconcile(store, job.job_id);
  return locked(store, () => {
    run = readRun(store, id);
    if (!activeRun(run.state) || (run.supervisor_pid && isProcessAlive(run.supervisor_pid))) return run;
    // Recover a job created just before a crash interrupted run ownership publication.
    for (const job of allJobs(store).filter(j => j.pipeline_id === id)) {
      const step = run.steps.find(s => s.instance === job.step_instance);
      if (step && !step.attempts.some(a => a.job_id === job.job_id)) {
        step.attempts.push({ attempt: job.attempt ?? 1, job_id: job.job_id, job_state: job.state, failure_reason: job.failure_reason ?? null });
        step.state = 'failed'; run.jobs_used++; run.current = { instance: step.instance, job_id: job.job_id, job_state: job.state, attempt: job.attempt ?? 1 };
      }
    }
    if (run.current) {
      const job = store.read(run.current.job_id), step = run.steps.find(s => s.instance === run.current!.instance)!;
      run.current.job_state = job.state; step.state = 'failed'; step.finished_at = job.updated_at;
      const attempt = step.attempts.at(-1)!; attempt.job_state = job.state; attempt.failure_reason = job.failure_reason ?? null;
    }
    transitionRun(store, run, 'failed', 'pipeline_supervisor_crashed'); return run;
  });
}
export async function reconcileAll(store: JobStore): Promise<void> {
  // Inventory under the lock: another start may be between mkdir and atomic JSON publication.
  const runs = await locked(store, () => allRuns(store));
  for (const run of runs) if (activeRun(run.state)) {
    try { await reconcilePipeline(store, run.pipeline_id); } catch { /* Isolate damaged runs; their active state still reserves the slot. */ }
  }
  const jobs = await locked(store, () => allJobs(store));
  for (const job of jobs) if (!job.pipeline_id && !isTerminal(job.state)) await reconcile(store, job.job_id);
}
