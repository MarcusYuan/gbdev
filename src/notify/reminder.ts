import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../core/config.js';
import { atomicWriteJson, type JobStore } from '../core/jobStore.js';
import { acquireLock, type LockHandle } from '../core/lock.js';
import { NOTIFY_DEFAULTS, notifyDisabledReason, type NotifyConfig } from '../core/notifyConfig.js';
import { locked } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { readRun } from '../run/store.js';
import { readRun as readPipeline } from '../pipeline/store.js';
import { notifiable, type NotifyUnit } from './filter.js';
import { notifyEvent, notifyTestingOptions, startReminder } from './enqueue.js';

export interface PendingReminder { key: string; unit: NotifyUnit; type: string; data: Record<string, unknown>; since: number }
export type ReminderState = Record<string, number>;
type ReminderConfig = Pick<NotifyConfig, 'reminder_after_min' | 'reminder_max'>;
/** Cumulative deadlines from the original attention: after, 2*after, 4*after, ... .
 * A delayed wake emits only the next ordinal; repeated scans catch up without losing IDs.
 */
export function planReminders(items: readonly PendingReminder[], state: ReminderState, now: number, config: ReminderConfig) {
  const due: { item: PendingReminder; n: number; waited_min: number }[] = [];
  let next_at: number | null = null;
  if (!config.reminder_max) return { due, next_at };
  for (const item of items) {
    const n = (state[item.key] ?? 0) + 1;
    if (n > config.reminder_max || !Number.isFinite(item.since)) continue;
    const at = item.since + config.reminder_after_min * 60_000 * 2 ** (n - 1);
    if (at <= now) due.push({ item, n, waited_min: Math.max(0, Math.floor((now - item.since) / 60_000)) });
    next_at = Math.min(next_at ?? Infinity, at);
  }
  return { due, next_at };
}
function names(path: string): string[] { try { return readdirSync(path); } catch { return []; } }
function candidate(unit: NotifyUnit, type: string, data: Record<string, unknown>, since: string, episode: string): PendingReminder[] {
  if (!notifiable(unit, type, data) || !Number.isFinite(Date.parse(since))) return [];
  const key = createHash('sha256').update(`${unit.kind}:${unit.id}:${episode}`).digest('hex');
  return [{ key, unit, type, data, since: Date.parse(since) }];
}
/** Caller holds the source lock. Corrupt/missing individual sources never block others. */
export function pendingReminders(store: JobStore): PendingReminder[] {
  const items: PendingReminder[] = [];
  for (const id of names(join(store.paths.home, 'runs'))) {
    try {
      const run = readRun(store, id);
      if (run.state !== 'needs_decision') continue;
      for (const attention of run.attention) items.push(...candidate({ kind: 'run', id, state: run.state }, 'decision_required', { ...attention }, attention.created_at, attention.decision_id));
    } catch { /* Damaged source. */ }
  }
  for (const id of names(join(store.paths.home, 'pipelines'))) {
    try {
      const run = readPipeline(store, id), last = run.state_history.at(-1);
      if (!['needs_input', 'needs_decision'].includes(run.state) || !last || last.state !== run.state) continue;
      items.push(...candidate({ kind: 'pipeline', id, state: run.state, workspace_mode: run.workspace.mode }, 'decision_required', { ...run.decision }, last.at, `${run.state_history.length}:${last.at}`));
    } catch { /* Damaged source. */ }
  }
  for (const id of names(store.paths.jobs)) {
    try {
      const job = store.read(id), last = job.state_history.at(-1);
      if (job.state !== 'needs_input' || !last || last.state !== job.state) continue;
      items.push(...candidate({ kind: 'job', id, state: job.state, pipeline_id: job.pipeline_id ?? null, run_id: job.run_id ?? job.branch.match(/^gbdev\/(r_\d{8}_\d{4}_[a-f0-9]{4})\//)?.[1] ?? (job.task_id ? 'owned' : null) }, 'state_change', { state: job.state }, last.at, `${job.state_history.length}:${last.at}`));
    } catch { /* Damaged source. */ }
  }
  return items;
}
function stateFor(store: JobStore, items: PendingReminder[]): ReminderState {
  const state: ReminderState = {};
  for (const { key } of items) {
    try {
      const n: unknown = JSON.parse(readFileSync(join(store.paths.home, 'notify', 'reminders', `${key}.json`), 'utf8'));
      if (Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 10) state[key] = Number(n);
    } catch { /* Missing/corrupt counters replay the deterministic notice ID safely. */ }
  }
  return state;
}
/** One transaction, also used by deterministic tests; never launches a reminder process. */
export async function reminderTick(store: JobStore, options: { now?: () => number; env?: NodeJS.ProcessEnv } = {}): Promise<number | null> {
  return locked(store, () => reminderTickLocked(store, options));
}
function reminderTickLocked(store: JobStore, options: { now?: () => number; env?: NodeJS.ProcessEnv }): number | null {
  const injected = notifyTestingOptions(store.paths.home), env = options.env ?? injected?.env ?? process.env;
  const config = loadConfig(store.paths.config).notify ?? NOTIFY_DEFAULTS;
  if (notifyDisabledReason(config, env) || !config.reminder_max) return null;
  const now = (options.now ?? injected?.now ?? Date.now)(), items = pendingReminders(store), state = stateFor(store, items);
  for (const { item, n, waited_min } of planReminders(items, state, now, config).due) {
    // Commit enqueue before counter. A crash between the writes replays the same ID,
    // which notice_ids deduplicates even when delivery has archived/deleted the notice.
    const committed = notifyEvent(store, item.unit, item.type, item.data, `reminder:${item.key}:${n}`, localIso(new Date(now)), undefined,
      { env, launch: true, reminder: { n, waited_min } });
    if (committed) {
      mkdirSync(join(store.paths.home, 'notify', 'reminders'), { recursive: true, mode: 0o700 });
      atomicWriteJson(join(store.paths.home, 'notify', 'reminders', `${item.key}.json`), n);
      state[item.key] = n;
    }
  }
  return planReminders(items, state, now, config).next_at;
}
/** Single-flight detached timer. Short polling notices resolutions/config changes and new
 * earlier deadlines. Lifetime rollover hands off only when pending work remains.
 */
export async function remind(store: JobStore, options: { now?: () => number; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; monotonic?: () => number } = {}): Promise<void> {
  const injected = notifyTestingOptions(store.paths.home), env = options.env ?? injected?.env ?? process.env;
  const now = options.now ?? injected?.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
  let lock: LockHandle | undefined;
  try {
    const config = loadConfig(store.paths.config).notify ?? NOTIFY_DEFAULTS;
    if (notifyDisabledReason(config, env) || !config.reminder_max) return;
    lock = acquireLock(join(store.paths.home, 'notify', 'remind.lock'));
    const end = monotonic() + config.deliverer_max_lifetime_min * 60_000;
    for (;;) {
      const next = await locked(store, () => {
        const at = reminderTickLocked(store, { now, env });
        if (at === null || monotonic() >= end) {
          // Release under source lock: a concurrent attention enqueue cannot lose its wake.
          lock!.release(); lock = undefined;
          if (at !== null) startReminder(store, env);
        }
        return at;
      });
      if (!lock || next === null) return;
      await (options.sleep ?? delay)(Math.max(1000, Math.min(60_000, next - now())));
    }
  } catch { /* Additive; supervisors/next attention can restart after a crash. */ }
  finally { lock?.release(); }
}
