import { decisionSummary, safeDecisionText, type DecisionSummaryInput } from '../core/decisionSummary.js';
import { pipelineAttention } from './pipelineAttention.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, RunAttention, RunTask } from '../contracts/run.js';
import type { RunRequest } from '../contracts/runRequest.js';
import { validateRunResume, type RunResume } from '../contracts/runResume.js';
import type { SeedFindings } from '../contracts/seedFindings.js';
import { GbdevError } from '../contracts/error.js';
import { JobStore, atomicWriteJson } from '../core/jobStore.js';
import { localIso } from '../core/time.js';
import { optionalText } from '../core/runtime.js';
import {
  assertFinalReviewVerdictAccept, isFinalReviewVerdictMissing, isPipelineVerdictMissingAccept,
  pipelineRetryAvailable, verdictMissingMeta, type VerdictAcceptEvidence,
} from '../core/verdictAcceptance.js';
import { preparePipelineResume } from '../pipeline/resume.js';
import { readRun as readPipeline, writeRun as writePipeline } from '../pipeline/store.js';
import { validateTaskGraph, type TaskGraph, type GraphTask } from '../contracts/taskGraph.js';
import { resolveRequest, type RoleSnapshot } from '../contracts/pipelineRequest.js';
import { loadConfig } from '../core/config.js';
import { PipelineRegistry } from '../pipeline/definitions.js';
import { pipelineValue } from './requests.js';
import { newTask } from './planner.js';
import { jsonFile, runEvent, runPaths, taskState, transitionRun } from './store.js';

export class BudgetExhausted extends Error { constructor() { super('run_budget_exhausted'); } }
export interface RunRuntime {
  final_fixes?: number;
  run_notes?: string[];
  task_notes?: Record<string, string | null>;
  plan_note?: string | null;
  plan_answers?: { questions: RunAttention['pending_questions']; answers: NonNullable<RunResume['answers']> }[];
  plan_answer_pending?: boolean;
  plan_sequence?: number;
  plan_transient_retries?: Record<string, number>;
  seeds: Record<string, SeedFindings>;
  modes: Record<string, { kind: 'retry' | 'rebuild' | 'resume'; pipeline_id?: string; note?: string | null }>;
  resolve_extra: Record<string, number>;
  fix_limits: Record<string, number>;
  generation: Record<string, number>;
  budget_waiting: string[];
}
export function readRuntime(store: JobStore, run: Run): RunRuntime {
  return JSON.parse(optionalText(join(runPaths(store, run.run_id).dir, 'runtime.json')) ?? '{"seeds":{},"modes":{},"resolve_extra":{},"fix_limits":{},"generation":{},"budget_waiting":[]}') as RunRuntime;
}
export function writeRuntime(store: JobStore, run: Run, runtime: RunRuntime): void { atomicWriteJson(join(runPaths(store, run.run_id).dir, 'runtime.json'), runtime); }
export function requireDecision(store: JobStore, run: Run, task: RunTask | null, reason: RunAttention['reason'], detail: string, allowed_actions: RunAttention['allowed_actions'], pending_questions: RunAttention['pending_questions'] = [], source: Pick<DecisionSummaryInput, 'plan_path' | 'job_id'> = {}): RunAttention {
  const runtime = readRuntime(store, run);
  allowed_actions = allowed_actions.filter(action => {
    if (action === 'extend_budget') return !run.budget.extended && run.budget.max_total_jobs < 120;
    if (action === 'accept_final') return run.tasks.every(t => ['integrated', 'dropped'].includes(t.state));
    if ((action === 'answer' || action === 'retry') && task?.attempts.length) {
      const pipeline = readPipeline(store, task.attempts.at(-1)!.pipeline_id);
      return (pipeline.steps.find(s => s.instance === pipeline.decision?.instance)?.attempts.length ?? 3) < 3;
    }
    if (action === 'answer' && !task) return (runtime.plan_answers?.length ?? 0) < 3;
    if (action === 'replan') return run.plan.plan_attempts < 3;
    if (action === 'add_fix_task') return (runtime.final_fixes ?? 0) < 2 && run.tasks.length < run.budget.max_tasks && !run.tasks.some(t => t.task_id === `final-fix-${(runtime.final_fixes ?? 0) + 1}`);
    if (action === 'retry_resolve') return !task || (runtime.resolve_extra[task.task_id] ?? 0) < 1;
    if (action === 'extra_fix') return !task || task.integration_fixes < 3;
    if (action === 'retry_task' || action === 'rebuild_task') return !task || task.attempts.filter(a => a.kind === 'retry' || a.kind === 'rebuild').length < 3;
    return true;
  });
  let evidence: Partial<DecisionSummaryInput> & { cause?: string } = { ...source };
  const pipelineId = task?.attempts.at(-1)?.pipeline_id;
  if (pipelineId && ['task_paused', 'task_failed', 'lane_broken'].includes(reason)) {
    try { evidence = pipelineAttention(store, readPipeline(store, pipelineId)); } catch { /* preserve caller detail */ }
  }
  detail = safeDecisionText([evidence.detail, detail].filter(Boolean).join('; '), 4000);
  const item: RunAttention = { decision_id: `d_${randomUUID()}`, scope: task ? 'task' : 'run', task_id: task?.task_id ?? null, reason, allowed_actions, detail, pipeline_id: task?.attempts.at(-1)?.pipeline_id ?? null, merge_seq: task?.merge_seq.at(-1) ?? null, pending_questions, created_at: localIso() };
  if (reason === 'final_review_revise' && isFinalReviewVerdictMissing(store, run)) {
    Object.assign(item, verdictMissingMeta({ retryAvailable: false, kind: 'final' }));
  } else if (reason === 'task_paused' && item.pipeline_id) {
    try {
      const pipeline = readPipeline(store, item.pipeline_id);
      if (isPipelineVerdictMissingAccept(store, pipeline)) {
        const step = pipeline.steps.find(s => s.instance === pipeline.decision?.instance);
        Object.assign(item, verdictMissingMeta({
          retryAvailable: pipelineRetryAvailable(step, item.allowed_actions),
          kind: 'pipeline',
        }));
      }
    } catch { /* damaged owned pipeline: leave attention without meta */ }
  }
  const planSequence = runtime.plan_sequence ?? run.plan.plan_attempts;
  const planPath = source.plan_path ?? (['plan_review', 'plan_invalid'].includes(reason) && planSequence > 0 ? `plans/plan-${planSequence}.json` : undefined);
  const evidencePath = planPath ?? (['final_review_revise', 'final_review_rejected', 'launch_failed', 'prompt_too_large'].includes(reason) && !task ? 'final-review.json' : undefined);
  if (evidencePath && !evidence.job_id) {
    try {
      const saved = jsonFile<{ job_id?: unknown }>(join(runPaths(store, run.run_id).dir, evidencePath));
      if (typeof saved.job_id === 'string') evidence.job_id = saved.job_id;
    } catch { /* No saved planner/final-review result yet. */ }
  }
  // Do not repeat identity in the short cause: pipeline evidence already projects it separately.
  const cause = evidence.cause || detail;
  item.summary = decisionSummary({ ...evidence, ...item, detail: cause, plan_path: planPath });
  run.attention.push(item); if (task) { task.decision_id = item.decision_id; taskState(store, run, task, 'needs_decision'); }
  appendFileSync(join(runPaths(store, run.run_id).dir, 'decisions.jsonl'), JSON.stringify({ type: 'created', ...item }) + '\n', { mode: 0o600 });
  runEvent(store, run, 'decision_required', { ...item }, task ?? undefined); return item;
}
const conflict = (reason: string): never => { throw new GbdevError('run_state_conflict', reason, { reason }); };
/** Pure validation/staging (including M2) before any decision in the batch is applied. */
export function prepareDecisions(store: JobStore, current: Run, request: RunRequest, value: unknown, runtime: RunRuntime) {
  if (current.attention.some(d => d.reason === 'integration_corrupt')) conflict('integration_corrupt');
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) throw new GbdevError('run_invalid', 'Empty answers batch');
  const run = structuredClone(current), next = structuredClone(runtime), effects: (() => void)[] = [], resolved: { input: RunResume; decision: RunAttention; acceptance?: VerdictAcceptEvidence | null }[] = [];
  const registry = new PipelineRegistry(store.paths.config), paths = runPaths(store, run.run_id);
  const graphContext = { ...request, registry };
  const install = (graph: TaskGraph) => {
    const execution = jsonFile<Record<string, ReturnType<typeof resolveRequest>>>(join(paths.dir, 'execution.snapshot.json'));
    const snapshots = jsonFile<Record<string, RoleSnapshot>>(paths.snapshot);
    for (const task of graph.tasks) if (!execution[`task:${task.id}`]) {
      const prepared = task.pipeline === 'final-fix' ? execution['internal:final-fix']! : resolveRequest(pipelineValue(request, task, registry), loadConfig(store.paths.config), registry, { internal: true });
      execution[`task:${task.id}`] = prepared; snapshots[`task:${task.id}`] = prepared.snapshot;
    }
    effects.push(() => { atomicWriteJson(join(paths.dir, 'task-graph.json'), graph); atomicWriteJson(join(paths.dir, 'execution.snapshot.json'), execution); atomicWriteJson(paths.snapshot, snapshots); request.tasks = graph.tasks; });
  };
  for (const v of values) {
    const input = validateRunResume(v, run, graphContext), decision = run.attention.find(d => d.decision_id === input.decision_id)!, task = run.tasks.find(t => t.task_id === input.task_id);
    let acceptance: VerdictAcceptEvidence | null = null;
    if (input.verdict_missing_reviewed === true && input.action !== 'accept' && input.action !== 'accept_final') {
      conflict('verdict_missing_reviewed_not_applicable');
    }
    // Notes live in trusted runtime context, not graph/history evidence or state_reason.
    if (input.note && ['approve_plan', 'extend_budget', 'resume_run', 'drop_task', 'accept'].includes(input.action)) (next.run_notes ??= []).push(input.note);
    if (task && ['retry_task', 'rebuild_task', 'retry_resolve', 'extra_fix'].includes(input.action)) (next.task_notes ??= {})[task.task_id] = input.note;
    switch (input.action) {
      case 'approve_plan': {
        const draft = input.task_graph ?? jsonFile<{ task_graph: unknown }>(join(paths.dir, 'plans', `plan-${next.plan_sequence ?? run.plan.plan_attempts}.json`)).task_graph;
        const graph = validateTaskGraph(draft, graphContext);
        install(graph); run.tasks = graph.tasks.map(newTask); run.plan.approved_at = localIso(); run.plan.approved_by = 'grok-bot'; break;
      }
      case 'replan':
        if (run.plan.plan_attempts >= 3) conflict('plan_attempts_exhausted');
        next.plan_note = input.note; break;
      case 'add_fix_task': {
        const count = next.final_fixes ?? 0;
        if (count >= 2) conflict('final_fixes_exhausted');
        if (run.tasks.some(t => t.task_id === `final-fix-${count + 1}`)) conflict('final_fix_id_conflict');
        if (run.tasks.length >= run.budget.max_tasks) conflict('max_tasks_exhausted');
        const final = jsonFile<{ findings: { id: string; severity: 'critical' | 'major' | 'minor' | 'nit'; file: string | null; line: number | null; message: string }[] }>(join(paths.dir, 'final-review.json'));
        const task: GraphTask = { id: `final-fix-${count + 1}`, title: 'Fix final review findings', goal: request.goal, context: '', depends_on: [], file_scope: request.allowed_paths, acceptance_criteria: request.acceptance_criteria.length ? request.acceptance_criteria : [{ id: 'AC1', text: 'Resolve final review findings', check: null }], pipeline: 'final-fix', size: 'S', notes: null };
        const graph = jsonFile<TaskGraph>(join(paths.dir, 'task-graph.json')); graph.tasks.push(task); install(graph); run.tasks.push(newTask(task));
        next.final_fixes = count + 1;
        (next.task_notes ??= {})[task.id] = input.note;
        next.seeds[task.id] = { source: 'final_review', findings: final.findings.map(f => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, text: f.message })), logs: [] }; break;
      }
      case 'extend_budget':
        if (run.budget.extended || run.budget.max_total_jobs >= 120) conflict('budget_extension_exhausted');
        run.budget.max_total_jobs += Math.min(30, 120 - run.budget.max_total_jobs); run.budget.extended = true;
        for (const id of next.budget_waiting) { const t = run.tasks.find(t => t.task_id === id)!; t.state = next.modes[id]?.kind === 'resume' ? 'ready' : 'merge_queued'; if (t.state === 'merge_queued' && !run.merge_queue.includes(id)) run.merge_queue.push(id); }
        next.budget_waiting = []; break;
      case 'accept_final':
        if (run.tasks.some(t => !['integrated', 'dropped'].includes(t.state))) conflict('tasks_not_integrated');
        acceptance = assertFinalReviewVerdictAccept(store, current, {
          action: input.action, note: input.note, decision_id: input.decision_id,
          ...(typeof input.verdict_missing_reviewed === 'boolean' ? { verdict_missing_reviewed: input.verdict_missing_reviewed } : {}),
        });
        run.outcome = 'accepted_by_decider'; break;
      case 'retry_task': case 'rebuild_task': {
        if (!task || task.state === 'integrated') conflict('task_not_retryable');
        if (task!.attempts.filter(a => a.kind === 'retry' || a.kind === 'rebuild').length >= 3) conflict('task_attempts_exhausted');
        delete next.resolve_extra[task!.task_id];
        next.modes[task!.task_id] = { kind: input.action === 'retry_task' ? 'retry' : 'rebuild', note: input.note }; if (next.seeds[task!.task_id]?.source !== 'final_review') delete next.seeds[task!.task_id];
        task!.state = 'ready'; task!.lane = null; break;
      }
      case 'retry_resolve':
        if (!task || (next.resolve_extra[task.task_id] ?? 0) >= 1) conflict('resolver_attempts_exhausted');
        next.resolve_extra[task!.task_id] = 1;
        if (task!.state_reason === 'refresh_conflict') task!.state = 'ready';
        else { task!.state = 'merge_queued'; task!.state_reason = null; run.merge_queue.push(task!.task_id); } break;
      case 'extra_fix':
        if (!task || task.integration_fixes >= 3) conflict('integration_fixes_exhausted');
        next.fix_limits[task!.task_id] = task!.integration_fixes + 1; task!.integration_fixes++; task!.state = 'ready';
        next.seeds[task!.task_id] ??= { source: 'integration_gate', findings: [{ id: 'C1', severity: 'major', file: null, line: null, text: decision.detail }], logs: [] }; break;
      case 'drop_task': {
        if (!task || task.state === 'integrated') conflict('cannot_drop_integrated');
        const dropped = new Set([task!.task_id]); let changed = true;
        while (changed) { changed = false; for (const t of run.tasks) if (!dropped.has(t.task_id) && t.depends_on.some(d => dropped.has(d))) { dropped.add(t.task_id); changed = true; } }
        if (run.tasks.some(t => dropped.has(t.task_id) && ['integrated', 'running', 'merging'].includes(t.state))) conflict('cannot_drop_active_or_integrated');
        for (const t of run.tasks.filter(t => dropped.has(t.task_id))) { t.state = 'dropped'; t.lane = null; t.decision_id = null; if (t !== task) t.state_reason = `dependency_dropped:${task!.task_id}`; delete next.seeds[t.task_id]; delete next.modes[t.task_id]; for (const a of t.attempts) effects.push(() => { const p = readPipeline(store, a.pipeline_id); if (p.integration) p.integration.merge_state = 'dropped'; writePipeline(store, p); }); }
        run.merge_queue = run.merge_queue.filter(id => !dropped.has(id));
        run.attention = run.attention.filter(d => !d.task_id || !dropped.has(d.task_id)); break;
      }
      case 'answer': case 'retry': case 'extra_round': case 'accept': {
        if (input.action === 'answer' && !task && ['plan_review', 'plan_invalid'].includes(decision.reason)) {
          if ((next.plan_answers?.length ?? 0) >= 3) conflict('plan_answers_exhausted');
          (next.plan_answers ??= []).push({ questions: decision.pending_questions, answers: input.answers! });
          next.plan_answer_pending = true;
          next.plan_note = input.note;
          break;
        }
        // B7: run-scoped retry re-executes final review after launch/prompt failure.
        if (input.action === 'retry' && !task && decision.scope === 'run' &&
            (decision.reason === 'launch_failed' || decision.reason === 'prompt_too_large')) {
          if (run.budget.jobs_used >= run.budget.max_total_jobs) conflict('run_budget_exhausted');
          // Clear prior final-review outcome so supervisor re-enters finalizing.
          effects.push(() => {
            const path = join(paths.dir, 'final-review.json');
            try { atomicWriteJson(path, { job_id: '', verdict: null, findings: [], failure_reason: decision.reason, review_completed: false, round_id: null }); } catch { /* rewritten on next finalReview */ }
          });
          break;
        }
        if (!task || !decision.pipeline_id) conflict('pipeline_missing');
        const prepared = preparePipelineResume(store, readPipeline(store, decision.pipeline_id!), {
          schema: 'gbdev.pipeline-resume.v1', pipeline_id: decision.pipeline_id, action: input.action,
          answers: input.answers ?? [], note: input.note,
          ...(typeof input.verdict_missing_reviewed === 'boolean' ? { verdict_missing_reviewed: input.verdict_missing_reviewed } : {}),
        }, input.decision_id);
        acceptance = prepared.acceptance;
        effects.push(prepared.apply); task!.state = input.action === 'accept' ? 'merge_queued' : 'ready';
        if (input.action === 'accept') run.merge_queue.push(task!.task_id);
        else next.modes[task!.task_id] = { kind: 'resume', pipeline_id: decision.pipeline_id! }; break;
      }
      case 'resume_run': break;
      default: conflict('action_not_implemented');
    }
    if (task) task.decision_id = null;
    run.attention = run.attention.filter(d => d.decision_id !== input.decision_id); resolved.push({ input, decision, acceptance });
  }
  return { run, runtime: next, apply() {
    for (const effect of effects) effect();
    const oldStates = new Map(current.tasks.map(t => [t.task_id, t.state]));
    // Active lane/merge promises retain task and lane references. Preserve their identity.
    const tasks = run.tasks.map(nextTask => { const task = current.tasks.find(t => t.task_id === nextTask.task_id); return task ? Object.assign(task, nextTask) : nextTask; });
    const lanes = run.lanes.map(nextLane => { const lane = current.lanes.find(l => l.lane === nextLane.lane); return lane ? Object.assign(lane, nextLane) : nextLane; });
    Object.assign(current, run, { tasks, lanes }); Object.assign(runtime, next);
    for (const t of current.tasks) if (oldStates.get(t.task_id) !== t.state) runEvent(store, current, 'task_state_change', { state: t.state }, t);
    for (const { input, decision, acceptance } of resolved) {
      const at = localIso();
      const record = {
        decision_id: input.decision_id, reason: decision.reason, action: input.action, by: 'grok-bot', at,
        ...(acceptance ? {
          note: acceptance.note, verdict_missing_reviewed: true as const,
          instance: acceptance.instance, job_ids: acceptance.job_ids,
        } : {}),
      };
      appendFileSync(join(runPaths(store, run.run_id).dir, 'decisions.jsonl'), JSON.stringify({ type: 'resolved', ...record }) + '\n');
      runEvent(store, current, 'decision_resolved', { ...record, dropped_tasks: current.tasks.filter(t => t.state === 'dropped').map(t => t.task_id) });
      if (acceptance) runEvent(store, current, 'verdict_missing_accepted', { by: 'grok-bot', instance: acceptance.instance, job_ids: acceptance.job_ids, note: acceptance.note, verdict_missing_reviewed: true, at, decision_id: input.decision_id }, decision.task_id ? current.tasks.find(t => t.task_id === decision.task_id) : undefined);
    }
    if (current.outcome === 'accepted_by_decider') transitionRun(store, current, 'succeeded', 'accept_final');
    else if (resolved.some(r => r.input.action === 'replan' || r.input.action === 'answer' && r.decision.scope === 'run')) transitionRun(store, current, 'planning');
    else if (current.plan.source === 'planner' && !current.plan.approved_at && current.state === 'needs_decision' && resolved.some(r => r.input.action === 'extend_budget' || r.input.action === 'resume_run')) transitionRun(store, current, 'planning');
    else if (current.state === 'plan_review') transitionRun(store, current, 'running');
    else if (current.state === 'needs_decision' && !current.attention.some(d => d.reason === 'supervisor_crashed')) transitionRun(store, current, 'running');
    writeRuntime(store, current, runtime);
  }, inputs: resolved.map(r => r.input), request };
}
