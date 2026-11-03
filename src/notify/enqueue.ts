import { chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { type JobStore } from '../core/jobStore.js';
import { ownsLock } from '../core/lock.js';
import { NOTIFY_DEFAULTS, notifyDisabledReason } from '../core/notifyConfig.js';
import { identity } from '../dashboard/names.js';
import type { JobStatus } from '../contracts/jobStatus.js';
import type { NotifyPayload } from '../contracts/notify.js';
import { GbdevError } from '../contracts/error.js';
import { notifiable, type NotifyUnit } from './filter.js';
import { buildPayload, computeNoticeId } from './payload.js';
import { launchDeliver, NotifyTrigger, type LaunchNotify } from './trigger.js';
import { notifyLaunchWarning, notifyLog, notifyWarning, pausedReason, type NotifyFailure } from './warning.js';

export interface OutboxRecord extends NotifyPayload { meta: { attempts: number; next_at: string; last_error: null | string } }
interface Testing { launch: LaunchNotify; launchReminder?: LaunchNotify; now?: () => number; env?: NodeJS.ProcessEnv; timing?: (ms: number) => void }
const testing = new Map<string, Testing>();
const triggers = new Map<string, NotifyTrigger>();
/** Scoped injection; production filtering never depends on this or on async context. */
export function installNotifyTesting(home: string, options: Testing): () => void {
  testing.set(home, options); triggers.delete(home);
  return () => { testing.delete(home); triggers.delete(home); };
}
export function notifyTestingOptions(home: string): Testing | undefined { return testing.get(home); }
export function startReminder(store: JobStore, env: NodeJS.ProcessEnv): void {
  const options = testing.get(store.paths.home);
  // Existing tests injecting delivery launch also suppress reminder launch by default.
  const launch = options ? options.launchReminder ?? (() => {}) : (failed: () => void) => launchDeliver(store.paths, failed, env, undefined, '__notify-remind');
  try { launch(() => notifyLog(store, 'launch_failed')); } catch { notifyLog(store, 'launch_failed'); }
}
function entries(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
/** Atomic visibility, without a blocking storage flush on the supervisor hot path.
 * Process crashes are safe; sudden power-loss durability is not a local enqueue guarantee.
 */
function atomicQueueWrite(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`; let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600); fchmodSync(fd, 0o600); writeFileSync(fd, content); closeSync(fd); fd = undefined;
    renameSync(temp, path);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
}
/** Synchronous transaction: MUST run in the same global lock as its source event.
 * Persist seq first: a crash may leave a gap, but can never reuse a committed seq.
 * No credentials are read here. Every failure (including observers) is contained.
 * True means committed now or previously (including records since delivered/deleted).
 * False means filtered/disabled/failed; callers must not persist a one-shot marker.
 */
export function notifyEvent(store: JobStore, unit: NotifyUnit | null, type: string, data: Record<string, unknown>, source_seq: number | string, at: string, currentJob?: JobStatus, control?: { env: NodeJS.ProcessEnv; launch: boolean; reminder?: NonNullable<NotifyPayload['reminder']> }): boolean {
  let enabled = false, reason: NotifyFailure = 'enqueue_failed';
  let claim: string | undefined, staged: string | undefined, committed = false;
  const started = performance.now();
  try {
    const notice = notifiable(unit, type, data);
    // Run attention can be published while other lanes still run. The first timer
    // may already have exited before the later needs_decision transition.
    const reminderWake = unit?.kind === 'run' && type === 'run_state_change' && data.state === 'needs_decision';
    if (!notice && !reminderWake) return false;
    const options = testing.get(store.paths.home), env = control?.env ?? options?.env ?? process.env;
    if (env.GBDEV_NOTIFY === '0' || env.NODE_TEST_CONTEXT !== undefined && env.GBDEV_NOTIFY_TEST !== '1') return false;
    reason = 'config_invalid';
    const config = loadConfig(store.paths.config).notify ?? NOTIFY_DEFAULTS;
    if (notifyDisabledReason(config, env)) return false;
    enabled = true; reason = 'enqueue_failed';
    if (!ownsLock(store.paths.lock)) throw new Error('Notify requires source event lock');
    if (!notice) {
      if (config.reminder_max > 0 && control?.launch !== false) startReminder(store, env);
      return false; // Wake only, not a new notifiable event or decision.
    }
    const dir = join(store.paths.home, 'notify');
    const input = { ...notice, ...(control?.reminder ? { reminder: control.reminder } : {}), ...(notice.event === 'attention' && typeof data.summary === 'string' ? { attention_summary: data.summary } : {}), home_id: identity(store.paths.home).h12, home_label: config.home_label, unit_kind: unit?.kind ?? null, unit_id: unit?.id ?? null, unit_state: unit?.state ?? null, source_seq, occurred_at: at, sent_at: at, gbdev_version: '1.0.0' };
    const id = computeNoticeId(input);
    for (const path of [dir, join(dir, 'outbox'), join(dir, 'notice_ids'), join(dir, 'staging')]) if (mkdirSync(path, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(path, 0o700);
    const marker = join(dir, 'notice_ids', id), stage = join(dir, 'staging', `${id}.json`);
    let recovered = false;
    try {
      const fd = openSync(marker, 'wx', 0o600); claim = marker;
      try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const raw = readFileSync(marker, 'utf8').trim();
      if (raw === '') {
        // The source lock excludes live enqueuers: an empty claim is an
        // interrupted, uncommitted transaction, safe to reclaim.
        rmSync(stage, { force: true }); rmSync(marker);
        const fd = openSync(marker, 'wx', 0o600); claim = marker;
        try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
      } else {
        if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('Invalid notice index');
        if (!existsSync(stage)) {
          // A replay may be the first entry after the original process died before launch.
          if (notice.event === 'attention' && !control?.reminder && config.reminder_max > 0 && control?.launch !== false) startReminder(store, env);
          return true;
        }
        // Index was committed before publishing outbox. Finish an interrupted
        // rename; delivery never reads/deletes staging or notice_ids.
        // This is a committed transaction, never owned by this replay.
        staged = stage;
        renameSync(stage, join(dir, 'outbox', `${raw}-${id}.json`));
        recovered = true;
      }
    }
    if (!recovered) {
      const files = ['outbox', 'sent', 'dead'].flatMap(name => entries(join(dir, name)));
      // Upgrade pre-index S2 records while they still exist.
      const existing = files.find(file => file.endsWith(`-${id}.json`));
      if (existing) { atomicQueueWrite(marker, `${existing.split('-')[0]}\n`); claim = undefined; }
      else {
        let previous = 0;
        try { const raw = readFileSync(join(dir, 'seq'), 'utf8').trim(); if (!/^\d+$/.test(raw)) throw new Error(); previous = Number(raw); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        // Recover a lagging/missing seq after interrupted filesystem persistence.
        for (const file of files) { const match = /^(\d+)-n_[a-f0-9]{16}\.json$/.exec(file); if (match) previous = Math.max(previous, Number(match[1])); }
        const seq = previous + 1;
        if (!Number.isSafeInteger(seq) || seq < 1) throw new Error();
        const result = buildPayload({ ...input, seq });
        if (!result.ok) { reason = 'oversize'; throw new Error(); }
        atomicQueueWrite(join(dir, 'seq'), `${seq}\n`);
        staged = stage;
        atomicQueueWrite(stage, JSON.stringify({ ...result.payload, meta: { attempts: 0, next_at: at, last_error: null } } satisfies OutboxRecord) + '\n');
        // Commit a tiny, non-secret seq index BEFORE exposing the outbox record.
        // The staging file lets a replay finish publication after a process crash.
        atomicQueueWrite(marker, `${seq}\n`); claim = undefined;
        renameSync(stage, join(dir, 'outbox', `${seq}-${id}.json`));
      }
    }
    committed = true;
    const paused = pausedReason(dir); if (paused && unit) notifyWarning(store, unit, paused, currentJob);
    let trigger = triggers.get(store.paths.home);
    if (!trigger) { trigger = new NotifyTrigger(options?.launch ?? (failed => launchDeliver(store.paths, failed, env)), options?.now); triggers.set(store.paths.home, trigger); }
    if (control?.launch !== false) trigger.fire(() => { if (unit) notifyLaunchWarning(store, unit); });
    if (notice.event === 'attention' && !control?.reminder && config.reminder_max > 0 && control?.launch !== false) startReminder(store, env);
    return true;
  } catch (error) {
    if (error instanceof GbdevError && error.contract.code === 'key_name_missing') reason = 'key_name_missing';
    notifyLog(store, reason);
    if (unit && ownsLock(store.paths.lock)) notifyWarning(store, unit, reason, currentJob);
    return committed;
  } finally {
    if (claim && !committed) {
      // Roll back only the empty placeholder owned by this transaction.
      // Filled indices and their staging survive every publication failure.
      try { rmSync(claim, { force: true }); if (staged) rmSync(staged, { force: true }); } catch { /* Best effort; a later replay retries recovery. */ }
    }
    try { if (enabled) testing.get(store.paths.home)?.timing?.(performance.now() - started); } catch { /* Test observers are additive too. */ }
  }
}

/** Restart persisted delivery on every supervisor entry; no credentials or network I/O. */
export function notifySupervisorStarted(store: JobStore): void {
  try {
    const options = testing.get(store.paths.home), env = options?.env ?? process.env;
    if (env.GBDEV_NOTIFY === '0' || (env.NODE_TEST_CONTEXT !== undefined && env.GBDEV_NOTIFY_TEST !== '1')) return;
    const config = loadConfig(store.paths.config).notify ?? NOTIFY_DEFAULTS;
    if (notifyDisabledReason(config, env)) return;
    if (config.reminder_max > 0) startReminder(store, env);
    if (!entries(join(store.paths.home, 'notify', 'outbox')).length) return;
    // Recovery must not be suppressed by a recent enqueue; deliver.lock is single-flight.
    (options?.launch ?? (failed => launchDeliver(store.paths, failed, env)))(() => notifyLog(store, 'launch_failed'));
  } catch { /* Additive only. */ }
}
