import { GbdevError } from './error.js';
import { bool, closed, dateSchema, enumeration, list, nullable, number, schemaErrors, taskIdSchema, type JsonSchema } from './runValidation.js';
import { timestamp } from './validation.js';
import { DECISION_REASONS, RUN_STATES } from './run.js';
import { RUN_STATES as PIPELINE_STATES } from './pipelineRun.js';
import { JOB_STATES } from './jobStatus.js';
import { JOB_ID_PATTERN, RUN_ID_PATTERN } from '../core/ids.js';
export const NOTICE_ID = /^n_[a-f0-9]{16}$/;
export const HOME_ID = /^[a-f0-9]{12}$/;
export const LABEL = /^[a-z][a-z0-9-]{0,31}$/;
export const PIPELINE_ID = /^p_\d{8}_\d{4}_[a-f0-9]{4}$/;
export const NOTIFY_EVENTS = ['attention', 'terminal', 'health', 'test'] as const;
export const NOTIFY_KINDS = [...DECISION_REASONS, 'needs_input', 'blocked', 'needs_decision', 'job_needs_input', 'job_blocked', 'succeeded', 'failed', 'cancelled', 'timeout', 'supervisor_heartbeat_stale', 'notify_secret_exposed', 'test'] as const;
// Deliberately finite: newly introduced producer reasons must be reviewed here first.
export const NOTIFY_REASON_CODES = [...DECISION_REASONS, 'run_timeout', 'pipeline_supervisor_crashed', 'worker_stalled', 'worker_crashed', 'worker_result_missing', 'worker_reported_failed', 'outside_allowed_paths', 'readonly_modified', 'result_invalid', 'result_missing', 'workspace_snapshot_invalid', 'policy_repair_required'] as const;
export const NOTIFY_REASONS = ['disabled_by_config', 'disabled_by_env', 'disabled_in_tests', 'secret_missing', 'secret_unsafe', 'secret_unsupported', 'key_name_missing', 'url_invalid', 'paused_auth_rejected', 'paused_endpoint_gone', 'paused_redirect_refused'] as const;
export const INIT_STATES = ['disabled', 'not_configured', 'paused', 'configured_unverified', 'test_sent', 'verified'] as const;
export const MISSING_STEPS = ['setup_secret', 'set_key_name', 'enable', 'run_test', 'await_ack', 'resume_paused', 'env_disabled'] as const;
export const ERROR_CLASSES = ['network', 'timeout', 'tls', 'http_retryable', 'auth_rejected', 'endpoint_gone', 'redirect_refused', 'rejected', 'oversize', 'secret'] as const;
export const SECRET_PROBLEMS = ['not_found', 'symlink', 'not_regular_file', 'owner_mismatch', 'mode_not_0600', 'directory_not_0700', 'directory_owner_mismatch', 'unsafe_location', 'too_large', 'invalid_json', 'invalid_schema', 'url_invalid', 'key_invalid', 'read_failed', 'keychain_failed', 'unsupported'] as const;
export type SecretProblem = typeof SECRET_PROBLEMS[number];
const pattern = (re: RegExp): JsonSchema => ({ type: 'string', pattern: re.source });
const notice = pattern(NOTICE_ID), label = pattern(LABEL), http = nullable(number(100, 599));
const unitId = pattern(/^[rpj]_\d{8}_\d{4}_[a-f0-9]{4}$/);
const pausedSchema = nullable(closed({ reason: enumeration('paused_auth_rejected', 'paused_endpoint_gone', 'paused_redirect_refused'), at: dateSchema, http_status: http }));
export interface NotifyPaused { reason: 'paused_auth_rejected' | 'paused_endpoint_gone' | 'paused_redirect_refused'; at: string; http_status: number | null }
export interface NotifyLastTest { notice_id: string; seq: number; sent_at: string; http_status: number | null; delivered: boolean }
export interface NotifyLastDelivery { notice_id: string; seq: number; event: typeof NOTIFY_EVENTS[number]; at: string; http_status: number | null }
const lastTestSchema = closed({ notice_id: notice, seq: number(1), sent_at: dateSchema, http_status: http, delivered: bool });
const lastDeliverySchema = closed({ notice_id: notice, seq: number(1), event: enumeration(...NOTIFY_EVENTS), at: dateSchema, http_status: http });
export interface NotifyInit {
  state: typeof INIT_STATES[number]; missing_step: typeof MISSING_STEPS[number] | null; configured: boolean;
  verified_at: string | null; verified_notice_id: string | null; verified_by_bot: string | null;
  last_test: NotifyLastTest | null; last_delivery: NotifyLastDelivery | null; paused: NotifyPaused | null;
}
export const notifyInitSchema = closed({ state: enumeration(...INIT_STATES), missing_step: nullable(enumeration(...MISSING_STEPS)), configured: bool, verified_at: nullable(dateSchema), verified_notice_id: nullable(notice), verified_by_bot: nullable(label), last_test: nullable(lastTestSchema), last_delivery: nullable(lastDeliverySchema), paused: pausedSchema });
export interface NotifyReminder { n: number; waited_min: number }
export const REMINDER_SOURCE = /^reminder:[a-f0-9]{64}:(?:[1-9]|10)$/;
export interface NotifyPayload {
  reminder?: NotifyReminder;
  schema: 'gbdev.notify.v1'; source_seq?: number | string; notice_id: string; seq: number; home_id: string; home_label: string | null;
  unit_kind: 'run' | 'pipeline' | 'job' | null; unit_id: string | null; event: typeof NOTIFY_EVENTS[number]; kind: typeof NOTIFY_KINDS[number];
  reason_code: typeof NOTIFY_REASON_CODES[number] | null; decision_id: string | null; task_id: string | null; unit_state: string | null;
  summary: string; occurred_at: string; sent_at: string; attempt: number; coalesced: number; covers_seq: [number, number]; next_step: string; gbdev_version: string;
}
export const notifyPayloadSchema = closed({
  reminder: closed({ n: number(1, 10), waited_min: number() }),
  schema: { const: 'gbdev.notify.v1' }, source_seq: { anyOf: [number(1), pattern(REMINDER_SOURCE), pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i)] }, notice_id: notice, seq: number(1), home_id: pattern(HOME_ID), home_label: nullable(label), unit_kind: nullable(enumeration('run', 'pipeline', 'job')), unit_id: nullable(unitId),
  event: enumeration(...NOTIFY_EVENTS), kind: enumeration(...NOTIFY_KINDS), reason_code: nullable(enumeration(...NOTIFY_REASON_CODES)), decision_id: nullable(pattern(/^d_[A-Za-z0-9-]{1,64}$/)), task_id: nullable(taskIdSchema), unit_state: nullable(enumeration(...RUN_STATES, ...PIPELINE_STATES, ...JOB_STATES)),
  summary: { type: 'string', maxLength: 200, pattern: '^[^\\x00-\\x1f\\x7f-\\x9f]*$' }, occurred_at: dateSchema, sent_at: dateSchema, attempt: number(1), coalesced: number(1), covers_seq: list(number(1), 2, 2), next_step: { type: 'string' }, gbdev_version: pattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
}, ['source_seq', 'reminder']);
export interface NotifyStatus {
  schema: 'gbdev.notify-status.v1'; init: NotifyInit; enabled: boolean; reason: typeof NOTIFY_REASONS[number] | null;
  home_id: string; home_label: string | null; secret_source: 'file' | 'keychain'; secret_ok: boolean; secret_problem: SecretProblem | null;
  endpoint_host: string | null; key_placement: 'header' | 'body_field'; key_name: string | null; paused: NotifyPaused | null;
  pending: number; oldest_pending_at: string | null; dead_recent: number; last_success_at: string | null; last_attempt_at: string | null;
  last_error: { class: typeof ERROR_CLASSES[number]; http_status: number | null; at: string } | null; deliverer_pid: number | null;
  pending_list?: { seq: number; notice_id: string; unit_id: string | null; event: typeof NOTIFY_EVENTS[number]; kind: typeof NOTIFY_KINDS[number]; attempts: number; next_at: string }[];
}
export const notifyStatusSchema = closed({ schema: { const: 'gbdev.notify-status.v1' }, init: notifyInitSchema, enabled: bool, reason: nullable(enumeration(...NOTIFY_REASONS)), home_id: pattern(HOME_ID), home_label: nullable(label), secret_source: enumeration('file', 'keychain'), secret_ok: bool, secret_problem: nullable(enumeration(...SECRET_PROBLEMS)), endpoint_host: nullable(pattern(/^[A-Za-z0-9.:[\]-]{1,253}$/)), key_placement: enumeration('header', 'body_field'), key_name: nullable(pattern(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$|^[0-9][A-Za-z0-9-]{0,63}$|^-[A-Za-z0-9-]{0,63}$/)), paused: pausedSchema, pending: number(), oldest_pending_at: nullable(dateSchema), dead_recent: number(), last_success_at: nullable(dateSchema), last_attempt_at: nullable(dateSchema), last_error: nullable(closed({ class: enumeration(...ERROR_CLASSES), http_status: http, at: dateSchema })), deliverer_pid: nullable(number(1)), pending_list: list(closed({ seq: number(1), notice_id: notice, unit_id: nullable(unitId), event: enumeration(...NOTIFY_EVENTS), kind: enumeration(...NOTIFY_KINDS), attempts: number(), next_at: dateSchema })) }, ['pending_list']);
export interface NotifyTest { schema: 'gbdev.notify-test.v1'; notice_id: string; seq: number; http_status: number | null; latency_ms: number; delivered: boolean; awaiting_ack: boolean }
export interface NotifyAck { schema: 'gbdev.notify-ack.v1'; notice_id: string; verified_at: string; verified_by_bot: string }
export const notifyTestSchema = closed({ schema: { const: 'gbdev.notify-test.v1' }, notice_id: notice, seq: number(1), http_status: http, latency_ms: number(), delivered: bool, awaiting_ack: bool });
export const notifyAckSchema = closed({ schema: { const: 'gbdev.notify-ack.v1' }, notice_id: notice, verified_at: dateSchema, verified_by_bot: label });
export interface NotifySecret { schema: 'gbdev.notify-secret.v1'; url: string; key: string }
export const notifySecretSchema = closed({ schema: { const: 'gbdev.notify-secret.v1' }, url: { type: 'string', minLength: 1, maxLength: 4096 }, key: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[^\\x00-\\x1f\\x7f-\\x9f]*$' } });
function validate(value: unknown, schema: JsonSchema): void {
  if (schemaErrors(value, schema).length) throw new GbdevError('config_invalid', 'Invalid notify contract');
  // Reuse the strict calendar/offset validator without reflecting input or field names.
  function dates(v: unknown, s: JsonSchema): void {
    if (v === null) return;
    if (s === dateSchema) { timestamp(v, 'notify timestamp'); return; }
    if (s.anyOf) { const selected = s.anyOf.find(x => !schemaErrors(v, x).length); if (selected) dates(v, selected); }
    else if (Array.isArray(v) && s.items) v.forEach(x => dates(x, s.items!));
    else if (v && typeof v === 'object') for (const [k, child] of Object.entries(s.properties ?? {})) dates((v as Record<string, unknown>)[k], child);
  }
  dates(value, schema);
}
export function notifyNextStep(kind: NotifyPayload['unit_kind'], id: string | null): string {
  return kind === null ? '' : `gbdev ${kind === 'job' ? '' : kind + ' '}status ${id} --json`;
}
export function validateNotifyPayload(value: unknown, checkSize = true): NotifyPayload {
  validate(value, notifyPayloadSchema); const p = value as NotifyPayload;
  const fail = (): never => { throw new GbdevError('config_invalid', 'Invalid notify payload'); };
  if (p.reminder !== undefined) {
    if (p.event !== 'attention' || typeof p.source_seq !== 'string' || !REMINDER_SOURCE.test(p.source_seq) || !p.source_seq.endsWith(`:${p.reminder.n}`) || p.coalesced !== 1) fail();
  } else if (p.source_seq !== undefined && (p.event === 'test' ? typeof p.source_seq !== 'string' : typeof p.source_seq !== 'number')) fail();
  if (p.event === 'test') {
    if (p.kind !== 'test' || p.unit_kind !== null || p.unit_id !== null || p.unit_state !== null || p.decision_id !== null || p.task_id !== null || p.reason_code !== null || p.coalesced !== 1) fail();
  } else {
    if (!p.unit_kind || !p.unit_id || !({ run: RUN_ID_PATTERN, pipeline: PIPELINE_ID, job: JOB_ID_PATTERN }[p.unit_kind]).test(p.unit_id)) fail();
    const states = p.unit_kind === 'run' ? RUN_STATES : p.unit_kind === 'pipeline' ? PIPELINE_STATES : JOB_STATES;
    if (!(states as readonly unknown[]).includes(p.unit_state)) fail();
    const kinds: readonly string[] = p.event === 'terminal' ? (p.unit_kind === 'job' ? ['succeeded', 'failed', 'cancelled', 'timeout'] : ['succeeded', 'failed', 'cancelled']) : p.event === 'health' ? ['supervisor_heartbeat_stale', 'notify_secret_exposed'] : p.unit_kind === 'run' ? DECISION_REASONS : p.unit_kind === 'pipeline' ? ['needs_input', 'blocked', 'needs_decision'] : ['job_needs_input', 'job_blocked'];
    if (!kinds.includes(p.kind) || p.event !== 'attention' && p.decision_id !== null || p.event === 'terminal' && p.unit_state !== p.kind || p.event === 'health' && p.kind !== 'notify_secret_exposed' && p.unit_kind !== 'run') fail();
  }
  if (p.covers_seq[0] > p.covers_seq[1] || p.covers_seq[1] !== p.seq || p.coalesced > p.covers_seq[1] - p.covers_seq[0] + 1) fail();
  if (p.next_step !== '' && p.next_step !== notifyNextStep(p.unit_kind, p.unit_id)) fail();
  if (checkSize && Buffer.byteLength(JSON.stringify(p)) > 2048) fail();
  return p;
}
export function validateNotifyInit(value: unknown): NotifyInit { validate(value, notifyInitSchema); return value as NotifyInit; }
export function validateNotifyStatus(value: unknown): NotifyStatus {
  validate(value, notifyStatusSchema); const v = value as NotifyStatus;
  if (v.key_name !== null && !(v.key_placement === 'header' ? /^[A-Za-z0-9-]{1,64}$/ : /^[A-Za-z_][A-Za-z0-9_]{0,63}$/).test(v.key_name)) throw new GbdevError('config_invalid', 'Invalid notify key name');
  return v;
}
export function validateNotifyTest(value: unknown): NotifyTest { validate(value, notifyTestSchema); const v = value as NotifyTest; if (v.delivered !== v.awaiting_ack) throw new GbdevError('config_invalid', 'Invalid notify test acknowledgment'); return v; }
export function validateNotifyAck(value: unknown): NotifyAck { validate(value, notifyAckSchema); return value as NotifyAck; }
export function validateNotifySecret(value: unknown, env: NodeJS.ProcessEnv = {}): NotifySecret {
  // Structured, closed diagnostics: setup can distinguish key, URL and schema errors.
  if (value && typeof value === 'object' && 'key' in value && schemaErrors(value.key, notifySecretSchema.properties!.key!).length) {
    throw new GbdevError('config_invalid', 'Invalid notify key', { reason: 'secret_unsafe', problem: 'key_invalid' });
  }
  try { validate(value, notifySecretSchema); }
  catch { throw new GbdevError('config_invalid', 'Invalid notify secret schema', { reason: 'secret_unsafe', problem: 'invalid_schema' }); }
  const secret = value as NotifySecret;
  if (!validateEndpoint(secret.url, env)) throw new GbdevError('config_invalid', 'Invalid notify secret endpoint', { reason: 'url_invalid' });
  return secret;
}

export function validateEndpoint(url: string, env: NodeJS.ProcessEnv = {}): string | null {
  try {
    if (url.trim() !== url || /[\x00-\x20\x7f-\x9f\\]/.test(url)) return null;
    const u = new URL(url);
    if (u.username || u.password || /^https?:\/\/[^/?#]*@/.test(url) || url.includes('#') || !u.hostname || !/^https?:\/\//.test(url)) return null;
    if (u.protocol !== 'https:' && !(env.GBDEV_NOTIFY_TEST === '1' && /^http:\/\/127\.0\.0\.1:[0-9]+(?:\/|\?|$)/.test(url) && u.hostname === '127.0.0.1')) return null;
    return u.hostname;
  } catch { return null; }
}
