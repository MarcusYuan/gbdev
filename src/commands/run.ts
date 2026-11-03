import { addNotify } from '../notify/status.js';
import { addDashboard } from '../dashboard/hints.js';
import { cleanupRun } from '../run/cleanup.js';
import { landRun } from '../run/land.js';
import { randomUUID } from 'node:crypto';
import { projectRunAttention, VERDICT_MISSING_STATUS_HINT } from '../core/verdictAcceptance.js';
import { reconcileRun, supervisorAlive } from '../run/reconcile.js';
import { prepareDecisions, readRuntime } from '../run/decisions.js';
import { assertRunInvariants } from '../run/invariants.js';
import { mergeRecords } from '../run/result.js';
import { isTerminal } from '../contracts/jobStatus.js';
import { failureResult } from '../core/finalize.js';
import { jobPaths } from '../core/paths.js';
import { runJobs, refreshSlots } from '../run/invariants.js';
import { allRuns as allPipelines, transitionRun as transitionPipeline } from '../pipeline/store.js';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { GbdevError } from '../contracts/error.js';
import { shouldDefaultTaskChecks, validateRunRequest, type RunRequest } from '../contracts/runRequest.js';
import type { Run } from '../contracts/run.js';
import { TASK_STATES } from '../contracts/run.js';
import { resolveRequest, type RoleSnapshot } from '../contracts/pipelineRequest.js';
import { loadConfig } from '../core/config.js';
import { git, resolveBase, isDirty } from '../core/git.js';
import { createJobId } from '../core/ids.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { isProcessAlive } from '../core/lock.js';
import { locked, optionalText, transition } from '../core/runtime.js';
import { caffeinatePath, spawnProcess, terminateGroup } from '../core/proc.js';
import { loadRunConfig } from '../core/runConfig.js';
import { localIso } from '../core/time.js';
import { PipelineRegistry } from '../pipeline/definitions.js';
import { assertIdle } from './pipeline.js';
import { activeRun, allRuns, jsonFile, readRun, runPaths, terminalRun, transitionRun, writeRun } from '../run/store.js';
import { pipelineValue } from '../run/requests.js';
import { runWorkspacePath } from '../run/workspace.js';
import { restoreIntegration } from '../run/supervisor.js';
import { acquireIntegrationLock } from '../run/integrationLock.js';
import { writeResult } from '../run/result.js';

export async function startRun(store: JobStore, value: unknown, launch = true, dryRun = false): Promise<Run> {
  const registry = new PipelineRegistry(store.paths.config), config = loadConfig(store.paths.config), settings = loadRunConfig(store.paths.config, registry);
  const request = validateRunRequest(value, config, registry, settings.run_defaults);
  const snapshots: Record<string, RoleSnapshot> = {}, execution: Record<string, ReturnType<typeof resolveRequest>> = {};
  const prepare = (key: string, value: unknown) => { const resolved = resolveRequest(value, config, registry, { internal: true }); execution[key] = resolved; snapshots[key] = resolved.snapshot; };
  for (const task of request.tasks ?? []) prepare(`task:${task.id}`, pipelineValue(request, task, registry));
  const placeholder = { id: 'internal', title: 'internal', goal: request.goal, context: '', depends_on: [], file_scope: request.allowed_paths, acceptance_criteria: request.acceptance_criteria, pipeline: null, size: 'S' as const, notes: null };
  prepare('internal:integration-fix', pipelineValue(request, placeholder, registry, true));
  prepare('internal:final-fix', pipelineValue(request, { ...placeholder, pipeline: 'final-fix' }, registry));
  if (request.final_review === 'reviewer') prepare('internal:final_review', pipelineValue(request, null, registry));
  for (const role of ['resolver', 'verifier', ...(request.decompose === 'planner' ? ['planner'] : [])]) {
    const definition = { schema: 'gbdev.pipeline.v1' as const, name: `run-${role}`, description: role, steps: [{ id: role, role }], timeout_min: 240 };
    const fakeOnly = Object.values(snapshots).length > 0 && Object.values(snapshots).every(s => Object.values(s.steps).every(step => step.provider === 'fake'));
    prepare(`internal:${role}`, { ...pipelineValue(request, null, registry), pipeline: definition, step_overrides: fakeOnly ? { [role]: { provider: 'fake' } } : {} });
  }
  if (request.final_review === 'verifier') snapshots['internal:final_review'] = snapshots['internal:verifier']!;
  const version = git(request.repo, ['--version']).match(/git version (\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 38) throw new GbdevError('run_invalid', 'Git >= 2.38 is required');
  const base = resolveBase(request.repo, request.base_ref), scale = Number(process.env.GBDEV_TIMEOUT_SCALE ?? 60_000);
  if (!Number.isFinite(scale) || scale <= 0 || scale * request.timeout_min > 2_147_483_647) throw new GbdevError('config_invalid', 'Invalid GBDEV_TIMEOUT_SCALE');
  const initialize = async () => {
    if (!dryRun) assertIdle(store);
    const id = createJobId().replace(/^j_/, 'r_'), at = localIso(), paths = runPaths(store, id);
    const worktree = runWorkspacePath({ paths: store.paths, run_id: id, repo: request.repo }, 'integration');
    const run: Run = { schema: 'gbdev.run.v1', run_id: id, state: 'queued', state_reason: null, outcome: null, failure_reason: null, repo: request.repo, base_ref: request.base_ref, base_sha: base, executor_host: 'local', lanes: [],
      integration: { branch: `gbdev/${id}/integration`, worktree, verified_sha: base, head_sha: base, merging: null, merges: 0, rollbacks: 0, target_branch: null, landed_sha: null, approved_by_user_at: null },
      tasks: (request.tasks ?? []).map(t => ({ task_id: t.id, state: 'pending', lane: null, branch: null, depends_on: t.depends_on, attempts: [], head_sha: null, base_sha: null, merge_seq: [], merged_sha: null, integration_fixes: 0, scope_exceeded: [], decision_id: null })),
      progress: Object.fromEntries(['total', ...TASK_STATES.filter(s => s !== 'cancelled')].map(s => [s, 0])) as Run['progress'], merge_queue: [], attention: [], slots: { max_workers: settings.parallel.max_workers, in_use: 0, by_provider: { codex: 0, cursor: 0 }, cooldown_until: {} },
      budget: { jobs_used: 0, max_total_jobs: request.max_total_jobs, max_tasks: request.max_tasks, extended: false }, plan: { source: request.decompose, approved_at: request.decompose === 'provided' ? at : null, approved_by: request.decompose === 'provided' ? 'grok-bot' : null, plan_attempts: 0 }, supervisor_pid: null, heartbeat_at: null, created_at: at, updated_at: at, deadline_at: localIso(new Date(Date.now() + request.timeout_min * scale)),
      state_history: [{ state: 'queued', at, by: 'gbdev', reason: null }], warnings: isDirty(request.repo) ? ['repo_dirty_changes_not_included'] : [] };
    if (shouldDefaultTaskChecks(value, settings.run_defaults)) run.warnings.push(`task_checks_defaulted:${JSON.stringify(request.task_checks)}`);
    run.progress.total = run.tasks.length; run.progress.pending = run.tasks.length;
    if (dryRun) return run;
    mkdirSync(paths.merges, { recursive: true }); mkdirSync(join(paths.dir, 'inputs'), { recursive: true }); atomicWriteJson(paths.request, request); atomicWriteJson(paths.snapshot, snapshots); atomicWriteJson(join(paths.dir, 'execution.snapshot.json'), execution); atomicWriteJson(join(paths.dir, 'settings.snapshot.json'), settings);
    if (request.tasks) atomicWriteJson(join(paths.dir, 'task-graph.json'), { schema: 'gbdev.task-graph.v1', summary: request.goal, tasks: request.tasks });
    const refs: Record<string, string> = {};
    // base_ref is the only known land target before S5. Unrelated heads are user-owned.
    const target = git(run.repo, ['rev-parse', '--symbolic-full-name', request.base_ref]).trim();
    if (target.startsWith('refs/heads/')) refs[target] = base;
    atomicWriteJson(join(paths.dir, 'protected-refs.json'), refs); writeRun(store, run);
    if (launch) {
      const fd = openSync(paths.log, 'a', 0o600);
      try {
        const wrapper = caffeinatePath(), args = [fileURLToPath(new URL('../cli.js', import.meta.url)), '__run-supervise', id];
        const child = await spawnProcess(wrapper ?? process.execPath, wrapper ? ['-i', process.execPath, ...args] : args, { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, GBDEV_HOME: store.paths.home, GBDEV_CONFIG: store.paths.config } });
        run.supervisor_pid = child.pid!; writeRun(store, run); child.unref();
      } catch (error) { transitionRun(store, run, 'failed', 'supervisor_start_failed'); writeRun(store, run); writeResult(store, run, request); throw error; }
      finally { closeSync(fd); }
    }
    return run;
  };
  return dryRun ? initialize() : locked(store, initialize);
}
export async function cancelRun(store: JobStore, id: string, waitMs = 20_000): Promise<Run> {
  const run = await reconcileRun(store, id); if (terminalRun(run.state)) return run;
  atomicWriteJson(runPaths(store, id).cancel, { at: localIso(), by: 'grok-bot' });
  if (supervisorAlive(run)) {
    const until = Date.now() + waitMs;
    for (;;) {
      const current = readRun(store, id); if (terminalRun(current.state)) return current;
      if (Date.now() >= until) throw new GbdevError('run_not_settled', 'Cancellation is still in progress; retry cancel or wait', { reason: 'cancel_pending', run: current });
      if (!current.supervisor_pid || !isProcessAlive(current.supervisor_pid)) break;
      await delay(50);
    }
  }
  // Minimal cancellation recovery only; restarting crashed runs belongs to S4.
  for (const job of runJobs(store, run)) {
    const p = jobPaths(store.paths, job.job_id);
    const info = JSON.parse(optionalText(p.processInfo) ?? '{}') as { worker_pgid?: number; check_pgid?: number };
    for (const pgid of [info.worker_pgid, info.check_pgid]) if (pgid) await terminateGroup(pgid);
    if (!isTerminal(job.state)) await locked(store, () => {
      const result = failureResult(store, job, null); result.state = 'cancelled'; result.failure_reason = null; result.failure_reasons = [];
      atomicWriteJson(p.result, result); transition(store, job, 'cancelled', 'grok-bot');
    });
  }
  const lock = acquireIntegrationLock(store.paths, id, 'recover');
  try {
    return await locked(store, async () => {
      const current = readRun(store, id); await restoreIntegration(store, current);
      for (const task of current.tasks) if (!['integrated', 'dropped', 'failed'].includes(task.state)) { task.state = 'cancelled'; task.lane = null; }
      for (const lane of current.lanes) if (lane.state === 'busy') lane.state = 'broken';
      for (const pipeline of allPipelines(store).filter(p => p.workspace.mode === 'per_lane' && p.workspace.run_id === id && !['succeeded', 'failed', 'cancelled'].includes(p.state))) transitionPipeline(store, pipeline, 'cancelled');
      refreshSlots(store, current);
      current.merge_queue = []; transitionRun(store, current, 'cancelled'); writeRun(store, current); writeResult(store, current, jsonFile(runPaths(store, id).request)); return current;
    });
  } finally { lock.release(); }
}
export async function launchRunSupervisor(store: JobStore, run: Run): Promise<void> {
  const fd = openSync(runPaths(store, run.run_id).log, 'a', 0o600);
  try {
    const wrapper = caffeinatePath(), args = [fileURLToPath(new URL('../cli.js', import.meta.url)), '__run-supervise', run.run_id];
    const child = await spawnProcess(wrapper ?? process.execPath, wrapper ? ['-i', process.execPath, ...args] : args, { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, GBDEV_HOME: store.paths.home, GBDEV_CONFIG: store.paths.config } });
    run.supervisor_pid = child.pid!; writeRun(store, run); child.unref();
  } finally { closeSync(fd); }
}
export async function resumeRun(store: JobStore, id: string, value: unknown, launch = true): Promise<Run> {
  await reconcileRun(store, id);
  // A settling supervisor publishes its result before relinquishing ownership.
  for (let n = 0; n < 200; n++) { const r = readRun(store, id); if (activeRun(r.state) || !supervisorAlive(r)) break; await delay(25); }
  return locked(store, async () => {
    const run = readRun(store, id), paths = runPaths(store, id), request = jsonFile<RunRequest>(paths.request), runtime = readRuntime(store, run);
    const prepared = prepareDecisions(store, run, request, value, runtime);
    if (prepared.inputs.some(i => i.action === 'resume_run')) {
      const settings = jsonFile<ReturnType<typeof loadRunConfig>>(join(paths.dir, 'settings.snapshot.json'));
      assertRunInvariants(store, run, mergeRecords(store, run), settings.parallel, undefined);
    }
    if (supervisorAlive(run)) {
      if (!activeRun(run.state)) throw new GbdevError('run_not_settled', 'Supervisor is still settling; retry resume', { reason: 'supervisor_settling', run });
      const dir = join(paths.dir, 'inputs'); mkdirSync(dir, { recursive: true });
      const queued = readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(n => jsonFile<{ decision_id: string }[]>(join(dir, n)));
      if (prepared.inputs.some(i => queued.some(q => q.decision_id === i.decision_id))) throw new GbdevError('run_state_conflict', 'Decision already submitted', { reason: 'stale_decision' });
      atomicWriteJson(join(dir, `${Date.now()}-${randomUUID()}.json`), prepared.inputs); return run;
    }
    assertIdle(store);
    prepared.apply(); writeRun(store, run);
    if (terminalRun(run.state)) writeResult(store, run, request);
    else if (launch && activeRun(run.state)) await launchRunSupervisor(store, run);
    return run;
  });
}
export async function runCommand(store: JobStore, args: string[], options: Record<string, string | boolean | undefined>): Promise<{ schema: string; result: unknown }> {
  const [command, id] = args;
  const usage = (): never => { throw new GbdevError('usage_error', 'Use run start --request <file|-> | list [--active] [--state <s>] [--limit <1..500>] | status [id] (reconciles; read-only inventory: run list) | wait <id> --timeout-ms <0..540000> [--until attention|settled] [--with-result] | result <id> | cancel <id> | resume <id> --input <file|-> | --answers-file <array-file> | cleanup <id> [--dry-run] [--force-branch] | land <id> --target <branch> --confirm-user-approved [--dry-run] [--approval-note <text>]'); };
  if (!command || !['start', 'status', 'wait', 'result', 'cancel', 'resume', 'cleanup', 'land'].includes(command) || args.length > 2 || command === 'start' && id || !['start', 'status'].includes(command) && !id) usage();
  const allowed: Record<string, string[]> = { cleanup: ['dry-run', 'force-branch'], land: ['target', 'confirm-user-approved', 'dry-run', 'approval-note'], start: ['request', 'dry-run'], resume: ['input', 'answers-file'], status: ['events', 'since'], wait: ['timeout-ms', 'until', 'with-result'] };
  for (const [key, value] of Object.entries(options)) if (value !== undefined && !(allowed[command!] ?? []).includes(key)) usage();
  if (command === 'cleanup') return { schema: 'gbdev.run-cleanup.v1', result: await cleanupRun(store, id!, options['force-branch'] === true, options['dry-run'] === true) };
  if (command === 'land') {
    if (options['confirm-user-approved'] !== true) throw new GbdevError('user_approval_required', 'run land requires --confirm-user-approved');
    if (typeof options.target !== 'string') usage();
    return { schema: 'gbdev.run-land.v1', result: await landRun(store, id!, options.target as string, true, options['dry-run'] === true, typeof options['approval-note'] === 'string' ? options['approval-note'] : null) };
  }
  if (command === 'start') {
    if (typeof options.request !== 'string') usage();
    let value: unknown; try { value = JSON.parse(readFileSync(options.request === '-' ? 0 : options.request as string, 'utf8')); } catch { throw new GbdevError('run_invalid', 'Cannot read request JSON'); }
    const started = await startRun(store, value, true, options['dry-run'] === true);
    return { schema: 'gbdev.run.v1', result: await addNotify(store.paths, options['dry-run'] ? started : await addDashboard(store.paths, started, started.run_id, 'run')) };
  }
  if (command === 'resume') {
    const file = options.input ?? options['answers-file'];
    if (typeof file !== 'string' || options.input && options['answers-file']) usage();
    let value: unknown; try { value = JSON.parse(readFileSync(file === '-' ? 0 : file as string, 'utf8')); } catch { throw new GbdevError('run_invalid', 'Cannot read resume JSON'); }
    if (options['answers-file'] && !Array.isArray(value)) throw new GbdevError('run_invalid', 'answers-file must contain an array of gbdev.run-resume.v1 inputs');
    return { schema: 'gbdev.run.v1', result: await resumeRun(store, id!, value) };
  }
  if (command === 'status') {
    if (options.events) {
      if (!id || options.since !== undefined && (typeof options.since !== 'string' || !/^\d+$/.test(options.since) || !Number.isSafeInteger(Number(options.since)))) usage();
      await reconcileRun(store, id!);
      return { schema: 'gbdev.event.v1', result: (optionalText(runPaths(store, id!).events) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { seq: number }).filter(e => e.seq > Number(options.since ?? 0)) };
    }
    if (options.since !== undefined) usage();
    const project = async (rid: string) => projectRunAttention(store, await reconcileRun(store, rid));
    return { schema: 'gbdev.run.v1', result: id ? await project(id) : await Promise.all(allRuns(store).slice(0, 20).map(r => project(r.run_id))) };
  }
  if (command === 'cancel') return { schema: 'gbdev.run.v1', result: await cancelRun(store, id!) };
  const result = async () => locked(store, () => { const run = readRun(store, id!); if (activeRun(run.state)) throw new GbdevError('run_not_settled', 'Run is active', { run }); return writeResult(store, run, jsonFile<RunRequest>(runPaths(store, id!).request)); });
  if (command === 'result') return { schema: 'gbdev.run-result.v1', result: await result() };
  const timeout = Number(options['timeout-ms']), until = options.until ?? 'attention';
  if (typeof options['timeout-ms'] !== 'string' || !/^\d+$/.test(options['timeout-ms']) || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > 540_000 || !['attention', 'settled'].includes(String(until))) usage();
  const deadline = Date.now() + timeout;
  for (;;) {
    let run = await reconcileRun(store, id!);
    // Attention can precede the supervisor's settled state publication. Refresh once;
    // running + attention remains valid while independent work is active.
    if (until === 'attention' && activeRun(run.state) && run.attention.length) run = await reconcileRun(store, id!);
    if (!activeRun(run.state) || until === 'attention' && run.attention.length) {
      if (options['with-result'] && !activeRun(run.state)) return { schema: 'gbdev.run-result.v1', result: await result() };
      return { schema: 'gbdev.run.v1', result: run };
    }
    if (Date.now() >= deadline) throw new GbdevError('wait_timeout', 'Run wait timed out', { run });
    await delay(Math.min(100, deadline - Date.now()));
  }
}
export function runText(result: unknown): string {
  if (Array.isArray(result)) return result.map(runText).join('');
  if (result && typeof result === 'object' && 'schema' in result && result.schema === 'gbdev.event.v1') { const e = result as unknown as { seq: number; type: string; data: unknown }; return `${e.seq} ${e.type} ${JSON.stringify(e.data)}\n`; }
  if (result && typeof result === 'object' && 'schema' in result && ['gbdev.run-cleanup.v1', 'gbdev.run-land.v1'].includes(String(result.schema))) return JSON.stringify(result, null, 2) + '\n';
  const r = result as Run;
  const hint = r.attention?.some(a => a.accept_requirements?.length) ? `${VERDICT_MISSING_STATUS_HINT}\n` : '';
  return `${r.run_id} ${r.state}${r.state_reason ? `: ${r.state_reason}` : ''}\n${r.lanes?.map(l => `${l.lane} ${l.state} ${l.task_id ?? ''}`).join('\n') ?? ''}\n${hint}Next: gbdev run ${activeRun(r.state) ? 'wait' : 'result'} ${r.run_id}${activeRun(r.state) ? ' --timeout-ms 540000 --with-result' : ''}\n`;
}
