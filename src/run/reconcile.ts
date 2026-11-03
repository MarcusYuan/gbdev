import { notifyEvent } from '../notify/enqueue.js';
import { notifyDisabledReason, NOTIFY_DEFAULTS } from '../core/notifyConfig.js';
import { loadConfig } from '../core/config.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { isTerminal } from '../contracts/jobStatus.js';
import type { MergeRecord } from '../contracts/mergeRecord.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { isProcessAlive } from '../core/lock.js';
import { jobPaths } from '../core/paths.js';
import { groupAlive, terminateGroup } from '../core/proc.js';
import { failureResult } from '../core/finalize.js';
import { locked, optionalText, transition } from '../core/runtime.js';
import { git, gitGuardedAsync, headAsync, dirtyAsync } from '../core/git.js';
import { localIso } from '../core/time.js';
import { allRuns as pipelines, transitionRun as transitionPipeline } from '../pipeline/store.js';
import { activeRun, jsonFile, readRun, runEvent, runPaths, transitionRun, writeRun } from './store.js';
import { refreshSlots, runJobs, assertRunInvariants } from './invariants.js';
import { requireDecision } from './decisions.js';
import { acquireIntegrationLock } from './integrationLock.js';
import { mergeRecords, writeResult } from './result.js';
import type { Run } from '../contracts/run.js';
import type { loadRunConfig } from '../core/runConfig.js';

export const localSupervisors = new Set<string>();
export function supervisorAlive(run: Run): boolean {
  if (!run.supervisor_pid || !isProcessAlive(run.supervisor_pid)) return false;
  // In-process library supervision is used by tests; detached production supervisors are checked by argv.
  if (run.supervisor_pid === process.pid && localSupervisors.has(run.run_id)) return true;
  try { return execFileSync('ps', ['-p', String(run.supervisor_pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 }).includes(`__run-supervise ${run.run_id}`); } catch { if (!isProcessAlive(run.supervisor_pid)) return false; throw new GbdevError('run_not_settled', 'Cannot verify supervisor process identity', { reason: 'supervisor_identity_unavailable', pid: run.supervisor_pid }); }
}
export async function restoreRunIntegration(store: JobStore, run: Run): Promise<void> {
  if (!existsSync(run.integration.worktree)) return;
  // A failed TERM/KILL wait must never be followed by reset while a writer can still hold index.lock.
  const processDir = join(runPaths(store, run.run_id).dir, 'processes');
  if (existsSync(processDir)) for (const file of readdirSync(processDir).filter(n => n.endsWith('.json'))) {
    const info = jsonFile<{ pgid: number; worktree?: string }>(join(processDir, file));
    if ((!info.worktree || info.worktree === run.integration.worktree) && groupAlive(info.pgid)) throw new Error(`process_group_still_alive:${info.pgid}`);
  }
  for (const job of runJobs(store, run).filter(j => j.worktree === run.integration.worktree)) {
    const info = JSON.parse(optionalText(jobPaths(store.paths, job.job_id).processInfo) ?? '{}') as { worker_pgid?: number; check_pgid?: number };
    for (const pgid of [info.worker_pgid, info.check_pgid]) if (pgid && groupAlive(pgid)) throw new Error(`process_group_still_alive:${pgid}`);
  }
  const c = { paths: store.paths, run_id: run.run_id, repo: run.repo, branch: run.integration.branch, worktree: run.integration.worktree };
  const mergeHead = (await git(c.worktree, ['rev-parse', '--git-path', 'MERGE_HEAD'], 120_000, new AbortController().signal)).trim();
  if (existsSync(mergeHead.startsWith('/') ? mergeHead : join(c.worktree, mergeHead))) await gitGuardedAsync(c, { operation: 'mergeAbort' });
  await gitGuardedAsync(c, { operation: 'resetHard', sha: run.integration.verified_sha });
  await gitGuardedAsync(c, { operation: 'clean' });
  if (await headAsync(c.worktree) !== run.integration.verified_sha || await dirtyAsync(c.worktree)) throw new Error('integration_corrupt');
  run.integration.head_sha = run.integration.verified_sha; run.integration.merging = null;
}
export async function reconcileRun(store: JobStore, id: string): Promise<Run> {
  let run = await locked(store, () => readRun(store, id));
  if (!activeRun(run.state) || run.state === 'queued' && !run.supervisor_pid) return run;
  if (supervisorAlive(run)) {
    if (run.heartbeat_at && Date.now() - Date.parse(run.heartbeat_at) > 180_000 && !run.warnings.includes('supervisor_heartbeat_stale')) {
      // Disabled notifications preserve M3's read-only status behavior exactly.
      let enabled = false;
      try { enabled = !notifyDisabledReason(loadConfig(store.paths.config).notify ?? NOTIFY_DEFAULTS); } catch { /* Notification config cannot break status. */ }
      if (!enabled) run.warnings.push('supervisor_heartbeat_stale');
      else try { run = await locked(store, () => {
        const current = readRun(store, id);
        if (!activeRun(current.state) || !current.heartbeat_at || Date.now() - Date.parse(current.heartbeat_at) <= 180_000 || current.warnings.includes('supervisor_heartbeat_stale')) return current;
        // Health is a reconciliation observation, not a new event type/code.
        // The ID is run-stable; HWM is retained only as payload observation metadata.
        const seq = Math.max(1, (optionalText(runPaths(store, id).events) ?? '').split('\n').filter(Boolean).length);
        if (notifyEvent(store, { kind: 'run', id, state: current.state }, 'supervisor_heartbeat_stale', {}, seq, localIso())) {
          current.warnings.push('supervisor_heartbeat_stale'); writeRun(store, current);
        }
        return current;
      }); } catch {
        // Health notification persistence is additive even when its disk writes fail.
        // No in-memory one-shot marker: a failed write must be retried.
      }
    }
    return run;
  }
  const lock = acquireIntegrationLock(store.paths, id, 'recover'), paths = runPaths(store, id);
  try {
    run = await locked(store, () => readRun(store, id));
    if (!activeRun(run.state) || supervisorAlive(run)) return run;
    const crashedPhase = run.state, merging = run.integration.merging;
    const step = async (name: string) => locked(store, () => { runEvent(store, run, 'recovery_step', { step: name, crashed_phase: crashedPhase }); writeRun(store, run); });
    try {
      // Stop *all* recorded groups, including late descendants of already-terminal jobs.
      for (const job of runJobs(store, run)) {
        const p = jobPaths(store.paths, job.job_id), info = JSON.parse(optionalText(p.processInfo) ?? '{}') as { worker_pgid?: number; check_pgid?: number };
        for (const pgid of [info.worker_pgid, info.check_pgid]) if (pgid && groupAlive(pgid)) await terminateGroup(pgid);
        if (!isTerminal(job.state)) await locked(store, () => {
          const result = failureResult(store, job, null);
          result.failure_reason = 'supervisor_crashed';
          result.failure_reasons = [...(result.failure_reasons ?? []), 'supervisor_crashed']; atomicWriteJson(p.result, result);
          transition(store, job, 'failed', 'gbdev', result.failure_reason, result.failure_reasons);
        });
      }
      const processDir = join(paths.dir, 'processes');
      if (existsSync(processDir)) for (const name of readdirSync(processDir).filter(n => n.endsWith('.json'))) {
        const p = jsonFile<{ pgid: number }>(join(processDir, name)); if (groupAlive(p.pgid)) await terminateGroup(p.pgid); unlinkSync(join(processDir, name));
      }
      await step('jobs_stopped');
      await locked(store, () => {
        for (const p of pipelines(store).filter(p => p.workspace.mode === 'per_lane' && p.workspace.run_id === id && ['queued', 'starting', 'running'].includes(p.state))) transitionPipeline(store, p, 'failed', 'pipeline_supervisor_crashed');
      });
      await step('pipelines_failed');
      await restoreRunIntegration(store, run);
      const interrupted = readdirSync(paths.merges).filter(n => n.endsWith('.pending.json')).map(n => { const r = jsonFile<MergeRecord>(join(paths.merges, n)); return { seq: r.seq, task_id: r.task_id }; });
      if (merging && !interrupted.some(m => m.seq === merging.seq)) interrupted.push(merging);
      for (const merging of interrupted) {
        const path = join(paths.merges, `${merging.seq}.pending.json`), finished = join(paths.merges, `${merging.seq}.json`);
        const record = existsSync(path) ? jsonFile<MergeRecord>(path) : null;
        const task = run.tasks.find(t => t.task_id === merging.task_id)!;
        if (record && record.merge_sha === run.integration.verified_sha) {
          record.result = 'integrated'; record.finished_at = localIso(); if (!existsSync(finished)) atomicWriteJson(finished, record);
        } else {
          if (record && !existsSync(finished)) { record.result = 'aborted_crash'; record.rolled_back_to = run.integration.verified_sha; record.finished_at = localIso(); atomicWriteJson(finished, record); }
          task.state = 'merge_queued'; run.merge_queue = [task.task_id, ...run.merge_queue.filter(t => t !== task.task_id)];
        }
        if (existsSync(path)) unlinkSync(path);
      }
      await step('integration_restored');
      for (const lane of run.lanes.filter(l => l.state === 'busy')) {
        const task = run.tasks.find(t => t.task_id === lane.task_id)!;
        try {
          const c = { paths: store.paths, repo: run.repo, run_id: id, worktree: lane.worktree, branch: lane.branch ?? task.branch! };
          if (await dirtyAsync(lane.worktree)) { await git(lane.worktree, ['add', '-A'], 120_000, new AbortController().signal); await gitGuardedAsync(c, { operation: 'snapshot', message: `gbdev: crash snapshot ${task.task_id} (${id})` }); }
          task.head_sha = await headAsync(lane.worktree); task.branch = c.branch;
          await gitGuardedAsync(c, { operation: 'switchDetach', sha: run.integration.verified_sha });
          Object.assign(lane, { state: 'idle', task_id: null, branch: null, pipeline_id: null, verified_sha: run.integration.verified_sha });
        } catch { lane.state = 'broken'; }
        task.lane = null;
        await locked(store, () => { if (!task.decision_id) requireDecision(store, run, task, 'task_failed', 'supervisor_crashed', ['retry_task', 'rebuild_task', 'drop_task']); });
      }
      await step('lanes_parked');
      refreshSlots(store, run);
      const settings = jsonFile<ReturnType<typeof loadRunConfig>>(join(paths.dir, 'settings.snapshot.json'));
      assertRunInvariants(store, run, mergeRecords(store, run), settings.parallel, undefined);
      await locked(store, () => {
        if (['queued', 'starting'].includes(run.state)) transitionRun(store, run, run.state === 'queued' ? 'starting' : 'running');
        if (run.state === 'starting') transitionRun(store, run, 'running');
        transitionRun(store, run, 'needs_decision', 'supervisor_crashed');
        requireDecision(store, run, null, 'supervisor_crashed', `Interrupted phase: ${crashedPhase}`, ['resume_run']);
        run.supervisor_pid = null; writeRun(store, run);
      });
      await step('needs_decision');
    } catch (e) {
      await locked(store, () => { run.integration.head_sha = run.integration.verified_sha; run.integration.merging = null; run.warnings.push(`recovery_failed:${String(e)}`); transitionRun(store, run, 'failed', 'integration_corrupt'); run.supervisor_pid = null; writeRun(store, run); });
    }
    writeResult(store, run, jsonFile(paths.request)); return run;
  } finally { lock.release(); }
}
