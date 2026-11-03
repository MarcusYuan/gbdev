import { assertNoSecret, readSecret } from '../notify/secret.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { ERROR_CLASSES, LABEL, validateNotifyAck, validateNotifyTest, type NotifyAck, type NotifyTest, type NotifyStatus } from '../contracts/notify.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { locked } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { deliver, readPendingNotices, type DeliveryOptions } from '../notify/deliver.js';
import { notifyEvent } from '../notify/enqueue.js';
import { computeNoticeId } from '../notify/payload.js';
import { currentTest, currentVerification, inspectNotify, notifyStatus, notifyHintText, type StatusOptions } from '../notify/status.js';
import { readDeliveryState, retryAuth } from '../notify/state.js';
import { launchDeliver, type LaunchNotify } from '../notify/trigger.js';

export interface NotifyActionOptions extends StatusOptions {
  delivery?: DeliveryOptions; launch?: LaunchNotify; sleep?: (ms: number) => Promise<void>; monotonic?: () => number;
}
export async function notifyAck(store: JobStore, id: string, bot: string, options: StatusOptions = {}): Promise<NotifyAck> {
  return locked(store, async () => {
    const invalid = (reason: string): never => { throw new GbdevError('notify_ack_invalid', 'Notify acknowledgment refused', { reason }); };
    if (!LABEL.test(bot)) invalid('bad_label');
    const { state, secret, secretOptions } = await inspectNotify(store.paths, options), last = state.last_test;
    if (!last) return invalid('no_test');
    if (id !== last.notice_id) invalid('notice_mismatch');
    if (!last.delivered) invalid('not_delivered');
    const age = (options.now ?? Date.now)() - Date.parse(last.sent_at);
    if (!Number.isFinite(age) || age < 0 || age > 86400000 || !currentTest(state, secret)) invalid('stale');
    const verified = currentVerification(state, secret);
    if (verified && state.verified_by_bot && state.verified_by_bot !== bot) invalid('bound_to_other_bot');
    const result = validateNotifyAck({ schema: 'gbdev.notify-ack.v1', notice_id: id,
      verified_at: verified && state.verified_notice_id === id ? state.verified_at : localIso(new Date((options.now ?? Date.now)())), verified_by_bot: bot });
    const checked = await readSecret(secretOptions, credentials => assertNoSecret(result, credentials));
    if (!checked.ok) throw new GbdevError('notify_unavailable', 'Notify acknowledgment unavailable', { class: 'secret' });
    if (checked.secret_gen !== secret.secret_gen) invalid('stale');
    if (!(verified && state.verified_notice_id === id && state.verified_by_bot === bot)) atomicWriteJson(join(store.paths.home, 'notify', 'state.json'), {
      ...state, verified_at: result.verified_at, verified_notice_id: id, verified_by_bot: bot, verified_secret_gen: secret.secret_gen,
    });
    return result;
  });
}
export async function notifyTest(store: JobStore, options: NotifyActionOptions = {}): Promise<NotifyTest> {
  try { return await performNotifyTest(store, options); }
  catch (error) {
    if (error instanceof GbdevError && error.contract.code === 'notify_unavailable') throw error;
    throw new GbdevError('notify_unavailable', 'Notify test unavailable', { class: 'secret' });
  }
}
async function performNotifyTest(store: JobStore, options: NotifyActionOptions): Promise<NotifyTest> {
  const unavailable = (classification: string): never => { throw new GbdevError('notify_unavailable', 'Notify test unavailable', { class: (ERROR_CLASSES as readonly string[]).includes(classification) ? classification : 'secret' }); };
  const inspected = await inspectNotify(store.paths, options);
  if (inspected.disabled || !inspected.secret.ok || !inspected.config.key_name) return unavailable('secret');
  // Fail closed on corrupt diagnostics, without reflecting untrusted state.
  if (inspected.state.last_error && !(ERROR_CLASSES as readonly string[]).includes(inspected.state.last_error.class)) return unavailable('secret');
  const source_seq = randomUUID(), now = options.now ?? Date.now, at = localIso(new Date(now()));
  const id = computeNoticeId({ home_id: inspected.home_id, unit_id: null, event: 'test', kind: 'test', source_seq });
  let seq = 0;
  await locked(store, () => {
    if (!notifyEvent(store, null, 'test', {}, source_seq, at, undefined, { env: options.env ?? process.env, launch: false })) unavailable('secret');
    const record = readPendingNotices(store.paths.home).find(p => p.notice_id === id);
    if (!record) return unavailable('secret');
    seq = record.seq;
    atomicWriteJson(join(store.paths.home, 'notify', 'state.json'), { ...readDeliveryState(store.paths.home),
      last_test_secret_gen: inspected.secret.secret_gen, last_test: { notice_id: id, seq, sent_at: at, http_status: null, delivered: false } });
  });
  const monotonic = options.monotonic ?? (() => performance.now()), started = monotonic();
  await deliver(store, { ...(options.env ? { env: options.env } : {}), ...(options.now ? { now: options.now } : {}), ...(options.secret ? { secret: options.secret } : {}), ...options.delivery, targetNoticeId: id, waitLockMs: 5000 });
  const state = readDeliveryState(store.paths.home);
  // A pre-existing deliverer may have sent this test while we waited for its lock.
  let http_status: number | null = null, delivered = false;
  try { const sent = JSON.parse(readFileSync(join(store.paths.home, 'notify', 'sent', `${seq}-${id}.json`), 'utf8')); delivered = sent.meta?.outcome === 'sent'; http_status = sent.meta?.http_status ?? null; } catch { /* Pending or rejected. */ }
  if (state.last_test?.notice_id === id) { http_status = state.last_test.http_status; delivered = state.last_test.delivered; }
  if (!delivered) {
    const record = readPendingNotices(store.paths.home).find(p => p.notice_id === id);
    // Secret preflight failures roll attempts back to zero, but retain attribution.
    const ownError = state.last_error_notice_id === id ||
      (state.last_error_notice_id == null && (record?.meta.attempts ?? 0) > 0);
    return unavailable(ownError ? state.last_error?.class ?? 'timeout' : 'timeout');
  }
  return validateNotifyTest({ schema: 'gbdev.notify-test.v1', notice_id: id, seq, http_status, latency_ms: Math.max(0, Math.round(monotonic() - started)), delivered, awaiting_ack: delivered });
}
export async function notifyFlush(store: JobStore, waitMs: number, retry: boolean, options: NotifyActionOptions = {}): Promise<NotifyStatus> {
  const status = await notifyStatus(store.paths, false, options);
  if (!status.enabled) return status;
  if (retry) await retryAuth(store);
  if (readPendingNotices(store.paths.home).length) (options.launch ?? (failed => launchDeliver(store.paths, failed, options.env ?? process.env)))(() => {});
  const monotonic = options.monotonic ?? (() => performance.now()), started = monotonic();
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  while (readPendingNotices(store.paths.home).length && monotonic() - started < waitMs) await sleep(Math.min(50, waitMs - (monotonic() - started)));
  return notifyStatus(store.paths, false, options);
}
export async function notifyActionCommand(store: JobStore, args: string[], flags: Record<string, unknown>, options: NotifyActionOptions = {}) {
  const sub = args[0], allowed: Record<string, string[]> = { status: ['pending'], test: [], flush: ['wait-ms', 'retry-auth'], ack: ['bot'] };
  if (!sub || !Object.hasOwn(allowed, sub) || args.length !== (sub === 'ack' ? 2 : 1) || Object.keys(flags).some(k => !allowed[sub]!.includes(k))) throw new GbdevError('usage_error', 'Invalid notify arguments');
  if (sub === 'ack' && typeof flags.bot !== 'string') throw new GbdevError('usage_error', 'Notify ack requires --bot');
  const wait = flags['wait-ms'] ?? '0';
  if (typeof wait !== 'string' || !/^\d+$/.test(wait) || Number(wait) > 60000) throw new GbdevError('usage_error', 'Notify wait must be between 0 and 60000 ms');
  const result = sub === 'status' ? await notifyStatus(store.paths, flags.pending === true, options) : sub === 'test' ? await notifyTest(store, options) : sub === 'ack' ? await notifyAck(store, args[1]!, flags.bot as string, options) : await notifyFlush(store, Number(wait), flags['retry-auth'] === true, options);
  return { schema: result.schema, result, text: notifyActionText(result) };
}

function notifyActionText(result: NotifyStatus | NotifyTest | NotifyAck): string {
  if (result.schema === 'gbdev.notify-test.v1') return `测试通知已送达（${result.notice_id}，HTTP ${result.http_status}，${result.latency_ms} ms）\n等待 webhook routine 确认（notify ack）\n`;
  if (result.schema === 'gbdev.notify-ack.v1') return `通知已验证（${result.verified_by_bot}）\n测试通知：${result.notice_id}\n验证时间：${result.verified_at}\n`;
  const lines = [`通知状态：${result.init.state}`, `待投递：${result.pending}；近期死信：${result.dead_recent}`];
  if (result.init.missing_step) lines.push(`下一步：${result.init.missing_step}`);
  for (const item of result.pending_list ?? []) lines.push(`#${item.seq} ${item.notice_id} ${item.event}/${item.kind} 尝试 ${item.attempts} 次；下次：${item.next_at}`);
  return lines.join('\n') + '\n' + notifyHintText({ notify: result });
}
