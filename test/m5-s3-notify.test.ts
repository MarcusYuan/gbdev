import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { job } from './helpers.js';
import { fixture as runFixture, until } from './helpers/m3.js';
import { startRun } from '../src/commands/run.js';
import { readRun } from '../src/run/store.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { acquireLock } from '../src/core/lock.js';
import { resolvePaths, jobPaths } from '../src/core/paths.js';
import { locked } from '../src/core/runtime.js';
import { localIso } from '../src/core/time.js';
import { NOTIFY_DEFAULTS, type NotifyConfig } from '../src/core/notifyConfig.js';
import { installNotifyTesting, notifyEvent } from '../src/notify/enqueue.js';
import { deliver, backoff, BACKOFF_MS, pendingNotices, pruneDelivery, type DeliveryOptions } from '../src/notify/deliver.js';
import { postNotice, retryAfter, type HttpResult } from '../src/notify/http.js';
import { deliveryLog } from '../src/notify/log.js';
import { readDeliveryState, retryAuth } from '../src/notify/state.js';
import { launchDeliver, deliveryEnv } from '../src/notify/trigger.js';
import { validateNotifyPayload, type NotifyPayload } from '../src/contracts/notify.js';
import { runCli } from '../src/cli.js';
import { failureEnvelope } from '../src/contracts/envelope.js';

type Action = { status?: number; retryAfter?: string | number; location?: string; mode?: string; delay?: number; body?: string; headers?: Record<string, string> };
type Request = { headers: Record<string, string>; body: NotifyPayload & Record<string, unknown>; path: string };
type Stub = { url: string; requests: Request[]; program(actions: Action[]): void; close(): Promise<void> };
const { startNotifyServer } = await import(pathToFileURL(resolve('test/fixtures/notify-server.js')).href) as { startNotifyServer(options: { responses?: Action[]; log?: string; onRequest?: (request: Request) => void }): Promise<Stub> };
const enabledEnv = { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1', GBDEV_NOTIFY: '' };
const success: HttpResult = { status: 200, error: null, retry_after_ms: null };
const stamp = (ms: number) => localIso(new Date(ms));
async function server(t: TestContext, responses: Action[] = [], log?: string): Promise<Stub> {
  const stub = await startNotifyServer({ responses, ...(log ? { log } : {}) }); t.after(() => stub.close()); return stub;
}
function setup(t: TestContext, extra: Partial<NotifyConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gbdev-m5-s3-')), paths = resolvePaths({ GBDEV_HOME: join(root, 'home'), GBDEV_CONFIG: join(root, 'config.json') });
  mkdirSync(paths.home, { mode: 0o700 }); const dir = join(root, 'secrets'); mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, 'notify.json'), key = `GBDEVTESTKEY-${randomUUID()}`;
  const config = { ...NOTIFY_DEFAULTS, enabled: true, key_name: 'X-Sender-Key', secret_file: file, ...extra };
  writeFileSync(paths.config, JSON.stringify({ version: 1, notify: config }));
  const store = new JobStore(paths); t.after(installNotifyTesting(paths.home, { launch: () => {}, env: enabledEnv }));
  let now = Date.now(), elapsed = 0; const sleeps: number[] = [];
  const clock: DeliveryOptions = { env: enabledEnv, now: () => now, monotonic: () => elapsed, random: () => .5, sleep: async ms => { sleeps.push(ms); now += ms; elapsed += ms; } };
  const credentials = (url: string) => { writeFileSync(file, JSON.stringify({ schema: 'gbdev.notify-secret.v1', url, key }), { mode: 0o600 }); chmodSync(file, 0o600); };
  credentials('http://127.0.0.1:1/unused');
  let source = 0;
  const enqueue = async (unit = 1, count = 1, isTest = false) => {
    const id = `j_20261029_0930_${unit.toString(16).padStart(4, '0')}`;
    if (!isTest && !existsSync(jobPaths(paths, id).job)) store.create(job(id));
    await locked(store, () => { for (let i = 0; i < count; i++) assert.equal(notifyEvent(store, isTest ? null : { kind: 'job', id, state: 'succeeded' }, isTest ? 'test' : 'state_change', { state: 'succeeded' }, isTest ? randomUUID() : ++source, stamp(now)), true); });
  };
  const records = (folder: string) => { const dir = join(paths.home, 'notify', folder); return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))) : []; };
  const scan = () => {
    const walk = (dir: string): void => { for (const e of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, e.name); if (e.isDirectory()) walk(path); else if (e.isFile()) assert.ok(!readFileSync(path, 'utf8').includes(key), `secret leaked to ${e.name}`); } }; walk(paths.home);
  };
  t.after(() => { try { scan(); } finally { rmSync(root, { recursive: true, force: true }); } });
  return { root, paths, store, config, key, file, dir, clock, sleeps, enqueue, records, credentials, scan, now: () => now, advance: (ms: number) => { now += ms; }, pending: () => pendingNotices(paths.home), deliver: (options: DeliveryOptions = {}) => deliver(store, { ...clock, ...options }) };
}
for (const placement of ['header', 'body_field'] as const) test(`AC-15 ${placement} wire credentials only; AC-12 disk, env and errors redacted`, async t => {
  const f = setup(t, { key_placement: placement, key_name: placement === 'header' ? 'X-Sender-Key' : 'sender_key', key_prefix: 'Bearer ' });
  const stub = await server(t, [{ status: 202 }], join(f.root, 'requests.json')); f.credentials(stub.url); await f.enqueue();
  const before = JSON.stringify(f.pending()); assert.ok(!before.includes('sender_key')); assert.ok(!before.includes(f.key));
  await f.deliver(); assert.equal(stub.requests.length, 1); const request = stub.requests[0]!;
  if (placement === 'header') assert.equal(request.headers['x-sender-key'], `Bearer ${f.key}`);
  else { assert.equal(request.body.sender_key, `Bearer ${f.key}`); delete request.body.sender_key; }
  assert.equal(request.headers.cookie, undefined); assert.equal(request.headers['content-type'], 'application/json; charset=utf-8');
  validateNotifyPayload(request.body); assert.ok(!('meta' in request.body)); assert.equal(f.pending().length, 0);
  assert.equal(f.records('sent').length, 1); assert.ok(readDeliveryState(f.paths.home).last_success_at);
  assert.equal(readDeliveryState(f.paths.home).deliverer_pid, null);
  assert.ok(!JSON.stringify(deliveryEnv(f.paths, { ...enabledEnv, TOKEN: f.key })).includes(f.key)); f.scan();
});

test('AC-18 disconnect before response retries same notice with attempt 1 then 2', async t => {
  const f = setup(t), stub = await server(t, [{ mode: 'disconnect' }, { status: 200 }]); f.credentials(stub.url); await f.enqueue(); await f.deliver();
  assert.deepEqual(stub.requests.map(r => r.body.attempt), [1, 2]); assert.equal(stub.requests[0]!.body.notice_id, stub.requests[1]!.body.notice_id);
  assert.deepEqual(f.sleeps, [5000]); assert.equal(f.records('sent')[0].meta.attempts, 2);
});

test('AC-19 complete backoff table and jitter bounds with fake clock', async t => {
  for (let n = 1; n <= 10; n++) { const base = BACKOFF_MS[n - 1] ?? 1800000; assert.equal(backoff(n, () => 0), base * .8); assert.equal(backoff(n, () => 1), base * 1.2); }
  const f = setup(t, { deliverer_max_lifetime_min: 240 }); await f.enqueue(); const attempts: number[] = [];
  await f.deliver({ post: async () => { attempts.push(f.now()); return attempts.length <= 8 ? { status: 500, error: null, retry_after_ms: null } : success; } });
  assert.deepEqual(attempts.slice(1).map((at, i) => at - attempts[i]!), [...BACKOFF_MS, 1800000]); assert.ok(f.sleeps.every(ms => ms <= 60000));
});
for (const header of ['120', '999999']) test(`AC-19 429 Retry-After ${header} respected and capped`, async t => {
  const f = setup(t), stub = await server(t, [{ status: 429, retryAfter: header }, { status: 200 }]); f.credentials(stub.url); await f.enqueue(); await f.deliver();
  assert.equal(f.sleeps.reduce((a, b) => a + b, 0), header === '120' ? 120000 : 1800000); assert.equal(stub.requests.length, 2);
  assert.equal(retryAfter(new Date(f.now() + 120000).toUTCString(), f.now()), 120000 - f.now() % 1000);
  assert.equal(retryAfter('invalid', f.now()), null);
});

test('AC-20 five same-run notices coalesce, distinct units and tests never merge', async t => {
  const f = setup(t), stub = await server(t); f.credentials(stub.url);
  await locked(f.store, () => { for (let i = 1; i <= 5; i++) notifyEvent(f.store, { kind: 'run', id: 'r_20261029_0930_ab12', state: 'running' }, 'decision_required', { reason: 'task_failed', decision_id: `d_${i}` }, i, stamp(f.now())); });
  await f.enqueue(2, 2); await f.enqueue(0, 2, true); await f.deliver();
  assert.deepEqual(stub.requests.map(r => [r.body.seq, r.body.coalesced, r.body.covers_seq]), [[5, 5, [1, 5]], [7, 2, [6, 7]], [8, 1, [8, 8]], [9, 1, [9, 9]]]);
  assert.equal(f.records('sent').filter(p => p.meta.outcome === 'sent_coalesced').length, 5); assert.equal(f.records('sent').length, 9);
  assert.equal(readDeliveryState(f.paths.home).last_test?.delivered, true);
});
for (const status of [401, 403, 404, 410, 302]) test(`AC-21/22 HTTP ${status} pauses whole home, retains all pending, resumes explicitly`, async t => {
  const f = setup(t), stub = await server(t, [{ status, location: '/must-not-follow' }]); f.credentials(stub.url);
  await f.enqueue(1, 3); await f.enqueue(2); await f.deliver(); const state = readDeliveryState(f.paths.home);
  assert.equal(state.paused?.reason, status === 401 || status === 403 ? 'paused_auth_rejected' : status === 404 || status === 410 ? 'paused_endpoint_gone' : 'paused_redirect_refused');
  assert.equal(f.pending().length, 4); assert.equal(f.records('sent').length, 0); await f.deliver(); assert.equal(stub.requests.length, 1);
  for (const unit of [1, 2]) { const events = readFileSync(jobPaths(f.paths, `j_20261029_0930_${unit.toString(16).padStart(4, '0')}`).events, 'utf8').trim().split('\n').map(s => JSON.parse(s)); assert.equal(events.filter(e => e.data.code === 'notify_unavailable').length, 1); }
  await retryAuth(f.store); await f.deliver(); assert.equal(f.pending().length, 0); assert.deepEqual(stub.requests.map(r => r.path), ['/webhook', '/webhook', '/webhook']);
  assert.deepEqual(stub.requests.slice(1).map(r => r.body.seq), [3, 4]);
});
test('AC-21 secret mtime generation change automatically resumes HTTP pause', async t => {
  const f = setup(t), stub = await server(t, [{ status: 401 }]); f.credentials(stub.url); await f.enqueue(); await f.deliver(); await f.deliver(); assert.equal(stub.requests.length, 1);
  const old = statSync(f.file); utimesSync(f.file, old.atime, new Date(old.mtimeMs + 2000)); await f.deliver();
  assert.equal(stub.requests.length, 2); assert.equal(readDeliveryState(f.paths.home).paused, null);
});
for (const status of [400, 402, 409, 422, 451]) test(`N10 other 4xx ${status} archives rejected record`, async t => {
  const f = setup(t), stub = await server(t, [{ status }]); f.credentials(stub.url); await f.enqueue(); await f.deliver();
  assert.equal(f.pending().length, 0); assert.equal(f.records('dead')[0].meta.outcome, `rejected_${status}`); assert.equal(readDeliveryState(f.paths.home).paused ?? null, null);
});
for (const status of [408, 425, 500, 503]) test(`N10 HTTP ${status} retries then succeeds`, async t => {
  const f = setup(t), stub = await server(t, [{ status }, { status: 200 }]); f.credentials(stub.url); await f.enqueue(); await f.deliver();
  assert.equal(stub.requests.length, 2); assert.deepEqual(f.sleeps, [5000]);
});
test('AC-23 max_age expiry never sends; indices and staging survive retention cleanup', async t => {
  const f = setup(t, { max_age_h: 1 }); await f.enqueue(); const original = f.pending()[0]!; const dir = join(f.paths.home, 'notify');
  writeFileSync(join(dir, 'staging', 'keep.json'), '{}'); f.advance(3600001);
  await f.deliver({ post: async () => assert.fail('expired notice must not send') });
  assert.equal(f.records('dead')[0].meta.outcome, 'expired'); assert.equal(f.pending().length, 0);
  f.advance(31 * 86400000); pruneDelivery(f.paths.home, f.now()); assert.equal(f.records('dead').length, 0);
  assert.equal(readFileSync(join(dir, 'notice_ids', original.notice_id), 'utf8'), '1\n'); assert.ok(existsSync(join(dir, 'staging', 'keep.json')));
  const sent = join(dir, 'sent'); mkdirSync(sent); for (let i = 1; i <= 205; i++) writeFileSync(join(sent, `${i}-${original.notice_id}.json`), '{}'); pruneDelivery(f.paths.home, f.now()); assert.equal(readdirSync(sent).length, 200);
});
test('AC-24 three-hour sleep jump resets every pending then waits exactly 10 seconds', async t => {
  const f = setup(t); await f.enqueue(1); await f.enqueue(2); const times: number[] = []; let jumped = false;
  const before = f.now();
  for (const p of f.pending()) { p.meta.next_at = stamp(before + 1800000); atomicWriteJson(join(f.paths.home, 'notify', 'outbox', `${p.seq}-${p.notice_id}.json`), p); }
  await f.deliver({ sleep: async ms => { f.sleeps.push(ms); f.advance(jumped ? ms : 3 * 3600000); jumped = true; }, post: async () => { times.push(f.now()); return success; } });
  assert.deepEqual(f.sleeps, [60000, 10000]); assert.deepEqual(times, [before + 10810000, before + 10810000]); assert.match(readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8'), /clock_jump/);
});

function child(t: TestContext, args: string[], env: NodeJS.ProcessEnv, ipc = false) {
  const c = spawn(process.execPath, args, { env, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  let output = ''; c.stdout!.on('data', b => { output += b; }); c.stderr!.on('data', b => { output += b; });
  const exited = once(c, 'exit');
  t.after(async () => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); await exited; });
  return { c, exited, output: () => output };
}
test('AC-25 eight concurrent hidden deliverers send each seq once in ascending order', async t => {
  const f = setup(t, { coalesce: false }), stub = await server(t); f.credentials(stub.url); await f.enqueue(1, 12);
  const env = deliveryEnv(f.paths, { ...process.env, ...enabledEnv, HOME: f.root });
  const children = Array.from({ length: 8 }, () => child(t, [resolve('dist/src/cli.js'), '__notify-deliver'], env));
  for (const c of children) { assert.equal((await c.exited)[0], 0, c.output()); assert.equal(c.output(), ''); }
  assert.deepEqual(stub.requests.map(r => r.body.seq), Array.from({ length: 12 }, (_, i) => i + 1)); assert.equal(f.pending().length, 0);
});
test('deliver.lock contention returns immediately without waiting or a POST', async t => {
  const f = setup(t); await f.enqueue(); const lock = acquireLock(join(f.paths.home, 'notify', 'deliver.lock'));
  try { await f.deliver({ post: async () => assert.fail('lock owner only'), sleep: async () => assert.fail('must not wait') }); }
  finally { lock.release(); }
  assert.equal(f.pending().length, 1); assert.equal(existsSync(join(f.paths.home, 'notify', 'state.json')), false);
});
test('AC-26 offline six notices survive lifetime then internal flush delivers three units', async t => {
  const f = setup(t, { deliverer_max_lifetime_min: 5 }); const offline = await startNotifyServer({}); t.after(() => offline.close());
  f.credentials(offline.url); await offline.close(); for (let i = 1; i <= 3; i++) await f.enqueue(i, 2);
  await f.deliver(); assert.equal(f.pending().length, 6); assert.equal(readDeliveryState(f.paths.home).last_error?.class, 'network'); assert.equal(f.sleeps.reduce((a, b) => a + b, 0), 300000);
  const stub = await server(t); f.credentials(stub.url); await f.deliver(); assert.equal(f.pending().length, 0);
  assert.deepEqual(stub.requests.map(r => [r.body.seq, r.body.coalesced]), [[2, 2], [4, 2], [6, 2]]);
});
test('AC-11 terminal fake run supervisor exits; detached delivery still retries 500 twice then 200', { timeout: 40000 }, async t => {
  const f = runFixture(t), secrets = join(f.root, 'notify-secrets'); mkdirSync(secrets, { mode: 0o700 });
  const key = `GBDEVTESTKEY-${randomUUID()}`, stub = await server(t, [{ status: 500 }, { status: 500 }, { status: 200 }]);
  const file = join(secrets, 'secret.json'); writeFileSync(file, JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: stub.url, key }), { mode: 0o600 });
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.notify = { enabled: true, key_name: 'X-Key', secret_file: file }; writeFileSync(f.paths.config, JSON.stringify(config));
  const run = await startRun(f.store, f.request, false);
  const parent = child(t, [resolve('test/fixtures/notify-launch-parent.js'), run.run_id], { ...process.env, ...enabledEnv, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config }, true);
  const launched: { pid: number; argv: string[]; env: NodeJS.ProcessEnv; detached: boolean }[] = [];
  parent.c.on('message', m => { launched.push(m as typeof launched[number]); });
  t.after(() => { for (const c of launched) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* Already finished. */ } } });
  assert.equal((await parent.exited)[0], 0, parent.output()); assert.equal(readRun(f.store, run.run_id).state, 'succeeded');
  await until(() => existsSync(join(f.paths.home, 'notify', 'test-delivery-done.json')), 10000);
  assert.equal(pendingNotices(f.paths.home).length, 0);
  assert.equal(launched.length, 1); assert.equal(launched[0]!.detached, true); assert.equal(launched[0]!.argv.at(-1), '__notify-deliver');
  assert.deepEqual(stub.requests.map(r => [r.body.kind, r.body.attempt]), [['succeeded', 1], ['succeeded', 2], ['succeeded', 3]]);
  assert.ok(!JSON.stringify(launched).includes(key)); assert.ok(!parent.output().includes(key));
  assert.equal(launched[0]!.env.GBDEV_FAKE_PLAN, undefined); assert.equal(launched[0]!.env.NODE_OPTIONS, undefined);
  for (const folder of ['outbox', 'sent', 'dead']) {
    const path = join(f.paths.home, 'notify', folder); if (existsSync(path)) for (const name of readdirSync(path)) assert.ok(!readFileSync(join(path, name), 'utf8').includes(key));
  }
  assert.ok(!readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8').includes(key));
});

test('second empty scan picks up an enqueue before exit', async t => {
  const f = setup(t); await f.enqueue(); let injected = false, sent = 0;
  await f.deliver({ post: async () => { sent++; return success; }, onEmpty: async () => { if (!injected) { injected = true; await f.enqueue(2); } } });
  assert.equal(sent, 2); assert.equal(f.pending().length, 0);
});
test('secret file is revalidated immediately before every separate POST', async t => {
  const f = setup(t); await f.enqueue(1); await f.enqueue(2); let sent = 0;
  await f.deliver({ post: async () => { sent++; chmodSync(f.file, 0o644); return success; } });
  assert.equal(sent, 1); assert.equal(f.pending().length, 1); assert.equal(readDeliveryState(f.paths.home).secret_problem, 'mode_not_0600');
  chmodSync(f.file, 0o600); await f.deliver({ post: async () => { sent++; return success; } }); assert.equal(sent, 2); assert.equal(f.pending().length, 0);
});
for (const unsafe of ['mode', 'directory', 'symlink', 'owner', 'home', 'repo', 'http', 'userinfo', 'missing']) test(`AC-13 unsafe secret ${unsafe} pauses delivery without requests`, async t => {
  const f = setup(t), stub = await server(t); f.credentials(stub.url); await f.enqueue();
  let secret: DeliveryOptions['secret'];
  if (unsafe === 'mode') chmodSync(f.file, 0o644);
  if (unsafe === 'directory') chmodSync(f.dir, 0o755);
  if (unsafe === 'symlink') { const target = join(f.dir, 'real.json'); writeFileSync(target, readFileSync(f.file), { mode: 0o600 }); rmSync(f.file); symlinkSync(target, f.file); }
  if (unsafe === 'owner') secret = { uid: (process.getuid?.() ?? 0) + 1 };
  if (unsafe === 'home') { const path = join(f.paths.home, 'secret.json'); writeFileSync(path, readFileSync(f.file), { mode: 0o600 }); const raw = JSON.parse(readFileSync(f.paths.config, 'utf8')); raw.notify.secret_file = path; writeFileSync(f.paths.config, JSON.stringify(raw)); }
  if (unsafe === 'repo') { const raw = JSON.parse(readFileSync(f.paths.config, 'utf8')); raw.allowed_repos = [f.dir]; writeFileSync(f.paths.config, JSON.stringify(raw)); }
  if (unsafe === 'http') f.credentials('http://example.invalid/');
  if (unsafe === 'userinfo') f.credentials('https://user:pass@example.invalid/');
  if (unsafe === 'missing') rmSync(f.file);
  await f.deliver({ ...(secret ? { secret } : {}) }); await f.deliver({ ...(secret ? { secret } : {}) });
  assert.equal(stub.requests.length, 0); assert.equal(f.pending().length, 1); assert.equal(f.pending()[0]!.meta.attempts, 0);
  assert.equal(readDeliveryState(f.paths.home).blocked_reason, unsafe === 'http' || unsafe === 'userinfo' ? 'url_invalid' : unsafe === 'missing' ? 'secret_missing' : 'secret_unsafe');
  assert.equal(readFileSync(jobPaths(f.paths, 'j_20261029_0930_0001').events, 'utf8').trim().split('\n').length, 1);
  if (unsafe === 'home') rmSync(join(f.paths.home, 'secret.json')); // Deliberately planted by this negative test, not by delivery.
});

test('HTTP options enforce manual redirect, timeout, no keepalive/cookies and bounded body read', async t => {
  const f = setup(t); await f.enqueue(); const { meta: _meta, ...payload } = f.pending()[0]!;
  const budgets: number[] = []; let reads = 0, cancelled = false, captured: RequestInit | undefined, timeout = 0;
  const nativeTimeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeout = ms; return nativeTimeout(ms); });
  const response = { status: 200, headers: new Headers(), body: { getReader: (options: { mode: string }) => { assert.equal(options.mode, 'byob'); return { read: async (buffer: Uint8Array) => { budgets.push(buffer.byteLength); reads++; return { done: false, value: new Uint8Array(1024) }; }, cancel: async () => { cancelled = true; }, releaseLock() {} }; } } };
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { captured = init; return response as unknown as Response; });
  const result = await postNotice({ schema: 'gbdev.notify-secret.v1', url: 'http://127.0.0.1:1234/test', key: f.key }, payload, f.config, enabledEnv);
  assert.equal(result.status, 200); assert.equal(reads, 4); assert.deepEqual(budgets, [4096, 3072, 2048, 1024]); assert.equal(cancelled, true); assert.equal(timeout, 5000);
  assert.equal(captured?.redirect, 'manual'); assert.equal(captured?.keepalive, false); assert.equal(captured?.credentials, 'omit'); assert.ok(captured?.signal);
});
for (const mode of ['hang', 'body-hang', 'slow', 'body-disconnect'] as const) test(`HTTP local stub ${mode} is bounded and safely classified`, async t => {
  const f = setup(t), stub = await server(t, [{ mode, delay: 5, body: f.key }]); f.credentials(stub.url); await f.enqueue();
  const { meta: _meta, ...payload } = f.pending()[0]!;
  const result = await postNotice({ schema: 'gbdev.notify-secret.v1', url: stub.url, key: f.key }, payload, { ...f.config, timeout_ms: 1000 }, enabledEnv);
  if (mode === 'slow') assert.equal(result.status, 200); else assert.equal(result.error, mode === 'body-disconnect' ? 'network' : 'timeout');
  assert.ok(!JSON.stringify(result).includes(f.key));
});
test('HTTP network/TLS exceptions never escape or reflect credentials in error envelopes', async t => {
  const f = setup(t); await f.enqueue(); const { meta: _meta, ...payload } = f.pending()[0]!;
  const original = globalThis.fetch;
  for (const [name, code, expected] of [['TimeoutError', '', 'timeout'], ['TypeError', 'CERT_HAS_EXPIRED', 'tls'], ['TypeError', 'ECONNRESET', 'network']]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => { const e = new Error(f.key); e.name = name!; Object.assign(e, { cause: { code } }); throw e; });
    try {
      const result = await postNotice({ schema: 'gbdev.notify-secret.v1', url: 'http://127.0.0.1:1234/', key: f.key }, payload, f.config, enabledEnv);
      assert.equal(result.error, expected); assert.ok(!JSON.stringify(failureEnvelope('notify', result)).includes(f.key));
    } finally { mocked.mock.restore(); }
  }
  assert.equal(globalThis.fetch, original, 'each exception fixture restores the suite fetch sentinel');
});
test('HTTP default test guard, external endpoints, unsafe TLS and proxy mode make zero requests', async t => {
  const f = setup(t); await f.enqueue(); const { meta: _meta, ...payload } = f.pending()[0]!; let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('network prohibited'); });
  for (const [url, env] of [['http://127.0.0.1:1234/', { NODE_TEST_CONTEXT: 'child' }], ['https://external.invalid/', enabledEnv], ['http://127.0.0.1:1234/', { ...enabledEnv, NODE_TLS_REJECT_UNAUTHORIZED: '0' }], ['http://127.0.0.1:1234/', { ...enabledEnv, NODE_USE_ENV_PROXY: '1' }]] as const) {
    assert.ok((await postNotice({ schema: 'gbdev.notify-secret.v1', url, key: f.key }, payload, f.config, env)).error);
  }
  await f.deliver({ env: { NODE_TEST_CONTEXT: 'child' } }); assert.equal(calls, 0);
});
test('wire payload oversize archives with warning and body/header collisions never send secrets', async t => {
  const f = setup(t); await f.enqueue(); const { meta: _meta, ...payload } = f.pending()[0]!;
  t.mock.method(globalThis, 'fetch', () => assert.fail('must not send'));
  for (const [placement, name] of [['header', 'Cookie'], ['header', 'Host'], ['body_field', 'notice_id'], ['body_field', '__proto__']] as const) {
    const result = await postNotice({ schema: 'gbdev.notify-secret.v1', url: 'http://127.0.0.1:1234/', key: f.key }, payload, { ...f.config, key_placement: placement, key_name: name }, enabledEnv); assert.equal(result.error, 'secret');
  }
  await f.deliver({ post: async () => ({ status: null, error: 'oversize', retry_after_ms: null }) });
  assert.equal(f.records('dead')[0].meta.outcome, 'oversize'); assert.match(readFileSync(jobPaths(f.paths, payload.unit_id!).events, 'utf8'), /oversize/);
});
test('notify.log rotates one backup at 1 MiB and rejects non-enum messages/links', async t => {
  const f = setup(t); await f.enqueue(); const log = join(f.paths.home, 'notify', 'notify.log');
  writeFileSync(log, 'x'.repeat(1024 * 1024 + 1)); deliveryLog(f.paths.home, 'sent'); assert.equal(statSync(log + '.1').size, 1024 * 1024 + 1);
  assert.match(readFileSync(log, 'utf8'), /sent/); const before = readFileSync(log); deliveryLog(f.paths.home, f.key); assert.deepEqual(readFileSync(log), before);
  rmSync(log); const target = join(f.root, 'link-target'); writeFileSync(target, 'untouched'); symlinkSync(target, log); deliveryLog(f.paths.home, 'sent'); assert.equal(readFileSync(target, 'utf8'), 'untouched');
});
test('launcher uses whitelist/detached/unref and ignores exit codes; CLI stays hidden', async t => {
  const f = setup(t); await f.enqueue(); let failed = 0, unref = 0, argv: string[] = [], opts: SpawnOptions = {};
  const fake = new EventEmitter() as ChildProcess; fake.unref = () => { unref++; };
  launchDeliver(f.paths, () => { failed++; }, { ...enabledEnv, PRIVATE_TOKEN: f.key, HTTPS_PROXY: f.key, NODE_OPTIONS: f.key }, (_command, args, options) => { argv = args; opts = options; return fake; });
  assert.equal(unref, 1); assert.equal(opts.detached, true); assert.equal(opts.shell, false); assert.equal(fake.listenerCount('exit'), 0);
  fake.emit('exit', 1, null); assert.equal(failed, 0); fake.emit('error', new Error(f.key)); assert.equal(failed, 1);
  assert.ok(!JSON.stringify([argv, opts.env]).includes(f.key)); assert.equal(argv.at(-1), '__notify-deliver');
  let output = ''; const io = { stdout: (s: string) => { output += s; }, stderr: (s: string) => { output += s; } };
  await runCli(['help'], io); assert.ok(!output.includes('__notify-deliver')); output = '';
  assert.equal(await runCli(['__notify-deliver'], io), 0); assert.equal(output, ''); // Default NODE_TEST_CONTEXT guard.
});

for (const corruption of ['json', 'seq', 'notice_id', 'meta_attempts', 'meta_next_at', 'meta_last_error'] as const) test(`S3 repair corrupt outbox ${corruption} is quarantined once and valid notice delivers`, async t => {
  const f = setup(t); await f.enqueue(1); await f.enqueue(2);
  const bad = f.pending()[0]!, good = f.pending()[1]!, name = `${bad.seq}-${bad.notice_id}.json`;
  const out = join(f.paths.home, 'notify', 'outbox', name), quarantine = join(f.paths.home, 'notify', 'dead', `corrupt_${name}`);
  if (corruption === 'seq') bad.seq++;
  if (corruption === 'notice_id') bad.notice_id = 'n_0000000000000000';
  if (corruption === 'meta_attempts') bad.meta.attempts = -1;
  if (corruption === 'meta_next_at') bad.meta.next_at = 'invalid';
  if (corruption === 'meta_last_error') Object.assign(bad.meta, { last_error: {} });
  const contents = corruption === 'json' ? '{broken JSON' : JSON.stringify(bad);
  writeFileSync(out, contents);
  const sent: string[] = [];
  await f.deliver({ post: async (_credentials, payload) => { sent.push(payload.notice_id); return success; } });
  assert.deepEqual(sent, [good.notice_id]); assert.equal(existsSync(out), false);
  assert.equal(readFileSync(quarantine, 'utf8'), contents); assert.equal(f.pending().length, 0);
  const log = () => readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8');
  assert.equal(log().split('\n').filter(line => line.includes('corrupt_record')).length, 1);
  assert.ok(!log().includes(contents));
  // Re-enter the loop with fresh work; the quarantined record is never parsed again.
  await f.enqueue(3); await f.deliver({ post: async () => success });
  assert.equal(log().split('\n').filter(line => line.includes('corrupt_record')).length, 1);
  assert.equal(readFileSync(quarantine, 'utf8'), contents);
});

test('S3 repair failed quarantine does not starve valid pending', async t => {
  const f = setup(t); await f.enqueue(1); await f.enqueue(2); const bad = f.pending()[0]!;
  const name = `${bad.seq}-${bad.notice_id}.json`, dir = join(f.paths.home, 'notify');
  writeFileSync(join(dir, 'outbox', name), '{broken');
  mkdirSync(join(dir, 'dead', `corrupt_${name}`), { recursive: true });
  let calls = 0; await f.deliver({ post: async () => { calls++; return success; } });
  assert.equal(calls, 1); assert.ok(existsSync(join(dir, 'outbox', name)));
  assert.equal(f.records('sent').length, 1);
  assert.match(readFileSync(join(dir, 'notify.log'), 'utf8'), /corrupt_record/);
});

test('S3 repair corrupt dead archives use mtime retention and never block pending', async t => {
  const f = setup(t); await f.enqueue(); const record = f.pending()[0]!, dir = join(f.paths.home, 'notify'), dead = join(dir, 'dead');
  mkdirSync(dead); const old = new Date(f.now() - 31 * 86400000);
  const names = ['2-n_0000000000000000.json', '3-n_0000000000000000.json', 'corrupt_4-n_0000000000000000.json', 'corrupt_5-n_0000000000000000.json'];
  for (const name of names) writeFileSync(join(dead, name), '{broken');
  for (const name of [names[0]!, names[2]!]) utimesSync(join(dead, name), old, old);
  writeFileSync(join(dir, 'staging', 'keep.json'), '{broken');
  const index = join(dir, 'notice_ids', record.notice_id), originalIndex = readFileSync(index);
  assert.doesNotThrow(() => pruneDelivery(f.paths.home, f.now()));
  assert.deepEqual(readdirSync(dead).sort(), [names[1], names[3]]);
  let calls = 0; await f.deliver({ post: async () => { calls++; return success; } });
  assert.equal(calls, 1); assert.equal(f.pending().length, 0);
  assert.deepEqual(readFileSync(index), originalIndex); assert.equal(readFileSync(join(dir, 'staging', 'keep.json'), 'utf8'), '{broken');
});

for (const content of ['{broken', 'null', '[]']) test(`S3 repair invalid state ${content} resets atomically and delivery continues`, async t => {
  const f = setup(t); await f.enqueue(); const path = join(f.paths.home, 'notify', 'state.json');
  writeFileSync(path, content); assert.throws(() => readDeliveryState(f.paths.home), /Invalid notify state/);
  let calls = 0; await f.deliver({ post: async () => {
    calls++; assert.ok(existsSync(f.paths.lock) === false); // Global lock is never held across POST.
    assert.equal(readDeliveryState(f.paths.home).deliverer_pid, process.pid); return success;
  } });
  assert.equal(calls, 1); assert.equal(f.pending().length, 0);
  const state = readDeliveryState(f.paths.home); assert.equal(state.deliverer_pid, null); assert.ok(state.last_success_at);
  assert.equal(readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8').split('\n').filter(line => line.includes('state_reset')).length, 1);
});

for (const [placement, name] of [['header', 'Cookie'], ['header', 'Host'], ['body_field', 'notice_id'], ['body_field', '__proto__']] as const) test(`S3 repair ${placement} ${name} conflict logs each launch without attempts`, async t => {
  const f = setup(t, { key_placement: placement, key_name: name }); await f.enqueue(); const original = f.pending()[0]!;
  for (let i = 0; i < 3; i++) {
    await f.deliver({ post: async () => assert.fail('preflight must not POST') });
    assert.deepEqual(f.pending()[0], original);
    const state = readDeliveryState(f.paths.home);
    assert.equal(state.blocked_reason, 'secret_unsafe'); assert.equal(state.secret_problem, null);
    assert.deepEqual(state.last_error, { class: 'secret', http_status: null, at: stamp(f.now()) });
  }
  const lines = readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3); assert.ok(lines.every(line => line.includes(`secret_unsafe ${original.notice_id} ${original.seq}`)));
});

test('S3 repair HTTP secret result rolls back attempts and last_attempt_at and matches secret failure diagnostics', async t => {
  const f = setup(t); await f.enqueue(); const original = f.pending()[0]!;
  const previousAttempt = stamp(f.now() - 60000);
  atomicWriteJson(join(f.paths.home, 'notify', 'state.json'), { last_attempt_at: previousAttempt });
  for (let i = 0; i < 3; i++) {
    await f.deliver({ post: async () => ({ status: null, error: 'secret', retry_after_ms: null }) });
    assert.deepEqual(f.pending()[0], original);
    const state = readDeliveryState(f.paths.home);
    assert.equal(state.last_attempt_at, previousAttempt);
    assert.equal(state.blocked_reason, 'secret_unsafe'); assert.equal(state.secret_problem, null);
    assert.deepEqual(state.last_error, { class: 'secret', http_status: null, at: stamp(f.now()) });
  }
  let lines = readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3); assert.ok(lines.every(line => line.includes(`secret_unsafe ${original.notice_id} ${original.seq}`)));
  chmodSync(f.file, 0o644); await f.deliver({ post: async () => assert.fail('unsafe file') });
  const state = readDeliveryState(f.paths.home); assert.equal(state.blocked_reason, 'secret_unsafe'); assert.equal(state.secret_problem, 'mode_not_0600');
  assert.deepEqual(state.last_error, { class: 'secret', http_status: null, at: stamp(f.now()) });
  lines = readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 4); assert.ok(lines.every(line => line.includes(`secret_unsafe ${original.notice_id} ${original.seq}`)));
});

test('S3 repair thrown POST is retryable network with next_at advanced and no secret block', async t => {
  const f = setup(t); await f.enqueue(); let elapsed = 0, calls = 0; const before = f.now();
  await f.deliver({ monotonic: () => elapsed, post: async () => { calls++; elapsed = 1e9; throw new Error(f.key); } });
  const record = f.pending()[0]!, state = readDeliveryState(f.paths.home);
  assert.equal(calls, 1); assert.equal(record.meta.attempts, 1); assert.equal(Date.parse(record.meta.next_at), before + 5000);
  assert.equal(record.meta.last_error, 'network'); assert.equal(state.blocked_reason, null); assert.equal(state.secret_problem, null); assert.equal(state.last_error?.class, 'network');
  const log = readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8'); assert.match(log, /network/); assert.doesNotMatch(log, /secret_unsafe/);
  f.advance(5000); await f.deliver({ post: async () => success }); assert.equal(f.pending().length, 0); assert.equal(f.records('sent')[0].meta.attempts, 2);
});


test('S3 repair unreadable dead file falls back to mtime without blocking delivery', async t => {
  const f = setup(t); await f.enqueue(); const dir = join(f.paths.home, 'notify', 'dead'); mkdirSync(dir);
  const path = join(dir, '99-n_0000000000000000.json'); writeFileSync(path, '{}');
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === path) throw new Error('injected archive read failure');
    return Reflect.apply(originalRead, fs, args);
  });
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => pruneDelivery(f.paths.home, f.now())); assert.ok(existsSync(path));
    let calls = 0; await f.deliver({ post: async () => { calls++; return success; } }); assert.equal(calls, 1);
    const old = new Date(f.now() - 31 * 86400000); utimesSync(path, old, old);
    assert.doesNotThrow(() => pruneDelivery(f.paths.home, f.now())); assert.equal(existsSync(path), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('S3 repair state write failure before POST logs storage_failed not secret_unsafe', async t => {
  const f = setup(t); await f.enqueue(); const path = join(f.paths.home, 'notify', 'state.json');
  const originalRename = fs.renameSync; let writes = 0, posts = 0;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (args[1] === path && ++writes === 2) throw new Error(f.key);
    return Reflect.apply(originalRename, fs, args);
  });
  syncBuiltinESMExports();
  try { await f.deliver({ post: async () => { posts++; return success; } }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(posts, 0); assert.equal(f.pending().length, 1);
  const state = readDeliveryState(f.paths.home); assert.equal(state.blocked_reason ?? null, null); assert.equal(state.secret_problem ?? null, null);
  const log = readFileSync(join(f.paths.home, 'notify', 'notify.log'), 'utf8'); assert.match(log, /storage_failed/); assert.doesNotMatch(log, /secret_unsafe/);
  await f.deliver({ post: async () => success }); assert.equal(f.pending().length, 0);
});
