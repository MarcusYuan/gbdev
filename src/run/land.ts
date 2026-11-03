import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import type { RunRequest } from '../contracts/runRequest.js';
import type { TaskGraph } from '../contracts/taskGraph.js';
import { validateMergeRecord, type MergeRecord } from '../contracts/mergeRecord.js';
import { validateBranchName } from '../core/ids.js';
import { JobStore, atomicWriteJson } from '../core/jobStore.js';
import { locked, optionalText } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { dirtyAsync, git, gitGuardedAsync, headAsync, isAncestor, landFastForward, mergeNoFfAsync, mergeTreeCheckAsync, worktreeListPorcelain, attachRunIntegration } from '../core/git.js';
import { acquireIntegrationLock } from './integrationLock.js';
import { jsonFile, readRun, runEvent, runPaths, writeRun } from './store.js';
import { mergeRecords, writeResult } from './result.js';
import { supervisorAlive } from './reconcile.js';
import { runGate } from './gate.js';
export async function landRun(store: JobStore, id: string, target: string, approved = false, dryRun = false, note: string | null = null) {
  if (!approved) throw new GbdevError('user_approval_required', 'run land requires --confirm-user-approved');
  return locked(store, async () => {
    const run = readRun(store, id), paths = runPaths(store, id), signal = new AbortController().signal;
    const refused = (reason: string, details: Record<string, unknown> = {}): never => { throw new GbdevError('land_refused', reason, { reason, ...details }); };
    if (run.state !== 'succeeded') refused('run_not_succeeded');
    if (supervisorAlive(run)) throw new GbdevError('run_not_settled', 'Supervisor is still settling');
    let from: string;
    try {
      validateBranchName(target); if (target.startsWith('gbdev/')) throw new Error('run namespace');
      const ref = `refs/heads/${target}`;
      if (git(run.repo, ['rev-parse', '--symbolic-full-name', ref]).trim() !== ref) throw new Error('symbolic target');
      from = git(run.repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    } catch { throw new GbdevError('run_invalid', 'Invalid target branch', { reason: 'invalid_target' }); }
    if (run.integration.landed_sha) {
      if (run.integration.target_branch !== target || !isAncestor(run.repo, run.integration.landed_sha, from)) refused('target_moved');
      return { schema: 'gbdev.run-land.v1', run_id: id, dry_run: dryRun, ...run.land };
    }
    if (note !== null && note.length > 2000) throw new GbdevError('run_invalid', 'approval-note exceeds 2000 characters');
    const lock = acquireIntegrationLock(store.paths, id, 'land', 0, true);
    try {
      for (const w of worktreeListPorcelain(run.repo).filter(w => w.branch === `refs/heads/${target}`)) if (git(w.worktree, ['status', '--porcelain', '--untracked-files=no']).length) refused('target_is_checked_out_dirty');
      const context = { paths: store.paths, run_id: id, repo: run.repo, branch: run.integration.branch, worktree: run.integration.worktree };
      let verified = run.integration.verified_sha;
      const sync = !isAncestor(run.repo, from, verified);
      const precheck = sync ? await mergeTreeCheckAsync(run.repo, verified, from, signal) : null;
      if (precheck && !precheck.clean) refused('sync_conflict', { conflict_files: precheck.conflict_files });
      if (dryRun) return { schema: 'gbdev.run-land.v1', run_id: id, dry_run: true, target, from_sha: from, integration_sha: verified, sync_required: sync };
      if (sync) {
        if (!existsSync(context.worktree)) await attachRunIntegration(context, verified, signal);
        if (await headAsync(context.worktree) !== verified || await dirtyAsync(context.worktree)) throw new GbdevError('internal_error', 'Integration worktree is not clean and verified', { reason: 'integration_corrupt' });
        const request = jsonFile<RunRequest>(paths.request), graph = jsonFile<TaskGraph>(join(paths.dir, 'task-graph.json'));
        const ids = [...request.integration_checks, ...graph.tasks.filter(t => run.tasks.some(r => r.task_id === t.id && r.state === 'integrated')).flatMap(t => t.acceptance_criteria.flatMap(c => c.check ? [c.check] : [])), ...request.acceptance_criteria.flatMap(c => c.check ? [c.check] : [])];
        const seq = mergeRecords(store, run).length + 1, at = localIso(), old = verified;
        const record: MergeRecord = { schema: 'gbdev.merge-record.v1', kind: 'sync', run_id: id, seq, task_id: 'land-sync', task_head_sha: from, pre_merge_sha: old, precheck: precheck!, resolution: null, merge_sha: null, gate: null, result: 'aborted_crash', rolled_back_to: null, started_at: at, finished_at: at };
        try {
          record.merge_sha = await mergeNoFfAsync(context, from, `gbdev: sync ${target} into integration (${id})`, signal);
          runEvent(store, run, 'gate_started', { kind: 'sync', seq });
          const settings = jsonFile<{ run_defaults: { gate_timeout_min: number } }>(join(paths.dir, 'settings.snapshot.json'));
          const result = await runGate(context, request, ids, join(paths.merges, `${seq}.gate`), signal, settings.run_defaults.gate_timeout_min * 60_000);
          record.gate = result.gate; record.warnings = result.warnings;
          runEvent(store, run, 'gate_finished', { kind: 'sync', seq, passed: result.gate.passed });
          if (!result.gate.passed) refused('gate_failed_on_sync', { gate: result.gate, logs: [...new Set(result.gate.checks.filter(c => c.exit_code !== 0).map(c => c.id))].map(check_id => ({ check_id, tail: (optionalText(join(result.gate.log_dir, `${check_id}.log`)) ?? '').trimEnd().split('\n').slice(-80).join('\n') })) });
          verified = record.merge_sha; record.result = 'integrated';
        } catch (e) {
          await gitGuardedAsync(context, { operation: 'resetHard', sha: old }); await gitGuardedAsync(context, { operation: 'clean' });
          record.result = record.gate ? 'rolled_back_gate_failed' : 'aborted_crash'; record.rolled_back_to = old; record.finished_at = localIso(); atomicWriteJson(join(paths.merges, `${seq}.json`), validateMergeRecord(record));
          if (e instanceof GbdevError) throw e;
          throw new GbdevError('internal_error', 'Land synchronization failed', { detail: String(e) });
        }
        record.finished_at = localIso(); atomicWriteJson(join(paths.merges, `${seq}.json`), validateMergeRecord(record));
        run.integration.head_sha = verified; run.integration.verified_sha = verified;
        atomicWriteJson(join(paths.dir, 'final-gate.json'), { sha: verified, passed: true }); writeRun(store, run);
      }
      await landFastForward(run.repo, target, verified, from, approved);
      const approvedAt = localIso();
      run.land = { target, from_sha: from, landed_sha: verified, approved_by_user_at: approvedAt, approval_note: note };
      Object.assign(run.integration, { target_branch: target, landed_sha: verified, approved_by_user_at: approvedAt });
      writeRun(store, run); runEvent(store, run, 'landed', { ...run.land }); writeResult(store, run, jsonFile(paths.request));
      return { schema: 'gbdev.run-land.v1', run_id: id, dry_run: false, ...run.land };
    } finally { lock.release(); }
  });
}
