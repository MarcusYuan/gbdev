import { setTimeout as delay } from 'node:timers/promises';
import { validateRun, type Run } from '../../contracts/run.js';
import { validatePipelineRun, type PipelineRun } from '../../contracts/pipelineRun.js';
import { JOB_STATES, isTerminal, type JobState } from '../../contracts/jobStatus.js';
import { HomeFs, RefusedPath, TransientPath } from '../homeFs.js';
import { safeText, record, str, truncate, type RenderLine, type Tag } from '../format.js';
import { LAUNCH_RETRYING_STATUS_HINT } from '../../core/verdictAcceptance.js';
import { localIso } from '../../core/time.js';
export const PIPELINE_ID = /^p_\d{8}_\d{4}_[a-f0-9]{4}$/;
export const terminal = (state: unknown): boolean => ['succeeded', 'failed', 'cancelled'].includes(str(state));
export const terminalJob = (state: unknown): boolean => (JOB_STATES as readonly string[]).includes(str(state)) && isTerminal(state as JobState);
export const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export const realClock: Clock = { now: Date.now, sleep: async (ms, signal) => { try { await delay(ms, undefined, signal ? { signal } : {}); } catch (e) { if (!signal?.aborted) throw e; } } };
export interface ViewOptions { columns?: number; verbose?: boolean; backfillLines?: number; pollMs?: number; retainFinishedMin?: number; idleExitMin?: number; session?: string; clock?: Clock; signal?: AbortSignal; pane?: boolean; once?: boolean; color?: boolean; tty?: boolean }
export function stamp(now: number, tag: Tag, text: string): RenderLine { return { at: localIso(new Date(now)), tag, text: safeText(text) }; }
export function textRow(text: string, columns = 120): string { return truncate(safeText(text).replace(/\t/g, '    '), columns); }
export function elapsed(at: unknown, now: number): string {
  const start = Date.parse(str(at)); if (!Number.isFinite(start)) return '-';
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}
/** Independent of stores/reconcile: no locks, writes, git, provider or supervisor imports. */
export class ViewFiles {
  readonly fs: HomeFs;
  private warned = new Set<string>();
  private notices: string[] = [];
  unstable = false;
  constructor(home: string) { this.fs = new HomeFs(home); }
  warn(path: string, error: unknown): void {
    if (error instanceof TransientPath) { this.unstable = true; return; }
    if (this.warned.has(path) || this.warned.size >= 256) return;
    this.warned.add(path); this.notices.push(error instanceof RefusedPath ? error.message : `cannot read ${path}`);
  }
  json(path: string): Record<string, unknown> | undefined {
    try { const data = this.fs.json(path); return data === undefined ? undefined : record(data); }
    catch (error) { this.warn(path, error); return undefined; }
  }
  exists(path: string): boolean | undefined {
    // Preserve the fail-closed lifecycle for a genuine refusal, but a racing
    // pathname/unreadable snapshot is not proof of deletion.
    try { return this.fs.exists(path); } catch (error) { this.warn(path, error); return error instanceof RefusedPath ? false : undefined; }
  }
  names(path: string, pattern: RegExp): string[] {
    try { return this.fs.names(path).filter(n => pattern.test(n)).sort(); }
    catch (error) { this.warn(path, error); return []; }
  }
  run(id: string): Run | undefined {
    const path = `runs/${id}/run.json`, data = this.json(path); if (!data) return;
    try { const run = validateRun(data); if (run.run_id !== id) throw new Error(); return run; }
    catch (error) { this.warn(path, error); return; }
  }
  pipeline(id: string): PipelineRun | undefined {
    if (!PIPELINE_ID.test(id)) { this.warn('pipeline id', new RefusedPath()); return; }
    const path = `pipelines/${id}/pipeline.json`, data = this.json(path); if (!data) return;
    try { const run = validatePipelineRun(data); if (run.pipeline_id !== id) throw new Error(); return run; }
    catch (error) { this.warn(path, error); return; }
  }
  warnings(now: number): RenderLine[] { return this.notices.splice(0).map(text => stamp(now, 'WARN', text)); }
}
/** Terminal observation starts retention, including an explicitly reopened old terminal unit. */
export class Lifecycle {
  state: 'WAIT_FILES' | 'BACKFILL' | 'FOLLOW' | 'SUMMARY' | 'LINGER' | 'EXIT' = 'WAIT_FILES';
  closeAt: number | undefined;
  private idleAt: number | undefined;
  constructor(readonly options: ViewOptions = {}) {}
  observe(found: boolean, done: boolean, now: number): void {
    if (this.state === 'EXIT') return;
    if (this.state === 'LINGER') { if (now >= this.closeAt!) this.state = 'EXIT'; return; }
    if (this.state === 'SUMMARY') return;
    if (!found) { this.state = 'WAIT_FILES'; return; }
    if (done) {
      this.state = 'SUMMARY';
      this.closeAt = now + (this.options.pane ? retentionMs(this.options.retainFinishedMin ?? 30) : 0);
    } else this.state = this.state === 'WAIT_FILES' ? 'BACKFILL' : 'FOLLOW';
  }
  summarized(now: number): void { this.state = this.options.once || now >= this.closeAt! ? 'EXIT' : 'LINGER'; }
  idle(active: boolean, now: number): boolean {
    if (active) this.idleAt = undefined; else this.idleAt ??= now;
    return this.idleAt !== undefined && now - this.idleAt >= (this.options.idleExitMin ?? 120) * 60000;
  }
}

/** End time is the terminal transition, never a later heartbeat/metadata rewrite. */
export function finishedAt(unit: Record<string, unknown>): number {
  return Date.parse(str(records(unit.state_history).findLast(h => h.state === unit.state)?.at ?? unit.updated_at));
}
export function retentionMs(minutes: number): number { return minutes === 0 ? 10000 : minutes * 60000; }

/** Read persisted retry facts without reconciling or mutating the job. */
export function launchRetryRows(files: ViewFiles, jobId: string, now: number): string[] {
  const job = files.json(`jobs/${jobId}/job.json`);
  if (!job || terminalJob(job.state) || !job.retry_not_before) return [];
  const chain = files.json(`jobs/${jobId}/launch-retry-chain.json`);
  const remaining = Date.parse(str(job.retry_not_before)) - now;
  if (!chain?.pending_execution || !Number.isFinite(remaining) || remaining <= 0) return [];
  return [`${jobId} ${LAUNCH_RETRYING_STATUS_HINT(Number(chain.launch_retries_used), Number(record(chain.policy).max_retries), remaining)}`];
}
