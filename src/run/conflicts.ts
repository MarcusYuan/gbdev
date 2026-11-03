import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MergeRecord } from '../contracts/mergeRecord.js';
import type { Run, RunTask } from '../contracts/run.js';
import type { RunRequest } from '../contracts/runRequest.js';
import type { RoleSnapshot } from '../contracts/pipelineRequest.js';
import type { PipelineSlotHooks } from '../pipeline/supervisor.js';
import { JobStore } from '../core/jobStore.js';
import { git, gitGuardedAsync, headAsync, type GitGuardContext } from '../core/git.js';
import { jobPaths } from '../core/paths.js';
import { jsonFile, runEvent } from './store.js';
import { runJob } from './jobs.js';

export async function resolveConflict(store: JobStore, run: Run, request: RunRequest, task: RunTask, record: MergeRecord, context: GitGuardContext,
  snapshots: Record<string, RoleSnapshot>, hooks: PipelineSlotHooks, signal: AbortSignal, attempts: number, maxFiles: number, checkpoint: () => void): Promise<boolean> {
  record.resolution = { attempts: [], verifier_job_id: null, verifier_verdict: null };
  if (record.precheck.conflict_files.length > maxFiles || !attempts) return false;
  for (let n = 1; n <= attempts; n++) {
    await gitGuardedAsync(context, { operation: 'resetHard', sha: record.pre_merge_sha });
    await gitGuardedAsync(context, { operation: 'clean' });
    try { await gitGuardedAsync(context, { operation: 'mergeNoCommit', sha: record.task_head_sha }, 120_000, signal); }
    catch (e) { if ((e as { status?: number }).status !== 1) throw e; }
    const conflicts = (await git(context.worktree, ['diff', '--name-only', '--diff-filter=U', '-z'], 120_000, signal)).split('\0').filter(Boolean);
    record.precheck.conflict_files = conflicts; checkpoint();
    if (conflicts.length > maxFiles) { await gitGuardedAsync(context, { operation: 'resetHard', sha: record.pre_merge_sha }); return false; }
    const files = (await git(context.worktree, ['ls-files', '-z'], 120_000, signal)).split('\0').filter(Boolean);
    const baseline = Object.fromEntries(files.map(file => { const path = join(context.worktree, file); return [file, !existsSync(path) ? 'absent' : lstatSync(path).isFile() ? readFileSync(path).toString('base64') : 'non-regular']; }));
    const job = await runJob(store, run, request, snapshots['internal:resolver']!, hooks, signal, { instance: `run:resolver#${record.seq}.${n}`, task, worktree: context.worktree, branch: context.branch, conflict_files: conflicts, baseline,
      prompt: JSON.stringify({ conflicts, ours: run.tasks.filter(t => t.state === 'integrated').map(t => ({ task: t, goal: request.tasks!.find(g => g.id === t.task_id) })), theirs: request.tasks!.find(t => t.id === task.task_id), history: task.attempts, previous_failures: record.resolution.attempts }) });
    const observedPath = join(jobPaths(store.paths, job.job_id).dir, 'resolution-observed.json');
    const observed = existsSync(observedPath) ? jsonFile<{ markers_left: string[]; touched_non_conflict: string[] }>(observedPath) : { markers_left: conflicts, touched_non_conflict: [] };
    record.resolution.attempts.push({ job_id: job.job_id, state: job.result.state === 'succeeded' ? 'succeeded' : 'failed', ...observed }); checkpoint();
    runEvent(store, run, 'resolver_finished', { job_id: job.job_id, seq: record.seq, ...observed, state: job.result.state }, task, context.worktree.match(/lane-[1-4]$/)?.[0]);
    if (observed.touched_non_conflict.length) run.warnings.push(`resolver_touched_non_conflict:${observed.touched_non_conflict.join(',')}`);
    if (job.result.state === 'succeeded' && !signal.aborted) {
      await git(context.worktree, ['add', '-A'], 120_000, signal);
      await gitGuardedAsync(context, { operation: 'snapshot', message: `gbdev: merge ${task.task_id} (${run.run_id}) [resolved by ${job.job_id}]` }, 120_000, signal);
      record.merge_sha = await headAsync(context.worktree, signal); checkpoint(); return true;
    }
    await gitGuardedAsync(context, { operation: 'resetHard', sha: record.pre_merge_sha });
    await gitGuardedAsync(context, { operation: 'clean' });
  }
  return false;
}
export async function verifyConflict(store: JobStore, run: Run, request: RunRequest, task: RunTask, record: MergeRecord, context: GitGuardContext,
  snapshots: Record<string, RoleSnapshot>, hooks: PipelineSlotHooks, signal: AbortSignal): Promise<boolean> {
  const diffs = [];
  for (const parent of [record.pre_merge_sha, record.task_head_sha]) diffs.push(await git(context.worktree, ['diff', parent, record.merge_sha!, '--'], 120_000, signal));
  const job = await runJob(store, run, request, snapshots['internal:verifier']!, hooks, signal, { instance: `run:verifier#${record.seq}`, task, worktree: context.worktree, branch: context.branch,
    prompt: JSON.stringify({ diffs, tasks: request.tasks, resolution: record.resolution }) });
  const review = job.result.worker_reported?.review;
  record.resolution!.verifier_job_id = job.job_id; record.resolution!.verifier_verdict = review?.verdict ?? null;
  runEvent(store, run, 'verifier_finished', { job_id: job.job_id, seq: record.seq, verdict: review?.verdict ?? null, findings: review?.findings ?? [] }, task);
  return job.result.state === 'succeeded' && review?.verdict === 'approve' && !review.findings.some(f => f.severity === 'critical');
}
