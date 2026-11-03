import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Run } from '../contracts/run.js';
import type { MergeRecord } from '../contracts/mergeRecord.js';
import type { ParallelConfig } from '../core/runConfig.js';
import { git, headAsync, dirtyAsync, assertRunWorktreeAsync, head, isAncestor, isDirty, assertRunWorktree } from '../core/git.js';
import { JobStore } from '../core/jobStore.js';
import { allJobs } from '../core/runtime.js';
import { groupAlive } from '../core/proc.js';
import { jobPaths } from '../core/paths.js';
import { jsonFile } from './store.js';
export function runJobs(store: JobStore, run: Run) {
  const pipelines = new Set(run.tasks.flatMap(t => t.attempts.map(a => a.pipeline_id)));
  return allJobs(store).filter(j => j.kind !== 'inspect' && (j.run_id === run.run_id || pipelines.has(j.pipeline_id ?? '') || j.branch === run.integration.branch));
}
export function liveRunJobs(store: JobStore, run: Run) {
  return runJobs(store, run).filter(j => {
    const path = jobPaths(store.paths, j.job_id).processInfo;
    if (!existsSync(path)) return false;
    const p = jsonFile<{ worker_pgid: number | null }>(path);
    return p.worker_pgid !== null && groupAlive(p.worker_pgid);
  });
}
export function refreshSlots(store: JobStore, run: Run) {
  const jobs = liveRunJobs(store, run);
  run.slots.in_use = jobs.length;
  run.slots.by_provider = { codex: jobs.filter(j => j.provider === 'codex').length, cursor: jobs.filter(j => j.provider === 'cursor').length, fake: jobs.filter(j => j.provider === 'fake').length };
  run.budget.jobs_used = runJobs(store, run).length;
  return jobs;
}
/** No repair here: invariant violations preserve evidence for the run owner. */
export function assertRunInvariants(store: JobStore, run: Run, records: MergeRecord[], parallel: ParallelConfig, protectedRefs?: Record<string, string>, observedJobs?: ReturnType<typeof liveRunJobs>): void {
  const invariant = (ok: boolean, name: string) => { if (!ok) throw new Error(`invariant_violation:${name}`); };
  if (existsSync(run.integration.worktree)) {
    assertRunWorktree({ paths: store.paths, run_id: run.run_id, repo: run.repo, branch: run.integration.branch, worktree: run.integration.worktree });
    if (!run.integration.merging) {
      invariant(head(run.integration.worktree) === run.integration.verified_sha && !isDirty(run.integration.worktree), 'I1');
      invariant(!existsSync(resolve(run.integration.worktree, git(run.integration.worktree, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim())), 'I1');
    }
    const chain = git(run.repo, ['rev-list', '--first-parent', `${run.base_sha}..${run.integration.verified_sha}`]).trim().split('\n').filter(Boolean);
    invariant(chain.every(sha => records.some(r => r.result === 'integrated' && r.merge_sha === sha)), 'I2');
    for (const task of run.tasks) invariant((task.state === 'integrated') === (task.merged_sha !== null && isAncestor(run.repo, task.merged_sha, run.integration.verified_sha)), 'I3');
  }
  for (const lane of run.lanes) {
    const owners = run.tasks.filter(t => t.state === 'running' && t.lane === lane.lane);
    invariant(lane.state === 'busy' ? owners.length === 1 && lane.task_id === owners[0]!.task_id : owners.length === 0, 'I4');
  }
  invariant(run.tasks.filter(t => t.state === 'running').every(t => run.lanes.some(l => l.state === 'busy' && l.lane === t.lane && l.task_id === t.task_id)), 'I4');
  const jobs = observedJobs ?? liveRunJobs(store, run);
  invariant(jobs.length === run.slots.in_use && jobs.length <= parallel.max_workers, 'I5');
  for (const provider of ['codex', 'cursor', 'fake'] as const) invariant(jobs.filter(j => j.provider === provider).length === (run.slots.by_provider[provider] ?? 0) && (run.slots.by_provider[provider] ?? 0) <= (parallel.provider_limits[provider] ?? parallel.max_workers), 'I5');
  if (protectedRefs) for (const [ref, sha] of Object.entries(protectedRefs)) invariant(git(run.repo, ['rev-parse', ref]).trim() === sha, 'I6');
  const cwd = new Set([run.integration.worktree, ...run.lanes.map(l => l.worktree)]);
  for (const job of runJobs(store, run)) invariant(cwd.has(job.worktree) && job.worktree !== run.repo, 'I7');
}

export async function assertRunInvariantsAsync(store: JobStore, run: Run, records: MergeRecord[], parallel: ParallelConfig, protectedRefs?: Record<string, string>, observedJobs?: ReturnType<typeof liveRunJobs>, signal = new AbortController().signal): Promise<void> {
  const invariant = (ok: boolean, name: string) => { if (!ok) throw new Error(`invariant_violation:${name}`); };
  if (existsSync(run.integration.worktree)) {
    await assertRunWorktreeAsync({ paths: store.paths, run_id: run.run_id, repo: run.repo, branch: run.integration.branch, worktree: run.integration.worktree }, true, 120_000, signal);
    if (!run.integration.merging) {
      invariant((await headAsync(run.integration.worktree, signal)) === run.integration.verified_sha && !(await dirtyAsync(run.integration.worktree, signal)), 'I1');
      invariant(!existsSync(resolve(run.integration.worktree, (await git(run.integration.worktree, ['rev-parse', '--git-path', 'MERGE_HEAD'], 120_000, signal)).trim())), 'I1');
    }
    const chain = (await git(run.repo, ['rev-list', '--first-parent', `${run.base_sha}..${run.integration.verified_sha}`], 120_000, signal)).trim().split('\n').filter(Boolean);
    invariant(chain.every(sha => records.some(r => r.result === 'integrated' && r.merge_sha === sha)), 'I2');
    for (const task of run.tasks) invariant((task.state === 'integrated') === (task.merged_sha !== null && (await ancestorAsync(run.repo, task.merged_sha, run.integration.verified_sha, signal))), 'I3');
  }
  for (const lane of run.lanes) {
    const owners = run.tasks.filter(t => t.state === 'running' && t.lane === lane.lane);
    invariant(lane.state === 'busy' ? owners.length === 1 && lane.task_id === owners[0]!.task_id : owners.length === 0, 'I4');
  }
  invariant(run.tasks.filter(t => t.state === 'running').every(t => run.lanes.some(l => l.state === 'busy' && l.lane === t.lane && l.task_id === t.task_id)), 'I4');
  const jobs = observedJobs ?? liveRunJobs(store, run);
  invariant(jobs.length === run.slots.in_use && jobs.length <= parallel.max_workers, 'I5');
  for (const provider of ['codex', 'cursor', 'fake'] as const) invariant(jobs.filter(j => j.provider === provider).length === (run.slots.by_provider[provider] ?? 0) && (run.slots.by_provider[provider] ?? 0) <= (parallel.provider_limits[provider] ?? parallel.max_workers), 'I5');
  if (protectedRefs) for (const [ref, sha] of Object.entries(protectedRefs)) invariant((await git(run.repo, ['rev-parse', ref], 120_000, signal)).trim() === sha, 'I6');
  const cwd = new Set([run.integration.worktree, ...run.lanes.map(l => l.worktree)]);
  for (const job of runJobs(store, run)) invariant(cwd.has(job.worktree) && job.worktree !== run.repo, 'I7');
}

async function ancestorAsync(repo: string, from: string, to: string, signal: AbortSignal): Promise<boolean> {
  try { await git(repo, ['merge-base', '--is-ancestor', from, to], 120_000, signal); return true; }
  catch (e) { if ((e as { status?: number }).status === 1) return false; throw e; }
}
