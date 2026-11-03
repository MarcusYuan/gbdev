import { transitionPauseBudget } from '../core/pauseBudget.js';
import { notifyEvent } from '../notify/enqueue.js';
import { dashboardEvent } from '../dashboard/trigger.js';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type PipelineRun, type RunState, activeRun, assertRunTransition, validatePipelineId, validatePipelineRun } from '../contracts/pipelineRun.js';
import type { PipelineResult } from '../contracts/pipelineResult.js';
import type { PipelineRequest, RoleSnapshot } from '../contracts/pipelineRequest.js';
import type { JobResult } from '../contracts/jobResult.js';
import { validateJobResult } from '../contracts/jobResult.js';
import { GbdevError } from '../contracts/error.js';
import { atomicWriteJson, atomicWriteText, JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { optionalText } from '../core/runtime.js';
import { compareInstantDesc, localIso } from '../core/time.js';
import { changedFiles, git, head } from '../core/git.js';
import { matchesAllowed } from '../core/glob.js';
export function pipelinePaths(store: JobStore, id: string) {
  validatePipelineId(id); const dir = join(store.paths.home, 'pipelines', id);
  return { dir, run: join(dir, 'pipeline.json'), request: join(dir, 'request.json'), definition: join(dir, 'definition.json'), snapshot: join(dir, 'roles.snapshot.json'),
    result: join(dir, 'result.json'), diff: join(dir, 'diff.patch'), handoffs: join(dir, 'handoffs'), events: join(dir, 'events.jsonl'), supervisorLog: join(dir, 'supervisor.log'), cancel: join(dir, 'cancel.json') };
}
export function readRun(store: JobStore, id: string): PipelineRun {
  const paths = pipelinePaths(store, id), raw = optionalText(paths.run);
  if (raw === null) throw new GbdevError('pipeline_not_found', 'Pipeline run not found', { pipeline_id: id });
  try { const r = validatePipelineRun(JSON.parse(raw)); if (r.schema !== 'gbdev.pipeline-run.v1' || r.pipeline_id !== id || !Array.isArray(r.steps) || !Array.isArray(r.state_history)) throw new Error(); return r; }
  catch { throw new GbdevError('internal_error', 'Invalid pipeline.json', { pipeline_id: id }); }
}
export function allRuns(store: JobStore): PipelineRun[] {
  let entries; try { entries = readdirSync(join(store.paths.home, 'pipelines'), { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  return entries.filter(e => e.isDirectory() && /^p_\d{8}_\d{4}_[a-f0-9]{4}$/.test(e.name)).flatMap(e => { try { return [readRun(store, e.name)]; } catch { return []; } }).sort((a, b) => compareInstantDesc(a.created_at, b.created_at) || b.pipeline_id.localeCompare(a.pipeline_id));
}
export function writeRun(store: JobStore, run: PipelineRun): void { run.updated_at = localIso(); atomicWriteJson(pipelinePaths(store, run.pipeline_id).run, run); }
/** Publish initial pipeline.json last so interrupted initialization is invisible to inventory. */
export function createRun(store: JobStore, run: PipelineRun, initialize?: () => void): void {
  const p = pipelinePaths(store, run.pipeline_id);
  mkdirSync(join(store.paths.home, 'pipelines'), { recursive: true });
  mkdirSync(p.dir, { mode: 0o700 });
  try {
    mkdirSync(p.handoffs); mkdirSync(join(p.dir, 'inputs'));
    initialize?.(); writeRun(store, run);
  } catch (e) { rmSync(p.dir, { recursive: true, force: true }); throw e; }
}
export function pipelineEvent(store: JobStore, run: PipelineRun, type: string, data: Record<string, unknown>, notifyState = run.state): void {
  const p = pipelinePaths(store, run.pipeline_id), old = optionalText(p.events) ?? '';
  const seq = old.split('\n').filter(Boolean).length + 1;
  const at = localIso();
  appendFileSync(p.events, `${old && !old.endsWith('\n') ? '\n' : ''}${JSON.stringify({ schema: 'gbdev.event.v1', pipeline_id: run.pipeline_id, ...(run.workspace.mode === 'per_lane' ? { run_id: run.workspace.run_id, task_id: run.workspace.task_id, lane: run.workspace.lane } : {}), job_id: run.current?.job_id ?? null, seq, at, source: 'gbdev', type, data })}\n`, { mode: 0o600 });
  dashboardEvent(store.paths.home, type, data);
  notifyEvent(store, { kind: 'pipeline', id: run.pipeline_id, state: notifyState, workspace_mode: run.workspace.mode }, type, data, seq, at);
}
export function transitionRun(store: JobStore, run: PipelineRun, state: RunState, reason: string | null = null, by = 'gbdev'): void {
  assertRunTransition(run.state, state);
  transitionPauseBudget(run, ['needs_decision', 'needs_input', 'blocked'].includes(state), ['succeeded', 'failed', 'cancelled'].includes(state));
  run.state = state; run.state_reason = reason;
  run.failure_reason = state === 'failed' ? reason : null;
  run.state_history.push({ state, at: localIso(), by, reason });
  if (state === 'failed' || state === 'cancelled') for (const s of run.steps) if (s.state === 'pending') s.state = 'skipped';
  // Publish the aggregate BEFORE the stable state, in the caller's same lock.
  if (!activeRun(state)) writePipelineResult(store, run);
  pipelineEvent(store, run, 'pipeline_state_change', { state, reason, by }); writeRun(store, run);
}
export function readRequest(store: JobStore, id: string): PipelineRequest { return JSON.parse(readFileSync(pipelinePaths(store, id).request, 'utf8')) as PipelineRequest; }
export function readSnapshot(store: JobStore, id: string): RoleSnapshot { return JSON.parse(readFileSync(pipelinePaths(store, id).snapshot, 'utf8')) as RoleSnapshot; }
export function stepResult(store: JobStore, jobId: string): JobResult { return validateJobResult(JSON.parse(readFileSync(jobPaths(store.paths, jobId).result, 'utf8'))); }
/** Stable aggregates are written before releasing the lock that publishes a settled state. */
export function writePipelineResult(store: JobStore, run: PipelineRun): PipelineResult {
  const p = pipelinePaths(store, run.pipeline_id), request = readRequest(store, run.pipeline_id), snapshot = readSnapshot(store, run.pipeline_id);
  let commits: string[] = [], files: string[] = [], diff = '';
  try { run.head_sha = head(run.workspace.worktree); commits = git(run.workspace.worktree, ['log', '--format=%h %s', `${run.base_sha}..HEAD`]).trim().split('\n').filter(Boolean); files = changedFiles(run.workspace.worktree, run.base_sha); diff = git(run.workspace.worktree, ['diff', run.base_sha, 'HEAD', '--']); }
  catch (e) { if (!run.warnings.includes('aggregate_git_unavailable')) run.warnings.push('aggregate_git_unavailable'); }
  let final_checks: PipelineResult['final_checks'] = null, final_verdict: PipelineResult['final_verdict'] = null;
  const steps = run.steps.map(s => {
    let result: JobResult | undefined;
    const last = s.attempts.at(-1); if (last) result = stepResult(store, last.job_id);
    if (result && snapshot.steps[s.step_id]!.output === 'change' && result.state === 'succeeded') final_checks = { job_id: result.job_id, checks: result.gbdev_observed.checks.map(c => ({ ...c, log: join(jobPaths(store.paths, result!.job_id).dir, c.log) })) };
    if (result?.worker_reported?.review && snapshot.steps[s.step_id]!.output === 'verdict') final_verdict = { instance: s.instance, verdict: s.verdict ?? result.worker_reported.review.verdict, open_findings: result.worker_reported.review.findings };
    return { instance: s.instance, state: s.state, job_ids: s.attempts.map(a => a.job_id), gate: s.gate, ...(s.verdict ? { verdict: s.verdict } : {}), summary: result?.worker_reported?.summary ?? '' };
  });
  const result: PipelineResult = { schema: 'gbdev.pipeline-result.v1', pipeline_id: run.pipeline_id, pipeline: run.pipeline, state: run.state, state_reason: run.state_reason, outcome: run.outcome, failure_reason: run.failure_reason, decision: run.decision, pending_questions: run.pending_questions,
    decisions: run.decisions ?? [], repo: run.repo, branch: run.workspace.branch, worktree: run.workspace.worktree, base_sha: run.base_sha, diff_base_sha: run.diff_base_sha, head_sha: run.head_sha,
    round: run.round, jobs_used: run.jobs_used, duration_s: Math.max(0, (Date.parse(run.state_history.at(-1)!.at) - Date.parse(run.created_at)) / 1000), commits, files_changed: files,
    outside_allowed_paths: files.filter(f => !matchesAllowed(f, request.allowed_paths)), final_checks, final_verdict, steps, warnings: run.warnings,
    paths: { pipeline: p.run, diff: p.diff, handoffs: p.handoffs, events: p.events } };
  atomicWriteText(p.diff, diff); atomicWriteJson(p.result, result); return result;
}
export function assertPipelineIdle(store: JobStore): void {
  const run = allRuns(store).find(r => activeRun(r.state));
  if (run) throw new GbdevError('busy', 'A pipeline is active', { running_pipeline_id: run.pipeline_id, ...(run.current ? { running_job_id: run.current.job_id } : {}) });
}
