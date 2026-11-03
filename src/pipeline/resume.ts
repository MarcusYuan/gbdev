import { join } from 'node:path';
import type { PipelineRun } from '../contracts/pipelineRun.js';
import { validatePipelineResume } from '../contracts/pipelineResume.js';
import { GbdevError } from '../contracts/error.js';
import { assertPipelineVerdictAccept, type VerdictAcceptEvidence } from '../core/verdictAcceptance.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { localIso } from '../core/time.js';
import { insertFix, readDefinition } from './fixLoop.js';
import { pipelineEvent, pipelinePaths, stepResult, transitionRun } from './store.js';
/** Validate and prepare in memory. No writes until apply: batch resume can reject atomically. Caller owns global lock. */
export function preparePipelineResume(store: JobStore, original: PipelineRun, value: unknown, decisionId?: string): { run: PipelineRun; apply: () => void; acceptance: VerdictAcceptEvidence | null } {
  const run = structuredClone(original), id = run.pipeline_id, input = validatePipelineResume(value, id), paths = pipelinePaths(store, id);
  const conflict = (reason: string): never => { throw new GbdevError('pipeline_state_conflict', reason, { reason }); };
  const allowed = run.state === 'needs_input' ? ['answer'] : run.state === 'blocked' ? ['retry'] : run.state === 'needs_decision' ? run.decision?.allowed_actions ?? [] : [];
  if (!allowed.includes(input.action)) conflict('action_not_allowed');
  const step = run.steps.find(s => s.instance === run.decision?.instance); if (!step) return conflict('instance_missing');
  // B7: re-verify latest job failure — stale allowed_actions must not permit accept on launch/prompt fail.
  if (input.action === 'accept' && step.attempts.length) {
    try {
      const latest = stepResult(store, step.attempts.at(-1)!.job_id);
      if (latest.failure_reason === 'launch_failed') {
        throw new GbdevError('pipeline_state_conflict', 'Cannot accept after launch_failed', { reason: 'launch_failed_not_acceptable' });
      }
      if (latest.failure_reason === 'prompt_too_large') {
        throw new GbdevError('pipeline_state_conflict', 'Cannot accept after prompt_too_large', { reason: 'prompt_too_large_not_acceptable' });
      }
    } catch (error) {
      if (error instanceof GbdevError) throw error;
    }
  }
  // Decision reason may already be launch_failed even if allowed_actions was stale.
  if (input.action === 'accept' && (run.decision?.reason === 'launch_failed' || run.decision?.reason === 'prompt_too_large' || run.state_reason === 'launch_failed' || run.state_reason === 'prompt_too_large')) {
    conflict(run.decision?.reason === 'prompt_too_large' || run.state_reason === 'prompt_too_large' ? 'prompt_too_large_not_acceptable' : 'launch_failed_not_acceptable');
  }
  if (input.action === 'answer') {
    const supplied = new Set(input.answers.map(a => a.question_id));
    const missing = run.pending_questions.filter(q => q.blocking && !supplied.has(q.id)).map(q => q.id);
    const unknown = input.answers.filter(a => !run.pending_questions.some(q => q.id === a.question_id)).map(a => a.question_id);
    if (!input.answers.length || missing.length || unknown.length) throw new GbdevError('config_invalid', 'Answers must cover blocking questions and only known questions', { missing_ids: missing, unknown_ids: unknown });
  }
  if (['answer', 'retry'].includes(input.action) && step.attempts.length >= 3) conflict('attempts_exhausted');
  if (input.action === 'extra_round' && (run.max_rounds >= 5 || !readDefinition(store, id).fix_loop)) conflict('extra_round_unavailable');
  const acceptance = assertPipelineVerdictAccept(store, original, { ...input, ...(decisionId ? { decision_id: decisionId } : {}) });
  const number = run.state_history.filter(h => h.by === 'grok-bot' && h.state === 'running').length + 1;
  const at = localIso(), decisions = input.action === 'answer' ? input.answers.map(a => ({ instance: step.instance, attempt: step.attempts.at(-1)!.attempt, question_id: a.question_id, question: run.pending_questions.find(q => q.id === a.question_id)!.question, answer: a.answer, at })) : [];
  let continuation: object | undefined;
  if (input.action === 'accept') run.outcome = 'accepted_by_decider';
  else if (input.action === 'extra_round') {
    run.max_rounds++; insertFix(store, run, step);
    const fix = run.steps[run.steps.indexOf(step) + 1]!;
    continuation = { instance: fix.instance, attempt: 1, answers: [], note: input.note };
  }
  else { step.state = 'pending'; continuation = { instance: step.instance, attempt: step.attempts.length + 1, answers: input.answers, note: input.note }; }
  run.decisions = [...(run.decisions ?? []), ...decisions]; run.decision = null; run.pending_questions = []; run.supervisor_pid = null;
  return { run, acceptance, apply() {
    atomicWriteJson(join(paths.dir, 'inputs', `${String(number).padStart(2, '0')}-resume.json`), input);
    if (continuation) atomicWriteJson(join(paths.dir, 'continuation.json'), continuation);
    transitionRun(store, run, input.action === 'accept' ? 'succeeded' : 'running', input.note, 'grok-bot');
    for (const decision of decisions) pipelineEvent(store, run, 'decider_decision', { ...decision });
    if (acceptance) pipelineEvent(store, run, 'verdict_missing_accepted', { by: 'grok-bot', instance: acceptance.instance, job_ids: acceptance.job_ids, note: acceptance.note, verdict_missing_reviewed: true, at });
  } };
}
