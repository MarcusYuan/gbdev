import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateNotifyPayload, type NotifyPayload, type NotifyPaused } from '../contracts/notify.js';
import { loadConfig } from '../core/config.js';
import { atomicWriteJson, type JobStore } from '../core/jobStore.js';
import { acquireLock, type LockHandle } from '../core/lock.js';
import { NOTIFY_DEFAULTS, notifyDisabledReason } from '../core/notifyConfig.js';
import { locked } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { identity } from '../dashboard/names.js';
import type { OutboxRecord } from './enqueue.js';
import { postNotice, requestPreflight, type HttpResult } from './http.js';
import { deliveryLog } from './log.js';
import { assertNoSecret, readSecret, type SecretOptions } from './secret.js';
import { readDeliveryState, readDeliveryStateForDelivery, updateDeliveryState, type DeliveryState } from './state.js';
import { notifyWarning, type NotifyFailure } from './warning.js';

export interface DeliveryOptions {
  targetNoticeId?: string; waitLockMs?: number;
  env?: NodeJS.ProcessEnv; now?: () => number; monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>; random?: () => number;
  post?: typeof postNotice;
  secret?: Pick<SecretOptions, 'uid' | 'platform' | 'spawn' | 'defaultDirectory'>;
  /** Deterministic test barrier between the first and final empty scan. */
  onEmpty?: () => void | Promise<void>;
}
export const BACKOFF_MS = [5000, 15000, 60000, 120000, 300000, 600000, 900000];
export function backoff(attempts: number, random = Math.random): number {
  return Math.round((BACKOFF_MS[attempts - 1] ?? 1_800_000) * (0.8 + 0.4 * Math.max(0, Math.min(1, random()))));
}
const nameOf = (p: NotifyPayload) => `${p.seq}-${p.notice_id}.json`;
const iso = (now: number) => localIso(new Date(now));
function files(dir: string, includeCorrupt = false): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && (/^(?:\d+-n_[a-f0-9]{16})\.json$/.test(e.name) || includeCorrupt && /^corrupt_\d+-n_[a-f0-9]{16}\.json$/.test(e.name))).map(e => e.name); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
/** Pure scan for status/doctor: never quarantines, logs, or changes state. */
export function readPendingNotices(home: string): OutboxRecord[] { return scanPending(home, false); }
export function pendingNotices(home: string): OutboxRecord[] { return scanPending(home, true); }
function scanPending(home: string, quarantine: boolean): OutboxRecord[] {
  const dir = join(home, 'notify', 'outbox');
  const records: OutboxRecord[] = [];
  for (const file of files(dir)) {
    try {
      const p = JSON.parse(readFileSync(join(dir, file), 'utf8')) as OutboxRecord;
      const { meta, ...payload } = p; validateNotifyPayload(payload, false);
      if (file !== nameOf(p) || !meta || typeof meta !== 'object' || Array.isArray(meta) ||
          !Number.isSafeInteger(meta.attempts) || meta.attempts < 0 || typeof meta.next_at !== 'string' || !Number.isFinite(Date.parse(meta.next_at)) ||
          !(meta.last_error === null || typeof meta.last_error === 'string')) throw new Error('Invalid queue record');
      records.push(p);
    } catch {
      if (!quarantine) continue;
      // Do not reflect untrusted contents or filenames in diagnostics.
      deliveryLog(home, 'corrupt_record');
      try {
        const dead = join(home, 'notify', 'dead'); mkdirSync(dead, { recursive: true, mode: 0o700 });
        renameSync(join(dir, file), join(dead, `corrupt_${file}`));
      } catch { /* A failed quarantine must not starve valid records. */ }
    }
  }
  return records.sort((a, b) => a.seq - b.seq);
}
function save(home: string, record: OutboxRecord): void { atomicWriteJson(join(home, 'notify', 'outbox', nameOf(record)), record); }
function archive(home: string, record: OutboxRecord, destination: 'sent' | 'dead', reason: string, now: number, httpStatus?: number): void {
  const dir = join(home, 'notify', destination); mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Persist outcome before moving: a crash is replayable, not a silently lost notice.
  atomicWriteJson(join(home, 'notify', 'outbox', nameOf(record)), { ...record, meta: { ...record.meta, outcome: reason, archived_at: iso(now), ...(httpStatus === undefined ? {} : { http_status: httpStatus }) } });
  renameSync(join(home, 'notify', 'outbox', nameOf(record)), join(dir, nameOf(record)));
}
/** Only retained delivery records: never visit notice_ids or staging. */
export function pruneDelivery(home: string, now: number): void {
  const sent = join(home, 'notify', 'sent'), dead = join(home, 'notify', 'dead');
  for (const file of files(sent).sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0])).slice(200)) rmSync(join(sent, file));
  for (const file of files(dead, true)) {
    const path = join(dead, file);
    let at = NaN;
    if (!file.startsWith('corrupt_')) {
      try { at = Date.parse((JSON.parse(readFileSync(path, 'utf8')) as { meta?: { archived_at?: string } }).meta?.archived_at ?? ''); }
      catch { /* Unreadable/unparseable archives use mtime retention. */ }
    }
    try { if (now - (Number.isFinite(at) ? at : statSync(path).mtimeMs) > 30 * 86400_000) rmSync(path); }
    catch { /* A single inaccessible archive cannot block delivery. */ }
  }
}
export function deliveryGroups(records: OutboxRecord[], coalesce: boolean): OutboxRecord[][] {
  const groups = new Map<string, OutboxRecord[]>();
  for (const record of records) {
    const key = coalesce && record.event !== 'test' && !record.reminder ? `${record.unit_kind}:${record.unit_id}` : record.notice_id;
    const group = groups.get(key) ?? []; group.push(record); groups.set(key, group);
  }
  return [...groups.values()].map(g => g.sort((a, b) => a.seq - b.seq)).sort((a, b) => a.at(-1)!.seq - b.at(-1)!.seq);
}
function pauseFor(status: number | null): NotifyPaused['reason'] | null {
  return status === 401 || status === 403 ? 'paused_auth_rejected' : status === 404 || status === 410 ? 'paused_endpoint_gone' : status !== null && status >= 300 && status < 400 ? 'paused_redirect_refused' : null;
}
async function warn(store: JobStore, records: OutboxRecord[], reason: NotifyFailure): Promise<void> {
  const seen = new Set<string>();
  await locked(store, () => {
    for (const p of records) if (p.unit_id && p.unit_kind && !seen.has(p.unit_id)) {
      seen.add(p.unit_id); notifyWarning(store, { kind: p.unit_kind, id: p.unit_id, state: p.unit_state! }, reason);
    }
  });
}
/** Fire-and-forget child entry: all errors are contained and diagnostics are closed enums. */
export async function deliver(store: JobStore, options: DeliveryOptions = {}): Promise<void> {
  const home = store.paths.home, env = options.env ?? process.env;
  // Return before reading config/creating anything in the default suite.
  if (env.GBDEV_NOTIFY === '0' || env.NODE_TEST_CONTEXT !== undefined && env.GBDEV_NOTIFY_TEST !== '1') return;
  let lock: LockHandle | undefined;
  const now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = monotonic();
  const update = (patch: Partial<DeliveryState>) => updateDeliveryState(store, patch, true);
  try {
    let fullConfig = loadConfig(store.paths.config), config = fullConfig.notify ?? NOTIFY_DEFAULTS;
    if (notifyDisabledReason(config, env)) return;
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || '0' === process.env.NODE_TLS_REJECT_UNAUTHORIZED) { deliveryLog(home, 'tls'); return; }
    if (!files(join(home, 'notify', 'outbox')).length) return;
    for (;;) {
      try { lock = acquireLock(join(home, 'notify', 'deliver.lock')); break; }
      catch { if (monotonic() - started >= (options.waitLockMs ?? 0)) return; await sleep(Math.min(20, (options.waitLockMs ?? 0) - (monotonic() - started))); }
    }
    await update({ deliverer_pid: process.pid });
    while (monotonic() - started < config.deliverer_max_lifetime_min * 60000) {
      // Disabling/rotating config while a process sleeps takes effect next iteration.
      fullConfig = loadConfig(store.paths.config); config = fullConfig.notify ?? NOTIFY_DEFAULTS;
      if (notifyDisabledReason(config, env)) return;
      const state = await readDeliveryStateForDelivery(store);
      const secretOptions: SecretOptions = { paths: store.paths, config, allowed_repos: fullConfig.allowed_repos, home_id: identity(home).h12, env, keychain_setup_at: state.keychain_setup_at ?? null, ...options.secret };
      if (state.paused) {
        const current = await readSecret(secretOptions);
        if (!current.ok || current.secret_gen === state.paused_secret_gen) return;
        await update({ paused: null, paused_secret_gen: null });
      }
      let records = pendingNotices(home);
      if (options.targetNoticeId) {
        records = records.filter(p => p.notice_id === options.targetNoticeId);
        // A competing deliverer may already have tried this fresh test while CLI waited.
        // Report its outcome; never turn the synchronous test into a retry loop.
        if (!records.length || records[0]!.meta.attempts > 0) return;
      }
      if (!records.length) {
        await options.onEmpty?.();
        if (pendingNotices(home).length) continue;
        // Close the final scan/unlock race: any enqueue after release can win the lock.
        await update({ deliverer_pid: null });
        lock.release(); lock = undefined;
        if (!pendingNotices(home).length) return;
        try { lock = acquireLock(join(home, 'notify', 'deliver.lock')); } catch { return; }
        await update({ deliverer_pid: process.pid });
        continue;
      }
      const expired = records.filter(p => now() - Date.parse(p.occurred_at) > config.max_age_h * 3600000);
      for (const p of expired) { archive(home, p, 'dead', 'expired', now()); deliveryLog(home, 'expired', p.notice_id, p.seq); }
      records = records.filter(p => !expired.includes(p));
      pruneDelivery(home, now());
      if (!records.length) continue;
      const groups = deliveryGroups(records, config.coalesce);
      const group = groups.find(g => Date.parse(g.at(-1)!.meta.next_at) <= now());
      if (!group) {
        const delay = Math.max(1, Math.min(60000, Math.min(...groups.map(g => Date.parse(g.at(-1)!.meta.next_at))) - now(), config.deliverer_max_lifetime_min * 60000 - (monotonic() - started)));
        const before = now(); await sleep(delay); const elapsed = now() - before;
        if (elapsed > delay * 2 && elapsed > 120000) {
          for (const p of pendingNotices(home)) { p.meta.next_at = iso(now()); save(home, p); }
          deliveryLog(home, 'clock_jump'); await sleep(10000);
        }
        continue;
      }
      const record = group.at(-1)!;
      const { meta: _meta, ...base } = record;
      const payload: NotifyPayload = { ...base, sent_at: iso(now()), attempt: record.meta.attempts + 1, coalesced: group.length, covers_seq: [group[0]!.seq, record.seq] };
      const blockSecret = async (reason: NonNullable<DeliveryState['blocked_reason']>, problem: DeliveryState['secret_problem'] = null) => {
        await update({ blocked_reason: reason, secret_problem: problem, last_error_notice_id: record.notice_id, last_error: { class: 'secret', http_status: null, at: iso(now()) } });
        deliveryLog(home, reason, record.notice_id, record.seq, null);
        await warn(store, records, reason);
      };
      const preflight = requestPreflight(payload, config, env);
      if (preflight === 'secret') { await blockSecret('secret_unsafe'); return; }
      // Validate before persisting any attempt; credentials never leave the callback.
      const currentState = await readDeliveryStateForDelivery(store);
      const checked = await readSecret(secretOptions, credentials => {
        assertNoSecret(payload, credentials); assertNoSecret(currentState, credentials);
      });
      if (!checked.ok) { await blockSecret(checked.reason!, checked.problem); return; }
      const previous = { last_attempt_at: currentState.last_attempt_at, attempts: record.meta.attempts, attempt: record.attempt, sent_at: record.sent_at };
      record.meta.attempts++; record.attempt = payload.attempt; record.sent_at = payload.sent_at;
      // Attempts are durable before POST. Storage exceptions never cross readSecret.
      save(home, record);
      await update({ last_attempt_at: payload.sent_at, blocked_reason: null, secret_problem: null });
      let result: HttpResult = { status: null, error: preflight, retry_after_ms: null };
      // Revalidate after persistence too: rotation must not bypass the safety checks.
      const secret = await readSecret(secretOptions, async credentials => {
        assertNoSecret(payload, credentials);
        try { result = await (options.post ?? postNotice)(credentials, payload, config, env, now); }
        catch { result = { status: null, error: 'network', retry_after_ms: null }; }
      });
      if (!secret.ok || result.error === 'secret') {
        record.meta.attempts = previous.attempts; record.attempt = previous.attempt; record.sent_at = previous.sent_at;
        save(home, record);
        await locked(store, () => {
          const latest = readDeliveryState(home);
          if (previous.last_attempt_at === undefined) delete latest.last_attempt_at; else latest.last_attempt_at = previous.last_attempt_at;
          atomicWriteJson(join(home, 'notify', 'state.json'), latest);
        });
        await blockSecret(secret.ok ? 'secret_unsafe' : secret.reason!, secret.ok ? null : secret.problem);
        return;
      }
      const { status, error } = result;
      if (record.event === 'test') await locked(store, () => {
        const latest = readDeliveryState(home);
        if (!latest.last_test || latest.last_test.seq <= record.seq) atomicWriteJson(join(home, 'notify', 'state.json'), { ...latest, last_test_secret_gen: secret.secret_gen, last_test: { notice_id: record.notice_id, seq: record.seq, sent_at: payload.sent_at, http_status: status, delivered: status !== null && status >= 200 && status < 300 } });
      });
      const paused = pauseFor(status);
      if (paused) {
        await update({ paused: { reason: paused, at: iso(now()), http_status: status }, paused_secret_gen: secret.secret_gen, last_error_notice_id: record.notice_id, last_error: { class: paused === 'paused_auth_rejected' ? 'auth_rejected' : paused === 'paused_endpoint_gone' ? 'endpoint_gone' : 'redirect_refused', http_status: status, at: iso(now()) } });
        deliveryLog(home, paused, record.notice_id, record.seq, status); await warn(store, records, paused); return;
      }
      if (status !== null && status >= 200 && status < 300) {
        // Archive covered notices first; until all moves finish the representative remains replayable.
        for (const covered of group.slice(0, -1)) archive(home, covered, 'sent', 'sent_coalesced', now());
        archive(home, { ...record, ...payload }, 'sent', 'sent', now(), record.event === 'test' ? status : undefined);
        await update({ last_success_at: iso(now()), last_error: null, last_error_notice_id: null, last_delivery: { notice_id: record.notice_id, seq: record.seq, event: record.event, at: iso(now()), http_status: status } });
        deliveryLog(home, 'sent', record.notice_id, record.seq, status);
      } else if (error === 'oversize' || status !== null && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) {
        archive(home, record, 'dead', error === 'oversize' ? 'oversize' : `rejected_${status}`, now());
        await update({ last_error_notice_id: record.notice_id, last_error: { class: error === 'oversize' ? 'oversize' : 'rejected', http_status: status, at: iso(now()) } });
        deliveryLog(home, error === 'oversize' ? 'oversize' : 'rejected', record.notice_id, record.seq, status);
        if (error === 'oversize') await warn(store, [record], 'oversize');
      } else {
        const classification = error ?? 'http_retryable';
        const delay = Math.max(backoff(record.meta.attempts, options.random), result.retry_after_ms ?? 0);
        // The 30-minute Retry-After ceiling is independent of exponential jitter.
        record.meta.next_at = iso(now() + (status === 429 ? Math.min(1_800_000, delay) : delay));
        record.meta.last_error = classification; save(home, record);
        await update({ last_error_notice_id: record.notice_id, last_error: { class: classification, http_status: status, at: iso(now()) } });
        deliveryLog(home, classification, record.notice_id, record.seq, status);
      }
      pruneDelivery(home, now());
      if (options.targetNoticeId) return;
    }
  } catch { deliveryLog(home, 'storage_failed'); }
  finally {
    if (lock) {
      try { await update({ deliverer_pid: null }); } catch { /* Preserve queue on disk failure. */ }
      lock.release();
    }
  }
}
