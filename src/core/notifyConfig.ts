import { isAbsolute } from 'node:path';
import { GbdevError } from '../contracts/error.js';
export interface NotifyConfig {
  enabled: boolean; secret_source: 'file' | 'keychain'; secret_file: string | null;
  key_placement: 'header' | 'body_field'; key_name: string | null; key_prefix: string;
  home_label: string | null; timeout_ms: number; max_age_h: number; deliverer_max_lifetime_min: number; coalesce: boolean; reminder_after_min: number; reminder_max: number;
}
export const NOTIFY_DEFAULTS: NotifyConfig = { enabled: false, secret_source: 'file', secret_file: null, key_placement: 'header', key_name: null, key_prefix: '', home_label: null, timeout_ms: 5000, max_age_h: 72, deliverer_max_lifetime_min: 60, coalesce: true, reminder_after_min: 30, reminder_max: 3 };
export const NOTIFY_LABEL = /^[a-z][a-z0-9-]{0,31}$/;
/** No input values (including unknown property names) are reflected in errors. */
export function rejectConfigSecrets(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['url', 'key', 'secret'].includes(key)) throw new GbdevError('config_invalid', 'Secrets are not permitted in configuration');
    rejectConfigSecrets(child);
  }
}
export function validateNotify(value: unknown): NotifyConfig {
  const fail = (): never => { throw new GbdevError('config_invalid', 'Invalid notify configuration'); };
  if (value === undefined) return { ...NOTIFY_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  if (Object.keys(value).some(k => !Object.hasOwn(NOTIFY_DEFAULTS, k))) fail();
  const n = { ...NOTIFY_DEFAULTS, ...value } as NotifyConfig;
  if (typeof n.enabled !== 'boolean' || typeof n.coalesce !== 'boolean') fail();
  if (!['file', 'keychain'].includes(n.secret_source) || !['header', 'body_field'].includes(n.key_placement)) fail();
  if (n.secret_file !== null && (typeof n.secret_file !== 'string' || !isAbsolute(n.secret_file) || /[\x00-\x1f\x7f]/.test(n.secret_file))) fail();
  if (n.key_name !== null && (typeof n.key_name !== 'string' || !(n.key_placement === 'header' ? /^[A-Za-z0-9-]{1,64}$/ : /^[A-Za-z_][A-Za-z0-9_]{0,63}$/).test(n.key_name))) fail();
  if (typeof n.key_prefix !== 'string' || !/^[\x20-\x7e]{0,16}$/.test(n.key_prefix)) fail();
  if (n.home_label !== null && (typeof n.home_label !== 'string' || !NOTIFY_LABEL.test(n.home_label))) fail();
  for (const [key, min, max] of [['reminder_after_min', 5, 1440], ['reminder_max', 0, 10], ['timeout_ms', 1000, 15000], ['max_age_h', 1, 168], ['deliverer_max_lifetime_min', 5, 240]] as const) if (!Number.isSafeInteger(n[key]) || n[key] < min || n[key] > max) fail();
  if (n.enabled && n.key_name === null) throw new GbdevError('key_name_missing', 'Notify key name is required');
  return n;
}
export function notifyDisabledReason(config: NotifyConfig, env: NodeJS.ProcessEnv = process.env): 'disabled_by_env' | 'disabled_in_tests' | 'disabled_by_config' | null {
  if (env.GBDEV_NOTIFY === '0') return 'disabled_by_env';
  if (env.NODE_TEST_CONTEXT !== undefined && env.GBDEV_NOTIFY_TEST !== '1') return 'disabled_in_tests';
  return config.enabled ? null : 'disabled_by_config';
}
