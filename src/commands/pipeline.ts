import { addNotify } from '../notify/status.js';
import { addDashboard } from '../dashboard/hints.js';
import { assertRunIdle } from '../run/store.js';
import { supervisePipeline, type PipelineSlotHooks } from '../pipeline/supervisor.js';
import { runWorkspacePath } from '../run/workspace.js';
import { closeSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validatePipelineResume } from '../contracts/pipelineResume.js';
import { preparePipelineResume } from '../pipeline/resume.js';
import { GbdevError } from '../contracts/error.js';
import { activeRun, terminalRun, validatePipelineId, type PipelineRun } from '../contracts/pipelineRun.js';
import { resolveRequest } from '../contracts/pipelineRequest.js';
import type { PipelineResult } from '../contracts/pipelineResult.js';
import { isTerminal } from '../contracts/jobStatus.js';
import { loadConfig } from '../core/config.js';
import { git, addWorktree, assertRunWorktreeAsync, headAsync, dirtyAsync, isDirty, resolveBase } from '../core/git.js';
import { createJobId } from '../core/ids.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { caffeinatePath, spawnProcess } from '../core/proc.js';
import { allJobs, locked } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { PipelineRegistry } from '../pipeline/definitions.js';
import { allRuns, assertPipelineIdle, createRun, pipelineEvent, pipelinePaths, readRun, transitionRun, writePipelineResult, writeRun } from '../pipeline/store.js';
import { projectPipelineDecision, VERDICT_MISSING_STATUS_HINT } from '../core/verdictAcceptance.js';
import { reconcileAll, reconcilePipeline } from '../pipeline/reconcile.js';
import { cleanupBranch } from './cleanup.js';
export function assertIdle(store: JobStore): void {
  assertRunIdle(store);
  assertPipelineIdle(store);
  const job = allJobs(store).find(j => j.kind !== 'inspect' && !j.pipeline_id && !isTerminal(j.state));
  if (job) throw new GbdevError('busy', 'A standalone job is active', { running_job_id: job.job_id });
}
async function launchSupervisor(store: JobStore, run: PipelineRun): Promise<void> {
  const paths = pipelinePaths(store, run.pipeline_id);
  const fd = openSync(paths.supervisorLog, 'a', 0o600);
  try {
    const wrapper = caffeinatePath(), args = [fileURLToPath(new URL('../cli.js', import.meta.url)), '__pipeline-supervise', run.pipeline_id];
    const child = await spawnProcess(wrapper ?? process.execPath, wrapper ? ['-i', process.execPath, ...args] : args, { detached: true, stdio: ['ignore', fd, fd] });
    run.supervisor_pid = child.pid!; writeRun(store, run); child.unref();
  } finally { closeSync(fd); }
}
export async function pipelineStart(store: JobStore, file: string, dryRun = false): Promise<PipelineRun> {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')); } catch { throw new GbdevError('pipeline_invalid', 'Cannot read request JSON'); }
  return startPipelineValue(store, value, dryRun);
}
/** Internal, in-process pipeline execution. Caller owns lane and run persistence. */
export async function runPipeline(store: JobStore, value: unknown, hooks: PipelineSlotHooks, prepared?: ReturnType<typeof resolveRequest>): Promise<PipelineRun> {
  const run = await startPipelineValue(store, value, false, hooks, prepared);
  await supervisePipeline(store, run.pipeline_id, hooks);
  return readRun(store, run.pipeline_id);
}
async function startPipelineValue(store: JobStore, value: unknown, dryRun: boolean, hooks?: PipelineSlotHooks, prepared?: ReturnType<typeof resolveRequest>): Promise<PipelineRun> {
  const resolved = prepared && hooks ? { ...structuredClone(prepared), request: { ...structuredClone(prepared.request), ...value as object } }
    : resolveRequest(value, loadConfig(store.paths.config), new PipelineRegistry(store.paths.config), { internal: !!hooks });
  const { request, definition, snapshot } = resolved;
  const binding = request.run_binding;
  if (hooks && !binding) throw new GbdevError('pipeline_invalid', 'Internal runPipeline requires run_binding');
  if (binding) {
    const expected = runWorkspacePath({ paths: store.paths, repo: request.repo, run_id: binding.run_id }, binding.lane);
    if (realpathSync(binding.worktree) !== realpathSync(expected) || !new RegExp(`^gbdev/${binding.run_id}/t/${binding.task_id}(-r(?:[2-9][0-9]*|1[0-9]+))?$`).test(binding.branch)) throw new GbdevError('guard_violation', 'run_binding does not match lane/task');
    await assertRunWorktreeAsync({ ...binding, repo: request.repo, paths: store.paths }, true, 120_000, hooks?.signal);
    if (await dirtyAsync(binding.worktree, hooks?.signal)) throw new GbdevError('worktree_failed', 'lane_broken');
  }
  const scale = Number(process.env.GBDEV_TIMEOUT_SCALE ?? 60_000);
  if (!Number.isFinite(scale) || scale <= 0 || scale * Math.max(request.timeout_min, ...Object.values(snapshot.steps).map(s => s.timeout_min)) > 2_147_483_647) throw new GbdevError('config_invalid', 'Invalid GBDEV_TIMEOUT_SCALE');
  const base = binding ? await headAsync(binding.worktree, hooks?.signal) : resolveBase(request.repo, request.base_ref), diff = request.diff_base_ref ? binding ? (await git(request.repo, ['rev-parse', '--verify', `${request.diff_base_ref}^{commit}`], 120_000, hooks?.signal ?? new AbortController().signal)).trim() : resolveBase(request.repo, request.diff_base_ref) : base;
  const initialize = (): PipelineRun => {
    if (!binding) assertIdle(store);
    else if (allRuns(store).some(r => activeRun(r.state) && (r.workspace.worktree === binding.worktree || r.workspace.mode === 'per_lane' && r.workspace.run_id === binding.run_id && r.workspace.lane === binding.lane))) throw new GbdevError('busy', 'Lane already has an active pipeline');
    const at = localIso(), id = dryRun ? 'p_dry_run' : createJobId().replace(/^j_/, 'p_');
    return { schema: 'gbdev.pipeline-run.v1', pipeline_id: id, pipeline: definition.name, state: 'queued', state_reason: null, outcome: null, failure_reason: null,
      repo: request.repo, workspace: binding ? { mode: 'per_lane', ...binding } : { mode: 'shared_run_worktree', worktree: join(store.paths.worktrees, basename(request.repo), id), branch: `gbdev/${id}` },
      base_sha: base, diff_base_sha: diff, head_sha: base, round: 0, max_rounds: request.max_rounds, jobs_used: 0, max_total_jobs: request.max_total_jobs, current: null,
      steps: definition.steps.map(s => { const r = snapshot.steps[s.id]!; return { instance: `${s.id}#1`, step_id: s.id, kind: 'step', role: r.role, provider: r.provider, sandbox: r.sandbox,
        state: 'pending', round: 0, attempts: [], gate: null, verdict: null, head_before: null, head_after: null, handoff: null, started_at: null, finished_at: null }; }),
      decision: null, decisions: [], pending_questions: [], supervisor_pid: null, heartbeat_at: null, created_at: at, updated_at: at,
      deadline_at: localIso(new Date(Date.now() + request.timeout_min * scale)), state_history: [{ state: 'queued', at, by: 'gbdev', reason: null }],
      warnings: !binding && isDirty(request.repo) ? ['repo_dirty_changes_not_included'] : [], integration: binding ? { run_id: binding.run_id, task_id: binding.task_id, integration_branch: `gbdev/${binding.run_id}/integration`, merge_state: 'pending', merged_sha: null, target_branch: null, approved_by_user_at: null } : null, ...(dryRun ? { dry_run: true } : {}) };
  };
  if (dryRun) return initialize(); // No reconcile, lock, directories, or writes.
  if (!binding) await reconcileAll(store);
  return locked(store, async () => {
    const run = initialize(), paths = pipelinePaths(store, run.pipeline_id);
    snapshot.pipeline_id = run.pipeline_id; snapshot.resolved_at = localIso();
    createRun(store, run, () => {
      atomicWriteJson(paths.request, request);
      atomicWriteJson(paths.definition, { ...definition, timeout_min: request.timeout_min,
        steps: definition.steps.map(step => ({ ...step, ...snapshot.steps[step.id] })),
        ...(definition.fix_loop ? { fix_loop: { ...definition.fix_loop, max_rounds: request.max_rounds, resolved_role: snapshot.steps.fix } } : {}) });
      atomicWriteJson(paths.snapshot, snapshot);
    });
    pipelineEvent(store, run, 'pipeline_state_change', { state: 'queued', by: 'gbdev' });
    try {
      if (binding) { run.supervisor_pid = process.pid; hooks?.onPipelineCreated?.(run); }
      transitionRun(store, run, 'starting');
      if (!binding) { addWorktree(run.repo, run.workspace.branch, run.workspace.worktree, base); await launchSupervisor(store, run); }
    } catch (e) {
      transitionRun(store, run, 'failed', e instanceof GbdevError && e.contract.code === 'worktree_failed' ? 'worktree_failed' : `internal_error: ${String(e)}`);
      throw e;
    }
    return run;
  });
}
export async function pipelineResult(store: JobStore, id: string): Promise<PipelineResult> {
  const run = await reconcilePipeline(store, id);
  if (activeRun(run.state)) throw new GbdevError('pipeline_not_settled', 'Pipeline is still active', { pipeline_id: id });
  // Lock synchronizes with the supervisor publishing state + aggregate together.
  return locked(store, () => {
    const current = readRun(store, id);
    if (activeRun(current.state)) throw new GbdevError('pipeline_not_settled', 'Pipeline is still active', { pipeline_id: id });
    try {
      const result = JSON.parse(readFileSync(pipelinePaths(store, id).result, 'utf8')) as PipelineResult;
      // A crash during accept can leave the new aggregate ahead of the still-paused run.
      if (result.state === current.state && result.state_reason === current.state_reason && result.outcome === current.outcome && result.round === current.round && result.jobs_used === current.jobs_used) return { ...result, decisions: current.decisions ?? [] };
      return writePipelineResult(store, current);
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return writePipelineResult(store, current); }
  });
}
function assertStandalone(store: JobStore, id: string): void {
  let run: PipelineRun;
  try { run = readRun(store, id); } catch { return; } // Preserve legacy validation/error ordering.
  if (run.workspace.mode === 'per_lane') throw new GbdevError('pipeline_owned_by_run', 'Use the owning run for mutations', { run_id: run.workspace.run_id });
}
export async function pipelineCancel(store: JobStore, id: string): Promise<PipelineRun> {
  assertStandalone(store, id);
  const initial = await reconcilePipeline(store, id);
  if (terminalRun(initial.state)) return initial;
  await locked(store, () => {
    const run = readRun(store, id); if (terminalRun(run.state)) return;
    atomicWriteJson(pipelinePaths(store, id).cancel, { at: localIso(), by: 'grok-bot' });
    if (!activeRun(run.state)) { run.decision = null; run.pending_questions = []; transitionRun(store, run, 'cancelled', null, 'grok-bot'); return; }
    if (run.current) {
      const job = store.read(run.current.job_id);
      if (!isTerminal(job.state)) {
        atomicWriteJson(jobPaths(store.paths, job.job_id).cancelRequest, { at: localIso(), by: 'grok-bot' });
        if (job.pid && job.state === 'running') try { process.kill(job.pid, 'SIGTERM'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      }
    }
  });
  const until = Date.now() + 15_000;
  for (;;) { const run = await reconcilePipeline(store, id); if (!activeRun(run.state) || Date.now() >= until) return run; await delay(100); }
}
export async function pipelineResume(store: JobStore, id: string, file: string): Promise<PipelineRun> {
  assertStandalone(store, id);
  let value: unknown;
  try { value = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')); }
  catch { throw new GbdevError('config_invalid', 'Cannot read resume JSON'); }
  const input = validatePipelineResume(value, id);
  await reconcileAll(store);
  return locked(store, async () => {
    const prepared = preparePipelineResume(store, readRun(store, id), input);
    if (input.action !== 'accept') assertIdle(store);
    prepared.apply(); const run = prepared.run;
    if (input.action === 'accept') return run;
    try { await launchSupervisor(store, run); }
    catch (e) { transitionRun(store, run, 'failed', `internal_error: ${String(e)}`); throw e; }
    return run;
  });
}
export interface PipelineOptions { input?: string | undefined; request?: string | undefined; 'dry-run'?: boolean | undefined; 'force-branch'?: boolean | undefined; 'timeout-ms'?: string | undefined; 'with-result'?: boolean | undefined }
export async function pipelineCommand(store: JobStore, args: string[], options: PipelineOptions): Promise<{ schema: string; result: unknown }> {
  const command = args[0] ?? '', id = args[1];
  const usage = (): never => { throw new GbdevError('usage_error', 'Use pipeline templates | start --request <file|-> [--dry-run] | list [--active] [--state <s>] [--limit <1..500>] [--standalone] | status [id] (reconciles; read-only inventory: pipeline list) | wait <id> --timeout-ms <1000..3600000> [--with-result] | result <id> | resume <id> --input <file|-> | cancel <id> | cleanup <id> [--dry-run] [--force-branch]'); };
  if (!command || !['templates', 'start', 'status', 'wait', 'result', 'resume', 'cancel', 'cleanup'].includes(command) || args.length > 2) usage();
  if (['templates', 'start'].includes(command) && id) usage();
  if (!['templates', 'start', 'status'].includes(command) && !id) usage();
  if (id) validatePipelineId(id);
  const allowed: Record<string, string[]> = { resume: ['input'], start: ['request', 'dry-run'], cleanup: ['force-branch', 'dry-run'], wait: ['timeout-ms', 'with-result'] };
  for (const [key, v] of Object.entries(options)) if (v !== undefined && !(allowed[command] ?? []).includes(key)) usage();
  let result: unknown, schema = 'gbdev.pipeline-run.v1';
  switch (command) {
    case 'templates': result = new PipelineRegistry(store.paths.config).list(); schema = 'gbdev.pipeline-list.v1'; break;
    case 'start': if (!options.request) usage(); { const started = await pipelineStart(store, options.request!, options['dry-run']); result = await addNotify(store.paths, options['dry-run'] ? started : await addDashboard(store.paths, started, started.pipeline_id, 'pipeline')); } break;
    case 'status': {
      const project = async (pid: string) => projectPipelineDecision(store, await reconcilePipeline(store, pid));
      result = id ? await project(id) : await Promise.all((await locked(store, () => allRuns(store).slice(0, 50))).map(r => project(r.pipeline_id)));
      break;
    }
    case 'result': result = await pipelineResult(store, id!); schema = 'gbdev.pipeline-result.v1'; break;
    case 'resume': if (!options.input) usage(); result = await pipelineResume(store, id!, options.input!); break;
    case 'cancel': result = await pipelineCancel(store, id!); break;
    case 'wait': {
      const n = Number(options['timeout-ms']); if (!options['timeout-ms'] || !/^\d+$/.test(options['timeout-ms']) || !Number.isSafeInteger(n) || n < 1000 || n > 3_600_000) usage();
      const until = Date.now() + n;
      for (;;) {
        const run = await reconcilePipeline(store, id!);
        if (!activeRun(run.state)) { result = options['with-result'] ? await pipelineResult(store, id!) : run; if (options['with-result']) schema = 'gbdev.pipeline-result.v1'; break; }
        if (Date.now() >= until) throw new GbdevError('wait_timeout', 'Pipeline wait timed out', { pipeline: run });
        await delay(Math.min(1000, until - Date.now()));
      }
      break;
    }
    case 'cleanup': {
      assertStandalone(store, id!);
      await reconcilePipeline(store, id!);
      result = await locked(store, () => {
        const run = readRun(store, id!);
        if (!terminalRun(run.state)) throw new GbdevError('pipeline_not_terminal', 'Pipeline must be terminal before cleanup', { pipeline_id: id });
        const cleaned = cleanupBranch({ status: { job_id: null, state: run.state as 'succeeded' | 'failed' | 'cancelled', repo: run.repo, worktree: run.workspace.worktree, branch: run.workspace.branch, base_sha: run.base_sha }, forceBranch: options['force-branch'], dryRun: options['dry-run'] });
        return { ...cleaned, pipeline_id: id };
      }); schema = 'gbdev.cleanup.v1'; break;
    }
  }
  return { schema, result };
}
export function pipelineText(result: unknown): string {
  if (Array.isArray(result)) return result.map(pipelineText).join('');
  const r = result as Record<string, unknown>;
  if ('pipelines' in r) return `${(r.pipelines as { name: string; steps: string[] }[]).map(p => `${p.name}: ${p.steps.join(' → ')}`).join('\n')}\n${(r.invalid as { message: string }[]).map(e => `invalid: ${e.message}\n`).join('')}`;
  if ('branch_retained' in r) return `${r.pipeline_id}: ${r.dry_run ? 'dry-run' : 'cleanup'} worktree_removed=${r.worktree_removed}, branch_deleted=${r.branch_deleted}${r.dry_run ? `, would_remove_worktree=${r.would_remove_worktree}, would_delete_branch=${r.would_delete_branch}` : ''}\n${r.branch_retained_reason ? `branch kept: ${r.branch_retained_reason}${r.branch_retained_reason === 'unmerged_job_commits' ? ' (use --force-branch only with user approval)' : ''}\n` : ''}`;
  const decision = r.decision as PipelineRun['decision'] | undefined;
  const hint = decision?.accept_requirements?.length ? `${VERDICT_MISSING_STATUS_HINT}\n` : '';
  const paused = ['needs_input', 'needs_decision', 'blocked'].includes(r.state as string);
  return `${r.pipeline_id} ${r.state}${r.state_reason ? `: ${r.state_reason}` : ''}${r.outcome ? ` (${r.outcome})` : ''}\n${hint}Next: gbdev pipeline ${activeRun(r.state as PipelineRun['state']) ? `wait ${r.pipeline_id} --timeout-ms 540000 --with-result` : `result ${r.pipeline_id}`}${paused ? `; gbdev pipeline resume ${r.pipeline_id} --input <file|->` : ''}\n`;
}
