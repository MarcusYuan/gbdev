import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { JobStore, atomicWriteJson } from '../core/jobStore.js';
import { locked } from '../core/runtime.js';
import { assertRunWorktree, deleteRunBranchCas, git, isAncestor, isDirty, pruneWorktrees, removeRunWorktree, worktreeListPorcelain } from '../core/git.js';
import { allRuns as pipelines, writeRun as writePipeline } from '../pipeline/store.js';
import { readRun, runPaths, terminalRun } from './store.js';
import { supervisorAlive } from './reconcile.js';
import { acquireIntegrationLock } from './integrationLock.js';
export interface RunCleanup {
  schema: 'gbdev.run-cleanup.v1'; contract_version: '1'; run_id: string; dry_run: boolean;
  worktrees: { path: string; kind: 'lane' | 'integration'; removed: boolean; would_remove?: boolean; retained_reason?: string }[];
  branches: { branch: string; tip: string; deleted: boolean; would_delete?: boolean; retained_reason?: string }[];
}
export async function cleanupRun(store: JobStore, id: string, forceBranch = false, dryRun = false): Promise<RunCleanup> {
  return locked(store, () => {
    const run = readRun(store, id);
    if (!terminalRun(run.state)) throw new GbdevError('run_not_terminal', 'Run must be terminal before cleanup');
    if (supervisorAlive(run)) throw new GbdevError('run_not_settled', 'Supervisor is still settling');
    const lock = acquireIntegrationLock(store.paths, id, 'cleanup', 0, true);
    try {
      const result: RunCleanup = { schema: 'gbdev.run-cleanup.v1', contract_version: '1', run_id: id, dry_run: dryRun, worktrees: [], branches: [] };
      const refs = git(run.repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', `refs/heads/gbdev/${id}/`]).trim().split('\n').filter(Boolean).map(l => { const [branch, tip] = l.split(' '); return { branch: branch!, tip: tip! }; });
      const integration = refs.find(r => r.branch === run.integration.branch)?.tip;
      let target: string | undefined;
      if (run.integration.landed_sha && run.integration.target_branch) {
        try { target = git(run.repo, ['rev-parse', '--verify', `refs/heads/${run.integration.target_branch}`]).trim(); } catch { /* Deleted target is not evidence of integration. */ }
      }
      for (const item of [...run.lanes.map(l => ({ path: l.worktree, kind: 'lane' as const, branch: l.branch ?? run.integration.branch })), { path: run.integration.worktree, kind: 'integration' as const, branch: run.integration.branch }]) {
        const entry: RunCleanup['worktrees'][number] = { path: item.path, kind: item.kind, removed: false };
        if (existsSync(item.path)) {
          const context = { paths: store.paths, run_id: id, repo: run.repo, branch: item.branch, worktree: item.path };
          assertRunWorktree(context, false);
          if (isDirty(item.path)) entry.retained_reason = 'worktree_dirty';
          else if (dryRun) entry.would_remove = true;
          else { removeRunWorktree(context); entry.removed = true; }
        }
        result.worktrees.push(entry);
      }
      if (!dryRun) pruneWorktrees(run.repo);
      for (const { branch, tip } of refs) {
        const entry: RunCleanup['branches'][number] = { branch, tip, deleted: false };
        const integrated = branch === run.integration.branch ? tip === run.base_sha || !!target && isAncestor(run.repo, tip, target) : !!integration && isAncestor(run.repo, tip, integration) || !!target && isAncestor(run.repo, tip, target);
        const checked = worktreeListPorcelain(run.repo).some(w => w.branch === `refs/heads/${branch}` && !(dryRun && result.worktrees.some(r => r.path === w.worktree && r.would_remove)));
        if (checked) entry.retained_reason = 'checked_out';
        else if (!integrated && !forceBranch) entry.retained_reason = branch === run.integration.branch ? 'unmerged_integration_commits' : 'unmerged_task_commits';
        else if (dryRun) entry.would_delete = true;
        else if (!(entry.deleted = deleteRunBranchCas({ paths: store.paths, repo: run.repo, run_id: id, branch, worktree: run.integration.worktree }, tip))) entry.retained_reason = 'checked_out';
        result.branches.push(entry);
      }
      if (!dryRun) {
        atomicWriteJson(join(runPaths(store, id).dir, 'cleanup.json'), result);
        for (const pipeline of pipelines(store).filter(p => p.workspace.mode === 'per_lane' && p.workspace.run_id === id)) { pipeline.cleanup = result; writePipeline(store, pipeline); }
      }
      return result;
    } finally { lock.release(); }
  });
}
