import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, RunTask, RunAttention } from '../contracts/run.js';
import type { JobResult } from '../contracts/jobResult.js';
import type { RunRequest } from '../contracts/runRequest.js';
import { validateTaskGraph, taskGraphSchema, type GraphTask, type TaskGraph } from '../contracts/taskGraph.js';
import type { RoleSnapshot } from '../contracts/pipelineRequest.js';
import type { PipelineSlotHooks } from '../pipeline/supervisor.js';
import { PipelineRegistry } from '../pipeline/definitions.js';
import { JobStore, atomicWriteJson } from '../core/jobStore.js';
import { runJob } from './jobs.js';
import { runPaths, runEvent, transitionRun } from './store.js';
import { requireDecision, BudgetExhausted, type RunRuntime } from './decisions.js';
import { providerOutputSchema } from '../providers/outputSchema.js';
export function newTask(task: GraphTask): RunTask {
  return { task_id: task.id, state: 'pending', lane: null, branch: null, depends_on: task.depends_on, attempts: [], head_sha: null, base_sha: null, merge_seq: [], merged_sha: null, integration_fixes: 0, scope_exceeded: [], decision_id: null };
}
/** Non-planning failures have their own bounded retry budget. */
export function plannerTransientFailure(result: JobResult): string | null {
  if (result.state !== 'failed') return null;
  const reasons = result.failure_reasons ?? [];
  if (result.gbdev_observed.policy_violations.length || result.gbdev_observed.policy_assessment?.fatal.length
    || reasons.includes('workspace_snapshot_invalid') || result.failure_reason === 'workspace_snapshot_invalid') return null;
  const reason = result.failure_reason ?? '';
  if (['launch_failed', 'rate_limit', 'provider_cooldown'].includes(reason)) return reason;
  if (result.worker_reported) return null;
  if (reason.startsWith('provider_error:')) return 'provider_failure';
  const durationMs = result.last_worker_duration_ms ?? result.duration_s * 1000;
  if (result.worker_exit_code !== null && result.worker_exit_code !== 0 && durationMs < 60_000) return 'quick_exit';
  return null;
}

export async function planRun(store: JobStore, run: Run, request: RunRequest, snapshot: RoleSnapshot, hooks: PipelineSlotHooks, signal: AbortSignal, runtime: RunRuntime, publish: (fn?: () => void) => Promise<void>): Promise<void> {
  const dir = join(runPaths(store, run.run_id).dir, 'plans'); mkdirSync(dir, { recursive: true });
  let errors: string[] = [];
  let questions: RunAttention['pending_questions'] = [];
  let needsInput = false;
  let policyDetail = '';
  const role = Object.values(snapshot.steps)[0]!;
  for (let substantive = 0; substantive < 2 && (run.plan.plan_attempts < 3 || runtime.plan_answer_pending);) {
    if (signal.aborted) return;
    if (run.budget.jobs_used >= run.budget.max_total_jobs) throw new BudgetExhausted();
    const attempt = (runtime.plan_sequence ?? run.plan.plan_attempts) + 1;
    const response = await runJob(store, run, request, snapshot, hooks, signal, { instance: `run:planner#${attempt}`, note: runtime.plan_note ?? null, prompt: JSON.stringify({ goal: request.goal, context: request.context, constraints: request.constraints, allowed_paths: request.allowed_paths, checks: request.checks.map(c => ({ id: c.id })), acceptance_criteria: request.acceptance_criteria, max_tasks: request.max_tasks, schema: providerOutputSchema(taskGraphSchema), validation_errors: errors, ...(runtime.plan_answers?.length ? { plan_answers: runtime.plan_answers } : {}) }) });
    if (signal.aborted) return;
    const transient = plannerTransientFailure(response.result);
    const report = response.result.worker_reported;
    const policyWarnings = response.result.gbdev_observed.policy_assessment?.warnings ?? [];
    policyDetail = policyWarnings.length ? `\nPolicy warnings: ${JSON.stringify(policyWarnings)}` : '';
    needsInput = response.result.state === 'needs_input';
    questions = report?.open_questions ?? [];
    const summary = report?.summary.replace(/\s+/g, ' ').trim().slice(0, 300);
    const failureDetail = `Planner ${response.result.state}${response.result.failure_reason ? ` (${response.result.failure_reason})` : ''}${summary ? `: ${summary}` : ''}`;
    let graph: TaskGraph | undefined;
    try {
      if (response.result.state !== 'succeeded' && !needsInput) throw new Error(failureDetail);
      graph = validateTaskGraph(report?.task_graph, { ...request, registry: new PipelineRegistry(store.paths.config) });
      errors = [];
    } catch (e) { errors = [needsInput ? `Error: ${failureDetail}` : String(e)]; }
    // Persist the artifact before publishing any sequence/answer consumption.
    // A crash before publish leaves the pending answer available on re-entry.
    atomicWriteJson(join(dir, `plan-${attempt}.json`), { job_id: response.job_id, task_graph: graph ?? report?.task_graph ?? null, errors });
    const answerActions = needsInput && questions.length ? ['answer' as const] : [];
    const transientExhausted = !!transient && (runtime.plan_transient_retries?.[transient] ?? 0) >= 3;
    let terminal = false;
    await publish(() => {
      runtime.plan_sequence = attempt;
      if (!transient) {
        if (!runtime.plan_answer_pending) run.plan.plan_attempts++;
        runtime.plan_answer_pending = false;
        substantive++;
      }
      if (graph) {
        runEvent(store, run, 'plan_ready', { attempt, path: join(dir, `plan-${attempt}.json`) });
        requireDecision(store, run, null, 'plan_review', graph.summary + policyDetail, ['approve_plan', ...(run.plan.plan_attempts < 3 ? ['replan' as const] : []), ...answerActions], questions, { plan_path: `plans/plan-${attempt}.json`, job_id: response.job_id });
        transitionRun(store, run, 'plan_review');
        terminal = true;
      } else {
        runEvent(store, run, 'plan_invalid', { attempt, errors });
        if (transientExhausted || !transient && (needsInput || substantive >= 2 || run.plan.plan_attempts >= 3)) {
          if (transientExhausted) runtime.plan_answer_pending = false;
          requireDecision(store, run, null, 'plan_invalid', errors.join('\n') + policyDetail, [...(run.plan.plan_attempts < 3 ? ['replan' as const] : []), 'approve_plan', ...answerActions], questions, { plan_path: `plans/plan-${attempt}.json`, job_id: response.job_id });
          transitionRun(store, run, 'needs_decision');
          terminal = true;
        }
      }
    });
    if (terminal) return;
    if (transient) {
      const used = runtime.plan_transient_retries?.[transient] ?? 0;
      await publish(() => { (runtime.plan_transient_retries ??= {})[transient] = used + 1; });
      // runJob already schedules rate-limit cooldown; other transient classes use
      // the same provider slot cooldown so budget/cancellation remain centralized.
      if (transient !== 'rate_limit') await hooks.onRateLimit(role.provider);
      continue;
    }
    if (needsInput) break;
  }
  await publish(() => { requireDecision(store, run, null, 'plan_invalid', errors.join('\n') + policyDetail, [...(run.plan.plan_attempts < 3 ? ['replan' as const] : []), 'approve_plan', ...(needsInput && questions.length ? ['answer' as const] : [])], questions); transitionRun(store, run, 'needs_decision'); });
}
