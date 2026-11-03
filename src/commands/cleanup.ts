import { readRun } from '../pipeline/store.js';
import { existsSync, realpathSync } from 'node:fs';
import { type CleanupResult } from '../contracts/commandResults.js';
import { GbdevError } from '../contracts/error.js';
import { isTerminal, type JobStatus } from '../contracts/jobStatus.js';
import { git } from '../core/git.js';
import { JobStore } from '../core/jobStore.js';
import { locked } from '../core/runtime.js';
import { releaseInspectReservation } from '../core/workerReservations.js';
import { reconcile } from './status.js';

export async function cleanup(store: JobStore, jobId: string, forceBranch = false, dryRun = false): Promise<CleanupResult> {
  const owned = store.read(jobId);
  if (/^gbdev\/r_\d{8}_\d{4}_[a-f0-9]{4}\//.test(owned.branch)) throw new GbdevError('job_owned_by_run', 'Use run cleanup for run jobs');
  if (owned.pipeline_id) {
    let bound = false;
    try { bound = readRun(store, owned.pipeline_id).workspace.mode === 'per_lane'; } catch { /* Legacy/missing pipeline still uses the M2 ownership error below. */ }
    if (bound) throw new GbdevError('job_owned_by_run', 'Use run cleanup for run jobs');
  }
  if (owned.pipeline_id) throw new GbdevError('job_owned_by_pipeline', 'Use pipeline cleanup for step jobs', { pipeline_id: owned.pipeline_id }, [`gbdev pipeline cleanup ${owned.pipeline_id}`]);
  if (owned.kind === 'inspect') {
    if (!dryRun) await reconcile(store, jobId);
    const result = await locked(store, () => cleanupBranch({ status: store.read(jobId), forceBranch, dryRun, neverDeleteRef: true }));
    if (!dryRun) releaseInspectReservation(store, jobId);
    return result;
  }
  if (!dryRun) await reconcile(store, jobId);
  return locked(store, () => cleanupBranch({ status: store.read(jobId), forceBranch, dryRun }));
}

export interface CleanupDependencies {
  status: Pick<JobStatus, 'state' | 'repo' | 'worktree' | 'branch' | 'base_sha'> & { job_id: string | null };
  forceBranch?: boolean | undefined;
  dryRun?: boolean | undefined;
  git?: typeof git;
  /** Test-only race injection, after worktree removal and before the final checkout guard. */
  beforeBranchDelete?: () => void;
  /** Inspect snapshots never have a branch ref. force-branch cannot delete one. */
  neverDeleteRef?: boolean;
}

/** Caller holds the global lock. External Git users do not share it. */
export function cleanupBranch(deps: CleanupDependencies): CleanupResult {
  const { status, forceBranch = false, dryRun = false, git: runGit = git } = deps;
  const jobId = status.job_id;
  if (!isTerminal(status.state)) throw new GbdevError('job_not_terminal', 'Job is not terminal', { job_id: jobId });
  let worktreeRemoved = false;
  let refDeletionAttempted = false;
  try {
    // --force-branch never permits discarding uncommitted changes.
    if (existsSync(status.worktree) && runGit(status.worktree, ['status', '--porcelain=v1', '-z']).length > 0) {
      throw new GbdevError('cleanup_refused', 'Worktree has uncommitted changes', { worktree: status.worktree, worktree_removed: false });
    }
    let branchExists = true;
    try { runGit(status.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${status.branch}`]); }
    catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
      branchExists = false;
    }
    const ref = `refs/heads/${status.branch}`;
    const tip = branchExists ? runGit(status.repo, ['rev-parse', '--verify', ref]).trim() : null;
    const noJobCommits = tip === status.base_sha;
    // The original base ref may have moved, disappeared, or be a literal SHA.
    // Only another local branch containing the tip makes job commits safe to delete.
    const mergedInto = branchExists && !noJobCommits && !forceBranch
      ? runGit(status.repo, ['for-each-ref', `--contains=${tip}`, '--format=%(refname)', 'refs/heads/'])
        .trim().split('\n').find(other => other && other !== ref)
      : undefined;
    const removed = existsSync(status.worktree);
    // update-ref does not protect checked-out branches. Apply one shared
    // preflight to every deletion path, including force and dry-run. Only the
    // job worktree that this cleanup will remove may be excluded.
    const ownWorktree = removed ? realpathSync(status.worktree) : null;
    const checkedOut = runGit(status.repo, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').some(record => {
      const fields = record.split('\0');
      return fields.includes(`branch ${ref}`) && fields.find(field => field.startsWith('worktree ')) !== `worktree ${ownWorktree}`;
    });
    let deleteBranch = branchExists && !checkedOut && (noJobCommits || mergedInto !== undefined || forceBranch);
    let retainedReason: CleanupResult['branch_retained_reason'] = branchExists && checkedOut ? 'checked_out'
      : branchExists && !deleteBranch ? 'unmerged_job_commits' : null;
    if (deps.neverDeleteRef) {
      deleteBranch = false;
      if (branchExists) retainedReason = retainedReason ?? 'unmerged_job_commits';
    }
    if (dryRun) return { job_id: jobId, dry_run: true, would_remove_worktree: removed, would_delete_branch: deleteBranch,
      worktree_removed: false, branch_deleted: false, branch_retained: branchExists && !deleteBranch, branch_retained_reason: retainedReason };
    if (removed) {
      try { runGit(status.repo, ['worktree', 'remove', status.worktree]); }
      catch (error) {
        if (error instanceof GbdevError) throw error;
        throw new GbdevError('cleanup_refused', 'Git refused to remove the worktree', {
          job_id: jobId, worktree_removed: false, detail: error instanceof Error ? error.message : String(error),
        });
      }
      worktreeRemoved = true;
    }
    if (deleteBranch) {
      deps.beforeBranchDelete?.();
      // Do not exclude the former job worktree: it has now been removed.
      const checkedOutNow = runGit(status.repo, ['worktree', 'list', '--porcelain', '-z'])
        .split('\0\0').some(record => record.split('\0').includes(`branch ${ref}`));
      if (checkedOutNow) { deleteBranch = false; retainedReason = 'checked_out'; }
    }
    if (deleteBranch) {
      refDeletionAttempted = true;
      runGit(status.repo, ['update-ref', '-d', ref, tip!]);
    }
    return { job_id: jobId, worktree_removed: worktreeRemoved, branch_deleted: deleteBranch, branch_retained: branchExists && !deleteBranch, branch_retained_reason: retainedReason };
  } catch (error) {
    if (error instanceof GbdevError && error.contract.code === 'cleanup_refused') throw error;
    throw new GbdevError('internal_error', 'Cleanup could not finish; job artifacts are retained', {
      ...(error instanceof GbdevError ? error.contract.details : {}),
      job_id: jobId, worktree_removed: worktreeRemoved, ...(refDeletionAttempted ? { retry_safe: true, branch_retained: true, branch_retained_reason: 'delete_failed_retry_safe' } : {}),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
