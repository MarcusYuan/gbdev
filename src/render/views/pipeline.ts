import type { PipelineRun } from '../../contracts/pipelineRun.js';
import { LAUNCH_FAILED_STATUS_HINT, PROMPT_TOO_LARGE_STATUS_HINT, VERDICT_MISSING_STATUS_HINT } from '../../core/verdictAcceptance.js';
import { str } from '../format.js';
import { elapsed, launchRetryRows, ViewFiles, textRow, type ViewOptions } from './common.js';
export function pipelineStatus(p: PipelineRun, now: number, options: ViewOptions = {}, files?: ViewFiles): string[] {
  const rows = [`pipeline ${p.pipeline_id} ${p.state} ${elapsed(p.created_at, now)} jobs ${p.jobs_used}/${p.max_total_jobs}`, `current ${p.current?.instance ?? '-'} ${p.current?.job_id ?? '-'} round ${p.round}/${p.max_rounds}`, 'STEP          STATE         PROVIDER   ATTEMPTS  GATE'];
  for (const step of p.steps) rows.push(`${step.instance.padEnd(13)} ${step.state.padEnd(13)} ${step.provider.padEnd(10)} ${step.attempts.length}  ${step.gate ?? '-'} ${step.verdict ?? ''}`);
  if (files && p.current?.job_id) rows.push(...launchRetryRows(files, p.current.job_id, now));
  if (p.decision) {
    rows.push(`ATTENTION ${p.decision.reason} actions: ${p.decision.allowed_actions.join(', ')}`, `  ${p.decision.detail}`);
    if (p.decision.reason === 'launch_failed') rows.push(`  ${LAUNCH_FAILED_STATUS_HINT}`, `  recommended: ${p.decision.allowed_actions.includes('retry') ? 'retry' : 'null'}`);
    if (p.decision.reason === 'prompt_too_large') rows.push(`  ${PROMPT_TOO_LARGE_STATUS_HINT}`, `  recommended: ${p.decision.allowed_actions.includes('retry') ? 'retry' : 'null'}`);
    if (p.decision.accept_requirements?.length) {
      rows.push(`  ${VERDICT_MISSING_STATUS_HINT}`);
      if (p.decision.recommended_action) rows.push(`  recommended: ${p.decision.recommended_action}`);
      rows.push(`  accept_requirements: ${p.decision.accept_requirements.join(', ')}`);
    }
  }
  for (const q of p.pending_questions) rows.push(`QUESTION ${q.id} ${q.question} options: ${q.options.join(', ')}`);
  rows.push(`BUDGET jobs ${p.jobs_used}/${p.max_total_jobs} deadline ${p.deadline_at}${(p.paused_ms ?? 0) > 0 ? ` paused ${Math.floor(p.paused_ms! / 60_000)}m` : ''}`, `workspace ${p.workspace.branch} @${p.head_sha}`);
  if (p.failure_reason) rows.push(`failure ${str(p.failure_reason)}`);
  return rows.map(row => textRow(row, options.columns));
}
