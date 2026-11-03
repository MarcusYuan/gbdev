import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import type { Run } from '../contracts/run.js';
import { GbdevError } from '../contracts/error.js';
import { worktreeAsync, FULL_SHA, addWorktree, assertRunWorktreeAsync, headAsync, dirtyAsync } from '../core/git.js';
import { runWorkspacePath, setupWorkspace, type RunWorkspaceOptions } from './workspace.js';

/** Completed worktrees open read-only; an explicit pending marker retries interrupted setup. */
export async function openIntegration(options: RunWorkspaceOptions, verifiedSha: string): Promise<Run['integration']> {
  if (!FULL_SHA.test(verifiedSha)) throw new GbdevError('guard_violation', 'Expected a full commit SHA');
  const marker = join(options.paths.home, 'runs', options.run_id, 'integration-setup-pending');
  const worktree = runWorkspacePath(options, 'integration'), branch = `gbdev/${options.run_id}/integration`;
  if (!existsSync(worktree)) {
    mkdirSync(join(options.paths.home, 'runs', options.run_id), { recursive: true });
    writeFileSync(marker, 'pending\n');
    if (options.signal) await worktreeAsync(options.repo, worktree, verifiedSha, options.signal, branch);
    else addWorktree(options.repo, branch, worktree, verifiedSha);
  }
  await assertRunWorktreeAsync({ ...options, branch, worktree }, true, 120_000, options.signal);
  if (existsSync(marker)) { await setupWorkspace(options, 'integration', worktree); unlinkSync(marker); }
  if (await headAsync(worktree, options.signal) !== verifiedSha || await dirtyAsync(worktree, options.signal)) throw new GbdevError('worktree_failed', 'integration_corrupt');
  return { branch, worktree, verified_sha: verifiedSha, head_sha: verifiedSha, merging: null, merges: 0, rollbacks: 0, target_branch: null, landed_sha: null, approved_by_user_at: null };
}
