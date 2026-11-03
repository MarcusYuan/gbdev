import { createHash } from 'node:crypto';
import { GbdevError } from '../contracts/error.js';
import { NOTIFY_REASON_CODES, REMINDER_SOURCE, notifyNextStep, validateNotifyPayload, type NotifyPayload } from '../contracts/notify.js';
import { sanitizeForTerminal } from '../render/sanitize.js';
import { redactSecrets } from '../render/redact.js';
export interface PayloadInput {
  home_id: string; home_label?: string | null; unit_kind: NotifyPayload['unit_kind']; unit_id: string | null;
  event: NotifyPayload['event']; kind: NotifyPayload['kind']; reason_code?: unknown; decision_id?: string | null; task_id?: string | null;
  unit_state: string | null; source_seq: number | string; seq: number; occurred_at: string; sent_at: string; gbdev_version: string;
  attention_summary?: string;
  reminder?: NotifyPayload['reminder'];
  attempt?: number; coalesced?: number; covers_seq?: [number, number];
}
/** test callers supply a freshly generated randomUUID(); explicit entropy keeps this module pure. */
export function computeNoticeId(input: Pick<PayloadInput, 'home_id' | 'unit_id' | 'event' | 'kind' | 'decision_id' | 'source_seq'>): string {
  if (input.event === 'test' ? typeof input.source_seq !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.source_seq) : !(input.event === 'attention' && typeof input.source_seq === 'string' && REMINDER_SOURCE.test(input.source_seq)) && (!Number.isSafeInteger(input.source_seq) || Number(input.source_seq) < 1)) throw new GbdevError('config_invalid', 'Invalid notify source sequence');
  return 'n_' + createHash('sha256').update([input.home_id, String(input.unit_id), input.event, input.kind, input.decision_id ?? '', input.event === 'health' && input.kind === 'supervisor_heartbeat_stale' ? '' : String(input.source_seq)].join('\n')).digest('hex').slice(0, 16);
}
export type PayloadResult = { ok: true; payload: NotifyPayload; json: string } | { ok: false; reason: 'oversize' };
/** Does not mutate its input. Ordered trimming also works for future contract extensions. */
export function fitPayload(payload: NotifyPayload): PayloadResult {
  const p = { ...payload, covers_seq: [...payload.covers_seq] as [number, number] };
  for (let step = 0; step < 4; step++) {
    const json = JSON.stringify(p);
    if (Buffer.byteLength(json, 'utf8') <= 2048) return { ok: true, payload: p, json };
    if (step === 0) p.summary = '';
    else if (step === 1) p.home_label = null;
    else if (step === 2) p.next_step = '';
  }
  return { ok: false, reason: 'oversize' };
}
export function buildPayload(input: PayloadInput): PayloadResult {
  // Explicit projection: never spread event/attention/worker data into the payload.
  const p: NotifyPayload = {
    schema: 'gbdev.notify.v1', source_seq: input.source_seq, notice_id: computeNoticeId(input), seq: input.seq, home_id: input.home_id, home_label: input.home_label ?? null,
    unit_kind: input.unit_kind, unit_id: input.unit_id, event: input.event, kind: input.kind,
    reason_code: (NOTIFY_REASON_CODES as readonly unknown[]).includes(input.reason_code) ? input.reason_code as NotifyPayload['reason_code'] : null,
    decision_id: input.decision_id ?? null, task_id: input.task_id ?? null, unit_state: input.unit_state, summary: '', occurred_at: input.occurred_at, sent_at: input.sent_at,
    attempt: input.attempt ?? 1, coalesced: input.coalesced ?? 1, covers_seq: input.covers_seq ?? [input.seq, input.seq], next_step: '', gbdev_version: input.gbdev_version,
  };
  if (input.reminder !== undefined) p.reminder = { ...input.reminder };
  validateNotifyPayload(p, false); // IDs/enums are validated before use in either template.
  const summary = p.event === 'test' ? 'gbdev 通知测试' : `${p.unit_kind} ${p.unit_id} ${p.event === 'attention' ? '需要决策' : p.event === 'terminal' ? '已结束' : '健康提醒'}：${p.kind}${p.task_id ? `（task ${p.task_id}）` : ''}`;
  p.summary = redactSecrets(sanitizeForTerminal((p.reminder ? `提醒（已等待 ${p.reminder.waited_min} 分钟）：` : '') + (p.event === 'attention' && typeof input.attention_summary === 'string' ? input.attention_summary : summary))).slice(0, 200);
  p.next_step = notifyNextStep(p.unit_kind, p.unit_id);
  const result = fitPayload(p);
  if (result.ok) validateNotifyPayload(result.payload);
  return result;
}
