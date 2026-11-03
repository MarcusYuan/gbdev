import { notifySupervisorStarted } from '../notify/enqueue.js';
import { dashboardSupervision } from '../core/dashboardSupervision.js';
import { withRunProcesses } from '../core/processRegistry.js';
import { existsSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Run, RunTask, RunAttention } from '../contracts/run.js';
import type { RunRequest } from '../contracts/runRequest.js';
import type { MergeRecord } from '../contracts/mergeRecord.js';
import { validateMergeRecord } from '../contracts/mergeRecord.js';
import type { resolveRequest, RoleSnapshot } from '../contracts/pipelineRequest.js';
import type { SeedFindings } from '../contracts/seedFindings.js';
import type { PipelineRun } from '../contracts/pipelineRun.js';
import { isTerminal } from '../contracts/jobStatus.js';
import { GbdevError } from '../contracts/error.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { locked, optionalText } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { isProcessAlive } from '../core/lock.js';
import { headAsync, dirtyAsync, gitGuardedAsync, mergeTreeCheckAsync, git, mergeNoFfAsync } from '../core/git.js';
import { jobPaths } from '../core/paths.js';
import { matchesAllowed } from '../core/glob.js';
import type { loadRunConfig } from '../core/runConfig.js';
import { runPipeline } from '../commands/pipeline.js';
import { reconcileInspectReservation } from '../commands/status.js';
import { allRuns as pipelines, pipelinePaths, readRun as readPipeline, transitionRun as transitionPipeline, writeRun as writePipeline } from '../pipeline/store.js';
import type { PipelineSlotHooks } from '../pipeline/supervisor.js';
import { LaneManager, type Lane } from './lanes.js';
import { openIntegration } from './integration.js';
import { acquireIntegrationLock } from './integrationLock.js';
import { acquireSlot, coolDown, releaseSlot, schedule } from './scheduler.js';
import { jsonFile, readRun, runEvent, runPaths, taskState, terminalRun, transitionRun, writeRun } from './store.js';
import { runGate } from './gate.js';
import { assertRunInvariantsAsync, refreshSlots, runJobs } from './invariants.js';
import { mergeRecords, writeResult } from './result.js';
import { valueForDefinition } from './requests.js';
import { integrationFixContextLine, rebuildOrRetryLine } from './promptAssembly.js';
import { localSupervisors, reconcileRun, supervisorAlive, restoreRunIntegration } from './reconcile.js';
import { BudgetExhausted, requireDecision, readRuntime, writeRuntime, prepareDecisions } from './decisions.js';
import { supervisePipeline } from '../pipeline/supervisor.js';
import { renderUntrustedData } from '../pipeline/prompt.js';
import { resolveConflict, verifyConflict } from './conflicts.js';
import { planRun } from './planner.js';
import type { TaskGraph } from '../contracts/taskGraph.js';
import { finalReview } from './finalReview.js';

/** CLI dead-supervisor cancel cleanup; live cancellation uses restoreRunIntegration. */
export async function restoreIntegration(store: JobStore, run: Run): Promise<void> {
  if (!existsSync(run.integration.worktree)) return;
  const context = { paths: store.paths, run_id: run.run_id, repo: run.repo, branch: run.integration.branch, worktree: run.integration.worktree };
  await gitGuardedAsync(context, { operation: 'resetHard', sha: run.integration.verified_sha }); await gitGuardedAsync(context, { operation: 'clean' });
  run.integration.head_sha = await headAsync(context.worktree); run.integration.merging = null;
  if (run.integration.head_sha !== run.integration.verified_sha || await dirtyAsync(context.worktree)) throw new Error('integration_corrupt');
}
async function superviseRunWork(store: JobStore, id: string, testHooks: { beforePublish?: (run: Run) => void } = {}): Promise<void> {
  if (localSupervisors.has(id)) throw new GbdevError('busy', 'Run already has an in-process supervisor');
  const existing = readRun(store, id);
  if (existing.supervisor_pid && existing.supervisor_pid !== process.pid && existing.supervisor_pid !== process.ppid && !supervisorAlive(existing)) await reconcileRun(store, id);
  localSupervisors.add(id);
  try { return await withRunProcesses(runPaths(store, id).dir, () => superviseRunOwned(store, id, testHooks)); }
  finally { localSupervisors.delete(id); }
}
async function superviseRunOwned(store: JobStore, id: string, testHooks: { beforePublish?: (run: Run) => void }): Promise<void> {
  const paths = runPaths(store, id);
  const run = await locked(store, () => {
    const r = readRun(store, id);
    if (!['queued', 'planning', 'running', 'finalizing'].includes(r.state) || r.supervisor_pid && r.supervisor_pid !== process.pid && r.supervisor_pid !== process.ppid && isProcessAlive(r.supervisor_pid)) throw new GbdevError('busy', 'Run already has a supervisor');
    r.supervisor_pid = process.pid; r.heartbeat_at = localIso(); if (r.state === 'queued') transitionRun(store, r, 'starting'); writeRun(store, r); return r;
  });
  const request = jsonFile<RunRequest>(paths.request);
  if (existsSync(join(paths.dir, 'task-graph.json'))) request.tasks = jsonFile<TaskGraph>(join(paths.dir, 'task-graph.json')).tasks;
  const { parallel, run_defaults: defaults } = jsonFile<ReturnType<typeof loadRunConfig>>(join(paths.dir, 'settings.snapshot.json'));
  const execution = jsonFile<Record<string, ReturnType<typeof resolveRequest>>>(join(paths.dir, 'execution.snapshot.json'));
  const snapshots = jsonFile<Record<string, RoleSnapshot>>(paths.snapshot);
  const abort = new AbortController();
  const options = { signal: abort.signal, paths: store.paths, repo: run.repo, run_id: id, worktree_setup_cmd: request.worktree_setup_cmd };
  const manager = new LaneManager(options, run.lanes);
  const active = new Map<string, Promise<void>>(), completed: { task: RunTask; lane: Lane; pipeline?: PipelineRun; error?: unknown }[] = [];
  const runtime = readRuntime(store, run);
  const lastLane = new Map<string, string>(), seeds = new Map<string, SeedFindings>(Object.entries(runtime.seeds));
  let reservations = 0;
  let leases = structuredClone(run.slots), merging: Promise<void> | undefined, mergeError: unknown, cancelling = false;
  const context = () => ({ ...options, branch: run.integration.branch, worktree: run.integration.worktree });
  // External users may advance the target; write guards enforce I6, not ref immobility.
  const protectedRefs = undefined;
  const publish = async (fn: () => void = () => {}) => locked(store, () => {
    fn(); runtime.seeds = Object.fromEntries(seeds); writeRuntime(store, run, runtime); refreshSlots(store, run);
    run.heartbeat_at = localIso(); testHooks.beforePublish?.(run); writeRun(store, run);
  });
  const heartbeat = setInterval(() => { void publish().catch(() => {}); }, 30_000);
  const attention = (task: RunTask | null, reason: RunAttention['reason'], detail: string, actions: RunAttention['allowed_actions'], questions: RunAttention['pending_questions'] = []) => requireDecision(store, run, task, reason, detail, actions, questions);
  const makeHooks = (): PipelineSlotHooks => { let reservation = false; return {
    signal: abort.signal,
    orchestratorNotes: taskId => [...(runtime.run_notes ?? []), taskId ? runtime.task_notes?.[taskId] ?? runtime.modes[taskId]?.note : null],
    async acquireSlot(provider, signal) {
      for (;;) {
        if (signal.aborted || abort.signal.aborted) throw new Error('Run cancelled');
        const inspectRecovery = reconcileInspectReservation(store);
        if (inspectRecovery) await inspectRecovery;
        const acquired = await locked(store, () => {
          if (runJobs(store, run).length + reservations >= run.budget.max_total_jobs) throw new BudgetExhausted();
          const next = acquireSlot(leases, parallel, provider, Date.now(), store); if (!next) return false;
          reservations++; reservation = true; leases = next; return true;
        });
        if (acquired) return;
        await delay(25);
      }
    },
    onJobCreated() { if (reservation) { reservations--; reservation = false; } },
    async releaseSlot(provider) { await locked(store, () => { if (reservation) { reservations--; reservation = false; } leases = releaseSlot(leases, provider); }); },
    async onRateLimit(provider) { await publish(() => { leases = coolDown(leases, provider, Date.now(), parallel.rate_limit_cooldown_s); run.slots.cooldown_until = { ...leases.cooldown_until }; runEvent(store, run, 'provider_cooldown', { provider, until: leases.cooldown_until[provider] }); }); },
  }; };
  const hooks = makeHooks();
  const stopWorkers = () => {
    abort.abort();
    for (const p of pipelines(store).filter(p => p.workspace.mode === 'per_lane' && p.workspace.run_id === id && !['succeeded', 'failed', 'cancelled'].includes(p.state))) atomicWriteJson(pipelinePaths(store, p.pipeline_id).cancel, { at: localIso() });
    for (const job of runJobs(store, run).filter(j => !isTerminal(j.state))) atomicWriteJson(jobPaths(store.paths, job.job_id).cancelRequest, { at: localIso() });
  };
  const requestStop = () => { cancelling = true; stopWorkers(); };
  process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop);
  const monitor = setInterval(() => {
    if (optionalText(paths.cancel) !== null || Date.now() >= Date.parse(run.deadline_at)) requestStop();
    if (cancelling) {
      for (const p of pipelines(store).filter(p => p.workspace.mode === 'per_lane' && p.workspace.run_id === id && !['succeeded', 'failed', 'cancelled'].includes(p.state))) atomicWriteJson(pipelinePaths(store, p.pipeline_id).cancel, { at: localIso() });
      for (const job of runJobs(store, run).filter(j => !isTerminal(j.state))) atomicWriteJson(jobPaths(store.paths, job.job_id).cancelRequest, { at: localIso() });
    }
  }, 50);
  const persistRecord = (record: MergeRecord) => atomicWriteJson(join(paths.merges, `${record.seq}.json`), validateMergeRecord(record));
  const integrate = async (task: RunTask): Promise<void> => {
    const seq = mergeRecords(store, run).length + 1, pre = run.integration.verified_sha;
    let lock;
    for (;;) {
      try { lock = acquireIntegrationLock(store.paths, id, 'merge', seq); break; }
      catch (e) { if (!(e instanceof GbdevError) || !['busy', 'integration_locked'].includes(e.contract.code) || abort.signal.aborted) throw e; await delay(50); }
    }
    const record: MergeRecord = { schema: 'gbdev.merge-record.v1', run_id: id, seq, task_id: task.task_id, task_head_sha: task.head_sha!, pre_merge_sha: pre,
      precheck: { clean: true, conflict_files: [], tree: null }, resolution: null, merge_sha: null, gate: null, result: 'aborted_crash', rolled_back_to: null, started_at: localIso(), finished_at: localIso() };
    let published = false;
    const checkpoint = () => atomicWriteJson(join(paths.merges, `${seq}.pending.json`), record);
    checkpoint();
    try {
      if (await headAsync(run.integration.worktree, abort.signal) !== pre || await dirtyAsync(run.integration.worktree, abort.signal)) await restoreRunIntegration(store, run);
      await publish(() => { run.warnings.push(...lock.warnings); task.merge_seq.push(seq); taskState(store, run, task, 'merging'); run.integration.merging = { seq, task_id: task.task_id, phase: 'precheck', started_at: record.started_at }; });
      record.precheck = await mergeTreeCheckAsync(run.repo, pre, task.head_sha!, abort.signal);
      await publish(() => { runEvent(store, run, 'merge_precheck', { ...record.precheck, seq }, task); });
      checkpoint();
      let resolved = record.precheck.clean;
      if (!resolved) {
        await publish(() => { run.integration.merging!.phase = 'resolving'; });
        resolved = await resolveConflict(store, run, request, task, record, context(), snapshots, hooks, abort.signal, runtime.resolve_extra[task.task_id] ? 1 : defaults.max_resolver_attempts, defaults.max_conflict_files, checkpoint);
      }
      if (!resolved) {
        await restoreRunIntegration(store, run);
        record.result = 'aborted_conflict_unresolved';
        await publish(() => { attention(task, 'merge_conflict_unresolved', record.precheck.conflict_files.join(', '), ['retry_resolve', 'rebuild_task', 'drop_task']); });
      } else if (!abort.signal.aborted) {
        await publish(() => { run.integration.merging!.phase = 'merging'; });
        if (record.precheck.clean) {
          try { record.merge_sha = await mergeNoFfAsync(context(), task.head_sha!, `gbdev: merge ${task.task_id} (${id})`, abort.signal); }
          catch (e) {
            if (abort.signal.aborted) throw e;
            record.precheck = { clean: false, conflict_files: [], tree: null };
            await publish(() => { run.integration.merging!.phase = 'resolving'; });
            const resolved = await resolveConflict(store, run, request, task, record, context(), snapshots, hooks, abort.signal, defaults.max_resolver_attempts, defaults.max_conflict_files, checkpoint);
            if (!resolved) { await restoreRunIntegration(store, run); record.result = 'aborted_conflict_unresolved'; await publish(() => { attention(task, 'merge_conflict_unresolved', String(e), ['retry_resolve', 'rebuild_task', 'drop_task']); }); return; }
          }
        }
        await publish(() => { run.integration.head_sha = record.merge_sha!; run.integration.merging!.phase = 'gating'; runEvent(store, run, 'merge_committed', { seq, sha: record.merge_sha }, task); runEvent(store, run, 'gate_started', { seq }, task); });
        const checkIds = [...request.integration_checks, ...[task, ...run.tasks.filter(t => t.state === 'integrated')].flatMap(t => request.tasks!.find(g => g.id === t.task_id)!.acceptance_criteria.flatMap(c => c.check ? [c.check] : [])), ...request.acceptance_criteria.flatMap(c => c.check ? [c.check] : [])];
        const result = await runGate(context(), request, checkIds, join(paths.merges, `${seq}.gate`), abort.signal, defaults.gate_timeout_min * 60_000);
        record.gate = result.gate; record.warnings = result.warnings;
        const failedChecks = [...new Map(result.gate.checks.map(c => [c.id, c])).values()].filter(c => c.exit_code !== 0).map(c => c.id);
        await publish(() => { run.warnings.push(...result.warnings); runEvent(store, run, 'gate_finished', { seq, passed: result.gate.passed, failed_checks: failedChecks }, task); });
        let verified = true;
        if (result.gate.passed && record.resolution && !abort.signal.aborted) {
          await publish(() => { run.integration.merging!.phase = 'verifying'; });
          verified = await verifyConflict(store, run, request, task, record, context(), snapshots, hooks, abort.signal);
        }
        checkpoint();
        if (result.gate.passed && verified && !abort.signal.aborted) {
          await publish(() => {
            run.integration.verified_sha = record.merge_sha!; run.integration.merges++; task.merged_sha = record.merge_sha; taskState(store, run, task, 'integrated');
            const p = readPipeline(store, task.attempts.at(-1)!.pipeline_id); p.integration!.merge_state = 'merged'; p.integration!.merged_sha = record.merge_sha; writePipeline(store, p);
            atomicWriteJson(join(paths.dir, 'final-gate.json'), { sha: record.merge_sha, passed: true });
          });
          record.result = 'integrated'; record.finished_at = localIso(); persistRecord(record); published = true;
        } else {
          await publish(() => { run.integration.merging!.phase = 'rolling_back'; });
          await gitGuardedAsync(context(), { operation: 'resetHard', sha: pre }); await gitGuardedAsync(context(), { operation: 'clean' }); record.rolled_back_to = pre;
          record.result = abort.signal.aborted ? 'aborted_cancelled' : !verified ? 'aborted_verifier_rejected' : 'rolled_back_gate_failed';
          const rolledBackHead = await headAsync(run.integration.worktree);
          await publish(() => {
            run.integration.head_sha = pre; run.integration.rollbacks++; runEvent(store, run, 'merge_rolled_back', { seq, pre_merge_sha: pre, head_sha: rolledBackHead }, task);
            if (!abort.signal.aborted) {
              if (!verified) attention(task, 'merge_conflict_unresolved', JSON.stringify(record.resolution), ['retry_resolve', 'rebuild_task', 'drop_task']);
              else if (task.integration_fixes < (runtime.fix_limits[task.task_id] ?? request.max_integration_fixes)) {
                task.integration_fixes++; taskState(store, run, task, 'ready');
                const failed = failedChecks;
                seeds.set(task.task_id, { source: 'integration_gate', findings: (failed.length ? failed : ['gate']).map((c, i) => ({ id: `C${i + 1}`, severity: 'major', file: null, line: null, text: `Integration check failed: ${c}` })), logs: failed.map(check_id => ({ check_id, tail: (optionalText(join(result.gate.log_dir, `${check_id}.log`)) ?? '').trimEnd().split('\n').slice(-80).join('\n') })) });
              } else attention(task, 'integration_gate_failed', `Gate failed after ${task.integration_fixes} integration fixes; logs: ${result.gate.log_dir}`, ['extra_fix', 'rebuild_task', 'drop_task']);
            }
          });
        }
      }
      if (abort.signal.aborted && !published) { await restoreRunIntegration(store, run); record.result = 'aborted_cancelled'; record.rolled_back_to = pre; }
    } catch (error) {
      const persisted = readRun(store, id);
      run.integration.verified_sha = persisted.integration.verified_sha;
      if (persisted.integration.verified_sha === record.merge_sha) { record.result = 'integrated'; persistRecord(record); published = true; }
      else { Object.assign(task, persisted.tasks.find(t => t.task_id === task.task_id)!); }
      await restoreRunIntegration(store, run); record.rolled_back_to = published ? null : pre;
      if (abort.signal.aborted) record.result = 'aborted_cancelled';
      else if (error instanceof BudgetExhausted) { await publish(() => { task.state = 'paused'; runtime.budget_waiting.push(task.task_id); writeRuntime(store, run, runtime); }); }
      else throw error;
    } finally {
      try {
      if (!published) { record.finished_at = localIso(); persistRecord(record); }
      if (existsSync(join(paths.merges, `${seq}.pending.json`))) unlinkSync(join(paths.merges, `${seq}.pending.json`));
      const settledHead = await headAsync(run.integration.worktree);
      await publish(() => { run.integration.head_sha = settledHead; run.integration.merging = null; }); } finally { lock?.release(); }
    }
  };
  const copyLane = (target: Lane, staged: Lane) => { delete target.verified_sha; Object.assign(target, staged); };
  const launch = (task: RunTask, lane: Lane, staged: Lane, verified: string) => {
    const taskHooks = makeHooks();
    const work = (async () => {
      try {
        const graph = request.tasks!.find(t => t.id === task.task_id)!, fixing = seeds.get(task.task_id)?.source === 'integration_gate';
        const mode = runtime.modes[task.task_id];
        const oldDiff = mode?.kind === 'rebuild' && task.base_sha && task.head_sha ? await git(run.repo, ['diff', '--stat', task.base_sha, task.head_sha, '--'], 120_000, abort.signal) : null;
        if (mode?.kind === 'resume') {
          await manager.resumeAsync(staged, task.task_id, task.branch!, task.head_sha!);
          await publish(() => { copyLane(lane, staged); const p = readPipeline(store, mode.pipeline_id!); const from = p.workspace.mode === 'per_lane' ? p.workspace.lane : ''; p.workspace = { mode: 'per_lane', run_id: id, task_id: task.task_id, lane: lane.lane, worktree: lane.worktree, branch: task.branch! }; const pp = pipelinePaths(store, p.pipeline_id); const req = jsonFile<Record<string, unknown>>(pp.request); req.run_binding = { run_id: id, task_id: task.task_id, lane: lane.lane, worktree: lane.worktree, branch: task.branch! }; atomicWriteJson(pp.request, req); p.supervisor_pid = process.pid; if (p.state === 'needs_decision' && p.state_reason === 'run_budget_exhausted') transitionPipeline(store, p, 'running'); p.state_history.push({ state: p.state, at: localIso(), by: 'gbdev', reason: `lane_moved:${from}->${lane.lane}` }); writePipeline(store, p); delete runtime.modes[task.task_id]; writeRuntime(store, run, runtime); });
          await supervisePipeline(store, mode.pipeline_id!, taskHooks); completed.push({ task, lane, pipeline: readPipeline(store, mode.pipeline_id!) }); return;
        }
        if (fixing) {
          await manager.resumeAsync(staged, task.task_id, task.branch!, task.head_sha!);
          const precheck = await mergeTreeCheckAsync(run.repo, task.head_sha!, verified, abort.signal);
          const laneContext = { ...options, branch: task.branch!, worktree: lane.worktree };
          if (!precheck.clean) {
            let refreshLock;
            try {
              while (!refreshLock) { if (abort.signal.aborted) throw new Error('Run cancelled'); try { refreshLock = acquireIntegrationLock(store.paths, id, 'merge'); } catch (e) { if (!(e instanceof GbdevError) || !['busy', 'integration_locked'].includes(e.contract.code)) throw e; await delay(50); } }
              const at = localIso(), seq = task.merge_seq.at(-1) ?? 1;
              const record: MergeRecord = { schema: 'gbdev.merge-record.v1', run_id: id, seq, task_id: task.task_id, task_head_sha: verified, pre_merge_sha: task.head_sha!, precheck, resolution: null, merge_sha: null, gate: null, result: 'aborted_crash', rolled_back_to: null, started_at: at, finished_at: at };
              const artifact = join(paths.dir, `refresh-${task.task_id}-${task.integration_fixes}.json`);
              const checkpoint = () => atomicWriteJson(artifact, { purpose: 'lane_refresh', record });
              const resolved = await resolveConflict(store, run, request, task, record, laneContext, snapshots, taskHooks, abort.signal, runtime.resolve_extra[task.task_id] ? 1 : defaults.max_resolver_attempts, defaults.max_conflict_files, checkpoint);
              if (!resolved) throw new Error(`merge_conflict_unresolved: ${precheck.conflict_files.join(', ')}`);
              const gate = await runGate(laneContext, request, [...request.integration_checks, ...graph.acceptance_criteria.flatMap(c => c.check ? [c.check] : [])], join(paths.dir, `refresh-${task.task_id}-${task.integration_fixes}.gate`), abort.signal, defaults.gate_timeout_min * 60_000);
              record.gate = gate.gate; checkpoint();
              if (!gate.gate.passed || !await verifyConflict(store, run, request, task, record, laneContext, snapshots, taskHooks, abort.signal)) {
                await gitGuardedAsync(laneContext, { operation: 'resetHard', sha: record.pre_merge_sha }); await gitGuardedAsync(laneContext, { operation: 'clean' });
                checkpoint(); throw new Error('merge_conflict_unresolved: lane refresh gate/verifier rejected');
              }
              checkpoint();
            } finally { refreshLock?.release(); }
          } else await mergeNoFfAsync(laneContext, verified, `gbdev: refresh ${task.task_id} onto integration ${verified.slice(0, 8)}`, abort.signal);
        } else {
          let reusable = false;
          if (task.branch && task.head_sha) { try { await git(run.repo, ['merge-base', '--is-ancestor', task.head_sha, verified], 120_000, abort.signal); reusable = true; } catch (e) { if ((e as { status?: number }).status !== 1) throw e; } }
          if (reusable) {
            await gitGuardedAsync({ ...options, branch: task.branch!, worktree: lane.worktree }, { operation: 'updateRefCas', expected: task.head_sha!, sha: verified }, 120_000, abort.signal);
            await manager.resumeAsync(staged, task.task_id, task.branch!, verified);
          } else { const generation = task.branch ? (runtime.generation[task.task_id] ?? 1) + 1 : 1;
            await manager.startAsync(staged, task.task_id, verified, generation); runtime.generation[task.task_id] = generation; }
        }
        // After refresh, compare the complete task (including its original changes) to
        // the integration parent, not the refresh merge commit or the original base.
        await publish(() => { copyLane(lane, staged); task.branch = staged.branch; task.base_sha = verified; runEvent(store, run, 'lane_assigned', { branch: task.branch, base_sha: task.base_sha }, task, lane.lane); });
        const prepared = execution[fixing ? 'internal:integration-fix' : `task:${task.task_id}`]!;
        const previous = task.attempts.at(-1);
        const history = previous ? optionalText(join(pipelinePaths(store, previous.pipeline_id).dir, 'result.json')) : null;
        const value = { ...valueForDefinition(request, graph, prepared.definition), ...(mode ? { context: `${request.context}\n${graph.context}\n${rebuildOrRetryLine(mode.kind === 'rebuild' ? 'rebuild' : 'retry')}\n${renderUntrustedData(JSON.stringify({ previous: history, old_diff_summary: oldDiff }))}` } : {}), base_ref: await headAsync(lane.worktree, abort.signal), diff_base_ref: task.base_sha,
          ...(seeds.get(task.task_id)?.source === 'final_review' ? { seed_findings: seeds.get(task.task_id) } : {}),
          ...(fixing ? { seed_findings: seeds.get(task.task_id), context: `${request.context}\n${graph.context}\n${integrationFixContextLine(run.tasks.filter(t => t.state === 'integrated').map(t => t.task_id).join(', '))}` } : {}),
          run_binding: { run_id: id, task_id: task.task_id, lane: lane.lane, worktree: lane.worktree, branch: task.branch! } };
        const pipeline = await runPipeline(store, value, { ...taskHooks, onPipelineCreated(p) {
          lane.pipeline_id = p.pipeline_id; task.attempts.push({ pipeline_id: p.pipeline_id, kind: fixing ? 'integration_fix' : mode?.kind === 'rebuild' ? 'rebuild' : mode?.kind === 'retry' ? 'retry' : graph.pipeline === 'final-fix' ? 'final_fix' : 'initial', state: 'running', outcome: null }); writeRun(store, run);
        } }, prepared);
        delete runtime.modes[task.task_id]; writeRuntime(store, run, runtime);
        completed.push({ task, lane, pipeline });
      } catch (error) { await publish(() => { if (!abort.signal.aborted) copyLane(lane, staged); }); completed.push({ task, lane, error }); }
    })();
    active.set(task.task_id, work);
  };
  try {
    if (run.state === 'starting') {
    const integration = await openIntegration(options, run.base_sha);
    await publish(() => { run.integration = integration; });
    const baselineLock = acquireIntegrationLock(store.paths, id, 'merge');
    let baseline;
    try {
      runEvent(store, run, 'gate_started', { baseline: true });
      baseline = await runGate(context(), request, request.integration_checks, join(paths.dir, 'baseline.gate'), abort.signal, defaults.gate_timeout_min * 60_000);
    } finally { baselineLock.release(); }
    await publish(() => { run.warnings.push(...baseline.warnings); runEvent(store, run, 'gate_finished', { baseline: true, passed: baseline.gate.passed }); atomicWriteJson(join(paths.dir, 'baseline-gate.json'), baseline); });
    if (!baseline.gate.passed && !cancelling) { run.warnings.push(`baseline_checks_failed:${baseline.gate.log_dir}`); await restoreRunIntegration(store, run); throw new Error('baseline_checks_failed'); }
    if (!cancelling) for (let n = 1; n <= request.lanes; n++) {
      const lane = await manager.create(n, run.base_sha);
      await publish(() => { run.lanes = manager.lanes; runEvent(store, run, 'lane_setup', {}, undefined, lane.lane); });
    }
    if (!cancelling) await publish(() => transitionRun(store, run, request.decompose === 'planner' ? 'planning' : 'running'));
    }
    if (!cancelling && run.state === 'planning') { await planRun(store, run, request, snapshots['internal:planner']!, hooks, abort.signal, runtime, publish); return; }
    const inputDir = join(paths.dir, 'inputs'); mkdirSync(inputDir, { recursive: true });
    while (!cancelling && run.state !== 'succeeded') {
      for (const name of readdirSync(inputDir).filter(n => n.endsWith('.json')).sort()) {
        await publish(() => {
          try { const values = jsonFile(join(inputDir, name)); const prepared = prepareDecisions(store, run, request, values, runtime); prepared.apply(); Object.assign(execution, jsonFile(join(paths.dir, 'execution.snapshot.json'))); Object.assign(snapshots, jsonFile(paths.snapshot)); seeds.clear(); for (const [key, seed] of Object.entries(runtime.seeds)) seeds.set(key, seed); }
          catch (e) { runEvent(store, run, 'warning', { code: 'run_state_conflict', input: name, detail: String(e) }); }
          unlinkSync(join(inputDir, name));
        });
      }
      if ((run as Run).state === 'succeeded') break;
      // Git lifecycle work is staged off the global lock; only state publication holds it.
      for (const done of completed.splice(0)) {
        const { task, lane, pipeline, error } = done, staged = structuredClone(lane);
        let taskHead = task.head_sha, parkError: unknown, scope: string[] = [];
        try { if (staged.state === 'busy') taskHead = (await manager.parkAsync(staged, run.integration.verified_sha)).head_sha; }
        catch (e) { parkError = e; }
        if (pipeline?.state === 'succeeded' && staged.state !== 'broken') scope = (await git(run.repo, ['diff', '--name-only', '-z', task.base_sha!, taskHead!, '--'], 120_000, abort.signal)).split('\0').filter(p => p && !matchesAllowed(p, request.tasks!.find(g => g.id === task.task_id)!.file_scope));
        await publish(() => {
          copyLane(lane, staged); task.head_sha = taskHead;
          active.delete(task.task_id); lastLane.set(task.task_id, lane.lane);
          if (pipeline) Object.assign(task.attempts.at(-1)!, { state: pipeline.state, outcome: pipeline.outcome });
          task.lane = null; runEvent(store, run, 'lane_released', { pipeline_id: pipeline?.pipeline_id ?? null }, task, lane.lane);
          if (lane.state === 'broken') { attention(task, 'lane_broken', String(parkError ?? error ?? 'Lane is broken'), ['retry_task', 'drop_task']); return; }
          if (pipeline?.state === 'succeeded') {
            task.scope_exceeded = scope;
            if (scope.length) run.warnings.push(`scope_exceeded:${task.task_id}`);
            seeds.delete(task.task_id); taskState(store, run, task, 'merge_queued');
            if (!run.merge_queue.includes(task.task_id)) run.merge_queue.push(task.task_id);
            runEvent(store, run, 'merge_queued', { pipeline_id: pipeline.pipeline_id, head_sha: task.head_sha }, task);
          } else if (pipeline?.state === 'needs_decision' && pipeline.state_reason === 'run_budget_exhausted') {
            taskState(store, run, task, 'paused'); runtime.modes[task.task_id] = { kind: 'resume', pipeline_id: pipeline.pipeline_id };
            if (!runtime.budget_waiting.includes(task.task_id)) runtime.budget_waiting.push(task.task_id); writeRuntime(store, run, runtime);
          } else {
            const paused = pipeline && ['needs_input', 'blocked', 'needs_decision'].includes(pipeline.state);
            const conflict = error && String(error).includes('merge_conflict_unresolved');
            if (conflict && seeds.has(task.task_id)) task.state_reason = 'refresh_conflict';
            const policyWarnings = pipeline?.warnings.filter(w => w.startsWith('policy_self_report')) ?? [];
            const detail = String(error ?? pipeline?.state_reason ?? pipeline?.failure_reason ?? '') + (policyWarnings.length ? `\nPolicy warnings: ${JSON.stringify(policyWarnings)}` : '');
            attention(task, conflict ? 'merge_conflict_unresolved' : paused ? 'task_paused' : 'task_failed', detail, conflict ? ['retry_resolve', 'rebuild_task', 'drop_task'] : paused ? [...(pipeline.decision?.allowed_actions ?? []), 'drop_task'] as RunAttention['allowed_actions'] : ['retry_task', 'rebuild_task', 'drop_task'], paused ? pipeline.pending_questions : []);
            if (paused) taskState(store, run, task, 'paused');
          }
        });
      }
      if (cancelling) break;
      if (mergeError) throw mergeError;
      if (!merging && run.merge_queue.length) {
        const task = await locked(store, () => {
          const next = run.merge_queue.shift()!; writeRun(store, run);
          return run.tasks.find(t => t.task_id === next)!;
        });
        merging = integrate(task).catch(e => { mergeError = e; }).finally(() => { merging = undefined; });
      }
      const inspected: Lane[] = [];
      for (const l of run.lanes.filter(l => l.state === 'idle')) { const staged = structuredClone(l); await manager.inspectAsync(staged); inspected.push(staged); }
      const starts: { task: RunTask; lane: Lane; staged: Lane; verified: string }[] = [];
      await publish(() => {
        for (const staged of inspected) Object.assign(run.lanes.find(l => l.lane === staged.lane)!, staged);
        for (const task of run.tasks) if (task.state === 'pending' && task.depends_on.every(dep => run.tasks.find(t => t.task_id === dep)?.state === 'integrated')) taskState(store, run, task, 'ready');
        const tasks = run.tasks.map(t => ({ ...request.tasks!.find(g => g.id === t.task_id)!, state: t.state, lane: t.lane ?? lastLane.get(t.task_id) ?? null, provider: snapshots[seeds.get(t.task_id)?.source === 'integration_gate' ? 'internal:integration-fix' : `task:${t.task_id}`]!.steps[seeds.get(t.task_id)?.source === 'integration_gate' ? 'fix' : execution[`task:${t.task_id}`]!.definition.steps[0]!.id]!.provider, integration_fix: seeds.get(t.task_id)?.source === 'integration_gate' }));
        const scheduled = schedule(tasks, run.lanes.filter(l => l.state === 'idle'), leases, parallel, Date.now(), request.overlap_policy);
        for (const w of scheduled.warnings) if (!run.warnings.includes(`${w.task_id}:${w.warning}`)) run.warnings.push(`${w.task_id}:${w.warning}`);
        for (const assignment of run.budget.jobs_used + reservations >= run.budget.max_total_jobs ? [] : scheduled.assignments) {
          const task = run.tasks.find(t => t.task_id === assignment.task_id)!, lane = run.lanes.find(l => l.lane === assignment.lane)!;
          if (task.state !== 'ready' || active.has(task.task_id)) continue;
          starts.push({ task, lane, staged: structuredClone(lane), verified: run.integration.verified_sha });
          lane.state = 'busy'; lane.task_id = task.task_id; task.lane = lane.lane; taskState(store, run, task, 'running');
        }
      });
      for (const start of starts) launch(start.task, start.lane, start.staged, start.verified);
      if (completed.length) continue; // Harvest synchronous allocation failures before checking lane ownership.
      if (run.lanes.length && run.lanes.every(l => l.state === 'broken')) throw new Error('all_lanes_broken');
      const observed = structuredClone(run), jobs = refreshSlots(store, observed);
      const signature = JSON.stringify({ integration: run.integration, tasks: run.tasks, lanes: run.lanes });
      try { await assertRunInvariantsAsync(store, observed, mergeRecords(store, run), parallel, protectedRefs, jobs, abort.signal); }
      catch (e) { if (signature === JSON.stringify({ integration: run.integration, tasks: run.tasks, lanes: run.lanes })) throw e; }
      await publish();
      if (run.budget.jobs_used >= Math.ceil(run.budget.max_total_jobs * 0.8) && !run.warnings.includes(`budget_warning:${run.budget.max_total_jobs}`)) await publish(() => { run.warnings.push(`budget_warning:${run.budget.max_total_jobs}`); runEvent(store, run, 'budget_warning', { jobs_used: run.budget.jobs_used, max_total_jobs: run.budget.max_total_jobs }); });
      const exhausted = run.budget.jobs_used >= run.budget.max_total_jobs;
      if (exhausted && !run.attention.some(d => d.reason === 'run_budget_exhausted')) await publish(() => { attention(null, 'run_budget_exhausted', 'Worker job budget exhausted', [...(!run.budget.extended && run.budget.max_total_jobs < 120 ? ['extend_budget' as const] : []), ...(run.tasks.every(t => ['integrated', 'dropped'].includes(t.state)) ? ['accept_final' as const] : [])]); });
      if (!active.size && !merging && !run.merge_queue.length) {
        if (run.tasks.every(t => ['integrated', 'dropped'].includes(t.state))) break;
        if ((exhausted || !run.tasks.some(t => t.state === 'ready')) && run.attention.length) { await publish(() => transitionRun(store, run, 'needs_decision')); return; }
      }
      await delay(50);
    }
    if (!cancelling && run.state !== 'succeeded') {
      await publish(() => transitionRun(store, run, 'finalizing'));
      if (request.final_review !== 'none') {
        const result = await finalReview(store, run, request, snapshots['internal:final_review']!, hooks, abort.signal);
        atomicWriteJson(join(paths.dir, 'final-review.json'), result);
        if (!cancelling && (result.failure_reason === 'launch_failed' || result.failure_reason === 'prompt_too_large')) {
          const reason = result.failure_reason;
          const canRetry = run.budget.jobs_used < run.budget.max_total_jobs;
          await publish(() => {
            attention(null, reason, reason === 'launch_failed'
              ? '最终评审启动失败：未产生有效评审输出；当前不能接受，需修复后 retry 或人工介入'
              : `最终评审 prompt 超限（prompt_too_large）；评审未完成，需缩减输入后 retry`,
              canRetry ? ['retry'] : []);
            transitionRun(store, run, 'needs_decision');
          });
          return;
        }
        if (!cancelling && (result.verdict !== 'approve' || result.findings.some(f => f.severity === 'critical'))) {
          await publish(() => { attention(null, result.verdict === 'revise' || result.verdict === null ? 'final_review_revise' : 'final_review_rejected', result.verdict === null ? 'final review verdict missing (verdict_missing) after two attempts' : 'Final review requires a decision', ['add_fix_task', 'accept_final']); transitionRun(store, run, 'needs_decision'); }); return;
        }
      }
      if (!cancelling) {
        const observed = structuredClone(run), jobs = refreshSlots(store, observed);
        await assertRunInvariantsAsync(store, observed, mergeRecords(store, run), parallel, protectedRefs, jobs, abort.signal);
        await publish(() => { run.outcome = run.tasks.some(t => t.state === 'dropped') ? 'integrated_partial' : 'integrated'; transitionRun(store, run, 'succeeded'); });
      }
    }
  } catch (error) {
    if (error instanceof BudgetExhausted) { await publish(() => { if (!run.attention.some(d => d.reason === 'run_budget_exhausted')) attention(null, 'run_budget_exhausted', error.message, run.budget.extended ? [] : ['extend_budget']); transitionRun(store, run, 'needs_decision'); }); return; }
    const userCancelled = cancelling && (existsSync(paths.cancel) || Date.now() < Date.parse(run.deadline_at));
    stopWorkers();
    await Promise.allSettled([...active.values(), ...(merging ? [merging] : [])]);
    const reason = error instanceof GbdevError ? error.message : String(error).replace(/^Error: /, '');
    let restoreFailed = false;
    try { if (reason !== 'planner_modified_worktree') await restoreRunIntegration(store, run); } catch { restoreFailed = true; }
    await publish(() => {
      if (restoreFailed) run.warnings.push('integration_corrupt');
      if (!terminalRun(run.state) && !userCancelled) {
        if (reason.startsWith('invariant_violation') && ['running', 'finalizing'].includes(run.state)) {
          runEvent(store, run, 'invariant_violation', { reason }); attention(null, 'integration_corrupt', reason, []); transitionRun(store, run, 'needs_decision', 'integration_corrupt');
        } else transitionRun(store, run, 'failed', reason);
      }
    });
  } finally {
    clearInterval(heartbeat); clearInterval(monitor); process.off('SIGTERM', requestStop); process.off('SIGINT', requestStop);
    if (cancelling) {
      await Promise.allSettled([...active.values(), ...(merging ? [merging] : [])]);
      const lock = acquireIntegrationLock(store.paths, id, 'recover');
      try { await restoreRunIntegration(store, run); } finally { lock?.release(); }
      // Workers have settled (including cancellation snapshots). Cleanup must not
      // inherit the aborted execution signal, or HEAD capture/parking always fails.
      const cleanupManager = new LaneManager({ ...options, signal: new AbortController().signal });
      const parked = await Promise.all(run.lanes.filter(l => l.state === 'busy').map(async lane => {
        const staged = structuredClone(lane); let taskHead: string | null = null;
        try { taskHead = (await cleanupManager.parkAsync(staged, run.integration.verified_sha)).head_sha; } catch { staged.state = 'broken'; }
        return { lane, staged, task_id: lane.task_id, taskHead };
      }));
      await publish(() => {
        for (const p of parked) { copyLane(p.lane, p.staged); const task = run.tasks.find(t => t.task_id === p.task_id); if (task && p.taskHead) task.head_sha = p.taskHead; }
        for (const task of run.tasks) if (!['integrated', 'dropped', 'failed'].includes(task.state)) {
          task.lane = null; taskState(store, run, task, run.state === 'failed' ? 'failed' : 'cancelled');
        }
        run.merge_queue = [];
        if (!terminalRun(run.state) && run.state !== 'needs_decision') transitionRun(store, run, Date.now() >= Date.parse(run.deadline_at) && !existsSync(paths.cancel) ? 'failed' : 'cancelled', Date.now() >= Date.parse(run.deadline_at) ? 'run_timeout' : null);
      });
    }
    clearInterval(heartbeat); clearInterval(monitor); process.off('SIGTERM', requestStop); process.off('SIGINT', requestStop);
    await publish(() => {
      for (const task of run.tasks) for (const attempt of task.attempts) { const pipeline = readPipeline(store, attempt.pipeline_id); attempt.state = pipeline.state; attempt.outcome = pipeline.outcome; }
      refreshSlots(store, run);
    });
    runtime.seeds = Object.fromEntries(seeds); writeRuntime(store, run, runtime);
    writeResult(store, run, request);
    await publish(() => { run.supervisor_pid = null; });
  }
}

export function superviseRun(store: JobStore, id: string, testHooks: { beforePublish?: (run: Run) => void } = {}): Promise<void> {
  notifySupervisorStarted(store);
  return dashboardSupervision(store, id, () => superviseRunWork(store, id, testHooks));
}
