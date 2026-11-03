import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { event, locked, optionalText } from '../core/runtime.js';
import { runEvent, readRun } from '../run/store.js';
import { pipelineEvent, readRun as readPipeline } from '../pipeline/store.js';
import type { JobStatus } from '../contracts/jobStatus.js';
import type { NotifyUnit } from './filter.js';

import { deliveryLog } from './log.js';
export type NotifyFailure = 'secret_missing' | 'secret_unsafe' | 'secret_unsupported' | 'url_invalid' | 'enqueue_failed' | 'launch_failed' | 'config_invalid' | 'key_name_missing' | 'oversize' | 'paused_auth_rejected' | 'paused_endpoint_gone' | 'paused_redirect_refused';
export function notifyLog(store: JobStore, reason: NotifyFailure): void {
  deliveryLog(store.paths.home, reason);
}
/** Caller holds the event's global lock. Read persisted warnings, not a process-local flag. */
export function notifyWarning(store: JobStore, unit: NotifyUnit, reason: NotifyFailure, currentJob?: JobStatus): void {
  try {
    const path = unit.kind === 'job' ? jobPaths(store.paths, unit.id).events : join(store.paths.home, unit.kind === 'run' ? 'runs' : 'pipelines', unit.id, 'events.jsonl');
    if ((optionalText(path) ?? '').split('\n').some(line => { try { const e = JSON.parse(line); return e.type === 'warning' && e.data?.code === 'notify_unavailable'; } catch { return false; } })) return;
    const data = { code: 'notify_unavailable', reason };
    if (unit.kind === 'job') event(store, currentJob ?? store.read(unit.id), 'warning', data);
    else if (unit.kind === 'run') runEvent(store, readRun(store, unit.id), 'warning', data);
    else pipelineEvent(store, readPipeline(store, unit.id), 'warning', data);
  } catch { /* Best effort, including failures while writing the warning itself. */ }
}
export function notifyLaunchWarning(store: JobStore, unit: NotifyUnit): void {
  notifyLog(store, 'launch_failed');
  void locked(store, () => notifyWarning(store, unit, 'launch_failed')).catch(() => {});
}
export function pausedReason(dir: string): NotifyFailure | null {
  try {
    const reason: unknown = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).paused?.reason;
    return reason === 'paused_auth_rejected' || reason === 'paused_endpoint_gone' || reason === 'paused_redirect_refused' ? reason : null;
  } catch { return null; } // Unknown pause state cannot undo an outbox commit or suppress its trigger.
}
