import { transitionPauseBudget } from '../core/pauseBudget.js';
import { notifyEvent } from '../notify/enqueue.js';
import { dashboardEvent } from '../dashboard/trigger.js';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { TASK_STATES, validateRun, type Run, type RunState, type RunTask } from '../contracts/run.js';
import type { JobEvent } from '../contracts/event.js';
import { RUN_ID_PATTERN } from '../core/ids.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { optionalText } from '../core/runtime.js';
import { compareInstantDesc, localIso } from '../core/time.js';
export const activeRun = (state: RunState) => ['queued', 'starting', 'planning', 'running', 'finalizing'].includes(state);
export const terminalRun = (state: RunState) => ['succeeded', 'failed', 'cancelled'].includes(state);
export function runPaths(store: JobStore, id: string) {
  if (!RUN_ID_PATTERN.test(id)) throw new GbdevError('run_invalid', 'Invalid run id');
  const dir = join(store.paths.home, 'runs', id);
  return { dir, run: join(dir, 'run.json'), request: join(dir, 'request.json'), snapshot: join(dir, 'roles.snapshot.json'), events: join(dir, 'events.jsonl'), cancel: join(dir, 'cancel.json'), result: join(dir, 'result.json'), diff: join(dir, 'diff.patch'), merges: join(dir, 'merges'), log: join(dir, 'supervisor.log') };
}
export function readRun(store: JobStore, id: string): Run {
  const raw = optionalText(runPaths(store, id).run);
  if (raw === null) throw new GbdevError('run_not_found', 'Run not found', { run_id: id });
  const run = validateRun(JSON.parse(raw));
  if (run.run_id !== id) throw new GbdevError('internal_error', 'Run identity mismatch');
  return run;
}
export function allRuns(store: JobStore): Run[] {
  let names: string[];
  try { names = readdirSync(join(store.paths.home, 'runs')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  return names.filter(n => RUN_ID_PATTERN.test(n)).map(n => readRun(store, n)).sort((a, b) => compareInstantDesc(a.created_at, b.created_at) || b.run_id.localeCompare(a.run_id));
}
export function assertRunIdle(store: JobStore): void {
  const run = allRuns(store).find(r => activeRun(r.state));
  if (run) throw new GbdevError('busy', 'A run is active', { running_run_id: run.run_id });
}
export function writeRun(store: JobStore, run: Run): void {
  // Finalize may publish additive exposure warnings from another lane. Every writer
  // (including onPipelineCreated and merge dequeue) must retain those observations.
  try {
    const previous = JSON.parse(optionalText(runPaths(store, run.run_id).run) ?? '{}') as { warnings?: unknown };
    if (Array.isArray(previous.warnings)) for (const warning of previous.warnings) {
      if (typeof warning === 'string' && /^notify_secret_exposed:j_\d{8}_\d{4}_[a-f0-9]{4}$/.test(warning) && !run.warnings.includes(warning)) run.warnings.push(warning);
    }
  } catch { /* Preserve pre-existing writer behavior for absent/corrupt snapshots. */ }
  run.updated_at = localIso();
  run.progress = Object.fromEntries(['total', ...TASK_STATES.filter(s => s !== 'cancelled')].map(s => [s, s === 'total' ? run.tasks.length : run.tasks.filter(t => t.state === s).length])) as Run['progress'];
  atomicWriteJson(runPaths(store, run.run_id).run, validateRun(run));
}
export function runEvent(store: JobStore, run: Run, type: JobEvent['type'], data: Record<string, unknown> = {}, task?: RunTask, lane?: string): void {
  const path = runPaths(store, run.run_id).events;
  const seq = (optionalText(path) ?? '').split('\n').filter(Boolean).length + 1;
  const at = localIso();
  appendFileSync(path, JSON.stringify({ schema: 'gbdev.event.v1', run_id: run.run_id, job_id: null, ...(task ? { task_id: task.task_id } : {}), ...(lane ? { lane } : {}), seq, at, source: 'gbdev', type, data } satisfies JobEvent) + '\n', { mode: 0o600 });
  dashboardEvent(store.paths.home, type, data);
  notifyEvent(store, { kind: 'run', id: run.run_id, state: run.state }, type, data, seq, at);
}
export const ALLOWED_RUN_TRANSITIONS: Partial<Record<RunState, RunState[]>> = {
  queued: ['starting', 'cancelled', 'failed'], starting: ['planning', 'running', 'cancelled', 'failed'], planning: ['plan_review', 'needs_decision', 'cancelled', 'failed'],
  plan_review: ['planning', 'running', 'cancelled'], running: ['needs_decision', 'finalizing', 'cancelled', 'failed'],
  needs_decision: ['running', 'planning', 'finalizing', 'succeeded', 'cancelled', 'failed'], finalizing: ['succeeded', 'needs_decision', 'running', 'cancelled', 'failed'],
};
export function transitionRun(store: JobStore, run: Run, state: RunState, reason: string | null = null): void {
  if (run.state === state) return;
  if (!ALLOWED_RUN_TRANSITIONS[run.state]?.includes(state)) throw new GbdevError('run_state_conflict', `Illegal run transition ${run.state} -> ${state}`);
  transitionPauseBudget(run, ['needs_decision', 'plan_review'].includes(state), terminalRun(state));
  run.state = state; run.state_reason = reason; run.failure_reason = state === 'failed' ? reason : null;
  run.state_history.push({ state, at: localIso(), by: 'gbdev', reason });
  runEvent(store, run, 'run_state_change', { state, reason });
}
export function taskState(store: JobStore, run: Run, task: RunTask, state: RunTask['state']): void {
  if (task.state === state) return;
  task.state = state; runEvent(store, run, 'task_state_change', { state, pipeline_id: task.attempts.at(-1)?.pipeline_id ?? null }, task, task.lane ?? undefined);
}
export function jsonFile<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
