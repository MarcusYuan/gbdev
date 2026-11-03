import { decisionSummary, safeDecisionText } from '../core/decisionSummary.js';
import { notifySupervisorStarted } from '../notify/enqueue.js';
import { dashboardSupervision } from '../core/dashboardSupervision.js';
import { BudgetExhausted } from '../run/decisions.js';
import type { Provider } from '../contracts/brief.js';
import { isRetryableRateLimit } from '../run/scheduler.js';
import { readFileSync, writeFileSync } from 'node:fs';
import type { TaskBrief } from '../contracts/brief.js';
import { isTerminal, type JobStatus } from '../contracts/jobStatus.js';
import { type PipelineRun, type PipelineStep, activeRun } from '../contracts/pipelineRun.js';
import type { Handoff } from '../contracts/handoff.js';
import { GbdevError } from '../contracts/error.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { inheritMissingResultRetry, loadRetryChain } from '../core/launchRetry.js';
import { createJobId } from '../core/ids.js';
import { assertRunWorktreeAsync, headAsync, assertRunWorktree, head } from '../core/git.js';
import { jobPaths } from '../core/paths.js';
import { failureResult } from '../core/finalize.js';
import { event, locked, optionalText, transition, allJobs } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { superviseJob } from '../core/supervise.js';
import { generateHandoff, writeHandoff } from './handoff.js';
import { renderUntrustedData, renderStepPrompt } from './prompt.js';
import { renderOrchestratorNotes } from '../core/prompt.js';
import { appendMissingResultRetryPrompt, readPreviousFinalText } from '../core/missingResultRetry.js';
import { withPipelineVerdictMeta } from '../core/verdictAcceptance.js';
import { decisionActions, gate } from './gate.js';
import { fixInput, insertFix, policyRepairMismatch, readDefinition } from './fixLoop.js';
import { pipelineEvent, pipelinePaths, readRequest, readRun, readSnapshot, stepResult, transitionRun, writeRun } from './store.js';
export interface PipelineSlotHooks {
  signal?: AbortSignal;
  onJobCreated?(): void;
  /** Trusted run-resume context, kept separate from automated evidence. */
  orchestratorNotes?(taskId?: string): readonly (string | null | undefined)[];
  onPipelineCreated?(run: PipelineRun): void;
  /** Must wait outside the global lock and reject promptly when signal aborts. */
  acquireSlot(provider: Provider, signal: AbortSignal): Promise<void>;
  releaseSlot(provider: Provider): void | Promise<void>;
  /** Run owner persists cooldown and emits provider_cooldown here. */
  onRateLimit(provider: Provider): void | Promise<void>;
}
async function supervisePipelineWork(store: JobStore, id: string, hooks?: PipelineSlotHooks): Promise<void> {
  const paths = pipelinePaths(store, id);
  let owns = false;
  let heldProvider: Provider | undefined;
  const release = async () => { if (heldProvider) { const provider = heldProvider; heldProvider = undefined; await hooks!.releaseSlot(provider); } };
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    await locked(store, () => {
      const run = readRun(store, id);
      if (run.workspace.mode === 'per_lane' && !hooks) throw new GbdevError('pipeline_owned_by_run', 'Bound pipeline requires run slot callbacks');
      if (run.state !== 'starting' && !(run.state === 'running' && (run.supervisor_pid === process.pid || run.supervisor_pid === process.ppid))) throw new GbdevError('busy', 'Pipeline already has a supervisor');
      run.supervisor_pid = process.pid; run.heartbeat_at = localIso(); owns = true;
      if (run.state === 'starting') transitionRun(store, run, 'running');
      else writeRun(store, run);
    });
    heartbeat = setInterval(() => { void locked(store, () => {
      const run = readRun(store, id); if (activeRun(run.state)) { run.heartbeat_at = localIso(); writeRun(store, run); }
    }).catch(() => {}); }, 30_000);
    const request = readRequest(store, id), snapshot = readSnapshot(store, id), definition = readDefinition(store, id);
    const pause = (run: PipelineRun, step: PipelineStep, reason: string, detail = '', state: 'needs_input' | 'blocked' | 'needs_decision' = 'needs_decision') => {
      const priorJob = step.attempts.at(-1)?.job_id;
      const policyWarnings = priorJob && optionalText(jobPaths(store.paths, priorJob).result) !== null ? stepResult(store, priorJob).gbdev_observed.policy_assessment?.warnings ?? [] : [];
      if (policyWarnings.length) detail += `\nPolicy warnings: ${JSON.stringify(policyWarnings)}`;
      const decision = {
        reason, instance: step.instance,
        allowed_actions: decisionActions(reason, !!definition.fix_loop, run.max_rounds, step.attempts.length),
        detail: safeDecisionText(detail, 4000),
      };
      const summary = decisionSummary({ ...decision, pending_questions: run.pending_questions, pipeline_id: id, job_id: priorJob });
      run.decision = withPipelineVerdictMeta(store, run, { ...decision, summary }, step);
      pipelineEvent(store, run, 'decision_required', { ...run.decision }, state);
      transitionRun(store, run, state, reason);
    };
    for (;;) {
      if (hooks) {
        const pending = readRun(store, id), step = pending.steps.find(s => s.state === 'pending');
        if (activeRun(pending.state) && step && pending.jobs_used < pending.max_total_jobs && optionalText(paths.cancel) === null && Date.now() < Date.parse(pending.deadline_at)) {
          const controller = new AbortController(), provider = snapshot.steps[step.step_id]!.provider;
          const checkAbort = () => { if (optionalText(paths.cancel) !== null || Date.now() >= Date.parse(pending.deadline_at)) controller.abort(); };
          const monitor = setInterval(checkAbort, 50);
          const warning = setTimeout(() => { void locked(store, () => { const r = readRun(store, id); if (!r.warnings.includes('slot_starved')) { r.warnings.push('slot_starved'); writeRun(store, r); } }).catch(() => {}); }, 1_800_000);
          try { await hooks.acquireSlot(provider, controller.signal); heldProvider = provider; }
          catch (error) { if (!controller.signal.aborted) throw error; }
          finally { clearInterval(monitor); clearTimeout(warning); }
        }
      }
      let boundHead: string | undefined;
      if (hooks && request.run_binding) {
        const pending = readRun(store, id), step = pending.steps.find(s => s.state === 'pending');
        if (activeRun(pending.state) && step) {
          await assertRunWorktreeAsync({ ...request.run_binding, repo: pending.repo, paths: store.paths }, true, 120_000, hooks.signal);
          boundHead = await headAsync(pending.workspace.worktree, hooks.signal);
        }
      }
      const jobId = await locked(store, () => {
        const run = readRun(store, id);
        if (!activeRun(run.state)) return null;
        if (optionalText(paths.cancel) !== null) {
          transitionRun(store, run, 'cancelled', null, 'grok-bot'); return null;
        }
        if (Date.now() >= Date.parse(run.deadline_at)) { transitionRun(store, run, 'failed', 'pipeline_timeout'); return null; }
        const step = run.steps.find(s => s.state === 'pending');
        if (!step) {
          run.outcome = run.steps.some(s => snapshot.steps[s.step_id]!.output === 'verdict') ? 'approved' : 'completed';
          transitionRun(store, run, 'succeeded'); return null;
        }
        if (run.jobs_used >= run.max_total_jobs) { pause(run, step, 'job_budget_exhausted'); return null; }
        const source = run.steps[run.steps.indexOf(step) - 1];
        if (step.kind === 'fix' && source) {
          const mismatch = policyRepairMismatch(store, source, run.workspace.worktree);
          if (mismatch) { pause(run, step, 'workspace_unresolved', mismatch); return null; }
        }
        const role = snapshot.steps[step.step_id]!;
        const attempt = step.attempts.length + 1, parent = step.attempts.at(-1)?.job_id ?? null;
        if (attempt > 3) throw new Error('attempts_exhausted');
        const continuation = JSON.parse(optionalText(`${paths.dir}/continuation.json`) ?? '{}') as { instance?: string; attempt?: number; answers?: TaskBrief['answers']; note?: string | null; missing_result_parent?: string };
        const input = continuation.instance === step.instance && continuation.attempt === attempt ? continuation : {};
        if (request.run_binding && !hooks) assertRunWorktree({ ...request.run_binding, repo: run.repo, paths: store.paths });
        const base = boundHead ?? head(run.workspace.worktree), at = localIso(), jobId = createJobId();
        const scale = Number(process.env.GBDEV_TIMEOUT_SCALE ?? 60_000);
        const brief: TaskBrief = { schema: 'gbdev.task-brief.v1', brief_id: `${id}:${step.instance}:${attempt}`, repo: run.repo, base_ref: base,
          role: role.role, provider: role.provider, model: role.model, sandbox: role.sandbox, timeout_min: role.timeout_min, stall_timeout_s: role.stall_timeout_s,
          network: request.network ?? true, goal: request.goal, context: request.context + renderOrchestratorNotes(...(hooks?.orchestratorNotes?.(request.run_binding?.task_id) ?? []), input.note), constraints: request.constraints, allowed_paths: request.allowed_paths,
          acceptance_criteria: request.acceptance_criteria.map(c => role.output === 'change' ? { ...c } : { id: c.id, text: c.text }),
          ...(request.run_binding && (role.output === 'change' || role.role === 'reviewer') && request.gate_checks?.length ? { gate_checks: structuredClone(request.gate_checks) } : {}),
          execution_checks: role.output === 'change' ? structuredClone(request.execution_checks ?? []) : [],
          required_evidence: request.required_evidence, parent_job_id: parent, answers: input.answers ?? [] };
        const job: JobStatus = { schema: 'gbdev.job-status.v1', job_id: jobId, ...(request.run_binding ? { run_id: request.run_binding.run_id, task_id: request.run_binding.task_id } : {}), state: 'starting', provider: role.provider, role: role.role, sandbox: role.sandbox,
          repo: run.repo, worktree: run.workspace.worktree, branch: run.workspace.branch, base_sha: base, pid: process.pid, session_id: null,
          created_at: at, updated_at: at, deadline_at: localIso(new Date(Date.now() + role.timeout_min * scale)), state_history: [{ state: 'queued', at, by: 'gbdev' }, { state: 'starting', at, by: 'gbdev' }], last_event: null,
          parent_job_id: parent, pipeline_id: id, step_instance: step.instance, attempt, failure_reason: null, failure_reasons: [] };
        // Git preflight may have consumed the remaining wall-clock budget.
        if (Date.now() >= Date.parse(run.deadline_at)) { transitionRun(store, run, 'failed', 'pipeline_timeout'); return null; }
        // Publish ownership before executing any worker. Global lock excludes competing start.
        store.create(job); hooks?.onJobCreated?.();
        const jp = jobPaths(store.paths, jobId); atomicWriteJson(jp.brief, brief);
        if (parent && input.missing_result_parent === parent) {
          inheritMissingResultRetry(jobPaths(store.paths, parent), jp, {
            job_id: jobId, pipeline_id: id, run_id: job.run_id ?? null, step_instance: step.instance,
          });
        }
        atomicWriteJson(`${jp.dir}/provider.json`, { previous_job_id: run.steps.slice(0, run.steps.indexOf(step)).flatMap(s => s.attempts).at(-1)?.job_id ?? null, bin: role.bin, writable_roots: role.sandbox === 'workspace-write' ? [run.workspace.worktree] : [], schema_options: { pipelineStep: true, output: role.output, policyIncidents: true } });
        const preceding = run.steps.slice(0, run.steps.indexOf(step));
        const previous = preceding.filter(s => s.handoff).map(s => JSON.parse(readFileSync(s.handoff!, 'utf8')) as Handoff);
        const previousReview = previous.filter(h => h.verdict && h.instance.startsWith(`${step.step_id}#`)).at(-1);
        const fix = step.kind === 'fix' && source ? fixInput(store, source) : { findings: [], logs: [] };
        let prompt = renderStepPrompt(brief, { pipeline: run.pipeline, instance: step.instance, index: run.steps.indexOf(step) + 1, total: run.steps.length, round: run.round, max_rounds: run.max_rounds,
          kind: step.kind, diff_base_sha: run.diff_base_sha, role: { output: role.output, instructions_text: snapshot.instructions_text[role.role]! }, prior_handoffs: previous,
          latest_handoff_path: preceding.filter(s => s.handoff).at(-1)?.handoff ?? undefined,
          ...(previousReview ? { previous_verdict: previousReview } : {}),
          ...(run.steps.indexOf(step) === 0 && request.seed_findings ? { seed_findings: request.seed_findings } : {}),
          fix_findings: fix.findings, check_logs: fix.logs, decisions: run.decisions ?? [] });
        if (parent) {
          prompt += `\nPrevious attempt summary:\n${renderUntrustedData(stepResult(store, parent).worker_reported?.summary ?? '')}\n`;
          if (role.output === 'verdict' && step.gate === 'retry') {
            // B6: reuse one G9 retry; enrich with bounded prior final text (do not rewrite prior result).
            prompt = appendMissingResultRetryPrompt(prompt, {
              previousJobId: parent,
              previousFinalText: readPreviousFinalText(store.paths, parent),
              headSha: stepResult(store, parent).gbdev_observed.head_after,
            });
          }
        }
        writeFileSync(jp.prompt, prompt);
        writeFileSync(role.provider === 'cursor' ? jp.rawJson : jp.rawJsonl, ''); writeFileSync(jp.workerLog, '');
        step.state = 'running'; step.head_before = base; step.started_at = at;
        step.attempts.push({ attempt, job_id: jobId, job_state: 'starting', failure_reason: null });
        run.current = { instance: step.instance, job_id: jobId, job_state: 'starting', attempt }; run.jobs_used++;
        event(store, job, 'state_change', { state: 'starting', by: 'gbdev' }); pipelineEvent(store, run, 'step_started', { instance: step.instance, job_id: jobId }); writeRun(store, run);
        return jobId;
      });
      if (!jobId) { await release(); break; }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, Date.parse(readRun(store, id).deadline_at) - Date.now()));
      let limited = false;
      try {
        await superviseJob(jobId, store, controller.signal);
        if (hooks) {
          const finished = stepResult(store, jobId);
          limited = isRetryableRateLimit(finished, optionalText(jobPaths(store.paths, jobId).workerLog) ?? '');
          // Persist cooldown before releasing capacity to other waiting pipelines.
          if (limited) await hooks.onRateLimit(store.read(jobId).provider);
        }
      } finally { clearTimeout(timeout); await release(); }
      const settled = await locked(store, () => {
        const run = readRun(store, id), result = stepResult(store, jobId);
        const step = run.steps.find(s => s.instance === run.current!.instance)!, role = snapshot.steps[step.step_id]!;
        const handoff = generateHandoff(result, { pipeline_id: id, seq: run.steps.indexOf(step) + 1, instance: step.instance, role: role.role, output: role.output, created_at: localIso() });
        step.handoff = writeHandoff(paths.handoffs, handoff); step.head_after = result.gbdev_observed.head_after; run.head_sha = step.head_after;
        step.verdict = handoff.verdict?.verdict ?? null; step.finished_at = localIso();
        step.state = result.state === 'timeout' ? 'failed' : result.state as typeof step.state;
        Object.assign(step.attempts.at(-1)!, { job_state: result.state, failure_reason: result.failure_reason }); run.current!.job_state = result.state;
        const previousVerdict = run.steps.slice(0, run.steps.indexOf(step)).filter(s => s.step_id === step.step_id && s.attempts.length).at(-1);
        const verdictRetried = loadRetryChain(jobPaths(store.paths, jobId))?.missing_result_retry_used || step.attempts.slice(0, -1).some(a => {
          const r = stepResult(store, a.job_id);
          return gate(r, role.output).rule === 'G9';
        });
        const priorRepairablePaths = (() => {
          if (step.kind !== 'fix') return undefined;
          const source = run.steps[run.steps.indexOf(step) - 1];
          const sourceJob = source?.attempts.at(-1)?.job_id;
          if (!sourceJob) return undefined;
          const prior = stepResult(store, sourceJob);
          const paths = [
            ...(prior.gbdev_observed.policy_assessment?.repairable ?? []).map(i => i.path),
            ...(prior.gbdev_observed.workspace_issues ?? []).filter(i => i.repairable).map(i => i.path),
          ];
          return [...new Set(paths)];
        })();
        const decision = gate(result, role.output, optionalText(paths.cancel) !== null, { hasFixLoop: !!definition.fix_loop, kind: step.kind, attempts: step.attempts.length, verdictRetried,
          ...(previousVerdict ? { previousFindings: stepResult(store, previousVerdict.attempts.at(-1)!.job_id).worker_reported?.review?.findings ?? [] } : {}),
          ...(priorRepairablePaths?.length ? { priorRepairablePaths } : {}) });

        step.gate = decision.action === 'settle' ? decision.state! : decision.action;
        run.warnings = [...new Set([...run.warnings, ...(decision.warnings ?? []), ...handoff.warnings])];
        pipelineEvent(store, run, 'step_finished', { instance: step.instance, job_id: jobId, state: result.state });
        pipelineEvent(store, run, 'gate', { rule: decision.rule, verdict: step.verdict, round: run.round });
        if (optionalText(paths.cancel) !== null) {
          transitionRun(store, run, 'cancelled', null, 'grok-bot'); return true;
        }
        if (Date.now() >= Date.parse(run.deadline_at)) { transitionRun(store, run, 'failed', 'pipeline_timeout'); return true; }
        const retryWarning = `rate_limit_retry:${step.instance}`;
        if (limited && isRetryableRateLimit(result, optionalText(jobPaths(store.paths, jobId).workerLog) ?? '') && step.attempts.length < 3 && !run.warnings.includes(retryWarning)) { run.warnings.push(retryWarning); step.state = 'pending'; writeRun(store, run); return false; }
        if (decision.action === 'retry') {
          atomicWriteJson(`${paths.dir}/continuation.json`, {
            instance: step.instance, attempt: step.attempts.length + 1, missing_result_parent: jobId,
          });
          step.state = 'pending'; writeRun(store, run); return false;
        }
        if (decision.action === 'fix') {
          if (run.round >= run.max_rounds) { pause(run, step, 'max_rounds_exceeded', result.failure_reason ?? ''); return true; }
          insertFix(store, run, step); writeRun(store, run); return false;
        }
        if (decision.action === 'advance') { step.state = 'succeeded'; writeRun(store, run); return false; }
        const state = decision.state!;
        if (state === 'needs_input' || state === 'blocked' || state === 'needs_decision') {
          if (state === 'needs_input') run.pending_questions = result.worker_reported?.open_questions ?? [];
          pause(run, step, decision.reason!, decision.detail ?? result.failure_reason ?? '', state);
        } else transitionRun(store, run, state, decision.reason ?? null);
        return true;
      });
      if (settled) break;
    }
  } catch (e) {
    if (!owns) throw e;
    if (e instanceof BudgetExhausted) { await locked(store, () => { const r = readRun(store, id); if (!r.warnings.includes('run_budget_exhausted')) r.warnings.push('run_budget_exhausted'); transitionRun(store, r, 'needs_decision', 'run_budget_exhausted'); }); return; }
    await locked(store, () => {
      const run = readRun(store, id);
      if (!activeRun(run.state)) return;
      for (const job of allJobs(store).filter(j => j.pipeline_id === id && !isTerminal(j.state))) {
        const result = failureResult(store, job, null); atomicWriteJson(jobPaths(store.paths, job.job_id).result, result);
        transition(store, job, 'failed', 'gbdev', result.failure_reason, result.failure_reasons);
        const step = run.steps.find(s => s.instance === job.step_instance)!;
        if (!step.attempts.some(a => a.job_id === job.job_id)) { step.attempts.push({ attempt: job.attempt ?? 1, job_id: job.job_id, job_state: 'failed', failure_reason: result.failure_reason }); run.jobs_used++; }
        else Object.assign(step.attempts.at(-1)!, { job_state: 'failed', failure_reason: result.failure_reason });
        step.state = 'failed'; step.finished_at = localIso();
        run.current = { instance: step.instance, job_id: job.job_id, job_state: 'failed', attempt: job.attempt ?? 1 };
      }
      transitionRun(store, run, 'failed', `internal_error: ${e instanceof Error ? e.message : String(e)}`);
    });
  } finally { if (heartbeat) clearInterval(heartbeat); await release(); }
}

export function supervisePipeline(store: JobStore, id: string, hooks?: PipelineSlotHooks): Promise<void> {
  notifySupervisorStarted(store);
  return dashboardSupervision(store, id, () => supervisePipelineWork(store, id, hooks));
}
