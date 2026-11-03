import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { validateNotifyStatus, type NotifyStatus, type NotifyInit } from '../contracts/notify.js';
import { validateConfig } from '../core/config.js';
import { NOTIFY_DEFAULTS, notifyDisabledReason, validateNotify } from '../core/notifyConfig.js';
import type { GbdevPaths } from '../core/paths.js';
import { identity } from '../dashboard/names.js';
import { readPendingNotices } from './deliver.js';
import { assertNoSecret, readSecret, secretFilePath, type SecretOptions, type SecretResult } from './secret.js';
import { readDeliveryState, type DeliveryState } from './state.js';

export interface StatusOptions { env?: NodeJS.ProcessEnv; now?: () => number; secret?: Pick<SecretOptions, 'uid' | 'platform' | 'spawn' | 'defaultDirectory'> }
/** Diagnostic loading tolerates only the missing-key-name case, without hiding other config errors. */
export function notifyConfiguration(paths: GbdevPaths) {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(paths.config, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') raw = { version: 1 }; else throw new GbdevError('notify_unavailable', 'Cannot read notify configuration', { class: 'secret' }); }
  const value = raw.notify as Record<string, unknown> | undefined;
  const missing = value?.enabled === true && (value.key_name === undefined || value.key_name === null);
  const checked = validateConfig(missing ? { ...raw, notify: { ...value, enabled: false } } : raw);
  return { config: missing ? { ...validateNotify({ ...value, enabled: false }), enabled: true } : checked.notify ?? NOTIFY_DEFAULTS, allowed_repos: checked.allowed_repos };
}
export async function inspectNotify(paths: GbdevPaths, options: StatusOptions = {}) {
  const { config, allowed_repos } = notifyConfiguration(paths), env = options.env ?? process.env;
  const state = readDeliveryState(paths.home), home_id = identity(paths.home).h12;
  const disabled = notifyDisabledReason(config, env);
  const secretOptions: SecretOptions = { paths, config, allowed_repos, home_id, env, keychain_setup_at: state.keychain_setup_at ?? null, ...options.secret };
  // Env/test disabling must not access a user's credential backend at all.
  const secret: SecretResult = disabled === 'disabled_by_env' || disabled === 'disabled_in_tests'
    ? { ok: false, reason: 'secret_missing', problem: 'not_found', endpoint_host: null, secret_gen: null }
    : await readSecret(secretOptions);
  let secretExists = secret.ok;
  if (disabled !== 'disabled_by_env' && disabled !== 'disabled_in_tests' && !secretExists) {
    if (config.secret_source === 'keychain') secretExists = !!state.keychain_setup_at;
    else { try { lstatSync(secretFilePath(secretOptions)); secretExists = true; } catch { /* Missing/inaccessible is not evidence of an existing secret. */ } }
  }
  return { config, state, secret, secretExists, disabled, home_id, secretOptions };
}
export function currentVerification(state: DeliveryState, secret: SecretResult): boolean {
  return secret.ok && secret.secret_gen !== null && state.verified_secret_gen === secret.secret_gen && !!state.verified_at;
}
export function currentTest(state: DeliveryState, secret: SecretResult): boolean {
  if (!secret.ok || !secret.secret_gen || !state.last_test) return false;
  if (state.last_test_secret_gen !== undefined) return state.last_test_secret_gen === secret.secret_gen;
  // Compatibility with tests/state written by S3 before the explicit generation field.
  const generationAt = secret.secret_gen.startsWith('keychain:') ? Date.parse(secret.secret_gen.slice(9)) : Number(secret.secret_gen.split(':')[0]);
  return Date.parse(state.last_test.sent_at) >= generationAt;
}
export async function notifyStatus(paths: GbdevPaths, pending = false, options: StatusOptions = {}): Promise<NotifyStatus> {
  try {
    const { config, state, secret, secretExists, disabled, home_id, secretOptions } = await inspectNotify(paths, options);
    const verified = currentVerification(state, secret), tested = currentTest(state, secret) && state.last_test?.delivered;
    const reason = disabled ?? secret.reason ?? (!config.key_name ? 'key_name_missing' : state.paused?.reason ?? null);
    const init: NotifyInit = {
      state: 'configured_unverified', missing_step: 'run_test', configured: !disabled && secret.ok && !!config.key_name,
      verified_at: verified ? state.verified_at! : null, verified_notice_id: verified ? state.verified_notice_id ?? null : null,
      verified_by_bot: verified ? state.verified_by_bot ?? null : null, last_test: state.last_test ?? null,
      last_delivery: state.last_delivery ?? null, paused: state.paused ?? null,
    };
    if (disabled === 'disabled_by_env' || disabled === 'disabled_in_tests') { init.state = 'disabled'; init.missing_step = 'env_disabled'; }
    else if (!config.enabled && secretExists) { init.state = 'disabled'; init.missing_step = 'enable'; }
    else if (!secret.ok) { init.state = 'not_configured'; init.missing_step = 'setup_secret'; }
    else if (!config.key_name) { init.state = 'not_configured'; init.missing_step = 'set_key_name'; }
    else if (state.paused) { init.state = 'paused'; init.missing_step = 'resume_paused'; }
    else if (verified) { init.state = 'verified'; init.missing_step = null; }
    else if (tested) { init.state = 'test_sent'; init.missing_step = 'await_ack'; }
    const records = readPendingNotices(paths.home), now = (options.now ?? Date.now)();
    let dead_recent = 0;
    try { for (const entry of readdirSync(join(paths.home, 'notify', 'dead'), { withFileTypes: true })) if (entry.isFile() && now - statSync(join(paths.home, 'notify', 'dead', entry.name)).mtimeMs <= 30 * 86400000) dead_recent++; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const result: NotifyStatus = {
      schema: 'gbdev.notify-status.v1', init, enabled: !disabled, reason, home_id, home_label: config.home_label,
      secret_source: config.secret_source, secret_ok: secret.ok, secret_problem: secret.problem, endpoint_host: secret.endpoint_host,
      key_placement: config.key_placement, key_name: config.key_name, paused: state.paused ?? null, pending: records.length,
      oldest_pending_at: records.length ? records.reduce((a, b) => Date.parse(a.occurred_at) < Date.parse(b.occurred_at) ? a : b).occurred_at : null,
      dead_recent, last_success_at: state.last_success_at ?? null, last_attempt_at: state.last_attempt_at ?? null,
      last_error: state.last_error ?? null, deliverer_pid: state.deliverer_pid ?? null,
      ...(pending ? { pending_list: records.map(p => ({ seq: p.seq, notice_id: p.notice_id, unit_id: p.unit_id, event: p.event, kind: p.kind, attempts: p.meta.attempts, next_at: p.meta.next_at })) } : {}),
    };
    validateNotifyStatus(result);
    if (secret.ok && !(await readSecret(secretOptions, credentials => assertNoSecret(result, credentials))).ok) throw new Error('Unsafe projection');
    return result; // Reject untrusted state before any serialization.
  } catch { throw new GbdevError('notify_unavailable', 'Cannot inspect notifications', { class: 'secret' }); }
}
export interface NotifyHint { enabled: boolean; reason: NotifyStatus['reason']; endpoint_host: string | null }
export async function addNotify<T extends object>(paths: GbdevPaths, result: T): Promise<T & { notify: NotifyHint }> {
  let notify: NotifyHint;
  try { const status = await notifyStatus(paths); notify = { enabled: status.enabled, reason: status.reason, endpoint_host: status.endpoint_host }; }
  catch { notify = { enabled: false, reason: 'secret_unsafe', endpoint_host: null }; }
  return { ...result, notify };
}
export function notifyHintText(value: unknown): string {
  const hint = (value as { notify?: NotifyHint })?.notify;
  if (!hint) return '';
  if (!hint.enabled) return `通知未开启（${hint.reason}）\n`;
  if (!hint.reason) return `完成或需要决定时将通知控制器（${hint.endpoint_host}）\n`;
  const recovery: Partial<Record<NonNullable<NotifyHint['reason']>, string>> = {
    paused_auth_rejected: '请用户在 routine 面板复制新密钥，重新 gbdev notify setup 后执行 gbdev notify flush --retry-auth',
    paused_endpoint_gone: '请用户确认或重新创建 routine，重新 gbdev notify setup 后执行 gbdev notify flush --retry-auth',
    paused_redirect_refused: '请用户核对 routine URL，重新 gbdev notify setup 后执行 gbdev notify flush --retry-auth',
    secret_missing: '请用户在终端执行 gbdev notify setup',
    secret_unsafe: '请用户在终端重新执行 gbdev notify setup',
    url_invalid: '请用户核对 routine URL 后重新执行 gbdev notify setup',
    key_name_missing: '请确认密钥 header/字段名后执行 gbdev notify enable --key-name <名称>',
    secret_unsupported: '请用户在支持的系统配置秘密来源，或使用 gbdev notify setup 写入秘密文件',
  };
  return `通知${hint.reason.startsWith('paused_') ? '已暂停' : '暂不可用'}（${hint.reason}）；${recovery[hint.reason] ?? '请检查 gbdev notify status --json'}\n`;
}
export async function notifyDiagnostic(paths: GbdevPaths, options: StatusOptions = {}): Promise<{ name: string; ok: boolean; detail: string }> {
  try {
    const status = await notifyStatus(paths, false, options);
    const old = status.oldest_pending_at !== null && (options.now ?? Date.now)() - Date.parse(status.oldest_pending_at) >= 3600000;
    return { name: 'notify', ok: !status.enabled || (!status.reason && !old), detail: `${!status.enabled ? `disabled (${status.reason}); controller falls back to polling` : status.reason ?? (old ? 'pending_too_old' : 'ready')}; init_state=${status.init.state}` };
  } catch {
    // Disabling remains healthy even when old notification state is corrupt.
    let disabled = notifyDisabledReason({ ...NOTIFY_DEFAULTS, enabled: true }, options.env ?? process.env);
    try { disabled ??= notifyDisabledReason(notifyConfiguration(paths).config, options.env ?? process.env); } catch { /* Separate config check. */ }
    return disabled ? { name: 'notify', ok: true, detail: `disabled (${disabled}); controller falls back to polling; init_state=disabled` }
      : { name: 'notify', ok: false, detail: 'secret_unsafe; init_state=not_configured' };
  }
}
