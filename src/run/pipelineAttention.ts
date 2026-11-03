import type { PipelineRun } from '../contracts/pipelineRun.js';
import type { JobStore } from '../core/jobStore.js';
import { safeDecisionText, type DecisionSummaryInput } from '../core/decisionSummary.js';
import { stepResult } from '../pipeline/store.js';

/** Read only owned pipeline/job evidence. Missing legacy artifacts retain decision evidence. */
export function pipelineAttention(store: JobStore, pipeline: PipelineRun): Pick<DecisionSummaryInput, 'detail' | 'instance' | 'job_id' | 'environment' | 'reviewer_verdict'> & { cause: string } {
  const decision = pipeline.decision;
  const step = pipeline.steps.find(s => s.instance === decision?.instance) ?? pipeline.steps.find(s => s.instance === pipeline.current?.instance) ?? pipeline.steps.at(-1);
  const attempt = step?.attempts.at(-1);
  let failure = attempt?.failure_reason ?? '', environment = false, reviewer_verdict: string | undefined;
  let blockers = '';
  if (attempt) {
    try {
      const result = stepResult(store, attempt.job_id);
      failure = result.failure_reason ?? failure;
      environment = result.worker_reported?.blockers.some(b => b.kind === 'env') ?? false;
      blockers = result.worker_reported?.blockers.map(b => b.detail).join('; ') ?? '';
      if (step?.role === 'reviewer') reviewer_verdict = result.worker_reported?.review?.verdict;
    } catch { /* Legacy/missing job result: use the persisted attempt and decision. */ }
  }
  const cause = [decision?.detail, failure, blockers].filter(Boolean).map(v => safeDecisionText(v!, 1200));
  const detail = [pipeline.pipeline_id, decision?.instance ?? step?.instance, attempt?.job_id, decision?.reason ?? pipeline.state_reason ?? pipeline.failure_reason, ...new Set(cause)].filter(Boolean).join('; ');
  environment ||= /operation not permitted|\bEPERM\b|sandbox.{0,30}(deni|restrict)|permission denied|沙箱|权限拒绝/i.test(detail);
  return { cause: safeDecisionText(failure || decision?.detail || blockers || pipeline.state_reason || '', 1200), detail: safeDecisionText(detail, 4000), instance: decision?.instance ?? step?.instance, job_id: attempt?.job_id, environment, ...(reviewer_verdict ? { reviewer_verdict } : {}) };
}
