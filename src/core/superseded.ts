import type { JobStatus } from '../contracts/jobStatus.js';
import { terminalRun as terminalPipeline, type PipelineRun } from '../contracts/pipelineRun.js';
import type { Run } from '../contracts/run.js';
import { readRun as readPipeline } from '../pipeline/store.js';
import { readRun, terminalRun } from '../run/store.js';
import type { JobStore } from './jobStore.js';
import { JOB_ID_PATTERN } from './ids.js';

const SUPERSEDED_STATES = ['needs_input', 'blocked', 'failed', 'timeout', 'cancelled'];

/** Display-only ownership projection. Successful/reviewed/integrated facts stay visible. */
export function supersededBy(job: JobStatus, pipeline: PipelineRun | null, run: Run | null): string | null {
  if (!SUPERSEDED_STATES.includes(job.state)) return null;
  if (pipeline && pipeline.pipeline_id === job.pipeline_id) {
    const step = pipeline.steps.find(s => s.instance === job.step_instance);
    // (a) Corrupt attempts invalidate only the later-attempt evidence, not parent state.
    if (step && !step.attempts.some(a => !a || !Number.isSafeInteger(a.attempt) || a.attempt < 1 || typeof a.job_id !== 'string' || !JOB_ID_PATTERN.test(a.job_id))) {
      const index = step.attempts.findIndex(a => a.job_id === job.job_id);
      const attempt = index >= 0 ? step.attempts[index]!.attempt : job.attempt;
      const later = step.attempts.filter((a, i) => a.job_id !== job.job_id &&
        ((index >= 0 && i > index) || (attempt != null && a.attempt > attempt))).at(-1);
      if (later) return later.job_id;
    }
    // (b) Either terminal parent is enough, independently of attempt integrity.
    if (terminalPipeline(pipeline.state)) return `pipeline ${pipeline.pipeline_id} (${pipeline.state})`;
  }
  // A terminal owning run supersedes even a nonterminal pipeline (e.g. a cancel race).
  // Prefer the parent's completed ownership over stale child state; never rewrite facts.
  const runId = job.run_id ?? (pipeline?.workspace.mode === 'per_lane' ? pipeline.workspace.run_id : null);
  if (run && run.run_id === runId && terminalRun(run.state)) return `run ${run.run_id} (${run.state})`;
  return null;
}

/** Best-effort snapshot reads only; absent/corrupt parents never imply completion. */
export function readSupersededBy(store: JobStore, job: JobStatus): string | null {
  if (!SUPERSEDED_STATES.includes(job.state)) return null;
  let pipeline: PipelineRun | null = null, run: Run | null = null;
  if (job.pipeline_id) {
    try { pipeline = readPipeline(store, job.pipeline_id); } catch { return null; }
  }
  const runId = job.run_id ?? (pipeline?.workspace.mode === 'per_lane' ? pipeline.workspace.run_id : null);
  if (runId) try { run = readRun(store, runId); } catch { /* Unknown parent, not terminal evidence. */ }
  try { return supersededBy(job, pipeline, run); } catch { return null; }
}
