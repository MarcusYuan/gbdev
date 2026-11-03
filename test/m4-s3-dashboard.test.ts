import { reapDashboardChildren } from './helpers/dashboard.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runCli } from '../src/cli.js';
import { startRun, cancelRun } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { readRun } from '../src/run/store.js';
import { fixture as fakeRunFixture, until } from './helpers/m3.js';
import { validateEnvelope } from '../src/contracts/envelope.js';
import { validateConfig } from '../src/core/config.js';
import { DASHBOARD_DEFAULTS, loadDashboard, validateDashboard } from '../src/core/dashboardConfig.js';
import { resolvePaths } from '../src/core/paths.js';
import { acquireLock } from '../src/core/lock.js';
import { identity, key } from '../src/dashboard/names.js';
import { desired } from '../src/dashboard/desired.js';
import { closeDashboard, dashboardDiagnostic, dashboardStatus, ensureDashboard } from '../src/dashboard/reconcile.js';
import { DashboardFailure, safeArgs } from '../src/dashboard/safeArgs.js';
import { TMUX_ENV_KEYS, Tmux, paneArgs, tmuxEnv } from '../src/dashboard/tmux.js';
import { dashboardLog } from '../src/dashboard/log.js';
import { activeEnsures } from '../src/dashboard/trigger.js';
import { testEnv } from './helpers/run.js';
import { job, temporary } from './helpers.js';

interface FakePane { id: string; key: string; dead: boolean; argv: string[]; options: Record<string, string>; capture: string }
interface FakeWindow { id: string; name: string; key: string; panes: FakePane[]; options: Record<string, string>; layout?: string }
interface FakeState { sessions: Record<string, { owner: string; options: Record<string, string>; windows: FakeWindow[] }>; splits: number; nextWindow: number; nextPane: number }
interface Call { argv: string[]; env: string[] }
function fixture(t: TestContext) {
  reapDashboardChildren(t);
  const root = temporary(t), home = join(root, 'home'), config = join(root, 'config.json'), bin = join(root, 'tmux.mjs'); mkdirSync(home);
  copyFileSync('test/fixtures/fake-tmux.js', bin); chmodSync(bin, 0o755);
  const control: Record<string, unknown> = { state: join(root, 'state.json'), log: join(root, 'calls.jsonl') };
  const saveControl = () => writeFileSync(bin + '.json', JSON.stringify(control)); saveControl();
  const saveConfig = (dashboard: unknown = {}) => writeFileSync(config, JSON.stringify({ version: 1, dashboard, providers: { codex: { bin: join(root, 'missing') }, cursor: { bin: join(root, 'missing') } } })); saveConfig();
  testEnv(t, { GBDEV_HOME: home, GBDEV_CONFIG: config, GBDEV_TMUX_BIN: bin, GBDEV_DASHBOARD: '1', HOME: root, LANG: 'en_US.UTF-8', TMUX: 'do-not-inherit', TMUX_PANE: '%99', GBDEV_PRIVATE_TOKEN: 'do-not-inherit', NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') });
  writeFileSync(join(root, 'gitconfig'), '');
  const paths = resolvePaths({ GBDEV_HOME: home, GBDEV_CONFIG: config });
  const run = JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8')); run.repo = root; run.integration.worktree = root;
  const save = (path: string, value: unknown) => { const file = join(home, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
  save(`runs/${run.run_id}/run.json`, run);
  const calls = (): Call[] => existsSync(String(control.log)) ? readFileSync(String(control.log), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const state = (): FakeState => JSON.parse(readFileSync(String(control.state), 'utf8'));
  const writeState = (s: FakeState) => writeFileSync(String(control.state), JSON.stringify(s));
  return { root, home, paths, bin, control, saveControl, saveConfig, run, save, calls, state, writeState };
}
async function cli(args: string[]) { let stdout = '', stderr = ''; const code = await runCli(args, { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } }); return { code, stdout, stderr }; }
function windows(f: ReturnType<typeof fixture>): FakeWindow[] { return Object.values(f.state().sessions).flatMap(s => s.windows); }
function launch(t: TestContext, args: string[], env = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [resolve('dist/src/cli.js'), ...args], { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', s => { stdout += s; }); child.stderr.on('data', s => { stderr += s; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 18000);
  t.after(async () => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  return done.finally(() => clearTimeout(timeout));
}

test('M4 S3 dashboard config defaults ranges unknown fields and pane env overrides', t => {
  const f = fixture(t); assert.deepEqual(validateDashboard(undefined), DASHBOARD_DEFAULTS);
  assert.equal(validateConfig({ version: 1, dashboard: { enabled: false } }).dashboard?.enabled, false);
  for (const v of [null, [], { unknown: 1 }, { enabled: 1 }, { color: 'true' }, { session: 'gbdev;x' }, { session: 'Upper' }, { tmux_path: 'relative' }, { tmux_path: '/tmp/space path' }, { retain_finished_min: -1 }, { idle_exit_min: 4 }, { max_windows: 33 }, { backfill_lines: 49 }, { poll_ms: 5001 }, { poll_ms: 200.5 }]) assert.throws(() => validateConfig({ version: 1, dashboard: v }), /dashboard/);
  f.saveConfig({ color: false, backfill_lines: 50, retain_finished_min: 0 }); const c = loadDashboard(f.paths.config);
  const args = paneArgs(f.paths, c, 'run-lane', f.run.run_id, 'lane-1'); assert.equal(args[0], '/usr/bin/env'); assert.equal(args[1], '-i'); assert.ok(args.includes('NO_COLOR=1')); assert.ok(args.includes('--max-old-space-size=64'));
});

test('M4 AC-13 disabled env config and implicit tests invoke tmux zero times', async t => {
  const f = fixture(t);
  process.env.GBDEV_DASHBOARD = '0'; assert.equal((await ensureDashboard(f.paths)).reason, 'disabled_by_env'); assert.equal((await dashboardStatus(f.paths)).reason, 'disabled_by_env');
  process.env.GBDEV_DASHBOARD = '1'; f.saveConfig({ enabled: false }); assert.equal((await ensureDashboard(f.paths)).reason, 'disabled_by_config');
  f.saveConfig(); delete process.env.GBDEV_DASHBOARD; delete process.env.GBDEV_TMUX_BIN;
  assert.equal((await ensureDashboard(f.paths)).reason, 'disabled_in_tests'); assert.equal(dashboardDiagnostic(f.paths).reason, 'disabled_in_tests'); assert.deepEqual(f.calls(), []);
});

test('M4 AC-14 S-D1 rejects injection before calls and strict whitelist excludes supervisor env', async t => {
  const f = fixture(t);
  for (const arg of [';', 'x;', 'x y', '#{evil}', 'x\n', "x'", '$(id)', 'x\\y', 'x\x00']) assert.throws(() => safeArgs([arg]), DashboardFailure);
  safeArgs(['new-session', ';', 'set-option'], true);
  const env = tmuxEnv({ HOME: f.root, TMUX: 'secret', TMUX_PANE: '%1', SECRET: 'secret' }); assert.deepEqual(env, { HOME: f.root, TERM: 'xterm-256color' });
  assert.equal((await ensureDashboard({ ...f.paths, home: join(f.root, 'unsafe space') })).reason, 'unsafe_argv');
  process.env.GBDEV_TMUX_BIN = '/tmp/unsafe;'; assert.equal((await ensureDashboard(f.paths)).reason, 'unsafe_argv');
  process.env.GBDEV_TMUX_BIN = f.bin; process.env.LANG = 'unsafe space'; assert.equal((await ensureDashboard(f.paths)).reason, 'unsafe_argv'); assert.deepEqual(f.calls(), []);
  process.env.LANG = 'en_US.UTF-8';
  const received = spawnSync('/usr/bin/env', [], { env: tmuxEnv(), encoding: 'utf8', shell: false });
  assert.equal(received.status, 0); assert.ok(received.stdout.trim().split('\n').every(row => (TMUX_ENV_KEYS as readonly string[]).includes(row.split('=')[0]!)));
  const s = await ensureDashboard(f.paths); assert.equal(s.enabled, true, JSON.stringify(s));
  for (const call of f.calls()) { assert.ok(call.env.every(k => (TMUX_ENV_KEYS as readonly string[]).includes(k)), call.env.join(',')); safeArgs(call.argv, call.argv.includes(';')); assert.ok(!call.argv.includes('-g')); }
});

test('M4 AC-15 AC-16 two lane topology keys direct exec and five ensures are idempotent', async t => {
  const f = fixture(t), original = readFileSync(join(f.home, `runs/${f.run.run_id}/run.json`));
  const first = await cli(['dashboard', 'ensure', '--target', f.run.run_id, '--json']); assert.equal(first.code, 0); validateEnvelope(JSON.parse(first.stdout)); assert.equal(first.stderr, '');
  const result = JSON.parse(first.stdout).result; assert.equal(result.enabled, true, first.stdout); assert.equal(result.windows.length, 1);
  const w = windows(f).find(w => w.name === f.run.run_id)!;
  assert.deepEqual(w.panes.map(p => p.key), ['status', 'lane-1', 'lane-2', 'integration'].map(p => key(f.run.run_id, p)));
  assert.equal(w.layout, 'main-horizontal'); assert.equal(w.options['main-pane-height'], '35%');
  for (const p of w.panes) { assert.deepEqual(p.argv.slice(0, 2), ['/usr/bin/env', '-i']); assert.ok(p.argv.includes('__pane')); assert.ok(p.argv.every(a => !a.includes('do-not-inherit'))); }
  assert.equal(Object.keys(f.state().sessions).length, 1); const n = f.calls().length;
  for (let i = 0; i < 4; i++) assert.equal((await ensureDashboard(f.paths)).enabled, true);
  assert.equal(windows(f).find(w => w.name === f.run.run_id)!.panes.length, 4);
  assert.ok(f.calls().slice(n).every(c => !['new-session', 'new-window', 'split-window', 'select-layout', 'set-option'].includes(c.argv[0]!)));
  assert.deepEqual(readFileSync(join(f.home, `runs/${f.run.run_id}/run.json`)), original);
});

test('M4 AC-17 eight ensure processes serialize on separate PID lock without duplicate panes', async t => {
  const f = fixture(t), global = acquireLock(f.paths.lock);
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => launch(t, ['dashboard', 'ensure', '--json'])));
    for (const r of results) { assert.equal(r.code, 0, r.stderr); const s = JSON.parse(r.stdout).result; assert.ok(s.enabled || s.reason === 'lock_busy', r.stdout); }
    assert.equal(Object.keys(f.state().sessions).length, 1); assert.equal(windows(f).find(w => w.name === f.run.run_id)!.panes.length, 4);
    assert.equal(f.calls().filter(c => c.argv[0] === 'new-session').length, 1); assert.equal(existsSync(join(f.home, 'dashboard.lock')), false);
  } finally { global.release(); }
});

for (const marker of ['', 'wrong-owner']) test(`M4 AC-20 foreign session ${marker || 'unmarked'} stays untouched including capture close`, async t => {
  const f = fixture(t), name = identity(f.home).session;
  const state: FakeState = { sessions: { [name]: { owner: marker, options: {}, windows: [] } }, splits: 0, nextPane: 1, nextWindow: 1 }; f.writeState(state);
  assert.equal((await ensureDashboard(f.paths)).reason, 'foreign_session'); assert.equal((await dashboardStatus(f.paths)).session_state, 'foreign');
  for (const args of [['capture', f.run.run_id], ['close', '--all']]) { const r = await cli(['dashboard', ...args, '--json']); assert.equal(r.code, 1); assert.equal(JSON.parse(r.stdout).error.details.reason, 'foreign_session'); }
  assert.deepEqual(f.state(), state); assert.ok(f.calls().every(c => ['-V', 'has-session', 'show-options'].includes(c.argv[0]!)));
});

test('M4 AC-21 separate canonical homes hash names and share default server without interference', async t => {
  const f = fixture(t), other = join(f.root, 'second'); mkdirSync(other); const paths = { ...f.paths, home: other };
  const results = await Promise.all([ensureDashboard(f.paths), ensureDashboard(paths)]);
  for (const [i, home] of [f.home, other].entries()) { const hash = createHash('sha256').update(realpathSync(home)).digest('hex'); assert.equal(results[i]!.session, 'gbdev-' + hash.slice(0, 6)); assert.equal(f.state().sessions[results[i]!.session!]!.owner, hash.slice(0, 12)); }
  assert.equal(Object.keys(f.state().sessions).length, 2);
  const alias = join(f.root, 'alias'); symlinkSync(f.home, alias); assert.equal(identity(alias).session, results[0]!.session);
  f.saveConfig({ session: 'gbdev-explicit' }); assert.equal((await ensureDashboard(f.paths)).session, 'gbdev-explicit');
});

for (const noSpace of [[1], 'always']) test(`M4 AC-23 no space ${JSON.stringify(noSpace)} tiles retries and reports status border`, async t => {
  const f = fixture(t); f.control.noSpace = noSpace; f.saveControl();
  const r = await cli(['dashboard', 'ensure', '--json']); assert.equal(r.code, 0); const s = JSON.parse(r.stdout).result; assert.equal(s.enabled, true, r.stdout);
  const calls = f.calls(), split = calls.findIndex(c => c.argv[0] === 'split-window'); assert.equal(calls[split + 1]!.argv[0], 'select-layout'); assert.equal(calls[split + 1]!.argv.at(-1), 'tiled');
  if (noSpace === 'always') { assert.equal(s.missing_panes.length, 3); assert.match(windows(f).find(w => w.name === f.run.run_id)!.options['pane-border-format']!, /no-pane:window-too-small/); }
  else assert.equal(windows(f).find(w => w.name === f.run.run_id)!.panes.length, 4);
});

test('M4 AC-24 AC-5 capture only owned id with bounds and sanitized redacted multiline text', async t => {
  const f = fixture(t); f.control.capture = 'safe\x1b]52;c;PAYLOAD\x07\x1b[2J\x9b2J\u202e\npassword=abcdef,ghijkl\n-----BEGIN RSA PRIVATE KEY-----\nBODY\n-----END RSA PRIVATE KEY-----\nlast'; f.saveControl();
  assert.equal((await ensureDashboard(f.paths)).enabled, true);
  const out = await cli(['dashboard', 'capture', `${f.run.run_id}:lane-1`, '--lines', '50', '--json']); assert.equal(out.code, 0); validateEnvelope(JSON.parse(out.stdout));
  const text = JSON.parse(out.stdout).result.text; assert.match(text, /safe\n/); assert.match(text, /‹redacted›/); assert.doesNotMatch(text, /PAYLOAD|BODY|abcdef|ghijkl|[\x1b\x9b\x07\u202e]/);
  assert.deepEqual(f.calls().at(-1)!.argv.slice(0, 5), ['capture-pane', '-p', '-J', '-S', '-50']);
  const n = f.calls().filter(c => c.argv[0] === 'capture-pane').length;
  const absent = await cli(['dashboard', 'capture', `${f.run.run_id}:lane-4`, '--json']); assert.equal(absent.code, 1); assert.equal(JSON.parse(absent.stdout).error.code, 'dashboard_unavailable');
  assert.equal(f.calls().filter(c => c.argv[0] === 'capture-pane').length, n);
});

test('M4 S3 explicit ensure repairs removed pane dead pane and lost session without modifying worker files', async t => {
  const f = fixture(t), before = readFileSync(join(f.home, `runs/${f.run.run_id}/run.json`)); await ensureDashboard(f.paths);
  let state = f.state(); const w = Object.values(state.sessions)[0]!.windows.find(w => w.name === f.run.run_id)!; const keep = w.panes.filter(p => !p.key.endsWith('lane-2')).map(p => p.id); w.panes = w.panes.filter(p => !p.key.endsWith('lane-2')); f.writeState(state);
  let n = f.calls().length; assert.equal((await ensureDashboard(f.paths)).enabled, true); assert.equal(f.calls().slice(n).filter(c => c.argv[0] === 'split-window').length, 1); assert.ok(keep.every(id => windows(f).some(w => w.panes.some(p => p.id === id))));
  state = f.state(); Object.values(state.sessions)[0]!.windows.find(w => w.name === f.run.run_id)!.panes[0]!.dead = true; f.writeState(state); n = f.calls().length;
  assert.equal((await ensureDashboard(f.paths)).enabled, true); assert.equal(f.calls().slice(n).filter(c => c.argv[0] === 'respawn-pane').length, 1);
  state = f.state(); state.sessions = {}; f.writeState(state); assert.equal((await ensureDashboard(f.paths)).enabled, true);
  assert.deepEqual(readFileSync(join(f.home, `runs/${f.run.run_id}/run.json`)), before);
});

test('M4 S3 status is read-only close targets only own window or session and reopens safely', async t => {
  const f = fixture(t); const before = readdirSync(f.home); assert.equal((await dashboardStatus(f.paths)).session_state, 'absent'); assert.deepEqual(readdirSync(f.home), before); assert.ok(!existsSync(String(f.control.state)) || Object.keys(f.state().sessions).length === 0);
  await ensureDashboard(f.paths); const state = f.state(); state.sessions['user-work'] = { owner: '', options: {}, windows: [] }; f.writeState(state);
  assert.equal((await closeDashboard(f.paths, f.run.run_id)).enabled, true); assert.ok(!windows(f).some(w => w.name === f.run.run_id)); assert.ok(f.state().sessions['user-work']);
  await ensureDashboard(f.paths); assert.equal((await closeDashboard(f.paths)).session_state, 'absent'); assert.deepEqual(Object.keys(f.state().sessions), ['user-work']);
  assert.equal((await ensureDashboard(f.paths)).enabled, true);
});

test('M4 S3 desired excludes nested units warns corrupt metadata and only explicit terminal target', t => {
  const f = fixture(t), standalone = job(), child = job('j_20261025_1131_1111'), terminal = job('j_20261025_1131_2222'); terminal.state = 'succeeded';
  f.save(`jobs/${standalone.job_id}/job.json`, standalone); f.save(`jobs/${child.job_id}/job.json`, { ...child, run_id: f.run.run_id }); f.save(`jobs/${terminal.job_id}/job.json`, terminal);
  f.save('jobs/j_20261025_1131_3333/job.json', {}); writeFileSync(join(f.home, 'jobs/j_20261025_1131_3333/job.json'), '{bad');
  const s = desired(f.home); assert.deepEqual(s.windows.map(w => w.id).sort(), [f.run.run_id, standalone.job_id].sort()); assert.equal(s.warnings.length, 1);
  assert.equal(desired(f.home, terminal.job_id).windows.length, 1); assert.equal(desired(f.home, child.job_id).windows.length, 0);
});

for (const mode of ['fail', 'old-version', 'hang']) test(`M4 S3 adapter ${mode} is bounded best effort and independent of task state`, async t => {
  const f = fixture(t); f.control.mode = mode; f.saveControl(); const before = readFileSync(join(f.home, `runs/${f.run.run_id}/run.json`)), at = Date.now();
  const out = await cli(['dashboard', 'ensure', '--json']); assert.equal(out.code, 0); const s = JSON.parse(out.stdout).result; assert.equal(s.reason, mode === 'hang' ? 'tmux_timeout' : mode === 'old-version' ? 'tmux_too_old' : 'tmux_error'); assert.ok(Date.now() - at < 4500);
  assert.deepEqual(readFileSync(join(f.home, `runs/${f.run.run_id}/run.json`)), before); assert.match(readFileSync(join(f.home, 'dashboard.log'), 'utf8'), new RegExp(s.reason));
});

test('M4 S3 missing binary config fallback lock busy and total call deadline', async t => {
  const f = fixture(t); process.env.GBDEV_TMUX_BIN = join(f.root, 'missing'); assert.equal((await ensureDashboard(f.paths)).reason, 'tmux_not_found');
  delete process.env.GBDEV_TMUX_BIN; f.saveConfig({ tmux_path: f.bin }); assert.equal((await ensureDashboard(f.paths)).enabled, true);
  const held = acquireLock(join(f.home, 'dashboard.lock')), at = Date.now();
  try { assert.equal((await ensureDashboard(f.paths)).reason, 'lock_busy'); assert.ok(Date.now() - at < 3000); } finally { held.release(); }
  await assert.rejects(new Tmux(f.bin, process.env, Date.now() - 1).call(['-V']), /tmux_timeout/);
});

test('M4 S3 CLI strict arguments hidden ensure and no options leaking to older commands', async t => {
  const f = fixture(t);
  for (const args of [['status', 'extra'], ['ensure', '--target', '../bad'], ['capture', f.run.run_id, '--lines', '0'], ['capture', f.run.run_id, '--lines', '2001'], ['capture', f.run.run_id + ':lane-5'], ['close'], ['close', f.run.run_id, '--all'], ['ensure', '--follow'], ['status', '--target', f.run.run_id]]) { const r = await cli(['dashboard', ...args, '--json']); assert.equal(r.code, 2, JSON.stringify(args)); }
  assert.equal((await cli(['status', '--all', '--json'])).code, 2);
  assert.equal((await cli(['__dashboard-ensure', '--target', f.run.run_id])).code, 0);
  const help = await cli(['--help']); assert.match(help.stdout, /dashboard capture/); assert.doesNotMatch(help.stdout, /__dashboard/);
});

test('M4 AC-28 doctor JSON reports optional version and dashboard state without real providers', async t => {
  const f = fixture(t); let out = await cli(['doctor', '--json']); assert.equal(out.code, 0); validateEnvelope(JSON.parse(out.stdout));
  let item = JSON.parse(out.stdout).result.checks.find((c: { name: string }) => c.name === 'tmux'); assert.equal(item.ok, true); assert.equal(item.version, '3.6a'); assert.equal(item.dashboard.session_state, 'absent');
  process.env.GBDEV_TMUX_BIN = join(f.root, 'missing'); out = await cli(['doctor', '--json']); assert.equal(out.code, 0);
  item = JSON.parse(out.stdout).result.checks.find((c: { name: string }) => c.name === 'tmux'); assert.equal(item.ok, false); assert.match(item.detail, /not installed \(optional/); assert.equal(item.dashboard.reason, 'tmux_not_found');
});

test('M4 S3 dashboard log rotates one generation and refuses outside link', t => {
  const f = fixture(t), log = join(f.home, 'dashboard.log'); writeFileSync(log, 'x'.repeat(1024 * 1024 + 1)); dashboardLog(f.home, 'password=abcdef,ghijkl');
  assert.ok(existsSync(log + '.1')); assert.match(readFileSync(log, 'utf8'), /‹redacted›/); const outside = join(f.root, 'outside'); writeFileSync(outside, 'untouched'); rmSync(log); symlinkSync(outside, log); dashboardLog(f.home, 'oops'); assert.equal(readFileSync(outside, 'utf8'), 'untouched');
});

test('M4 AC-26 dashboard static guards argv-only no networking no worker or supervisor dependency', () => {
  const forbidden = ['send-keys', 'pipe-pane', 'run-shell', 'if-shell', 'source-file', 'set-environment', 'kill-server', 'shell: true', 'Object.keys(process.env)', 'JSON.stringify(process.env)', '...process.env', 'mcp.json', '.cursor/', '.codex/', 'node:http', 'node:net', 'fetch(', 'terminateGroup', '/supervisor.js'];
  for (const entry of readdirSync('src/dashboard', { withFileTypes: true })) { const source = readFileSync(join('src/dashboard', entry.name), 'utf8'); for (const word of forbidden) assert.ok(!source.includes(word), entry.name + ': ' + word); }
  assert.match(readFileSync('src/dashboard/tmux.ts', 'utf8'), /shell: false/);
});

test('M4 S3 unmarked pane is never split captured or closed as a unit', async t => {
  const f = fixture(t); await ensureDashboard(f.paths);
  const state = f.state(), own = state.sessions[identity(f.home).session]!;
  const w = own.windows.find(w => w.name === f.run.run_id)!; w.key = ''; for (const p of w.panes) p.key = '';
  f.writeState(state); const n = f.calls().length;
  assert.equal((await cli(['dashboard', 'capture', f.run.run_id, '--json'])).code, 1);
  assert.equal((await cli(['dashboard', 'close', f.run.run_id, '--json'])).code, 1);
  assert.ok(f.calls().slice(n).every(c => !['capture-pane', 'kill-window', 'split-window'].includes(c.argv[0]!)));
  assert.deepEqual(f.state(), state);
});

test('M4 S3 duplicate session rechecks owner and never claims foreign session', async t => {
  const f = fixture(t); f.control.duplicateForeign = true; f.saveControl();
  const s = await ensureDashboard(f.paths); assert.equal(s.reason, 'foreign_session');
  assert.equal(f.state().sessions[identity(f.home).session]!.owner, '');
  const afterCreate = f.calls().slice(f.calls().findIndex(c => c.argv[0] === 'new-session') + 1);
  assert.ok(afterCreate.every(c => ['has-session', 'show-options'].includes(c.argv[0]!)));
});

test('M4 S3 no-space retry recovers border and uses window-scoped options', async t => {
  const f = fixture(t); f.control.noSpace = 'always'; f.saveControl(); await ensureDashboard(f.paths);
  f.control.noSpace = []; f.saveControl(); const s = await ensureDashboard(f.paths); assert.equal(s.enabled, true); assert.equal(s.missing_panes, undefined);
  const w = windows(f).find(w => w.name === f.run.run_id)!; assert.equal(w.panes.length, 4); assert.equal(w.options['pane-border-format'], '#{pane_title}');
  for (const c of f.calls().filter(c => c.argv.includes('pane-border-format'))) assert.ok(c.argv.includes('-w'));
});

test('M4 S3 standalone pipeline and job topology excludes run children', async t => {
  const f = fixture(t), p = { schema: 'gbdev.pipeline-run.v1', pipeline_id: 'p_20261028_1200_abcd', pipeline: 'implement-review', state: 'running', state_reason: null, outcome: null, failure_reason: null,
    repo: f.root, workspace: { mode: 'shared_run_worktree', worktree: f.root, branch: 'test' }, base_sha: 'abc', diff_base_sha: 'abc', head_sha: 'abc', round: 1, max_rounds: 2, jobs_used: 0, max_total_jobs: 12,
    current: null, steps: [], decision: null, pending_questions: [], supervisor_pid: null, heartbeat_at: null, created_at: '2026-10-28T12:00:00Z', updated_at: '2026-10-28T12:00:00Z', deadline_at: '2026-10-28T13:00:00Z', state_history: [], warnings: [], integration: null };
  f.save(`pipelines/${p.pipeline_id}/pipeline.json`, p);
  const j = job(); f.save(`jobs/${j.job_id}/job.json`, j); f.save('jobs/j_20261025_1131_1111/job.json', { ...job('j_20261025_1131_1111'), pipeline_id: p.pipeline_id });
  const s = await ensureDashboard(f.paths, p.pipeline_id); assert.equal(s.reason, null, JSON.stringify({ status: s, calls: f.calls() })); assert.equal(s.enabled, true);
  assert.deepEqual(windows(f).find(w => w.name === p.pipeline_id)!.panes.map(pane => pane.key), ['status', 'step'].map(name => key(p.pipeline_id, name)));
  assert.equal((await ensureDashboard(f.paths, j.job_id)).enabled, true); assert.deepEqual(windows(f).find(w => w.name === j.job_id)!.panes.map(pane => pane.key), [key(j.job_id, 'job')]);
  assert.ok(windows(f).every(w => w.name !== 'j_20261025_1131_1111'));
});

test('M4 S3 doctor retains old version and rejects non-version output without echoing it', async t => {
  const f = fixture(t); f.control.version = 'tmux 3.1c'; f.saveControl(); const old = dashboardDiagnostic(f.paths); assert.equal(old.tmux_version, '3.1c'); assert.equal(old.reason, 'tmux_too_old');
  f.control.version = 'tmux 3.6a\npassword=abcdef,ghijkl'; f.saveControl(); const bad = await dashboardStatus(f.paths); assert.equal(bad.reason, 'tmux_too_old'); assert.equal(bad.tmux_version, null);
});

test('M4 AC-15 live two-lane fake run survives explicit dashboard failure close and reopen', async t => {
  const tmux = fixture(t), f = fakeRunFixture(t);
  testEnv(t, { GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config });
  for (const task of ['a', 'b']) f.fakePlan[`${task}/implement#1`] = { sleep_ms: 12000, actions: [{ type: 'write_file', path: `src/${task}.txt`, content: task + '\n' }] };
  f.savePlan(); const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  try {
    await until(() => readRun(f.store, initial.run_id).lanes.filter(l => l.state === 'busy').length === 2);
    // Startup ensure is fire-and-forget and may still own the two-second lock.
    // This case tests topology/close/reopen, not the separately covered lock_busy
    // outcome. Join the test-owned ensure before making assertions about windows.
    await until(() => activeEnsures.size === 0);
    const s = await ensureDashboard(f.paths, initial.run_id); assert.equal(s.enabled, true, JSON.stringify(s));
    assert.equal(s.reason, null, JSON.stringify(s));
    assert.deepEqual(s.windows.find(w => w.unit_id === initial.run_id)!.panes.map(p => p.key).sort(), ['status', 'lane-1', 'lane-2', 'integration'].map(p => key(initial.run_id, p)).sort());
    assert.equal((await closeDashboard(f.paths)).session_state, 'absent'); assert.equal(readRun(f.store, initial.run_id).state, 'running');
    tmux.control.mode = 'fail'; tmux.saveControl(); assert.equal((await ensureDashboard(f.paths, initial.run_id)).reason, 'tmux_error');
    delete tmux.control.mode; tmux.saveControl(); assert.equal((await ensureDashboard(f.paths, initial.run_id)).enabled, true);
    await work; assert.equal(readRun(f.store, initial.run_id).state, 'succeeded'); f.invariants(initial.run_id);
  } finally {
    if (!['succeeded', 'failed', 'cancelled'].includes(readRun(f.store, initial.run_id).state)) await cancelRun(f.store, initial.run_id);
    await work;
  }
});

test('M4 R55 P2 runtime failures preserve enabled and optional missing_panes validates', async t => {
  // Pre-seed a foreign session in this fixture's private fake-tmux state (same
  // pattern as AC-20). Avoid mode=foreign injection during has-session: under
  // full-suite load a timed-out/failed first probe left session_state at the
  // default `absent` before ownership could mark `foreign` (tmux/timing jitter).
  const f = fixture(t), name = identity(f.home).session;
  f.writeState({ sessions: { [name]: { owner: '', options: {}, windows: [] } }, splits: 0, nextWindow: 1, nextPane: 1 });
  const foreign = await ensureDashboard(f.paths);
  assert.equal(foreign.enabled, true); assert.equal(foreign.reason, 'foreign_session'); assert.equal(foreign.session_state, 'foreign');
  f.control.mode = 'hang'; f.saveControl(); const timeout = await ensureDashboard(f.paths); assert.equal(timeout.enabled, true); assert.equal(timeout.reason, 'tmux_timeout');
  delete f.control.mode; f.saveControl(); const held = acquireLock(join(f.home, 'dashboard.lock'));
  try { const busy = await ensureDashboard(f.paths); assert.equal(busy.enabled, true); assert.equal(busy.reason, 'lock_busy'); } finally { held.release(); }
  const out = JSON.parse((await cli(['dashboard', 'status', '--json'])).stdout);
  for (const missing_panes of [null, {}, [{ key: 4, reason: 'x' }], [{ key: 'x', reason: false }]]) assert.throws(() => validateEnvelope({ ...out, result: { ...out.result, missing_panes } }));
  validateEnvelope({ ...out, result: { ...out.result, missing_panes: [{ key: 'x', reason: 'small' }] } });
});

test('M4 R60 fake matches 3.6a session versus option targets and stops a failed command queue', async t => {
  const f = fixture(t), tmux = new Tmux(f.bin), name = 'gbdev-target';
  const create = ['new-session', '-d', '-s', name, '-n', 'index', '-P', '-F', '#{window_id}\t#{pane_id}', '--', '/usr/bin/true'];
  const failed = await tmux.call([...create, ';', 'set-option', '-t', `=${name}`, '@gbdev_owner', 'owner', ';', 'set-option', '-t', `=${name}:`, 'destroy-unattached', 'off'], true);
  assert.equal(failed.code, 1); assert.equal(failed.stderr, `no such session: =${name}\n`);
  assert.match(failed.stdout, /^@\d+\t%\d+\n$/); assert.deepEqual(f.state().sessions[name]!.options, {});
  for (const cmd of ['set-option', 'show-options']) {
    const args = cmd === 'set-option' ? ['@gbdev_owner', 'owner'] : ['@gbdev_owner'];
    const bad = await tmux.call([cmd, '-t', `=${name}`, ...args]);
    assert.equal(bad.code, 1); assert.equal(bad.stderr, `no such session: =${name}\n`);
  }
  assert.equal((await tmux.call(['has-session', '-t', `=${name}`])).code, 0);
  for (const target of [`=${name}`, `=${name}:`]) assert.equal((await tmux.call(['list-panes', '-s', '-t', target])).code, 0);
  assert.equal((await tmux.call(['set-option', '-t', `=${name}:`, '@gbdev_owner', 'owner'])).code, 0);
  assert.equal(await tmux.ok(['show-options', '-v', '-t', `=${name}:`, '@gbdev_owner']), 'owner\n');
  assert.equal((await tmux.call(['new-window', '-d', '-t', `=${name}:`, '-n', 'run', '--', '/usr/bin/true'])).code, 0);
  assert.equal((await tmux.call(['kill-session', '-t', `=${name}`])).code, 0);
  assert.deepEqual(f.state().sessions, {});
});

test('M4 R60 bootstrap persists both options and status doctor capture see an owned run', async t => {
  const f = fixture(t), expected = identity(f.home);
  const ensured = await ensureDashboard(f.paths); assert.equal(ensured.reason, null); assert.equal(ensured.session_state, 'owned');
  const tmux = new Tmux(f.bin);
  assert.equal((await tmux.ok(['show-options', '-v', '-t', `=${expected.session}:`, '@gbdev_owner'])).trim(), expected.h12);
  assert.equal((await tmux.ok(['show-options', '-v', '-t', `=${expected.session}:`, 'destroy-unattached'])).trim(), 'off');
  for (const status of [await dashboardStatus(f.paths), dashboardDiagnostic(f.paths)]) {
    assert.equal(status.reason, null); assert.equal(status.session_state, 'owned'); assert.ok(status.attach_hint);
  }
  const status = JSON.parse((await cli(['dashboard', 'status', '--json'])).stdout).result;
  assert.equal(status.reason, null); assert.equal(status.windows[0].unit_id, f.run.run_id); assert.equal(status.windows[0].panes.length, 4);
  assert.equal((await cli(['dashboard', 'capture', `${f.run.run_id}:lane-1`, '--json'])).code, 0);
  for (const call of f.calls()) {
    const commands: string[][] = [[]];
    for (const arg of call.argv) { if (arg === ';') commands.push([]); else commands.at(-1)!.push(arg); }
    for (const args of commands) {
      if (!args.includes('-t')) continue;
      const target = args[args.indexOf('-t') + 1]!;
      if (['set-option', 'show-options', 'new-window'].includes(args[0]!) && target.startsWith('=')) assert.equal(target, `=${expected.session}:`);
      else assert.match(target, /^(?:=gbdev-[a-f0-9]{6}|@\d+|%\d+)$/);
    }
  }
});

for (const option of ['@gbdev_owner', 'destroy-unattached']) for (const fault of ['failSetOption', 'skipSetOption']) {
  test(`M4 R60 ${fault} ${option} rolls back bootstrap reports tmux_error and retries cleanly`, async t => {
    const f = fixture(t), before = readFileSync(join(f.home, `runs/${f.run.run_id}/run.json`));
    f.control[fault] = option; f.saveControl();
    const output = await cli(['dashboard', 'ensure', '--json']); assert.equal(output.code, 0);
    const status = JSON.parse(output.stdout).result;
    assert.equal(status.reason, 'tmux_error'); assert.equal(status.session_state, 'absent'); assert.equal(status.attach_hint, null);
    assert.deepEqual(f.state().sessions, {}); assert.equal((await dashboardStatus(f.paths)).reason, null);
    assert.match(readFileSync(join(f.home, 'dashboard.log'), 'utf8'), /tmux_error/);
    assert.deepEqual(readFileSync(join(f.home, `runs/${f.run.run_id}/run.json`)), before);
    assert.deepEqual(f.calls().filter(c => c.argv[0] === 'kill-window').map(c => c.argv), [['kill-window', '-t', '@1']]);
    assert.ok(!f.calls().some(c => c.argv[0] === 'new-window'));
    delete f.control[fault]; f.saveControl();
    const recovered = await ensureDashboard(f.paths); assert.equal(recovered.reason, null); assert.equal(recovered.session_state, 'owned');
    assert.equal(recovered.windows[0]!.panes.length, 4);
  });
}

test('M4 R60 exact targets never claim capture or kill a prefix-neighbor session', async t => {
  const f = fixture(t), name = identity(f.home).session, neighbor = name + 'x', tmux = new Tmux(f.bin);
  await tmux.ok(['new-session', '-d', '-s', neighbor, '-n', 'user', '--', '/usr/bin/true']);
  const before = f.state().sessions[neighbor];
  // Model tmux prefix matching too: dropping '=' would find the neighbor.
  assert.equal((await tmux.call(['has-session', '-t', name])).code, 0);
  assert.equal((await tmux.call(['has-session', '-t', `=${name}`])).code, 1);
  assert.equal((await dashboardStatus(f.paths)).session_state, 'absent');
  assert.equal((await ensureDashboard(f.paths)).reason, null);
  assert.deepEqual(f.state().sessions[neighbor], before);
  assert.equal((await closeDashboard(f.paths)).session_state, 'absent');
  assert.deepEqual(f.state().sessions, { [neighbor]: before });
});

test('M4 R60 bootstrap rollback never removes a same-name replacement session', async t => {
  const f = fixture(t), name = identity(f.home).session;
  f.control.failSetOption = '@gbdev_owner'; f.saveControl();
  const original = Tmux.prototype.call;
  t.mock.method(Tmux.prototype, 'call', async function (this: Tmux, args: string[], compound = false) {
    const result = await original.call(this, args, compound);
    if (args[0] === 'new-session') {
      const state = f.state(), window = state.sessions[name]!.windows[0]!;
      window.id = '@99'; window.panes[0]!.id = '%99'; f.writeState(state);
    }
    return result;
  });
  assert.equal((await ensureDashboard(f.paths)).reason, 'tmux_error');
  assert.equal(f.state().sessions[name]!.windows[0]!.id, '@99');
  assert.ok(!f.calls().some(c => ['kill-window', 'kill-session'].includes(c.argv[0]!)));
});

test('M4 D-M4-3 lane assignment and step changes never respawn either live lane', async t => {
  const f = fixture(t);
  for (const lane of f.run.lanes) Object.assign(lane, { state: 'idle', pipeline_id: null, task_id: null });
  f.save(`runs/${f.run.run_id}/run.json`, f.run);
  assert.equal((await ensureDashboard(f.paths)).reason, null);
  const panes = windows(f).find(w => w.name === f.run.run_id)!.panes;
  const ids = panes.map(p => p.id), offset = f.calls().length;
  for (const [task, pipeline] of [['health', 'p_20261028_1200_aaaa'], ['lib-sum', 'p_20261028_1201_bbbb']]) {
    Object.assign(f.run.lanes[0], { state: 'busy', task_id: task, pipeline_id: pipeline });
    f.save(`runs/${f.run.run_id}/run.json`, f.run);
    // Reconcile is invoked on step_started as well as lane_assigned.
    for (let step = 0; step < 2; step++) assert.equal((await ensureDashboard(f.paths)).reason, null);
  }
  assert.deepEqual(windows(f).find(w => w.name === f.run.run_id)!.panes.map(p => p.id), ids);
  assert.ok(!f.calls().slice(offset).some(c => c.argv.some(a => ['respawn-pane', 'split-window', 'new-window', 'kill-pane', 'kill-window', 'select-layout'].includes(a))));
  // Explicitly killed/dead lane still repairs alone; unrelated live history survives.
  const state = f.state(), runWindow = Object.values(state.sessions)[0]!.windows.find(w => w.name === f.run.run_id)!;
  const lane2 = runWindow.panes.find(p => p.key.endsWith(':lane-2'))!; lane2.dead = true; f.writeState(state);
  const beforeRepair = f.calls().length; assert.equal((await ensureDashboard(f.paths)).reason, null);
  const repairs = f.calls().slice(beforeRepair).filter(c => c.argv[0] === 'respawn-pane');
  assert.equal(repairs.length, 1); assert.equal(repairs[0]!.argv[3], lane2.id);
});
