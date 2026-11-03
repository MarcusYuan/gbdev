import { readFileSync } from 'node:fs';
import { GbdevError } from '../contracts/error.js';
import { type InspectTarget, type InspectWarning } from '../contracts/inspect.js';
import { isTerminal, type JobStatus } from '../contracts/jobStatus.js';
import { assertRepoAllowed, loadConfig } from '../core/config.js';
import { git } from '../core/git.js';
import { JOB_ID_PATTERN, RUN_ID_PATTERN } from '../core/ids.js';
import { JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { optionalText } from '../core/runtime.js';
import { readRun as readPipeline } from '../pipeline/store.js';
import { readRun as readGbdevRun } from '../run/store.js';

export interface ResolvedInspectTarget {
  repo: string;
  source_branch: string;
  source_worktree: string;
  target: InspectTarget;
  target_sha: string;
  diff_base_sha: string;
  warnings: InspectWarning[];
}

function unavailable(reason: string): never {
  throw new GbdevError('inspect_target_unavailable', 'Inspect target is not available', { reason });
}

function verifyCommit(repo: string, sha: string): string {
  try {
    const full = git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    if (!/^[0-9a-f]{40}$/.test(full)) unavailable('object_missing');
    return full;
  } catch (error) {
    if (error instanceof GbdevError && error.contract.code === 'inspect_target_unavailable') throw error;
    unavailable('object_missing');
  }
}

function headAfter(store: JobStore, jobId: string): string | null {
  try {
    const raw = optionalText(jobPaths(store.paths, jobId).result);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { gbdev_observed?: { head_after?: unknown } };
    return typeof parsed.gbdev_observed?.head_after === 'string' ? parsed.gbdev_observed.head_after : null;
  } catch {
    return null;
  }
}

function ownedRunId(job: JobStatus): string | null {
  if (job.run_id && RUN_ID_PATTERN.test(job.run_id)) return job.run_id;
  const match = /^gbdev\/(r_\d{8}_\d{4}_[a-f0-9]{4})\//.exec(job.branch);
  return match?.[1] ?? null;
}

function diffBaseForJob(store: JobStore, job: JobStatus, repo: string): string {
  if (job.kind === 'merge_resolution') return verifyCommit(repo, job.base_sha);
  if (job.pipeline_id) {
    try {
      const pipeline = readPipeline(store, job.pipeline_id);
      if (!pipeline.diff_base_sha) unavailable('diff_base_missing');
      return verifyCommit(repo, pipeline.diff_base_sha);
    } catch (error) {
      if (error instanceof GbdevError && error.contract.code === 'inspect_target_unavailable') throw error;
      unavailable('diff_base_missing');
    }
  }
  const runId = ownedRunId(job);
  if (runId) {
    try { return verifyCommit(repo, readGbdevRun(store, runId).base_sha); }
    catch (error) {
      if (error instanceof GbdevError && error.contract.code === 'inspect_target_unavailable') throw error;
      unavailable('record_corrupt');
    }
  }
  return verifyCommit(repo, job.base_sha);
}

function resolveJob(store: JobStore, job: JobStatus): ResolvedInspectTarget {
  if (job.kind === 'inspect') unavailable('recursive_inspect');
  let repo: string;
  try { repo = assertRepoAllowed(job.repo, loadConfig(store.paths.config)); }
  catch (error) {
    if (error instanceof GbdevError && error.contract.code === 'repo_not_allowed') throw error;
    unavailable('record_corrupt');
  }
  const warnings: InspectWarning[] = ['uncommitted_excluded'];
  const active = !isTerminal(job.state);
  let targetSha: string;
  if (job.kind === 'merge_resolution' || active) {
    if (!job.base_sha) unavailable('no_recorded_sha');
    targetSha = verifyCommit(repo, job.base_sha);
    if (active) warnings.push('active_target_base_only');
  } else {
    const recorded = headAfter(store, job.job_id);
    if (!recorded) unavailable('no_recorded_sha');
    targetSha = verifyCommit(repo, recorded);
  }
  return {
    repo, source_branch: job.branch, source_worktree: job.worktree, target_sha: targetSha,
    diff_base_sha: diffBaseForJob(store, job, repo), warnings,
    target: {
      kind: 'job', id: job.job_id, run_id: job.run_id ?? null, task_id: job.task_id ?? null,
      job_id: job.job_id, pipeline_id: job.pipeline_id ?? null,
    },
  };
}

function resolveRun(store: JobStore, id: string, taskId?: string): ResolvedInspectTarget {
  let run;
  try { run = readGbdevRun(store, id); }
  catch { unavailable('record_corrupt'); }
  let repo: string;
  try { repo = assertRepoAllowed(run.repo, loadConfig(store.paths.config)); }
  catch (error) {
    if (error instanceof GbdevError && error.contract.code === 'repo_not_allowed') throw error;
    unavailable('record_corrupt');
  }
  const warnings: InspectWarning[] = ['uncommitted_excluded'];
  if (!taskId) {
    return {
      repo, source_branch: run.integration.branch, source_worktree: run.integration.worktree, warnings,
      target_sha: verifyCommit(repo, run.integration.verified_sha),
      diff_base_sha: verifyCommit(repo, run.base_sha),
      target: { kind: 'run', id: run.run_id, run_id: run.run_id, task_id: null, job_id: null, pipeline_id: null },
    };
  }
  const task = run.tasks.find(item => item.task_id === taskId);
  if (!task) unavailable('task_not_found');
  const attempt = task.attempts.at(-1);
  let targetSha: string | null = null;
  if (task.head_sha) targetSha = verifyCommit(repo, task.head_sha);
  else if (task.state === 'running' && task.base_sha) {
    targetSha = verifyCommit(repo, task.base_sha);
    warnings.push('active_target_base_only');
  }
  if (!targetSha) unavailable(task.attempts.length || task.base_sha ? 'no_recorded_sha' : 'no_attempt');
  if (!attempt) unavailable('diff_base_missing');
  let pipeline;
  try { pipeline = readPipeline(store, attempt.pipeline_id); }
  catch { unavailable('diff_base_missing'); }
  if (!pipeline.diff_base_sha) unavailable('diff_base_missing');
  const lane = run.lanes.find(item => item.lane === task.lane);
  const source = pipeline.workspace.worktree || lane?.worktree || run.integration.worktree;
  return {
    repo, source_branch: task.branch || run.integration.branch, source_worktree: source, warnings,
    target_sha: targetSha, diff_base_sha: verifyCommit(repo, pipeline.diff_base_sha),
    target: { kind: 'run', id: run.run_id, run_id: run.run_id, task_id: task.task_id, job_id: null, pipeline_id: attempt.pipeline_id },
  };
}

/** Resolve a run or job id to a fixed commit. `--task` is only valid with a run id. */
export function resolveInspectTarget(store: JobStore, id: string, taskId?: string): ResolvedInspectTarget {
  if (taskId !== undefined && !RUN_ID_PATTERN.test(id)) {
    throw new GbdevError('usage_error', '--task is only valid with a run_id');
  }
  if (JOB_ID_PATTERN.test(id)) {
    let job: JobStatus;
    try { job = store.read(id); }
    catch (error) {
      if (error instanceof GbdevError && error.contract.code === 'job_not_found') unavailable('not_found');
      unavailable('record_corrupt');
    }
    return resolveJob(store, job);
  }
  if (RUN_ID_PATTERN.test(id)) return resolveRun(store, id, taskId);
  unavailable('unknown_id');
}

export function readJobResultChecks(store: JobStore, jobId: string): { id: string; exit_code: number | null; log: string; sha: string | null; at: string }[] {
  try {
    const raw = readFileSync(jobPaths(store.paths, jobId).result, 'utf8');
    const parsed = JSON.parse(raw) as { gbdev_observed?: { head_after?: string; checks?: { id?: string; exit_code?: number | null; log?: string }[] } };
    const sha = typeof parsed.gbdev_observed?.head_after === 'string' ? parsed.gbdev_observed.head_after : null;
    const job = store.read(jobId);
    return (parsed.gbdev_observed?.checks ?? []).flatMap(check => {
      if (!check || typeof check.id !== 'string' || typeof check.log !== 'string') return [];
      return [{ id: check.id, exit_code: typeof check.exit_code === 'number' || check.exit_code === null ? check.exit_code ?? null : null, log: check.log, sha, at: job.updated_at }];
    });
  } catch {
    return [];
  }
}
