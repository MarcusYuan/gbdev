import { AsyncLocalStorage } from 'node:async_hooks';
import { validateEndpoint, type NotifyPayload, type NotifySecret } from '../contracts/notify.js';
import type { NotifyConfig } from '../core/notifyConfig.js';
import { assertNoSecret } from './secret.js';
import { fitPayload } from './payload.js';

// Every gbdev test process installs this at module load, including CLI children.
// The only exception is a scoped, explicitly opted-in loopback POST below.
const testNetwork = new AsyncLocalStorage<boolean>();
let forbiddenFetchCalls = 0;
export function notifyFetchSentinelCalls(): number { return forbiddenFetchCalls; }
if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.GBDEV_NOTIFY_TEST !== '1') {
  const original = globalThis.fetch;
  globalThis.fetch = (...args) => {
    if (testNetwork.getStore() === true) return original(...args);
    forbiddenFetchCalls++;
    throw new Error('Default test network access refused');
  };
  process.on('exit', () => { if (forbiddenFetchCalls) process.exitCode = 1; });
}

export type HttpError = 'network' | 'timeout' | 'tls' | 'oversize' | 'secret';
export interface HttpResult { status: number | null; error: HttpError | null; retry_after_ms: number | null }
export function retryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const delay = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(1_800_000, Math.max(0, delay)) : null;
}
/** Checks independent of credentials, shared with delivery before durable attempts. */
export function requestPreflight(payload: NotifyPayload, config: NotifyConfig, env: NodeJS.ProcessEnv): HttpError | null {
  if ((env.NODE_TEST_CONTEXT !== undefined && env.GBDEV_NOTIFY_TEST !== '1') || !config.key_name) return 'secret';
  if (env.NODE_USE_ENV_PROXY === '1' || '1' === process.env.NODE_USE_ENV_PROXY || process.execArgv.includes('--use-env-proxy') || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '')) return 'secret';
  if (config.key_placement === 'header' && /^(cookie|cookie2|host|connection|content-length|content-type|user-agent|x-gbdev-.*|proxy-.*)$/i.test(config.key_name)) return 'secret';
  if (config.key_placement === 'body_field' && (Object.hasOwn(payload, config.key_name) || ['__proto__', 'constructor', 'prototype', 'meta'].includes(config.key_name))) return 'secret';
  return null;
}
/** The only network boundary. Neither Response nor exception text may escape it. */
export async function postNotice(secret: Readonly<NotifySecret>, payload: NotifyPayload, config: NotifyConfig, env: NodeJS.ProcessEnv = process.env, now = Date.now): Promise<HttpResult> {
  const fail = (error: HttpError): HttpResult => ({ status: null, error, retry_after_ms: null });
  const preflight = requestPreflight(payload, config, env); if (preflight) return fail(preflight);
  const host = validateEndpoint(secret.url, env);
  if (!host || !config.key_name) return fail('secret');
  // The default suite can never contact an external endpoint, even by mistake.
  if (process.env.NODE_TEST_CONTEXT !== undefined && (env.GBDEV_NOTIFY_TEST !== '1' || host !== '127.0.0.1')) return fail('secret');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || '0' === process.env.NODE_TLS_REJECT_UNAUTHORIZED) return fail('tls');
  try {
    assertNoSecret(payload, secret);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8', 'User-Agent': `gbdev/${payload.gbdev_version}`,
      'X-Gbdev-Notice-Id': payload.notice_id, 'X-Gbdev-Seq': String(payload.seq),
    };
    const fitted = fitPayload(payload); if (!fitted.ok) return fail('oversize');
    let body = fitted.json;
    if (config.key_placement === 'header') headers[config.key_name] = config.key_prefix + secret.key;
    else {
      const p = { ...fitted.payload };
      // Include the credential overhead in the wire-size limit, without ever storing it.
      for (let step = 0; ; step++) {
        body = JSON.stringify({ ...p, [config.key_name]: config.key_prefix + secret.key });
        if (Buffer.byteLength(body) <= 2048) break;
        if (step === 0) p.summary = ''; else if (step === 1) p.home_label = null; else if (step === 2) p.next_step = ''; else return fail('oversize');
      }
    }
    const response = await testNetwork.run(env.GBDEV_NOTIFY_TEST === '1' && host === '127.0.0.1', () => fetch(secret.url, { method: 'POST', body, headers, redirect: 'manual', signal: AbortSignal.timeout(config.timeout_ms), keepalive: false, credentials: 'omit' }));
    const status = response.status, retry_after_ms = status === 429 ? retryAfter(response.headers.get('retry-after'), now()) : null;
    // Node 24's byte stream supports BYOB: even a single read is capped by the
    // remaining budget. Never decode, accumulate or log response data.
    const reader = response.body?.getReader({ mode: 'byob' });
    if (reader) {
      try { let remaining = 4096; while (remaining > 0) { const chunk = await reader.read(new Uint8Array(remaining)); if (chunk.done) break; remaining -= Math.min(remaining, chunk.value.byteLength); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    return { status, error: null, retry_after_ms };
  } catch (error) {
    const e = error as { name?: string; cause?: { code?: string } };
    // Codes only, never messages (which can contain URL, key or response text).
    return fail(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : /CERT|TLS|SSL/.test(e.cause?.code ?? '') ? 'tls' : 'network');
  }
}
