import './helpers/notifyGuard.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { temporary, job, result as jobResult } from './helpers.js';
import { testEnv } from './helpers/run.js';
import { fixture as runFixture, until } from './helpers/m3.js';
import { pipelineFixture } from './helpers/pipeline.js';
import { resolvePaths, jobPaths } from '../src/core/paths.js';
import { atomicWriteJson, JobStore } from '../src/core/jobStore.js';
import { locked } from '../src/core/runtime.js';
import { acquireLock } from '../src/core/lock.js';
import { localIso } from '../src/core/time.js';
import { NOTIFY_DEFAULTS } from '../src/core/notifyConfig.js';
import { runCli } from '../src/cli.js';
import { notifyAck, notifyTest, type NotifyActionOptions } from '../src/commands/notifyActions.js';
import { notifyStatus, notifyDiagnostic, inspectNotify, addNotify, notifyHintText } from '../src/notify/status.js';
import { readDeliveryState, retryAuth, updateDeliveryState } from '../src/notify/state.js';
import { deliver, readPendingNotices, type DeliveryOptions } from '../src/notify/deliver.js';
import { installNotifyTesting, notifyEvent, notifySupervisorStarted } from '../src/notify/enqueue.js';
import { launchDeliver } from '../src/notify/trigger.js';
import { validateNotifyPayload, type NotifyStatus, type NotifyTest } from '../src/contracts/notify.js';
import { validateEnvelope } from '../src/contracts/envelope.js';
import { checkNotifyExposure } from '../src/notify/exposure.js';
import { startRun } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { readRun, writeRun, runPaths } from '../src/run/store.js';

const env = { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1', GBDEV_NOTIFY: '' };
const success = { status: 202, error: null, retry_after_ms: null } as const;
const stamp = (n: number) => localIso(new Date(n));
type Stub = { url: string; requests: { body: Record<string, unknown> }[]; close(): Promise<void> };
const { startNotifyServer } = await import(pathToFileURL(resolve('test/fixtures/notify-server.js')).href) as { startNotifyServer(options: { responses?: object[] }): Promise<Stub> };
async function server(t: TestContext, responses: object[] = []) { const stub = await startNotifyServer({ responses }); t.after(() => stub.close()); return stub; }
function bytes(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  if (existsSync(dir)) for (const e of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, e.name); if (e.isDirectory()) for (const [key, value] of Object.entries(bytes(path))) entries[`${e.name}/${key}`] = value; else if (e.isFile()) entries[e.name] = readFileSync(path).toString('base64'); }
  return entries;
}
function setup(t: TestContext) {
  const root = temporary(t), paths = resolvePaths({ GBDEV_HOME: join(root, 'home'), GBDEV_CONFIG: join(root, 'config.json') });
  mkdirSync(paths.home); const dir = join(root, 'secrets'); mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, 'secret.json'), key = `GBDEVTESTKEY-${randomUUID()}`;
  let now = Date.now() + 1000, elapsed = 0, launches = 0;
  const config = { ...NOTIFY_DEFAULTS, enabled: true, key_name: 'X-Sender-Key', secret_file: file };
  const save = (patch: object = {}) => writeFileSync(paths.config, JSON.stringify({ version: 1, providers: { codex: { bin: join(root, 'missing') }, cursor: { bin: join(root, 'missing') } }, notify: { ...config, ...patch } })); save();
  const credentials = (url = 'http://127.0.0.1:1/unused') => { writeFileSync(file, JSON.stringify({ schema: 'gbdev.notify-secret.v1', url, key }), { mode: 0o600 }); chmodSync(file, 0o600); utimesSync(file, new Date(now - 1000), new Date(now - 1000)); }; credentials();
  const store = new JobStore(paths);
  t.after(installNotifyTesting(paths.home, { env, launch: () => { launches++; }, now: () => now }));
  testEnv(t, { GBDEV_HOME: paths.home, GBDEV_CONFIG: paths.config });
  const clock: DeliveryOptions = { env, now: () => now, monotonic: () => elapsed, sleep: async ms => { elapsed += ms; now += ms; }, post: async () => success };
  const options: NotifyActionOptions = { env, now: () => now, monotonic: () => elapsed, sleep: clock.sleep!, delivery: clock, launch: () => {} };
  const cli = async (args: string[], more: NotifyActionOptions = {}) => {
    let output = ''; const code = await runCli(['notify', ...args, '--json'], { stdout: s => { output += s; }, stderr: s => { output += s; }, notifyActions: { ...options, ...more } });
    const envelope = JSON.parse(output); validateEnvelope(envelope); assert.ok(!output.includes(key)); assert.ok(!output.includes(file)); assert.doesNotMatch(output, /https?:\/\//);
    if (envelope.result?.endpoint_host != null) assert.ok(!envelope.result.endpoint_host.includes('/'));
    return { code, envelope, output, result: envelope.result as NotifyStatus & Omit<NotifyTest, 'schema'> };
  };
  const enqueue = async (n = 1, count = 1) => { const id = `j_20261029_0930_${String(n).padStart(4, '0')}`; if (!existsSync(jobPaths(paths, id).job)) store.create(job(id)); await locked(store, () => { for (let i = 1; i <= count; i++) assert.equal(notifyEvent(store, { kind: 'job', id, state: 'succeeded' }, 'state_change', { state: 'succeeded' }, i, stamp(now)), true); }); };
  return { root, paths, store, dir, file, key, config, save, credentials, options, clock, cli, enqueue, now: () => now, advance: (ms: number) => { now += ms; elapsed += ms; }, launches: () => launches };
}

const initCases = [
  ['env', 'disabled', 'env_disabled'], ['tests', 'disabled', 'env_disabled'], ['disabled-existing', 'disabled', 'enable'],
  ['missing', 'not_configured', 'setup_secret'], ['unsafe', 'not_configured', 'setup_secret'], ['unsupported', 'not_configured', 'setup_secret'],
  ['key', 'not_configured', 'set_key_name'], ['configured', 'configured_unverified', 'run_test'], ['sent', 'test_sent', 'await_ack'],
  ['paused', 'paused', 'resume_paused'], ['verified', 'verified', null],
] as const;
for (const [mode, state, missing] of initCases) test(`AC-32 init ${mode}: ${state}/${missing}`, async t => {
  const f = setup(t); let options: NotifyActionOptions = {};
  if (mode === 'env') options = { env: { ...env, GBDEV_NOTIFY: '0' } };
  if (mode === 'tests') options = { env: { NODE_TEST_CONTEXT: 'child' } };
  if (mode === 'disabled-existing') f.save({ enabled: false });
  if (mode === 'missing') { rmSync(f.file); f.save({ enabled: false }); }
  if (mode === 'unsafe') chmodSync(f.file, 0o644);
  if (mode === 'unsupported') { f.save({ secret_source: 'keychain' }); options = { secret: { platform: 'linux' } }; }
  if (mode === 'key') f.save({ key_name: null });
  if (mode === 'sent' || mode === 'verified') await notifyTest(f.store, f.options);
  if (mode === 'verified') await notifyAck(f.store, readDeliveryState(f.paths.home).last_test!.notice_id, 'bot-a', f.options);
  if (mode === 'paused') { mkdirSync(join(f.paths.home, 'notify')); await updateDeliveryState(f.store, { paused: { reason: 'paused_auth_rejected', at: stamp(f.now()), http_status: 401 } }); }
  const out = await f.cli(['status', '--pending'], options); assert.equal(out.code, 0);
  assert.equal(out.result.init.state, state); assert.equal(out.result.init.missing_step, missing);
  assert.equal(out.result.init.configured, ['configured', 'sent', 'paused', 'verified'].includes(mode));
  const diagnostic = await notifyDiagnostic(f.paths, { ...f.options, ...options }); assert.match(diagnostic.detail, new RegExp(`init_state=${state}`));
  assert.equal(diagnostic.ok, ['env', 'tests', 'disabled-existing', 'missing', 'configured', 'sent', 'verified'].includes(mode));
  for (const bad of [f.root, f.file, f.key, 'http://', 'https://']) assert.ok(!JSON.stringify(out.result.init).includes(bad));
  if (mode === 'unsupported') {
    f.save({ enabled: false, secret_source: 'keychain' });
    const disabled = await f.cli(['status'], options); assert.equal(disabled.result.init.state, 'not_configured'); assert.equal(disabled.result.init.missing_step, 'setup_secret');
  }
});

test('S3 nit pure status scan preserves corrupt outbox/dead/state/log bytes', async t => {
  const f = setup(t); await f.enqueue(); const dir = join(f.paths.home, 'notify');
  writeFileSync(join(dir, 'outbox', '99-n_1111111111111111.json'), '{broken');
  mkdirSync(join(dir, 'dead')); writeFileSync(join(dir, 'dead', 'prior'), 'prior');
  await updateDeliveryState(f.store, { last_attempt_at: null }); writeFileSync(join(dir, 'notify.log'), 'prior log\n');
  const before = bytes(dir); const out = await f.cli(['status', '--pending']); assert.equal(out.result.pending, 1); assert.equal(out.result.pending_list!.length, 1);
  assert.deepEqual(bytes(dir), before); await notifyDiagnostic(f.paths, f.options); assert.deepEqual(bytes(dir), before);
});

test('AC-33 two immediate test notices are unique, uncoalesced, N22 persisted and envelope closed', async t => {
  const f = setup(t); await f.enqueue(); const pending = readPendingNotices(f.paths.home)[0]!;
  const received: unknown[] = []; const delivery = { ...f.clock, post: async (_secret: unknown, payload: Parameters<NonNullable<DeliveryOptions['post']>>[1]) => { received.push(payload); return success; } };
  const a = await f.cli(['test'], { delivery }), b = await f.cli(['test'], { delivery });
  assert.equal(a.code, 0); assert.equal(b.code, 0); assert.notEqual(a.result.notice_id, b.result.notice_id); assert.equal(a.result.awaiting_ack, true); assert.equal(b.result.seq, a.result.seq + 1);
  for (const raw of received) { const p = validateNotifyPayload(raw); assert.deepEqual([p.event, p.kind, p.unit_kind, p.unit_id, p.coalesced], ['test', 'test', null, null, 1]); }
  assert.deepEqual(readPendingNotices(f.paths.home), [pending]); assert.equal(f.launches(), 1, 'test bypasses trigger/debounce');
  const state = readDeliveryState(f.paths.home); assert.equal(state.last_test!.notice_id, b.result.notice_id); assert.equal(state.last_test!.http_status, 202); assert.equal(state.last_delivery!.event, 'test');
  const status = (await f.cli(['status'])).result; assert.equal(status.init.state, 'test_sent'); assert.equal(status.init.missing_step, 'await_ack');
  assert.throws(() => validateEnvelope({ ...b.envelope, result: { ...b.result, extra: 1 } }));
});

for (const reason of ['no_test', 'notice_mismatch', 'not_delivered', 'stale', 'bound_to_other_bot', 'bad_label']) test(`AC-34 ack ${reason} exit 1 and byte-identical state`, async t => {
  const f = setup(t); const sent = await notifyTest(f.store, f.options); let id = sent.notice_id, bot = 'bot-a';
  if (reason === 'no_test') await updateDeliveryState(f.store, { last_test: null });
  if (reason === 'notice_mismatch') id = 'n_1111111111111111';
  if (reason === 'not_delivered') await updateDeliveryState(f.store, { last_test: { ...readDeliveryState(f.paths.home).last_test!, delivered: false } });
  if (reason === 'stale') f.advance(86400001);
  if (reason === 'bound_to_other_bot') { await notifyAck(f.store, id, bot, f.options); bot = 'bot-b'; }
  if (reason === 'bad_label') bot = 'Bad/Label';
  const path = join(f.paths.home, 'notify', 'state.json'), before = readFileSync(path);
  const out = await f.cli(['ack', id, '--bot', bot]); assert.equal(out.code, 1); assert.equal(out.envelope.error.code, 'notify_ack_invalid'); assert.equal(out.envelope.error.details.reason, reason); assert.deepEqual(readFileSync(path), before);
});

test('AC-34/35 ack idempotence, rotation unbinds, pause/resume preserves generation verification', async t => {
  const f = setup(t), sent = await notifyTest(f.store, f.options);
  const ack = await f.cli(['ack', sent.notice_id, '--bot', 'bot-a']); assert.equal(ack.code, 0);
  const path = join(f.paths.home, 'notify', 'state.json'), before = readFileSync(path); f.advance(1000);
  assert.equal((await f.cli(['ack', sent.notice_id, '--bot', 'bot-a'])).output, ack.output); assert.deepEqual(readFileSync(path), before);
  assert.equal((await f.cli(['status'])).result.init.verified_by_bot, 'bot-a');
  await updateDeliveryState(f.store, { paused: { reason: 'paused_auth_rejected', at: stamp(f.now()), http_status: 401 } });
  let status = (await f.cli(['status'])).result; assert.equal(status.init.state, 'paused'); assert.equal(status.init.missing_step, 'resume_paused');
  await retryAuth(f.store); assert.equal((await f.cli(['status'])).result.init.state, 'verified');
  f.advance(2000); f.credentials(); const rotatedBytes = bytes(join(f.paths.home, 'notify'));
  status = (await f.cli(['status'])).result;
  assert.deepEqual(bytes(join(f.paths.home, 'notify')), rotatedBytes);
  assert.equal(status.init.state, 'configured_unverified'); assert.deepEqual([status.init.verified_at, status.init.verified_notice_id, status.init.verified_by_bot], [null, null, null]);
  assert.equal((await f.cli(['ack', sent.notice_id, '--bot', 'bot-b'])).envelope.error.details.reason, 'stale');
  const next = await notifyTest(f.store, f.options); assert.equal((await f.cli(['ack', next.notice_id, '--bot', 'bot-b'])).code, 0);
  assert.equal((await f.cli(['status'])).result.init.verified_by_bot, 'bot-b');
});

for (const status of [401, 404, 302]) test(`flush --retry-auth resumes HTTP ${status} with CLI status envelope`, async t => {
  const f = setup(t); await f.enqueue(); await deliver(f.store, { ...f.clock, post: async () => ({ ...success, status }) });
  let delivery: Promise<void> | undefined;
  const out = await f.cli(['flush', '--retry-auth', '--wait-ms', '10000'], { launch: () => { delivery = deliver(f.store, f.clock); }, sleep: async () => { await delivery; } });
  assert.equal(out.code, 0); assert.equal(out.result.pending, 0); assert.equal(out.result.paused, null);
});

test('notify test waits at most 5 seconds for deliver.lock with fake clock and no POST', async t => {
  const f = setup(t); mkdirSync(join(f.paths.home, 'notify'));
  await updateDeliveryState(f.store, { last_error: { class: 'network', http_status: null, at: stamp(f.now() - 1000) } });
  const lock = acquireLock(join(f.paths.home, 'notify', 'deliver.lock')); t.after(() => lock.release());
  const start = f.now(); const out = await f.cli(['test'], { delivery: { ...f.clock, post: async () => assert.fail('lock held') } });
  assert.equal(out.code, 1); assert.equal(out.envelope.error.details.class, 'timeout'); assert.equal(f.now() - start, 5000);
  assert.equal(readDeliveryState(f.paths.home).last_test!.delivered, false); assert.equal(readPendingNotices(f.paths.home)[0]!.meta.attempts, 0);
});

for (const classification of ['network', 'timeout', 'tls', 'secret', 'oversize', 'http_retryable'] as const) test(`notify test failure ${classification} returns exit 1 and details.class`, async t => {
  const f = setup(t); mkdirSync(join(f.paths.home, 'notify'));
  await updateDeliveryState(f.store, { last_error: { class: 'rejected', http_status: 422, at: stamp(f.now() - 1000) } });
  const out = await f.cli(['test'], { delivery: { ...f.clock, post: async () => ({ status: classification === 'http_retryable' ? 500 : null, error: classification === 'http_retryable' ? null : classification, retry_after_ms: null }) } });
  assert.equal(out.code, 1); assert.equal(out.envelope.error.code, 'notify_unavailable'); assert.equal(out.envelope.error.details.class, classification); assert.equal(readDeliveryState(f.paths.home).last_test!.delivered, false);
  const state = readDeliveryState(f.paths.home); assert.equal(state.last_error_notice_id, state.last_test!.notice_id);
  if (classification === 'network') assert.equal(readPendingNotices(f.paths.home)[0]!.meta.attempts, 1);
  if (classification === 'secret') assert.equal(readPendingNotices(f.paths.home)[0]!.meta.attempts, 0);
  if (classification === 'secret') for (const invalid of [null, [], { version: 99 }, '{broken']) {
    writeFileSync(f.paths.config, typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
    const failed = await f.cli(['test']); assert.equal(failed.code, 1); assert.equal(failed.envelope.error.code, 'notify_unavailable'); assert.equal(failed.envelope.error.details.class, 'secret');
  }
});

test('flush timeout and usage bounds; help contains public commands but not delivery command', async t => {
  const f = setup(t); await f.enqueue(); const start = f.now(); const out = await f.cli(['flush', '--wait-ms', '60000']);
  assert.equal(out.code, 0); assert.equal(out.result.pending, 1); assert.equal(f.now() - start, 60000);
  for (const args of [['flush', '--wait-ms', '60001'], ['flush', '--wait-ms', '-1'], ['flush', '--wait-ms', 'NaN'], ['ack', 'n_1111111111111111'], ['status', '--retry-auth'], ['test', '--pending']]) assert.equal((await f.cli(args)).code, 2);
  let text = ''; await runCli(['help'], { stdout: s => { text += s; }, stderr: () => {} });
  for (const name of ['status', 'test', 'flush', 'ack']) assert.ok(text.includes(`notify ${name}`)); assert.ok(!text.includes('__notify-deliver'));
});

test('AC-26 CLI flush recovers six offline notices, coalesces three units and empties outbox', async t => {
  const f = setup(t), offline = await server(t); f.credentials(offline.url); await offline.close();
  for (let n = 1; n <= 3; n++) await f.enqueue(n, 2);
  let elapsed = 0;
  await deliver(f.store, { env, now: f.now, monotonic: () => elapsed, random: () => .5, sleep: async ms => { elapsed += ms; f.advance(ms); } });
  assert.equal(readPendingNotices(f.paths.home).length, 6);
  const stub = await server(t); f.credentials(stub.url); let pending: Promise<void> | undefined;
  const out = await f.cli(['flush', '--wait-ms', '10000'], { launch: () => { pending = deliver(f.store, ((({ post: _post, ...clock }) => clock)(f.clock))); }, sleep: async () => { await pending; } });
  assert.equal(out.code, 0); assert.equal(out.result.pending, 0); assert.deepEqual(stub.requests.map(r => [r.body.seq, r.body.coalesced]), [[2, 2], [4, 2], [6, 2]]);
});

test('supervisor startup immediately replays pending inside enqueue debounce window; disabled creates nothing', async t => {
  const f = setup(t); await f.enqueue(); notifySupervisorStarted(f.store); assert.equal(f.launches(), 2);
  notifySupervisorStarted(f.store); assert.equal(f.launches(), 3);
  f.save({ enabled: false }); notifySupervisorStarted(f.store); assert.equal(f.launches(), 3);
});

test('doctor notify enabled is independent of verification; old pending and unsafe secret fail', async t => {
  const f = setup(t); assert.equal((await notifyDiagnostic(f.paths, f.options)).ok, true);
  await f.enqueue(); f.advance(3600000); const old = await notifyDiagnostic(f.paths, f.options); assert.equal(old.ok, false); assert.match(old.detail, /pending_too_old/);
  chmodSync(f.file, 0o644); const unsafe = await notifyDiagnostic(f.paths, f.options); assert.equal(unsafe.ok, false); assert.match(unsafe.detail, /secret_unsafe/);
});

test('AC-27 start projection keeps M1-M4 existing fields byte-for-byte and human hints', async t => {
  const f = setup(t); testEnv(t, env);
  for (const value of [job(), JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8')), { schema: 'gbdev.pipeline-run.v1', pipeline_id: 'p_20261029_0930_ab12', state: 'queued', dashboard: { enabled: false } }]) {
    const before = JSON.stringify(value), output = await addNotify(f.paths, value), { notify, ...rest } = output;
    assert.equal(JSON.stringify(rest), before); assert.equal(JSON.stringify(output).slice(0, before.length - 1), before.slice(0, -1));
    assert.deepEqual(notify, { enabled: true, reason: null, endpoint_host: '127.0.0.1' }); assert.equal(notifyHintText(output), '完成或需要决定时将通知控制器（127.0.0.1）\n');
  }
  f.save({ enabled: false }); assert.equal(notifyHintText(await addNotify(f.paths, {})), '通知未开启（disabled_by_config）\n');
});

test('AC-27 job/pipeline/run start CLI include notify without persisting hints; doctor disabled ok', async t => {
  const f = pipelineFixture(t); t.after(() => rmSync(f.root, { recursive: true, force: true })); f.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT; f.env.GBDEV_NOTIFY_TEST = ''; f.env.GBDEV_NOTIFY = '0';
  const initial = await f.command(['start', '--brief', f.briefFile]); assert.equal(initial.exit, 0); const j = (initial.envelope as { result: ReturnType<typeof job> & { notify: unknown } }).result;
  assert.ok(j.notify); await f.waitJob(j.job_id); assert.ok(!('notify' in f.getJob(j.job_id)));
  const started = await f.launch(); const p = (started.envelope as { result: { pipeline_id: string; notify: unknown } }).result;
  assert.ok(p.notify); await f.wait(p.pipeline_id); assert.ok(!('notify' in f.read(p.pipeline_id)));
  const rawConfig = JSON.parse(readFileSync(f.config, 'utf8')); rawConfig.providers = { codex: { bin: join(f.root, 'missing') }, cursor: { bin: join(f.root, 'missing') } }; writeFileSync(f.config, JSON.stringify(rawConfig));
  const doctor = await f.command(['doctor']); const checks = (doctor.envelope as { result: { checks: { name: string; ok: boolean; detail: string }[] } }).result.checks;
  const check = checks.find(c => c.name === 'notify')!; assert.equal(check.ok, true); assert.match(check.detail, /disabled \(disabled_by_env\); controller falls back to polling; init_state=disabled/);
  const r = runFixture(t); testEnv(t, { GBDEV_HOME: r.paths.home, GBDEV_CONFIG: r.paths.config, GBDEV_NOTIFY: '0' });
  const request = join(r.root, 'request.json'); writeFileSync(request, JSON.stringify(r.request)); let output = '';
  assert.equal(await runCli(['run', 'start', '--request', request, '--json'], { stdout: s => { output += s; }, stderr: () => {} }), 0);
  const startedRun = JSON.parse(output); validateEnvelope(startedRun);
  const runId = startedRun.result.run_id;
  try {
    assert.equal(startedRun.result.notify.reason, 'disabled_by_env');
    assert.ok(!('notify' in readRun(r.store, runId)));
    await until(() => readRun(r.store, runId).supervisor_pid === null, 20000);
    assert.equal(await runCli(['run', 'wait', runId, '--timeout-ms', '60000', '--json'], { stdout: () => {}, stderr: () => {} }), 0);
  } finally { const pid = readRun(r.store, runId).supervisor_pid; if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* This test's detached supervisor already exited. */ } } }
});

test('AC-28 static network/env/shell boundaries and provider argv safety', t => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const path of walk('src')) {
    const source = readFileSync(path, 'utf8');
    if (path !== 'src/notify/http.ts') assert.doesNotMatch(source, /\bfetch\s*\(|node:(?:http|https|net|tls)\b|XMLHttpRequest/, path);
    if (path.startsWith('src/notify/')) assert.doesNotMatch(source, /process\.env(?:\[[^\]]+\]|\.\w+)\s*=(?!=)|Object\.keys\(process\.env\)|JSON\.stringify\(process\.env\)|shell:\s*true/, path);
    for (const forbidden of ['--dangerously-' + 'bypass-approvals-and-sandbox', '--sandbox' + ' disabled']) assert.ok(!source.includes(forbidden), path);
  }
  // Provider argv behavior is verified directly, independent of repository history.
  const root = temporary(t);
  // Run the compiled safety-argv.test.ts suite using this exact Node, with local provider stubs only.
  const safety = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./safety-argv.test.js', import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, GBDEV_HOME: join(root, 'home'), GBDEV_CONFIG: join(root, 'config.json'), GBDEV_NOTIFY: '0' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.ifError(safety.error); assert.equal(safety.status, 0, safety.stdout + safety.stderr);
  assert.match(safety.stdout, /# tests 10\b/); assert.match(safety.stdout, /# fail 0\b/);
});

test('AC-29 default-process fetch sentinel is installed and never invoked', () => {
  const script = `const original = globalThis.fetch; const module = await import(${JSON.stringify(pathToFileURL(resolve('dist/src/notify/http.js')).href)}); if (globalThis.fetch === original || module.notifyFetchSentinelCalls() !== 0) process.exitCode = 1;`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '' }, encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
});

for (const field of ['diff', 'final', 'summary']) test(`AC-17 ${field} exposure is deduplicated, health/warning never carry key`, async t => {
  const f = setup(t), unit = job(); f.store.create(unit); const paths = jobPaths(f.paths, unit.job_id), result = jobResult();
  writeFileSync(paths.diff, field === 'diff' ? f.key : 'clean'); writeFileSync(paths.finalMessage, field === 'final' ? f.key : 'clean');
  if (field === 'summary') result.worker_reported!.summary = f.key;
  await checkNotifyExposure(f.store, unit, result, f.options); await checkNotifyExposure(f.store, unit, result, f.options);
  const events = readFileSync(paths.events, 'utf8').trim().split('\n').map(s => JSON.parse(s)); assert.equal(events.filter(e => e.data?.code === 'notify_secret_exposed').length, 1);
  const notices = readPendingNotices(f.paths.home); assert.equal(notices.length, 1); assert.equal(notices[0]!.event, 'health'); assert.equal(notices[0]!.kind, 'notify_secret_exposed'); validateNotifyPayload((({ meta: _meta, ...p }) => p)(notices[0]!));
  assert.ok(!JSON.stringify([events, notices]).includes(f.key)); assert.equal(f.store.read(unit.job_id).state, unit.state);
});

for (const mode of ['hang', '500', 'refused']) test(`AC-9 ${mode}: fake run.json/events/CLI exit codes match disabled baseline, heartbeat <=35s`, { timeout: 60000 }, async t => {
  let baseline: unknown;
  for (const enabled of [false, true]) await t.test(enabled ? 'enabled' : 'disabled', async t => {
    const f = runFixture(t); f.request.tasks = f.request.tasks!.slice(0, 1); f.request.lanes = 1;
    const stub = await server(t, mode === 'hang' ? [{ mode: 'hang' }] : [{ status: 500 }]); if (mode === 'refused') await stub.close();
    const dir = join(f.root, 'secrets'); mkdirSync(dir, { mode: 0o700 }); const file = join(dir, 'secret.json');
    writeFileSync(file, JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: stub.url, key: `GBDEVTESTKEY-${randomUUID()}` }), { mode: 0o600 });
    const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.notify = { enabled, key_name: 'X-Key', secret_file: file, timeout_ms: 1000 }; writeFileSync(f.paths.config, JSON.stringify(config));
    testEnv(t, { ...env, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config, GBDEV_DASHBOARD: '0' });
    let work: Promise<void> | undefined;
    t.after(installNotifyTesting(f.paths.home, { env, launch: () => {
      if (!work) { const targetNoticeId = readPendingNotices(f.paths.home)[0]?.notice_id; if (targetNoticeId) work = deliver(f.store, { env, targetNoticeId }); }
    } }));
    t.after(async () => { await work; });
    // An unrelated pending bell exercises a hanging deliverer during the entire run.
    await locked(f.store, () => notifyEvent(f.store, null, 'test', {}, randomUUID(), stamp(Date.now())));
    f.savePlan(); const initial = await startRun(f.store, f.request, false); let heartbeat = Date.now(), maxGap = 0;
    await superviseRun(f.store, initial.run_id, { beforePublish: () => { const now = Date.now(); maxGap = Math.max(maxGap, now - heartbeat); heartbeat = now; } });
    assert.ok(maxGap <= 35000); await work; const run = readRun(f.store, initial.run_id); assert.equal(run.state, 'succeeded');
    if (enabled) { assert.equal(readDeliveryState(f.paths.home).last_error?.class, mode === 'hang' ? 'timeout' : mode === '500' ? 'http_retryable' : 'network'); }
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v: unknown) => ['supervisor_pid', 'heartbeat_at'].includes(key) ? null : typeof v === 'string' ? v.replaceAll(f.root, '<root>').replace(/[jpr]_\d{8}_\d{4}_[a-f0-9]{4}/g, '<id>').replace(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)/g, '<time>').replace(/\b[a-f0-9]{40}\b/g, '<sha>') : v));
    const events = readFileSync(runPaths(f.store, run.run_id).events, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    const warnings = events.filter(e => e.type === 'warning' && e.data.code === 'notify_unavailable'); assert.ok(warnings.length <= 1);
    const exitCodes = [];
    for (const command of ['status', 'wait', 'result', 'cancel']) { let output = ''; const code = await runCli(['run', command, run.run_id, ...(command === 'wait' ? ['--timeout-ms', '0'] : []), '--json'], { stdout: s => { output += s; }, stderr: () => {} }); assert.equal(code, 0, output); exitCodes.push(code); }
    const evidence = { run: normalize(readRun(f.store, run.run_id)), events: normalize(events.filter(e => !warnings.includes(e)).map(({ seq: _seq, ...e }) => e)), exitCodes };
    if (!enabled) baseline = evidence; else assert.deepEqual(evidence, baseline);
  });
});

test('AC-12 full fake run worker/gbdev env, ps argv, disk, CLI and doctor are sentinel-free', { timeout: 60000 }, async t => {
  const f = runFixture(t); f.request.tasks = f.request.tasks!.slice(0, 1); f.request.lanes = 1;
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'snapshot_process' }, { type: 'write_file', path: 'src/a.txt', content: 'a\n' }] }; f.fakePlan['review#1'] = { scenario: 'review_approve', actions: [{ type: 'snapshot_process' }] };
  const stub = await server(t), key = `GBDEVTESTKEY-${randomUUID()}`, dir = join(f.root, 'secrets'); mkdirSync(dir, { mode: 0o700 }); const file = join(dir, 'secret.json');
  writeFileSync(file, JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: stub.url, key }), { mode: 0o600 });
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.notify = { enabled: true, key_name: 'X-Key', secret_file: file }; writeFileSync(f.paths.config, JSON.stringify(config));
  testEnv(t, { ...env, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config, GBDEV_DASHBOARD: '0' }); t.after(installNotifyTesting(f.paths.home, { env, launch: () => {} }));
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded');
  const processInfo = readdirSync(f.paths.jobs).map(id => join(f.paths.jobs, id, 'test-process.json')).filter(path => existsSync(path)); assert.ok(processInfo.length >= 2);
  for (const value of [JSON.stringify(process.env), JSON.stringify(process.argv), ...processInfo.map(path => readFileSync(path, 'utf8'))]) { assert.ok(!value.includes(key)); assert.ok(!value.includes(stub.url)); }
  for (const args of [['notify', 'status', '--pending'], ['notify', 'test'], ['notify', 'flush', '--wait-ms', '10000'], ['notify', 'ack', 'n_1111111111111111', '--bot', 'BadLabel'], ['doctor']]) {
    let output = '', delivering: Promise<void> | undefined;
    const code = await runCli([...args, '--json'], { stdout: s => { output += s; }, stderr: s => { output += s; }, notifyActions: { env, launch: () => { delivering = deliver(f.store, { env }); }, sleep: async () => { await delivering; } } });
    assert.equal(code, args[1] === 'ack' ? 1 : 0, output); assert.ok(!output.includes(key)); assert.ok(!output.includes(stub.url)); assert.ok(!output.includes(file)); assert.doesNotMatch(output, /https?:\/\//);
    const envelope = JSON.parse(output); validateEnvelope(envelope);
    if (envelope.result?.endpoint_host != null) assert.ok(!envelope.result.endpoint_host.includes('/'));
  }
  // Every file under GBDEV_HOME, including worker capture, events/logs/index/archives.
  for (const value of Object.values(bytes(f.paths.home))) assert.ok(!Buffer.from(value, 'base64').toString('utf8').includes(key));
  const ps = spawnSync('ps', ['-ww', '-p', String(process.pid), '-o', 'command='], { encoding: 'utf8' }); if (ps.error) throw ps.error; assert.equal(ps.status, 0); assert.ok(!ps.stdout.includes(key)); assert.ok(!ps.stdout.includes(stub.url));
});

test('AC-17 fake worker exposure in diff/final/summary survives run publishing, exactly one health', { timeout: 60000 }, async t => {
  const f = runFixture(t); f.request.tasks = f.request.tasks!.slice(0, 1); f.request.tasks![0]!.file_scope = ['src/**']; f.request.lanes = 1;
  const key = `GBDEVTESTKEY-${randomUUID()}`, dir = join(f.root, 'secrets'); mkdirSync(dir, { mode: 0o700 }); const file = join(dir, 'secret.json');
  writeFileSync(file, JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: 'http://127.0.0.1:1/unused', key }), { mode: 0o600 });
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.notify = { enabled: true, key_name: 'X-Key', secret_file: file }; writeFileSync(f.paths.config, JSON.stringify(config));
  testEnv(t, { ...env, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config }); t.after(installNotifyTesting(f.paths.home, { env, launch: () => {} }));
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'notify_exposure', file }] };
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded');
  const exposed = readdirSync(f.paths.jobs).filter(id => readFileSync(jobPaths(f.paths, id).finalMessage, 'utf8').includes(key)); assert.equal(exposed.length, 1);
  const paths = jobPaths(f.paths, exposed[0]!); assert.ok(readFileSync(paths.diff, 'utf8').includes(key));
  assert.ok(readFileSync(paths.result, 'utf8').includes(key), 'N20 detects but does not rewrite worker evidence');
  assert.ok(run.warnings.includes(`notify_secret_exposed:${exposed[0]}`));
  const events = readFileSync(paths.events, 'utf8'); assert.equal(events.split('\n').filter(s => s.includes('notify_secret_exposed')).length, 1); assert.ok(!events.includes(key));
  const notices = readPendingNotices(f.paths.home); assert.equal(notices.filter(p => p.event === 'health' && p.kind === 'notify_secret_exposed').length, 1); assert.ok(!JSON.stringify(notices).includes(key));
  await checkNotifyExposure(f.store, f.store.read(exposed[0]!), JSON.parse(readFileSync(paths.result, 'utf8')), { env });
  assert.equal(readPendingNotices(f.paths.home).filter(p => p.event === 'health').length, 1);
});

test('S3 HTTP-secret rollback also preserves an initially absent last_attempt_at', async t => {
  const f = setup(t); await f.enqueue(); const before = readPendingNotices(f.paths.home)[0]!;
  await deliver(f.store, { ...f.clock, post: async () => ({ status: null, error: 'secret', retry_after_ms: null }) });
  assert.deepEqual(readPendingNotices(f.paths.home)[0], before); assert.equal(readDeliveryState(f.paths.home).last_attempt_at, undefined);
});

test('AC-35 old test timestamp cannot verify rotated file even in legacy S3 state', async t => {
  const f = setup(t); await notifyTest(f.store, f.options); const path = join(f.paths.home, 'notify', 'state.json');
  const state = readDeliveryState(f.paths.home); delete state.last_test_secret_gen; atomicWriteJson(path, state);
  assert.equal((await notifyStatus(f.paths, false, f.options)).init.state, 'test_sent');
  const prior = (await inspectNotify(f.paths, f.options)).secret.secret_gen;
  f.advance(3000); f.credentials(); assert.notEqual((await inspectNotify(f.paths, f.options)).secret.secret_gen, prior);
  const before = bytes(join(f.paths.home, 'notify'));
  assert.equal((await notifyStatus(f.paths, false, f.options)).init.state, 'configured_unverified');
  assert.deepEqual(bytes(join(f.paths.home, 'notify')), before);
});

test('AC-35 keychain setup generation invalidates verification and test without real security', async t => {
  const f = setup(t); f.save({ secret_source: 'keychain' }); mkdirSync(join(f.paths.home, 'notify'));
  await updateDeliveryState(f.store, { keychain_setup_at: stamp(f.now() - 1000) });
  const secret: NonNullable<DeliveryOptions['secret']> = { platform: 'darwin', spawn: (_command, args, opts) => {
    assert.ok(!JSON.stringify([args, opts]).includes(f.key)); const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough(), stdout = new PassThrough(); Object.assign(child, { stdin, stdout, kill: () => true });
    stdin.on('finish', () => queueMicrotask(() => { stdout.emit('data', Buffer.from(readFileSync(f.file, 'utf8'))); child.emit('close', 0); })); return child;
  } };
  const options = { ...f.options, secret, delivery: { ...f.clock, secret } };
  const sent = await notifyTest(f.store, options); await notifyAck(f.store, sent.notice_id, 'bot-a', options);
  assert.equal((await notifyStatus(f.paths, false, options)).init.state, 'verified');
  await updateDeliveryState(f.store, { keychain_setup_at: stamp(f.now() + 1) });
  const before = bytes(join(f.paths.home, 'notify'));
  const status = await notifyStatus(f.paths, false, options); assert.equal(status.init.state, 'configured_unverified'); assert.equal(status.init.verified_by_bot, null);
  assert.deepEqual(bytes(join(f.paths.home, 'notify')), before);
});

test('older queued test delivery never overwrites a newer last_test', async t => {
  const f = setup(t); const lock = acquireLock(join(f.paths.home, 'notify', 'deliver.lock'));
  try { assert.equal((await f.cli(['test'])).code, 1); } finally { lock.release(); }
  const old = readPendingNotices(f.paths.home)[0]!;
  const latest = await notifyTest(f.store, f.options); await deliver(f.store, { ...f.clock, targetNoticeId: old.notice_id });
  assert.equal(readDeliveryState(f.paths.home).last_test!.notice_id, latest.notice_id);
  assert.equal((await f.cli(['ack', old.notice_id, '--bot', 'bot-a'])).envelope.error.details.reason, 'notice_mismatch');
});

test('status rejects unsafe public projection without reflecting state or key material', async t => {
  const f = setup(t); await f.enqueue(); await updateDeliveryState(f.store, { verified_at: f.key, verified_secret_gen: (await inspectNotify(f.paths, f.options)).secret.secret_gen });
  const out = await f.cli(['status']); assert.equal(out.code, 1); assert.equal(out.envelope.error.code, 'notify_unavailable');
});

for (const kind of ['job', 'pipeline', 'run'] as const) test(`supervisor ${kind} entry launches pre-existing outbox with injected launch`, async t => {
  const f = setup(t); await f.enqueue();
  // Entry validation then fails for this deliberately absent unit, avoiding any worker launch.
  if (kind === 'job') { const { superviseJob } = await import('../src/core/supervise.js'); await assert.rejects(superviseJob('j_20261029_0930_ab12', f.store)); }
  else if (kind === 'pipeline') { const { supervisePipeline } = await import('../src/pipeline/supervisor.js'); await assert.rejects(supervisePipeline(f.store, 'p_20261029_0930_ab12')); }
  else await assert.rejects(superviseRun(f.store, 'r_20261029_0930_ab12'));
  assert.equal(f.launches(), 2);
});

test('N20 different jobs with identical warning seq retain distinct parent health identities', async t => {
  const f = setup(t), run = JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8'));
  mkdirSync(runPaths(f.store, run.run_id).dir, { recursive: true }); atomicWriteJson(runPaths(f.store, run.run_id).run, run); writeFileSync(runPaths(f.store, run.run_id).events, '');
  for (const suffix of ['0001', '0002']) {
    const unit = { ...job(`j_20261029_0930_${suffix}`), run_id: run.run_id }; f.store.create(unit); const paths = jobPaths(f.paths, unit.job_id);
    writeFileSync(paths.finalMessage, f.key); writeFileSync(paths.diff, 'clean');
    await checkNotifyExposure(f.store, unit, jobResult(), f.options); await checkNotifyExposure(f.store, unit, jobResult(), f.options);
  }
  const notices = readPendingNotices(f.paths.home); assert.equal(notices.length, 2); assert.notEqual(notices[0]!.notice_id, notices[1]!.notice_id);
  assert.ok(notices.every(p => p.unit_id === run.run_id && p.event === 'health')); assert.equal(readRun(f.store, run.run_id).warnings.filter(w => w.startsWith('notify_secret_exposed:')).length, 2);
  await locked(f.store, () => writeRun(f.store, run)); // stale supervisor snapshot
  assert.equal(readRun(f.store, run.run_id).warnings.filter(w => w.startsWith('notify_secret_exposed:')).length, 2);
});

test('test lock handoff never sleeps through a competing deliverer retry schedule', async t => {
  const f = setup(t); await f.enqueue(); const p = readPendingNotices(f.paths.home)[0]!;
  p.meta.attempts = 1; p.meta.next_at = stamp(f.now() + 1800000); atomicWriteJson(join(f.paths.home, 'notify', 'outbox', `${p.seq}-${p.notice_id}.json`), p);
  await deliver(f.store, { ...f.clock, targetNoticeId: p.notice_id, sleep: async () => assert.fail('synchronous test must not wait for retry'), post: async () => assert.fail('already attempted') });
  assert.deepEqual(readPendingNotices(f.paths.home)[0], p);
});

test('doctor disabled remains ok with corrupt historic notify state and does not repair it', async t => {
  const f = setup(t); await f.enqueue(); f.save({ enabled: false }); const path = join(f.paths.home, 'notify', 'state.json'); writeFileSync(path, '{broken');
  const before = bytes(join(f.paths.home, 'notify'));
  const check = await notifyDiagnostic(f.paths, f.options); assert.equal(check.ok, true); assert.match(check.detail, /disabled \(disabled_by_config\)/);
  assert.deepEqual(bytes(join(f.paths.home, 'notify')), before);
});

test('test failure never reflects an untrusted persisted error class', async t => {
  const f = setup(t); mkdirSync(join(f.paths.home, 'notify'));
  atomicWriteJson(join(f.paths.home, 'notify', 'state.json'), { last_error: { class: f.key, http_status: null, at: stamp(f.now()) } });
  const lock = acquireLock(join(f.paths.home, 'notify', 'deliver.lock')); t.after(() => lock.release());
  const out = await f.cli(['test']); assert.equal(out.code, 1); assert.equal(out.envelope.error.details.class, 'secret');
});

for (const binding of [null, undefined, '']) test(`AC-34 legacy verified state with ${String(binding)} bot permits ack`, async t => {
  const f = setup(t), sent = await notifyTest(f.store, f.options);
  await notifyAck(f.store, sent.notice_id, 'bot-a', f.options);
  const state = readDeliveryState(f.paths.home), verifiedAt = state.verified_at;
  if (binding === undefined) delete state.verified_by_bot; else state.verified_by_bot = binding;
  atomicWriteJson(join(f.paths.home, 'notify', 'state.json'), state);
  const out = await f.cli(['ack', sent.notice_id, '--bot', 'bot-b']);
  assert.equal(out.code, 0); assert.equal(out.envelope.result.verified_by_bot, 'bot-b');
  assert.equal(out.envelope.result.verified_at, verifiedAt);
  assert.equal((await f.cli(['status'])).result.init.verified_by_bot, 'bot-b');
});

test('AC-32 HTTPS endpoint output contains host only, never URL or secret path', async t => {
  const f = setup(t); f.credentials('https://notify.example.invalid/private-webhook?token=sentinel');
  const out = await f.cli(['status', '--pending']); assert.equal(out.code, 0);
  assert.equal(out.result.endpoint_host, 'notify.example.invalid');
  assert.ok(!out.output.includes('private-webhook')); assert.ok(!out.output.includes('token=sentinel'));
});

test('AC-12 actual __notify-deliver launcher argv/env exclude sentinel and secret file contents', t => {
  const f = setup(t), contents = readFileSync(f.file, 'utf8'); let calls = 0, unrefs = 0;
  mkdirSync(join(f.paths.home, 'notify'));
  const captured: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const source = { ...env, HOME: f.root, PATH: process.env.PATH, GBDEV_SECRET_SENTINEL: f.key, GBDEV_SECRET_CONTENTS: contents };
  const before = { ...source };
  launchDeliver(f.paths, () => assert.fail('launcher failed'), source, (command, args, options) => {
    calls++; captured.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess; child.unref = () => { unrefs++; }; return child;
  });
  assert.equal(calls, 1); assert.equal(unrefs, 1); assert.deepEqual(source, before);
  const { command, args, options } = captured[0]!; assert.equal(command, process.execPath);
  assert.deepEqual(args, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '__notify-deliver']);
  assert.equal(options.shell, false); assert.equal(options.detached, true);
  assert.deepEqual(options.env, { HOME: f.root, PATH: process.env.PATH, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config, ...env });
  for (const value of [JSON.stringify(args), JSON.stringify(options.env)]) {
    for (const forbidden of [f.key, contents, f.file, 'http://', 'https://', 'GBDEV_SECRET_SENTINEL', 'GBDEV_SECRET_CONTENTS']) assert.ok(!value.includes(forbidden));
  }
  for (const value of Object.values(bytes(join(f.paths.home, 'notify')))) assert.ok(!Buffer.from(value, 'base64').toString('utf8').includes(f.key));
});

test('flush with empty outbox never launches, including retry-auth', async t => {
  const f = setup(t);
  for (const retry of [false, true]) {
    if (retry) { mkdirSync(join(f.paths.home, 'notify')); await updateDeliveryState(f.store, { paused: { reason: 'paused_auth_rejected', at: stamp(f.now()), http_status: 401 } }); }
    const out = await f.cli(['flush', ...(retry ? ['--retry-auth'] : [])], { launch: () => assert.fail('empty outbox'), sleep: async () => assert.fail('empty outbox must not wait') });
    assert.equal(out.code, 0); assert.equal(out.result.pending, 0); assert.equal(out.result.paused, null);
  }
});

test('notify status/test/flush/ack without --json produce human text and safe hints', async t => {
  const f = setup(t); await f.enqueue();
  const human = async (args: string[]) => {
    let output = ''; assert.equal(await runCli(['notify', ...args], { stdout: s => { output += s; }, stderr: s => { output += s; }, notifyActions: f.options }), 0);
    assert.throws(() => JSON.parse(output)); assert.doesNotMatch(output, /https?:\/\//);
    assert.ok(!output.includes(f.key)); assert.ok(!output.includes(f.file)); return output;
  };
  const pending = readPendingNotices(f.paths.home)[0]!;
  const status = await human(['status', '--pending']); assert.match(status, /通知状态：configured_unverified/);
  assert.ok(status.includes(pending.notice_id)); assert.ok(status.endsWith('完成或需要决定时将通知控制器（127.0.0.1）\n'));
  assert.match(await human(['test']), /测试通知已送达.*\n等待 webhook routine 确认/);
  assert.match(await human(['ack', readDeliveryState(f.paths.home).last_test!.notice_id, '--bot', 'bot-a']), /通知已验证（bot-a）/);
  assert.match(await human(['flush']), /通知状态：verified/);
  f.save({ enabled: false }); assert.ok((await human(['status'])).endsWith('通知未开启（disabled_by_config）\n'));
});
