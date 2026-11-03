import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runCli } from '../src/cli.js';
import { notifyCommand } from '../src/commands/notify.js';
import { identity } from '../src/dashboard/names.js';
import { validateConfig } from '../src/core/config.js';
import { validateNotify, NOTIFY_DEFAULTS, notifyDisabledReason } from '../src/core/notifyConfig.js';
import { resolvePaths } from '../src/core/paths.js';
import { GbdevError, errorExitCode, validateError } from '../src/contracts/error.js';
import { failureEnvelope, serializeEnvelope, successEnvelope, validateEnvelope } from '../src/contracts/envelope.js';
import { INIT_STATES, MISSING_STEPS, validateNotifyInit, validateNotifyPayload, validateNotifyStatus, validateNotifyTest, validateNotifySecret, validateNotifyAck, type NotifyInit, type NotifyPayload } from '../src/contracts/notify.js';
import { DECISION_REASONS } from '../src/contracts/run.js';
import { buildPayload, computeNoticeId, fitPayload, type PayloadInput } from '../src/notify/payload.js';
import { SecretUseError, assertNoSecret, computeSecretGen, readSecret, secretFilePath, setupOutput, validateEndpoint, type SecretOptions, type SecuritySpawn } from '../src/notify/secret.js';
function testEnv(t: { after(fn: () => void): void }, paths: { home: string; config: string }): void {
  const oldHome = process.env.GBDEV_HOME, oldConfig = process.env.GBDEV_CONFIG;
  process.env.GBDEV_HOME = paths.home; process.env.GBDEV_CONFIG = paths.config;
  t.after(() => { if (oldHome === undefined) delete process.env.GBDEV_HOME; else process.env.GBDEV_HOME = oldHome; if (oldConfig === undefined) delete process.env.GBDEV_CONFIG; else process.env.GBDEV_CONFIG = oldConfig; });
}
const at = '2026-10-29T10:31:02-07:00';
const h12 = 'a1b2c3d4e5f6', nid = 'n_1234567890abcdef';
const base: PayloadInput = { home_id: h12, unit_kind: 'run', unit_id: 'r_20261029_0930_ab12', event: 'attention', kind: 'plan_review', decision_id: 'd_abc-123', task_id: 't5', unit_state: 'running', source_seq: 7, seq: 42, occurred_at: at, sent_at: at, gbdev_version: '1.0.0' };
function payload(input: PayloadInput = base): NotifyPayload { const r = buildPayload(input); assert.equal(r.ok, true); if (!r.ok) throw new Error('Unexpected oversize'); return r.payload; }
function code(expected: string) { return (e: unknown) => e instanceof GbdevError && e.contract.code === expected; }
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'gbdev-m5-s1-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = resolvePaths({ GBDEV_HOME: join(dir, 'home'), GBDEV_CONFIG: join(dir, 'config.json') });
  mkdirSync(paths.home, { mode: 0o700 }); const secrets = join(dir, 'secrets'); mkdirSync(secrets, { mode: 0o700 });
  const file = join(secrets, 'notify.json'), key = `GBDEVTESTKEY-${randomUUID()}`, url = `https://hooks.example.test/private/${randomUUID()}?token=${randomUUID()}`;
  const secret = { schema: 'gbdev.notify-secret.v1' as const, url, key };
  writeFileSync(file, JSON.stringify(secret), { mode: 0o600 });
  const config = validateNotify({ secret_file: file });
  const opts: SecretOptions = { paths, config, allowed_repos: [], home_id: h12, env: {}, defaultDirectory: secrets };
  const safe = (v: unknown) => { const text = v instanceof Error ? v.message : typeof v === 'string' ? v : JSON.stringify(v); assert.ok(!text.includes(key)); assert.ok(!text.includes(url)); };
  const setupIO = { isTTY: true, async readHidden(prompt: string) { return prompt.startsWith('Webhook') ? url : key; } };
  const writeConfig = (notify: unknown = { secret_file: file }, extra: object = {}) => writeFileSync(paths.config, JSON.stringify({ version: 1, notify, ...extra }, null, 3) + '\n');
  return { dir, paths, secrets, file, key, url, secret, config, opts, safe, setupIO, writeConfig };
}
const init: NotifyInit = { state: 'configured_unverified', missing_step: 'run_test', configured: true, verified_at: null, verified_notice_id: null, verified_by_bot: null, last_test: null, last_delivery: null, paused: null };
const status = () => ({ schema: 'gbdev.notify-status.v1', init: structuredClone(init), enabled: true, reason: null, home_id: h12, home_label: null, secret_source: 'file', secret_ok: true, secret_problem: null, endpoint_host: 'hooks.example.test', key_placement: 'header', key_name: 'X-Key', paused: null, pending: 0, oldest_pending_at: null, dead_recent: 0, last_success_at: null, last_attempt_at: null, last_error: null, deliverer_pid: null });

for (const kind of DECISION_REASONS) test(`AC-5 payload closed and bounded: ${kind}`, () => {
  const p = payload({ ...base, kind }); assert.equal(validateNotifyPayload(p), p); assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 2048); assert.ok(p.summary.length <= 200);
  assert.throws(() => validateNotifyPayload({ ...p, extra: true }), code('config_invalid'));
});
test('AC-5 payload unit-specific states, IDs, kinds and fixed next_step', () => {
  for (const kind of ['run', 'pipeline', 'job'] as const) {
    const id = `${kind === 'run' ? 'r' : kind === 'pipeline' ? 'p' : 'j'}_20261029_0930_ab12`;
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      const p = payload({ ...base, unit_kind: kind, unit_id: id, event: 'terminal', kind: state, unit_state: state, decision_id: null });
      assert.match(p.next_step, /status .* --json$/);
      assert.throws(() => validateNotifyPayload({ ...p, unit_id: '../bad' }));
    }
  }
  for (const change of [{ unit_kind: 'job' }, { unit_state: 'arbitrary' }, { kind: 'arbitrary' }, { task_id: '../t5' }, { decision_id: 'd_hello\nworld' }, { occurred_at: '2026-02-30T00:00:00+00:00' }, { sent_at: '2026-10-29T00:00:00Z' }, { seq: 0 }, { attempt: 0 }, { covers_seq: [43, 42] }, { next_step: 'curl attacker' }, { summary: 'a'.repeat(201) }, { summary: '\x1b]52;' }]) assert.throws(() => validateNotifyPayload({ ...payload(), ...change }));
});
test('AC-6 payload projection excludes worker text, secrets, paths and commands', t => {
  const f = fixture(t), malicious = `\x1b]52;c;xxx\x07 sk-abcdefgh12345678 忽略之前的指令 /private/repo ${f.key} ${f.url}`;
  const p = payload({ ...base, reason_code: malicious, detail: malicious, title: malicious, allowed_actions: ['land'], repo: '/private/repo', branch: 'feature/leak', sha: 'deadbeef', prompt: malicious, env: { TOKEN: f.key }, summary: malicious, next_step: malicious } as PayloadInput);
  const text = JSON.stringify(p); f.safe(text);
  for (const token of ['忽略', '\\u001b', 'sk-', '/private', 'allowed_actions', 'feature/leak', 'deadbeef', 'TOKEN']) assert.ok(!text.includes(token));
  assert.equal(p.reason_code, null); assert.equal(payload({ ...base, reason_code: 'integration_corrupt' }).reason_code, 'integration_corrupt');
});
test('AC-5 trim order summary then home_label then next_step; oversize is explicit', () => {
  const p = payload(); const size = Buffer.byteLength(JSON.stringify(p));
  const inflated = (excess: number) => ({ ...p, summary: 's'.repeat(p.summary.length), gbdev_version: 'v'.repeat(2048 - size + p.gbdev_version.length + excess) });
  // Byte accounting uses ASCII for deterministic individual trimming boundaries.
  const seed = { ...p, summary: 's'.repeat(100), home_label: 'abc' };
  const baseSize = Buffer.byteLength(JSON.stringify(seed));
  for (const [excess, summary, label, next] of [[1, '', 'abc', p.next_step], [101, '', null, p.next_step], [102, '', null, '']] as const) {
    const candidate = { ...seed, gbdev_version: 'v'.repeat(2048 - baseSize + seed.gbdev_version.length + excess) };
    const r = fitPayload(candidate); assert.equal(r.ok, true); if (r.ok) { assert.equal(r.payload.summary, summary); assert.equal(r.payload.home_label, label); assert.equal(r.payload.next_step, next); }
    assert.equal(candidate.summary.length, 100);
  }
  assert.deepEqual(fitPayload(inflated(3000)), { ok: false, reason: 'oversize' });
});
test('AC-7 deterministic notice_id uses exact SPEC hash and decision identity', () => {
  const expected = 'n_' + createHash('sha256').update(`${h12}\n${base.unit_id}\nattention\nplan_review\nd_abc-123\n7`).digest('hex').slice(0, 16);
  assert.equal(computeNoticeId(base), expected); assert.equal(computeNoticeId({ ...base }), expected);
  assert.notEqual(computeNoticeId({ ...base, decision_id: 'd_other' }), expected);
  assert.notEqual(computeNoticeId({ ...base, source_seq: 8 }), expected);
});
test('AC-33 S1 test payload validates and UUID source yields distinct IDs', () => {
  const input: PayloadInput = { ...base, event: 'test', kind: 'test', unit_kind: null, unit_id: null, unit_state: null, decision_id: null, task_id: null, source_seq: randomUUID() };
  const p = payload(input); assert.equal(p.next_step, ''); assert.equal(validateNotifyPayload(p), p);
  assert.notEqual(p.notice_id, payload({ ...input, source_seq: randomUUID() }).notice_id);
  for (const change of [{ unit_kind: 'run' }, { unit_state: 'running' }, { task_id: 't5' }, { kind: 'plan_review' }, { coalesced: 2 }]) assert.throws(() => validateNotifyPayload({ ...p, ...change }));
  assert.throws(() => payload({ ...input, source_seq: 1 }));
});
for (const state of INIT_STATES) test(`AC-32 S1 init accepts state ${state}`, () => { validateNotifyInit({ ...init, state }); validateNotifyStatus({ ...status(), init: { ...init, state } }); });
for (const missing_step of [null, ...MISSING_STEPS]) test(`AC-32 S1 init accepts missing_step ${missing_step}`, () => { validateNotifyStatus({ ...status(), init: { ...init, missing_step } }); });
test('AC-32 S1 init and nested objects closed; unknown values and missing fields rejected', () => {
  const full = { ...init, verified_at: at, verified_notice_id: nid, verified_by_bot: 'example-main', last_test: { notice_id: nid, seq: 1, sent_at: at, http_status: 202, delivered: true }, last_delivery: { notice_id: nid, seq: 2, event: 'attention', at, http_status: 200 }, paused: { reason: 'paused_auth_rejected', at, http_status: 401 } };
  validateNotifyInit(full);
  for (const change of [{ state: 'unknown' }, { missing_step: 'unknown' }, { url: 'https://secret.test' }, { verified_by_bot: '/path' }, { last_test: { ...full.last_test, key: 'leak' } }, { last_delivery: { ...full.last_delivery, url: 'leak' } }, { paused: { ...full.paused, reason: 'unknown' } }]) assert.throws(() => validateNotifyInit({ ...full, ...change }));
  for (const key of Object.keys(init)) { const copy: Record<string, unknown> = { ...init }; delete copy[key]; assert.throws(() => validateNotifyInit(copy)); }
  assert.throws(() => validateNotifyStatus({ ...status(), surprise: true }));
});
test('S1 envelope branches test/ack/status only, error codes retain contract v1', () => {
  const results = [status(), { schema: 'gbdev.notify-test.v1', notice_id: nid, seq: 1, http_status: 202, latency_ms: 42, delivered: true, awaiting_ack: true }, { schema: 'gbdev.notify-ack.v1', notice_id: nid, verified_at: at, verified_by_bot: 'example-main' }];
  for (const r of results) validateEnvelope(successEnvelope('notify', r.schema, r));
  assert.throws(() => validateEnvelope(successEnvelope('notify', 'gbdev.notify.v1', payload())));
  assert.throws(() => validateEnvelope(successEnvelope('notify', 'gbdev.notify-secret.v1', {})));
  assert.throws(() => validateNotifyTest({ ...results[1], awaiting_ack: false }));
  for (const field of ['seq', 'awaiting_ack']) { const copy = { ...results[1] }; delete (copy as Record<string, unknown>)[field]; assert.throws(() => validateNotifyTest(copy)); }
  assert.throws(() => validateNotifyAck({ ...results[2], key: 'unexpected' }));
  for (const error of ['notify_unavailable', 'notify_ack_invalid'] as const) { validateError(new GbdevError(error, 'Notify failed').contract); assert.equal(errorExitCode(error), 1); }
});

test('AC-14 notify defaults, ranges, placement and safe validation errors', t => {
  const f = fixture(t); assert.deepEqual(validateNotify(undefined), NOTIFY_DEFAULTS);
  for (const v of [null, [], true, { enabled: 'true' }, { coalesce: 1 }, { secret_source: 'env' }, { secret_file: 'relative' }, { secret_file: '/tmp/\0' }, { key_placement: 'query' }, { key_name: '' }, { key_name: 'bad_name' }, { key_prefix: '\n' }, { key_prefix: 'a'.repeat(17) }, { home_label: 'Upper' }, { timeout_ms: 999 }, { timeout_ms: 15001 }, { max_age_h: 0 }, { max_age_h: 169 }, { deliverer_max_lifetime_min: 4 }, { deliverer_max_lifetime_min: 241 }, { timeout_ms: 1.5 }, { [f.key]: f.url }]) {
    assert.throws(() => validateNotify(v), e => { f.safe(e); return code('config_invalid')(e); });
  }
  for (const [key, min, max] of [['timeout_ms', 1000, 15000], ['max_age_h', 1, 168], ['deliverer_max_lifetime_min', 5, 240]] as const) { validateNotify({ [key]: min }); validateNotify({ [key]: max }); }
  validateNotify({ enabled: true, key_placement: 'body_field', key_name: '_sender_key', key_prefix: 'Bearer ' });
  assert.throws(() => validateNotify({ enabled: true }), code('key_name_missing'));
  assert.throws(() => validateNotify({ key_placement: 'body_field', key_name: 'X-Key' }), code('config_invalid'));
});
for (const key of ['url', 'key', 'secret']) test(`AC-14 reject config secret key ${key} at any depth`, t => {
  const f = fixture(t);
  for (const raw of [{ version: 1, [key]: f.key }, { version: 1, notify: { [key]: f.url } }, { version: 1, unknown: { nested: [{ [key]: f.key }] } }]) assert.throws(() => validateConfig(raw), e => { f.safe(e); return code('config_invalid')(e); });
});
test('O-10 legacy top-level unknown fields remain ignored; notify is now validated', () => {
  assert.deepEqual(validateConfig({ version: 1, future_unknown: { enabled: true } }), validateConfig({ version: 1 }));
  assert.throws(() => validateConfig({ version: 1, notify: { enabled: true } }), code('key_name_missing'));
  assert.equal(validateConfig({ version: 1, notify: {} }).notify?.enabled, false);
});
test('N17 environment policy cannot force-enable notify', () => {
  const n = validateNotify({ enabled: true, key_name: 'X-Key' });
  assert.equal(notifyDisabledReason(n, {}), null); assert.equal(notifyDisabledReason(n, { GBDEV_NOTIFY: '0' }), 'disabled_by_env');
  assert.equal(notifyDisabledReason(n, { NODE_TEST_CONTEXT: '' }), 'disabled_in_tests');
  assert.equal(notifyDisabledReason(n, { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1' }), null);
  assert.equal(notifyDisabledReason(NOTIFY_DEFAULTS, { GBDEV_NOTIFY: '1' }), 'disabled_by_config');
});

test('AC-13 safe file returns metadata only; callback sees credentials; generation is metadata', async t => {
  const f = fixture(t); let called = 0;
  const r = await readSecret(f.opts, secret => { called++; assert.deepEqual(secret, f.secret); });
  assert.equal(called, 1); assert.equal(r.ok, true); assert.equal(r.endpoint_host, 'hooks.example.test'); f.safe(r);
  assert.deepEqual(Object.keys(r).sort(), ['endpoint_host', 'ok', 'problem', 'reason', 'secret_gen']);
  const s = statSync(f.file); assert.equal(r.secret_gen, `${s.mtimeMs}:${s.size}:${s.ino}`);
  assert.equal(computeSecretGen({ source: 'keychain', keychain_setup_at: at }), `keychain:${at}`); assert.equal(computeSecretGen({ source: 'keychain', keychain_setup_at: null }), null);
  assert.equal(secretFilePath({ ...f.opts, config: validateNotify({}) }), join(f.secrets, `${h12}.secret.json`));
  await assert.rejects(readSecret(f.opts, () => { throw new Error(`${f.url} ${f.key}`); }), e => {
    assert.ok(e instanceof SecretUseError); f.safe(e); f.safe(e.message); f.safe(failureEnvelope('notify', e)); return true;
  });
});
const unsafeCases: [string, string, (f: ReturnType<typeof fixture>) => void][] = [
  ['mode 0644', 'mode_not_0600', f => chmodSync(f.file, 0o644)],
  ['directory 0755', 'directory_not_0700', f => chmodSync(f.secrets, 0o755)],
  ['symlink', 'symlink', f => { const link = join(f.secrets, 'link'); symlinkSync(f.file, link); f.opts.config = { ...f.config, secret_file: link }; }],
  ['parent directory symlink', 'directory_not_0700', f => { const link = join(f.dir, 'linked-secrets'); symlinkSync(f.secrets, link); f.opts.config = { ...f.config, secret_file: join(link, 'notify.json') }; }],
  ['not regular', 'not_regular_file', f => { rmSync(f.file); mkdirSync(f.file, { mode: 0o600 }); }],
  ['owner mismatch', 'owner_mismatch', f => { f.opts.uid = (process.getuid?.() ?? 0) + 1; }],
  ['GBDEV_HOME location', 'unsafe_location', f => { f.opts.paths = { ...f.paths, home: f.dir }; }],
  ['allowed repo location', 'unsafe_location', f => { f.opts.allowed_repos = [f.dir]; }],
  ['worktrees location', 'unsafe_location', f => { f.opts.paths = { ...f.paths, worktrees: f.secrets }; }],
  ['canonical repo alias', 'unsafe_location', f => { const alias = join(f.dir, 'alias'); symlinkSync(f.secrets, alias); f.opts.allowed_repos = [alias]; }],
  ['missing', 'not_found', f => rmSync(f.file)],
  ['over 4 KiB', 'too_large', f => writeFileSync(f.file, 'x'.repeat(4097))],
  ['invalid JSON', 'invalid_json', f => writeFileSync(f.file, f.key + f.url)],
  ['unknown schema field', 'invalid_schema', f => writeFileSync(f.file, JSON.stringify({ ...f.secret, leak: f.key }))],
  ['empty key', 'key_invalid', f => writeFileSync(f.file, JSON.stringify({ ...f.secret, key: '' }))],
  ['long key', 'key_invalid', f => writeFileSync(f.file, JSON.stringify({ ...f.secret, key: 'x'.repeat(513) }))],
  ['control in key', 'key_invalid', f => writeFileSync(f.file, JSON.stringify({ ...f.secret, key: f.key + '\x85' }))],
  ['HTTP', 'url_invalid', f => writeFileSync(f.file, JSON.stringify({ ...f.secret, url: 'http://hooks.example.test/private' }))],
  ['userinfo', 'url_invalid', f => writeFileSync(f.file, JSON.stringify({ ...f.secret, url: 'https://user:password@hooks.example.test/' }))],
  ['fragment', 'url_invalid', f => writeFileSync(f.file, JSON.stringify({ ...f.secret, url: f.url + '#' }))],
];
for (const [name, problem, mutate] of unsafeCases) test(`AC-13 unsafe secret: ${name}`, async t => {
  const f = fixture(t); mutate(f); let used = false; const r = await readSecret(f.opts, () => { used = true; });
  assert.equal(r.ok, false); assert.equal(r.problem, problem); assert.equal(r.reason, problem === 'not_found' ? 'secret_missing' : problem === 'url_invalid' ? 'url_invalid' : 'secret_unsafe'); assert.equal(used, false); f.safe(r);
});
test('AC-13 directory owner mismatch rejects without reading contents', async t => {
  const f = fixture(t);
  // No chown/root privileges: inject only lstat metadata through node:test mock.
  const fs = await import('node:fs');
  const original = fs.default.lstatSync;
  t.mock.method(fs.default, 'lstatSync', (...args: Parameters<typeof original>) => { const result = original(...args); if (args[0] === f.secrets) Object.defineProperty(result, 'uid', { value: (process.getuid?.() ?? 0) + 1 }); return result; });
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
  try { assert.equal((await readSecret(f.opts)).problem, 'directory_owner_mismatch'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
test('AC-13 strict HTTPS and test-only exact IPv4 loopback with explicit port', async t => {
  const f = fixture(t);
  for (const url of ['http://localhost:1234', 'http://127.0.0.2:1234', 'http://127.1:1234', 'http://2130706433:1234', 'http://[::1]:1234', 'http://127.0.0.1', 'https://x/#', 'https://u@x/', 'https://x/\n', 'ftp://x/', 'garbage']) assert.equal(validateEndpoint(url, { GBDEV_NOTIFY_TEST: '1' }), null);
  assert.equal(validateEndpoint('http://127.0.0.1:1234', {}), null);
  writeFileSync(f.file, JSON.stringify({ ...f.secret, url: 'http://127.0.0.1:1234/path' }));
  assert.equal((await readSecret(f.opts)).reason, 'url_invalid'); assert.equal((await readSecret({ ...f.opts, env: { GBDEV_NOTIFY_TEST: '1' } })).endpoint_host, '127.0.0.1');
  validateNotifySecret(f.secret); assert.throws(() => validateNotifySecret({ ...f.secret, extra: true }));
});
function fakeSecurity(reply: string | null, inspect?: (args: string[], opts: SpawnOptions, stdin: string) => void): SecuritySpawn {
  return (command, args, opts) => {
    assert.equal(command, '/usr/bin/security'); const child = new EventEmitter() as ChildProcess;
    const input = new PassThrough(), output = new PassThrough(); Object.assign(child, { stdin: input, stdout: output, kill: () => true });
    let text = ''; input.on('data', chunk => { text += chunk.toString(); });
    input.on('finish', () => { inspect?.(args, opts, text); queueMicrotask(() => { if (reply !== null) output.emit('data', Buffer.from(reply)); child.emit('close', reply === null ? 1 : 0); }); });
    return child;
  };
}
test('AC-13 keychain read is injected, bounded, shell-free, env-whitelisted', async t => {
  const f = fixture(t); let calls = 0;
  const opts = { ...f.opts, platform: 'darwin' as const, config: { ...f.config, secret_source: 'keychain' as const }, keychain_setup_at: at,
    env: { HOME: f.dir, PATH: '/usr/bin', SHOULD_NOT_PASS: f.key, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    spawn: fakeSecurity(JSON.stringify(f.secret), (args, options, stdin) => { calls++; assert.deepEqual(args, ['find-generic-password', '-s', 'gbdev-notify', '-a', h12, '-w']); assert.equal(stdin, ''); assert.equal(options.shell, false); assert.equal(options.timeout, 3000); assert.deepEqual(options.env, { HOME: f.dir, PATH: '/usr/bin' }); f.safe(args); f.safe(options); }) };
  const r = await readSecret(opts); assert.equal(r.ok, true); assert.equal(calls, 1); assert.equal(r.secret_gen, `keychain:${at}`); f.safe(r);
  assert.equal((await readSecret({ ...opts, platform: 'linux', spawn: () => { throw new Error('must not call'); } })).reason, 'secret_unsupported');
  for (const spawn of [fakeSecurity(null), fakeSecurity('x'.repeat(4097)), (() => { throw new Error(f.key + f.url); }) as SecuritySpawn]) { const result = await readSecret({ ...opts, spawn }); assert.equal(result.problem, 'keychain_failed'); f.safe(result); }
});
test('S-N2 assertNoSecret refuses raw and JSON-escaped secrets without reflection', t => {
  const f = fixture(t);
  for (const text of [f.key, f.url, { message: f.key }, { url: f.url }]) assert.throws(() => assertNoSecret(text, f.secret), e => { f.safe(e); f.safe(serializeEnvelope(failureEnvelope('notify', e))); return true; });
  assert.throws(() => assertNoSecret({ x: 'quote"key' }, { url: f.url, key: 'quote"key' }));
  assertNoSecret({ endpoint_host: 'hooks.example.test' }, f.secret);
});
test('AC-13/28 static boundary: HTTP-only network and no secret env mutation', () => {
  for (const name of readdirSync('src', { recursive: true }) as string[]) {
    if (!name.endsWith('.ts') || name === 'notify/http.ts') continue;
    assert.doesNotMatch(readFileSync(join('src', name), 'utf8'), /node:(?:http|https|net|tls)\b|\bfetch\s*\(|XMLHttpRequest/);
  }
  for (const name of readdirSync('src/notify')) {
    const source = readFileSync(join('src/notify', name), 'utf8');
    if (name !== 'http.ts') assert.doesNotMatch(source, /node:(?:http|https|net|tls)\b|\bfetch\s*\(|XMLHttpRequest/);
    else { assert.match(source, /\bfetch\s*\(/); assert.doesNotMatch(source, /node:(?:http|https|net|tls)\b|XMLHttpRequest/); }
    assert.doesNotMatch(source, /process\.env(?:\[[^\]]+\]|\.\w+)\s*=|shell:\s*true|Object\.keys\(process\.env\)|JSON\.stringify\(process\.env\)/);
  }
});

test('AC-16 setup rejects non-TTY with exit 2 and no writes; CLI parser secrets redacted', async t => {
  const f = fixture(t); testEnv(t, f.paths);
  let out = '', err = '', reads = 0;
  const io = { stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; }, notifySetup: { isTTY: false, async readHidden() { reads++; return f.key; } } };
  assert.equal(await runCli(['notify', 'setup', '--json'], io), 2); assert.equal(JSON.parse(out).error.code, 'usage_error'); assert.equal(reads, 0); assert.equal(existsSync(f.paths.config), false); assert.equal(existsSync(join(f.paths.home, 'notify')), false); f.safe(out + err);
  out = ''; assert.equal(await runCli(['notify', 'setup', `--url=${f.url}`, '--json'], io), 2); f.safe(out);
  out = ''; assert.equal(await runCli(['notify', 'setup', f.key, '--json'], io), 2); f.safe(out);
});
test('AC-16 setup fake TTY writes 0600 and 0700, no echo, reusable envelope', async t => {
  const f = fixture(t); const target = join(f.dir, 'new-secrets', 'new.json'); f.writeConfig({ secret_file: target });
  testEnv(t, f.paths);
  let text = ''; const io = { stdout: (s: string) => { text += s; }, stderr: (s: string) => { text += s; }, notifySetup: f.setupIO };
  assert.equal(await runCli(['notify', 'setup', '--json'], io), 0); validateEnvelope(JSON.parse(text)); f.safe(text);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), f.secret); assert.equal(statSync(target).mode & 0o777, 0o600); assert.equal(statSync(dirname(target)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dirname(target)), ['new.json']); assert.equal(existsSync(join(f.paths.home, 'notify')), false);
  assert.match(text, /endpoint_host/); assert.match(text, /gbdev notify test/);
});
test('AC-16 setup failures do not echo injected exceptions or replace old secret', async t => {
  const f = fixture(t); f.writeConfig(); const before = readFileSync(f.file);
  for (const io of [{ isTTY: true, async readHidden() { throw new Error(f.key + f.url); } }, { isTTY: true, async readHidden() { return 'invalid\n' + f.key; } }, { isTTY: true, async readHidden() { throw new GbdevError('notify_unavailable', f.url, { leak: f.key }); } }]) {
    await assert.rejects(notifyCommand(f.paths, ['setup'], {}, io), e => { f.safe(e); f.safe(failureEnvelope('notify setup', e)); return true; });
    assert.deepEqual(readFileSync(f.file), before);
  }
  chmodSync(f.secrets, 0o755); await assert.rejects(notifyCommand(f.paths, ['setup'], {}, f.setupIO), code('notify_unavailable')); assert.deepEqual(readFileSync(f.file), before);
});
test('AC-16 setup keychain uses stdin only, verifies readback and records generation', async t => {
  const f = fixture(t); f.writeConfig(); let calls = 0;
  const spawn: SecuritySpawn = (command, args, opts) => fakeSecurity(args[0] === '-i' ? '' : JSON.stringify(f.secret), (argv, options, stdin) => { calls++; f.safe(argv); f.safe(options); if (argv[0] === '-i') { assert.match(stdin, /^add-generic-password /); assert.ok(stdin.includes(f.key)); } else assert.equal(stdin, ''); })(command, args, opts);
  const output = await notifyCommand(f.paths, ['setup'], { keychain: true }, f.setupIO, { platform: 'darwin', spawn, env: { HOME: f.dir } }); f.safe(output); assert.equal(calls, 2);
  const statePath = join(f.paths.home, 'notify', 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8')); f.safe(state); assert.equal(typeof state.keychain_setup_at, 'string'); assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f.paths.config, 'utf8')).notify.secret_source, 'keychain');
});
test('AC-16 failed keychain roundtrip leaves state and config unchanged', async t => {
  const f = fixture(t); f.writeConfig(); const before = readFileSync(f.paths.config);
  await assert.rejects(notifyCommand(f.paths, ['setup'], { keychain: true }, f.setupIO, { platform: 'darwin', spawn: fakeSecurity('{}') }), code('notify_unavailable'));
  assert.deepEqual(readFileSync(f.paths.config), before); assert.equal(existsSync(join(f.paths.home, 'notify', 'state.json')), false);
});
test('AC-37 enable merges options preserving all fields, disable changes only enabled', async t => {
  const f = fixture(t); f.writeConfig({ secret_file: f.file, home_label: 'mac-main', timeout_ms: 6000 }, { allowed_repos: [f.dir], future: { keep: [1, 2] }, dashboard: { enabled: false } });
  const before = JSON.parse(readFileSync(f.paths.config, 'utf8'));
  await notifyCommand(f.paths, ['enable'], { 'key-placement': 'body_field', 'key-name': 'sender_key', 'key-prefix': 'Bearer ' });
  const enabled = JSON.parse(readFileSync(f.paths.config, 'utf8')); assert.deepEqual(enabled, { ...before, notify: { ...before.notify, enabled: true, key_placement: 'body_field', key_name: 'sender_key', key_prefix: 'Bearer ' } });
  await notifyCommand(f.paths, ['disable'], {}); assert.deepEqual(JSON.parse(readFileSync(f.paths.config, 'utf8')), { ...enabled, notify: { ...enabled.notify, enabled: false } });
  assert.equal(readdirSync(f.dir).some(s => s.endsWith('.tmp')), false);
});
for (const [options, expected] of [[{}, 'key_name_missing'], [{ 'key-name': '' }, 'config_invalid'], [{ 'key-name': 'bad_name' }, 'config_invalid'], [{ 'key-placement': 'query', 'key-name': 'X-Key' }, 'config_invalid'], [{ 'key-name': 'X-Key', 'key-prefix': '\r\n' }, 'config_invalid']] as const) test(`AC-37 invalid enable is byte-preserving: ${JSON.stringify(options)}`, async t => {
  const f = fixture(t); f.writeConfig(); const before = readFileSync(f.paths.config);
  await assert.rejects(notifyCommand(f.paths, ['enable'], options), e => { f.safe(e); return code(expected)(e); }); assert.deepEqual(readFileSync(f.paths.config), before);
});
test('AC-37 CLI enable/disable help and flags; S4 commands registered, unknown commands rejected', async t => {
  const f = fixture(t); f.writeConfig(); testEnv(t, f.paths);
  let out = ''; const io = { stdout: (s: string) => { out += s; }, stderr: (s: string) => { out += s; } };
  assert.equal(await runCli(['notify', 'enable', '--key-name', 'X-Key', '--json'], io), 0); validateEnvelope(JSON.parse(out));
  out = ''; assert.equal(await runCli(['notify', 'disable', '--json'], io), 0); validateEnvelope(JSON.parse(out));
  for (const sub of ['unknown', 'send', 'initialize']) { out = ''; assert.equal(await runCli(['notify', sub, '--json'], io), 2); }
  for (const sub of ['status', 'flush']) { out = ''; assert.equal(await runCli(['notify', sub, '--json'], io), 0); validateEnvelope(JSON.parse(out)); }
  out = ''; assert.equal(await runCli(['notify', 'test', '--json'], io), 1); assert.equal(JSON.parse(out).error.code, 'notify_unavailable');
  out = ''; assert.equal(await runCli(['notify', 'ack', '--json'], io), 2);
  out = ''; await runCli(['help'], io); for (const sub of ['setup', 'enable', 'disable', 'status', 'test', 'flush', 'ack']) assert.ok(out.includes(`notify ${sub}`));
  out = ''; assert.equal(await runCli(['status', '--key-name', 'X-Key', '--json'], io), 2); f.safe(out);
});

test('AC-13 exact 4 KiB and 512-character key boundaries; forbidden secret schema URLs', async t => {
  const f = fixture(t), secret = { ...f.secret, key: 'x'.repeat(512) };
  const json = JSON.stringify(secret); writeFileSync(f.file, json + ' '.repeat(4096 - Buffer.byteLength(json)));
  assert.equal((await readSecret(f.opts)).ok, true);
  for (const url of ['https://@hooks.example.test/', 'https://hooks.example.test/#', 'http://127.0.0.1:1234/']) assert.throws(() => validateNotifySecret({ ...secret, url }));
  validateNotifySecret({ ...secret, url: 'http://127.0.0.1:1234/' }, { GBDEV_NOTIFY_TEST: '1' });
});
test('AC-13 special permission bits reject using injected metadata on platforms that strip setuid', async t => {
  const f = fixture(t), fs = await import('node:fs'), original = fs.default.lstatSync;
  t.mock.method(fs.default, 'lstatSync', (...args: Parameters<typeof original>) => { const result = original(...args); if (args[0] === f.file) Object.defineProperty(result, 'mode', { value: Number(result!.mode) | 0o4000 }); return result; });
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
  try { assert.equal((await readSecret(f.opts)).problem, 'mode_not_0600'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
test('AC-16 setup refuses a symlink target and forbidden repository location', async t => {
  const f = fixture(t), alias = join(f.secrets, 'alias'); symlinkSync(f.file, alias);
  const before = readFileSync(f.file); f.writeConfig({ secret_file: alias });
  await assert.rejects(notifyCommand(f.paths, ['setup'], {}, f.setupIO), code('notify_unavailable'));
  assert.deepEqual(readFileSync(f.file), before);
  f.writeConfig({ secret_file: f.file }, { allowed_repos: [f.dir] });
  await assert.rejects(notifyCommand(f.paths, ['setup'], {}, f.setupIO), code('notify_unavailable'));
  assert.deepEqual(readFileSync(f.file), before);
});
test('AC-16 keychain setup rotations strictly advance generation and retain other state fields', async t => {
  const f = fixture(t); f.writeConfig();
  const dir = join(f.paths.home, 'notify'); mkdirSync(dir, { mode: 0o700 });
  const statePath = join(dir, 'state.json'); writeFileSync(statePath, JSON.stringify({ keychain_setup_at: '2099-01-01T00:00:00.000+00:00', retained: 42 }), { mode: 0o600 });
  const spawn: SecuritySpawn = (command, args, options) => fakeSecurity(args[0] === '-i' ? '' : JSON.stringify(f.secret))(command, args, options);
  await notifyCommand(f.paths, ['setup'], { keychain: true }, f.setupIO, { platform: 'darwin', spawn });
  const state = JSON.parse(readFileSync(statePath, 'utf8')); assert.equal(state.retained, 42); assert.ok(Date.parse(state.keychain_setup_at) > Date.parse('2099-01-01T00:00:00.000+00:00')); f.safe(state);
});
test('AC-37 disable also validates merged config without changing bytes on failure', async t => {
  const f = fixture(t); f.writeConfig({ key_name: 'bad_name' }); const before = readFileSync(f.paths.config);
  await assert.rejects(notifyCommand(f.paths, ['disable'], {}), code('config_invalid')); assert.deepEqual(readFileSync(f.paths.config), before);
});
test('S1 secret callback serialization guard and static boundary hold for config errors', async t => {
  const f = fixture(t); const guarded = await readSecret(f.opts, secret => assertNoSecret({ message: secret.key }, secret));
  f.safe(guarded); assert.equal(guarded.problem, 'read_failed');
  f.writeConfig({ url: f.url, key: f.key });
  await assert.rejects(notifyCommand(f.paths, ['enable'], {}), e => { f.safe(e); f.safe(serializeEnvelope(failureEnvelope('notify enable', e))); return code('config_invalid')(e); });
});

// Emulate storage from the actual interactive stdin, not a prearranged read reply.
function memoryKeychain(home: string, account: string) {
  let stored = '', calls = 0;
  const spawn: SecuritySpawn = (command, args, options) => fakeSecurity(args[0] === '-i' ? '' : stored + '\n', (argv, opts, stdin) => {
    calls++; assert.equal(opts.shell, false); assert.deepEqual(opts.env, { HOME: home });
    if (argv[0] === '-i') {
      assert.deepEqual(argv, ['-i']);
      const prefix = `add-generic-password -U -s gbdev-notify -a ${account} -w `;
      assert.ok(stdin.startsWith(prefix)); stored = JSON.parse(stdin.slice(prefix.length));
    } else {
      assert.deepEqual(argv, ['find-generic-password', '-s', 'gbdev-notify', '-a', account, '-w']); assert.equal(stdin, '');
    }
  })(command, args, options);
  return { spawn, calls: () => calls };
}
for (const source of ['file', 'keychain'] as const) for (const key of ['test', 'notify', 'gbdev', 'host', 'hooks', 'hooks.example.test', 'example', 'keychain', '1', 'keychain_setup_at', '{}']) test(`AC-16 setup public-output key collision roundtrips: ${source}/${key}`, async t => {
  const f = fixture(t), secret = { ...f.secret, key }, account = identity(f.paths.home).h12;
  f.writeConfig(); const backend = memoryKeychain(f.dir, account);
  const deps = { platform: 'darwin' as const, spawn: backend.spawn, env: { HOME: f.dir } };
  const io = { isTTY: true, async readHidden(prompt: string) { return prompt.startsWith('Webhook') ? secret.url : secret.key; } };
  const out = await notifyCommand(f.paths, ['setup'], source === 'keychain' ? { keychain: true } : {}, io, deps);
  assert.deepEqual(out, { text: 'endpoint_host: hooks.example.test\n下一步执行 gbdev notify test\n' });
  assert.ok(!out.text.includes(secret.url));
  let read = false;
  const result = await readSecret({ ...f.opts, ...deps, home_id: account, config: validateNotify(JSON.parse(readFileSync(f.paths.config, 'utf8')).notify) }, actual => { read = true; assert.deepEqual(actual, secret); });
  assert.equal(result.ok, true); assert.equal(read, true); assert.equal(backend.calls(), source === 'keychain' ? 3 : 0);
  if (source === 'keychain') assert.deepEqual(await notifyCommand(f.paths, ['setup'], { keychain: true }, io, deps), out);
});
test('S-N2 setup output projection rejects URL, private key and extra fields', t => {
  const f = fixture(t);
  for (const fields of [{ endpoint_host: f.url }, { endpoint_host: f.key }, { endpoint_host: 'different.example.test' }, { endpoint_host: 'hooks.example.test', key: f.key }]) {
    assert.throws(() => setupOutput(fields, f.secret), e => { f.safe(serializeEnvelope(failureEnvelope('notify setup', e))); return code('notify_unavailable')(e); });
  }
});
test('S-N2 short keys are still blocked in arbitrary errors and envelopes', t => {
  const f = fixture(t);
  for (const key of ['test', 'notify', 'gbdev', 'hooks']) {
    const secret = { url: f.url, key }, error = new GbdevError('notify_unavailable', `Injected ${key}`, { reflected: key });
    for (const value of [error.message, error.contract, failureEnvelope('setup', error), serializeEnvelope(failureEnvelope('setup', error))]) assert.throws(() => assertNoSecret(value, secret), code('notify_unavailable'));
  }
});
test('S-N2 keychain state exposure check precedes all storage changes', async t => {
  const f = fixture(t); f.writeConfig();
  const dir = join(f.paths.home, 'notify'); mkdirSync(dir, { mode: 0o700 });
  const statePath = join(dir, 'state.json'); writeFileSync(statePath, JSON.stringify({ retained: f.key }), { mode: 0o600 });
  const before = [f.file, f.paths.config, statePath].map(path => readFileSync(path)); let calls = 0;
  await assert.rejects(notifyCommand(f.paths, ['setup'], { keychain: true }, f.setupIO, { platform: 'darwin', spawn: () => { calls++; throw new Error('must not call'); } }), e => { f.safe(serializeEnvelope(failureEnvelope('notify setup', e))); return e instanceof GbdevError && e.contract.code === 'notify_unavailable' && e.contract.details.reason === 'secret_unsafe'; });
  assert.equal(calls, 0); assert.deepEqual([f.file, f.paths.config, statePath].map(path => readFileSync(path)), before);
});
for (const source of ['file', 'keychain'] as const) for (const size of [4084, 4096, 4097]) test(`AC-16 setup exact serialized byte boundary: ${source}/${size}`, async t => {
  const f = fixture(t), target = join(f.dir, 'new-secrets', 'new.json'), account = identity(f.paths.home).h12;
  // Multibyte characters and JSON escapes ensure this tests bytes, not string length.
  const secret = { ...f.secret, url: 'https://hooks.example.test/路径/', key: 'quote"\\é' };
  secret.url += 'x'.repeat(size - Buffer.byteLength(JSON.stringify(secret) + '\n'));
  const expected = Buffer.from(JSON.stringify(secret) + '\n'); assert.equal(expected.length, size);
  if (size === 4084) { assert.equal(Buffer.byteLength(JSON.stringify(secret)), 4083); assert.equal(Buffer.byteLength(JSON.stringify(secret, null, 2) + '\n'), 4097); }
  f.writeConfig({ secret_file: target }); const before = readFileSync(f.paths.config), backend = memoryKeychain(f.dir, account);
  const deps = { platform: 'darwin' as const, spawn: backend.spawn, env: { HOME: f.dir } };
  const io = { isTTY: true, async readHidden(prompt: string) { return prompt.startsWith('Webhook') ? secret.url : secret.key; } };
  const setup = notifyCommand(f.paths, ['setup'], source === 'keychain' ? { keychain: true } : {}, io, deps);
  if (size > 4096) {
    await assert.rejects(setup, e => e instanceof GbdevError && e.contract.code === 'notify_unavailable' && e.contract.details.reason === 'secret_unsafe' && e.contract.details.problem === 'too_large');
    assert.equal(existsSync(dirname(target)), false); assert.equal(existsSync(join(f.paths.home, 'notify')), false); assert.equal(backend.calls(), 0); assert.deepEqual(readFileSync(f.paths.config), before);
  } else {
    await setup;
    if (source === 'file') { assert.deepEqual(readFileSync(target), expected); assert.equal(statSync(target).size, size); assert.deepEqual(readdirSync(dirname(target)), ['new.json']); }
    let read = false;
    const result = await readSecret({ ...f.opts, ...deps, home_id: account, config: validateNotify(JSON.parse(readFileSync(f.paths.config, 'utf8')).notify) }, actual => { read = true; assert.deepEqual(actual, secret); });
    assert.equal(result.ok, true); assert.equal(read, true);
  }
});
for (const invalid of ['http', 'userinfo', 'fragment', 'malformed', 'empty key', 'long key', 'control key'] as const) test(`AC-16 setup invalid input uses notify_unavailable: ${invalid}`, async t => {
  const f = fixture(t); f.writeConfig(); testEnv(t, f.paths);
  const url = invalid === 'http' ? f.url.replace('https:', 'http:') : invalid === 'userinfo' ? f.url.replace('https://', 'https://user:pass@') : invalid === 'fragment' ? f.url + '#' : invalid === 'malformed' ? 'bad-url-' + f.key : f.url;
  const key = invalid === 'empty key' ? '' : invalid === 'long key' ? 'x'.repeat(513) : invalid === 'control key' ? f.key + '\x85' : f.key;
  const before = [readFileSync(f.file), readFileSync(f.paths.config)]; let output = '';
  const io = { stdout: (s: string) => { output += s; }, stderr: (s: string) => { output += s; }, notifySetup: { isTTY: true, async readHidden(prompt: string) { return prompt.startsWith('Webhook') ? url : key; } } };
  assert.equal(await runCli(['notify', 'setup', '--json'], io), 1);
  const envelope = JSON.parse(output); validateEnvelope(envelope); assert.equal(envelope.contract_version, '1'); assert.equal(envelope.error.code, 'notify_unavailable');
  assert.deepEqual(envelope.error.details, invalid.endsWith('key') ? { reason: 'secret_unsafe', problem: 'key_invalid' } : { reason: 'url_invalid' });
  assertNoSecret(output, { url, key }); f.safe(output);
  assert.deepEqual([readFileSync(f.file), readFileSync(f.paths.config)], before); assert.equal(existsSync(join(f.paths.home, 'notify')), false); assert.deepEqual(readdirSync(f.secrets), ['notify.json']);
});


test('n1 secret validator distinguishes key, endpoint and unrelated schema failures', t => {
  const f = fixture(t);
  for (const [value, details] of [
    [{ ...f.secret, key: '' }, { reason: 'secret_unsafe', problem: 'key_invalid' }],
    [{ ...f.secret, url: 'http://invalid.test' }, { reason: 'url_invalid' }],
    [{ ...f.secret, extra: f.key }, { reason: 'secret_unsafe', problem: 'invalid_schema' }],
  ] as const) assert.throws(() => validateNotifySecret(value), e => { assert.ok(e instanceof GbdevError); assert.deepEqual(e.contract.details, details); f.safe(e); return true; });
});
test('n1 setup preserves non-key validator reason instead of rewriting key_invalid', async t => {
  const f = fixture(t); f.writeConfig(); const before = readFileSync(f.file);
  // Policy changes between setup precheck and the contract validator; no backend access.
  let reads = 0; const env = { get GBDEV_NOTIFY_TEST() { return ++reads === 1 ? '1' : '0'; } };
  const io = { isTTY: true, async readHidden(prompt: string) { return prompt.startsWith('Webhook') ? 'http://127.0.0.1:1234/' : f.key; } };
  await assert.rejects(notifyCommand(f.paths, ['setup'], {}, io, { env }), e => { assert.ok(e instanceof GbdevError); assert.equal(e.contract.code, 'notify_unavailable'); assert.deepEqual(e.contract.details, { reason: 'url_invalid' }); f.safe(e); return true; });
  assert.deepEqual(readFileSync(f.file), before);
});
test('n2 assertNoSecret includes classified safe errors for exposure and serialization', t => {
  const f = fixture(t); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [f.key, { key: f.key }, cyclic]) assert.throws(() => assertNoSecret(value, f.secret), e => { assert.ok(e instanceof GbdevError); assert.equal(e.contract.details.reason, 'secret_unsafe'); f.safe(serializeEnvelope(failureEnvelope('setup', e))); return true; });
});
