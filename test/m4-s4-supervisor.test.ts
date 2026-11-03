import { reapDashboardChildren } from './helpers/dashboard.js';
import { waitForCliChildren } from './helpers/children.js';
import { superviseRun } from '../src/run/supervisor.js';
import { dashboardSupervision } from '../src/core/dashboardSupervision.js';
import { JobStore } from '../src/core/jobStore.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DashboardTrigger, activeEnsures, dashboardEvent, withDashboard } from '../src/dashboard/trigger.js';
import { addDashboard, dashboardHintText } from '../src/dashboard/hints.js';
import { Tmux } from '../src/dashboard/tmux.js';
import { ensureDashboard } from '../src/dashboard/reconcile.js';
import { identity } from '../src/dashboard/names.js';
import { desired } from '../src/dashboard/desired.js';
import { DASHBOARD_DEFAULTS } from '../src/core/dashboardConfig.js';
import { resolvePaths } from '../src/core/paths.js';
import { runPaths, readRun } from '../src/run/store.js';
import { startRun, cancelRun } from '../src/commands/run.js';
import { fixture as runFixture, until } from './helpers/m3.js';
import { job, temporary } from './helpers.js';
import { testEnv } from './helpers/run.js';
import { pipelineFixture } from './helpers/pipeline.js';
import { unwrap } from './helpers/tmpRepo.js';

function tmuxFixture(t: TestContext) {
  reapDashboardChildren(t);
  const root = temporary(t), home = join(root, 'home'), bin = join(root, 'tmux.mjs'), config = join(root, 'config.json'); mkdirSync(home);
  copyFileSync('test/fixtures/fake-tmux.js', bin); chmodSync(bin, 0o755);
  const control = { state: join(root, 'state.json'), log: join(root, 'calls.jsonl'), mode: '' };
  const saveControl = () => writeFileSync(bin + '.json', JSON.stringify(control)); saveControl();
  writeFileSync(config, JSON.stringify({ version: 1 }));
  testEnv(t, { GBDEV_TMUX_BIN: bin, GBDEV_DASHBOARD: '1', HOME: root, LANG: 'en_US.UTF-8', GBDEV_HOME: home, GBDEV_CONFIG: config });
  const paths = resolvePaths({ GBDEV_HOME: home, GBDEV_CONFIG: config });
  const state = () => JSON.parse(readFileSync(control.state, 'utf8'));
  const saveState = (s: unknown) => writeFileSync(control.state, JSON.stringify(s));
  const calls = (): { argv: string[] }[] => existsSync(control.log) ? readFileSync(control.log, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const save = (dir: string, id: string, value: unknown) => { mkdirSync(join(home, dir, id), { recursive: true }); writeFileSync(join(home, dir, id, dir === 'runs' ? 'run.json' : 'job.json'), JSON.stringify(value)); };
  return { root, home, bin, paths, config, control, saveControl, state, saveState, calls, save };
}

/** Projection tests exercise the real deadline/status logic, not OS process scheduling.
 * Match fake-tmux.js's absent/foreign/version replies; unexpected commands fail the test.
 * Each fixture has a unique binary path, so the version cache cannot skip the clock advance.
 */
function immediateHintTmux(t: TestContext, mode = '', versionElapsedMs = 0) {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const calls: string[][] = [];
  t.mock.method(Tmux.prototype, 'call', async function(this: Tmux, args: string[]) {
    calls.push(args);
    this.timeout(); // Keep production's shared deadline and expiration check.
    if (args[0] === '-V') {
      t.mock.timers.tick(versionElapsedMs);
      return { code: 0, stdout: mode === 'old-version' ? 'tmux 3.1c\n' : 'tmux 3.6a\n', stderr: '' };
    }
    if (args[0] === 'has-session') return mode === 'foreign'
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 1, stdout: '', stderr: "can't find session\n" };
    if (args[0] === 'show-options' && mode === 'foreign') return { code: 1, stdout: '', stderr: 'invalid option\n' };
    assert.fail(`unexpected hint command: ${JSON.stringify(args)}`);
  });
  return calls;
}

test('M4 AC-19 T10 leading debounce has no trailing or periodic repair; warning once', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0, launches = 0; const warnings: string[] = [], failures: ((reason: string) => void)[] = [];
  const trigger = new DashboardTrigger(fail => { launches++; failures.push(fail); }, r => warnings.push(r), () => now);
  trigger.fire(); now = 4999; trigger.fire(); assert.equal(launches, 1);
  now = 90000; t.mock.timers.tick(90000); assert.equal(launches, 1); trigger.fire(); assert.equal(launches, 2);
  failures[0]!('tmux_timeout'); failures[1]!('foreign_session'); trigger.fire(); assert.deepEqual(warnings, ['tmux_timeout']);
  const throws = new DashboardTrigger(() => { throw new Error('spawn failed'); }, () => { throw new Error('warning failed'); }); assert.doesNotThrow(() => throws.fire());
});

test('M4 AC-18 AC-19 topology event repairs only missing pane and lost session; 90s idle does nothing', async t => {
  const f = tmuxFixture(t), run = JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8')); f.save('runs', run.run_id, run);
  let now = 0; const tasks: Promise<unknown>[] = [];
  await withDashboard(f.paths, run.run_id, () => {}, async () => {
    await Promise.all(tasks); let s = f.state(); const session = identity(f.home).session;
    const window = s.sessions[session].windows.find((w: { name: string }) => w.name === run.run_id);
    const keep = window.panes.filter((p: { key: string }) => !p.key.endsWith('lane-2')).map((p: { id: string }) => p.id);
    window.panes = window.panes.filter((p: { key: string }) => !p.key.endsWith('lane-2')); f.saveState(s);
    let n = f.calls().length; now += 90000;
    for (const type of ['heartbeat', 'worker_output', 'task_state_change', 'gate_started']) dashboardEvent(f.home, type, {});
    assert.equal(f.calls().length, n); assert.equal(tasks.length, 1);
    dashboardEvent(f.home, 'lane_assigned', {}); await Promise.all(tasks);
    assert.equal(f.calls().slice(n).filter(c => c.argv[0] === 'split-window').length, 1);
    s = f.state(); const panes = s.sessions[session].windows.find((w: { name: string }) => w.name === run.run_id).panes;
    assert.ok(keep.every((id: string) => panes.some((p: { id: string }) => p.id === id)));
    s.sessions = { 'user-work': { owner: '', options: {}, windows: [] } }; f.saveState(s); now += 5000;
    dashboardEvent(f.home, 'lane_released', {}); await Promise.all(tasks);
    assert.ok(f.state().sessions['user-work']); assert.equal(f.state().sessions[session].windows.length, 2);
    // Index is repaired only on a trigger as well.
    s = f.state(); s.sessions[session].windows = s.sessions[session].windows.filter((w: { name: string }) => w.name !== 'index'); f.saveState(s);
    now += 5000; dashboardEvent(f.home, 'plan_ready', {}); await Promise.all(tasks);
    assert.equal(f.state().sessions[session].windows.filter((w: { name: string }) => w.name === 'index').length, 1);
  }, { now: () => now, launch: () => { tasks.push(ensureDashboard(f.paths, run.run_id)); } });
  const n = tasks.length; dashboardEvent(f.home, 'lane_assigned', {}); assert.equal(tasks.length, n, 'outside supervisor scope is read-only');
});

test('M4 AC-22 retained selection expiry reopening and oldest terminal eviction never kills active windows', async t => {
  const f = tmuxFixture(t), now = Date.parse('2026-10-28T12:00:00Z');
  writeFileSync(f.config, JSON.stringify({ version: 1, dashboard: { max_windows: 2, retain_finished_min: 1 } }));
  const ids = [0, 1, 2, 3].map(i => `j_20261028_1200_000${i}`);
  for (const [i, id] of ids.entries()) f.save('jobs', id, { ...job(id), state: i === 3 ? 'running' : 'succeeded', updated_at: new Date(now).toISOString(), state_history: [{ state: i === 3 ? 'running' : 'succeeded', at: new Date(now - (3 - i) * 10000).toISOString(), by: 'gbdev' }] });
  for (const id of ids.slice(0, 3)) assert.equal((await ensureDashboard(f.paths, id, now)).reason, null);
  assert.equal((await ensureDashboard(f.paths, ids[3], now)).reason, null);
  const own = () => f.state().sessions[identity(f.home).session].windows as { name: string; id: string }[];
  assert.deepEqual(own().filter(w => w.name !== 'index').map(w => w.name).sort(), ids.slice(2));
  const activeWid = own().find(w => w.name === ids[3])!.id;
  const n = f.calls().length; await ensureDashboard(f.paths, undefined, now);
  assert.ok(f.calls().slice(n).every(c => !['new-window', 'kill-window'].includes(c.argv[0]!)), 'cap must not churn');
  // Fake tmux does not execute renderers: model their independently tested LINGER exit.
  const expired = f.state(); expired.sessions[identity(f.home).session].windows = own().filter(w => w.name === 'index' || w.name === ids[3]); f.saveState(expired);
  await ensureDashboard(f.paths, undefined, now + 70000); assert.deepEqual(own().map(w => w.name).sort(), ['index', ids[3]!].sort());
  await ensureDashboard(f.paths, ids[0], now + 70000); assert.ok(own().some(w => w.name === ids[0]));
  await ensureDashboard(f.paths, undefined, now + 71000); assert.ok(own().some(w => w.name === ids[0]), 'reopen remains present at cap; over-cap retention is tested separately');
  assert.ok(f.calls().every(c => c.argv[0] !== 'kill-window' || c.argv.at(-1) !== activeWid));
  assert.deepEqual(desired(f.home, undefined, { ...DASHBOARD_DEFAULTS, retain_finished_min: 1 }, now + 70000).windows.map(w => w.id), [ids[3]]);
  // Activity alone exceeding max_windows remains untouched.
  writeFileSync(f.config, JSON.stringify({ version: 1, dashboard: { max_windows: 1 } }));
  for (const id of ids) f.save('jobs', id, { ...job(id), state: 'running' });
  await ensureDashboard(f.paths, undefined, now); assert.equal(own().length, 5);
});

for (const mode of ['missing', 'fail', 'hang', 'old-version']) test(`M4 AC-12 ${mode} detached ensure cannot change fake run outcome or event sequence`, async t => {
  const tmux = tmuxFixture(t); tmux.control.mode = mode; tmux.saveControl();
  let baseline: { run: unknown; events: unknown; exitCodes: unknown } | undefined;
  for (const enabled of [false, true]) {
    await t.test(enabled ? 'dashboard failure' : 'disabled baseline', async t => {
      const f = runFixture(t); f.request.tasks = f.request.tasks!.slice(0, 1); f.request.lanes = 1;
      testEnv(t, { GBDEV_DASHBOARD: enabled ? '1' : '0', GBDEV_TMUX_BIN: mode === 'missing' ? join(tmux.root, 'missing') : tmux.bin });
      f.savePlan(); const initial = await startRun(f.store, f.request, false);
      let heartbeat = Date.now(), maxGap = 0;
      await superviseRun(f.store, initial.run_id, { beforePublish: () => { const now = Date.now(); maxGap = Math.max(maxGap, now - heartbeat); heartbeat = now; } });
      const run = readRun(f.store, initial.run_id); assert.ok(maxGap <= 35000, `supervisor heartbeat gap ${maxGap}ms`);
      if (enabled) await until(() => activeEnsures.size === 0, 18000);
      assert.equal(run.state, 'succeeded'); f.invariants(run.run_id);
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v: unknown) => {
        if (['supervisor_pid', 'heartbeat_at'].includes(key)) return null;
        return typeof v === 'string' ? v.replaceAll(f.root, '<root>').replace(/[jpr]_\d{8}_\d{4}_[a-f0-9]{4}/g, '<id>').replace(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)/g, '<time>').replace(/\b[a-f0-9]{40}\b/g, '<sha>') : v;
      }));
      const events = readFileSync(runPaths(f.store, run.run_id).events, 'utf8').trim().split('\n').map(s => JSON.parse(s));
      const warnings = events.filter(e => e.type === 'warning' && e.data.code === 'dashboard_unavailable'); assert.ok(warnings.length <= 1);
      const exitCodes = ['status', 'wait', 'result', 'cancel'].map(command => {
        const output = spawnSync(process.execPath, [resolve('dist/cli.js'), 'run', command, run.run_id, ...(command === 'wait' ? ['--timeout-ms', '0'] : []), '--json'], {
          env: { ...process.env, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config }, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(output.error, undefined); assert.equal(output.signal, null);
        assert.equal(output.status, 0, `${command}: ${output.stdout} ${output.stderr}`);
        return [command, output.status];
      });
      const evidence = { exitCodes, run: normalize(readRun(f.store, run.run_id)), events: normalize(events.filter(e => !warnings.includes(e)).map(({ seq: _seq, ...e }) => e)) };
      if (!enabled) baseline = evidence; else assert.deepEqual(evidence, baseline);
    });
  }
});

test('M4 AC-25 start hint projection preserves every existing JSON byte and disabled watch hints', async t => {
  const f = tmuxFixture(t), calls = immediateHintTmux(t);
  const fixtures = [job(), JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8'))];
  const pipeline = { ...fixtures[0], schema: 'gbdev.pipeline-run.v1', pipeline_id: 'p_20261028_1200_abcd', state: 'starting', steps: [] }; fixtures.push(pipeline);
  for (const value of fixtures) {
    const kind = value.run_id ? 'run' : value.pipeline_id ? 'pipeline' : 'job', id = value.run_id ?? value.pipeline_id ?? value.job_id;
    const before = JSON.stringify(value), projected = await addDashboard(f.paths, value, id, kind), after = JSON.stringify(projected);
    assert.equal(after.slice(0, before.length - 1), before.slice(0, -1));
    const { dashboard, ...legacy } = projected; assert.equal(JSON.stringify(legacy), before);
    const attach = `tmux attach -t ${identity(f.home).session}`, watch = kind === 'job' ? `gbdev logs ${id} --follow` : `gbdev ${kind} watch ${id}`;
    assert.equal(dashboard.reason, null); assert.equal(dashboard.attach_hint, attach); assert.equal(dashboard.watch_hint, watch);
    assert.equal(dashboardHintText(projected), `${attach}; ${watch}\n`);
    process.env.GBDEV_DASHBOARD = '0';
    const count = calls.length, disabled = await addDashboard(f.paths, value, id, kind);
    const { dashboard: disabledHint, ...disabledLegacy } = disabled;
    assert.equal(JSON.stringify(disabledLegacy), before);
    assert.equal(disabledHint.enabled, false); assert.equal(disabledHint.reason, 'disabled_by_env');
    assert.equal(disabledHint.attach_hint, null); assert.equal(disabledHint.watch_hint, watch);
    assert.equal(dashboardHintText(disabled), `${watch}\n`); assert.equal(calls.length, count);
    process.env.GBDEV_DASHBOARD = '1';
  }
  assert.deepEqual(calls.map(args => args[0]), ['-V', 'has-session', 'has-session', 'has-session']);
});

for (const elapsed of [999, 1000]) test(`M4 start hint shared 1s deadline after version probe: ${elapsed}ms`, async t => {
  const f = tmuxFixture(t), calls = immediateHintTmux(t, '', elapsed), unit = job();
  f.save('jobs', unit.job_id, unit);
  const before = JSON.stringify(unit), projected = await addDashboard(f.paths, unit, unit.job_id, 'job');
  const { dashboard, ...legacy } = projected, expired = elapsed === 1000;
  assert.deepEqual(calls.map(args => args[0]), ['-V', 'has-session']);
  assert.equal(dashboard.enabled, true); assert.equal(dashboard.reason, expired ? 'tmux_timeout' : null);
  assert.equal(dashboard.attach_hint, expired ? null : `tmux attach -t ${identity(f.home).session}`);
  assert.equal(dashboard.watch_hint, `gbdev logs ${unit.job_id} --follow`);
  assert.equal(dashboardHintText(projected), `${expired ? '' : dashboard.attach_hint + '; '}${dashboard.watch_hint}\n`);
  assert.equal(JSON.stringify(projected).slice(0, before.length - 1), before.slice(0, -1));
  assert.equal(JSON.stringify(legacy), before); assert.equal(JSON.stringify(unit), before);
  assert.equal(readFileSync(join(f.home, 'jobs', unit.job_id, 'job.json'), 'utf8'), before);
});

test('M4 AC-25 standalone job and pipeline CLI JSON adds dashboard without persisting it', async t => {
  const f = pipelineFixture(t); f.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT;
  const started = unwrap((await f.command(['start', '--brief', f.briefFile])).envelope) as ReturnType<typeof job> & { dashboard: { attach_hint: null; watch_hint: string } };
  assert.equal(started.dashboard.attach_hint, null); assert.equal(started.dashboard.watch_hint, `gbdev logs ${started.job_id} --follow`);
  await f.waitJob(started.job_id); assert.ok(!('dashboard' in f.getJob(started.job_id)));
  const p = unwrap((await f.launch()).envelope) as { pipeline_id: string; dashboard: { attach_hint: null; watch_hint: string } };
  assert.equal(p.dashboard.attach_hint, null); assert.equal(p.dashboard.watch_hint, `gbdev pipeline watch ${p.pipeline_id}`);
  await f.wait(p.pipeline_id); assert.ok(!('dashboard' in f.read(p.pipeline_id)));
});

test('M4 AC-27 NODE_TEST_CONTEXT fake run and child supervisors never invoke PATH tmux', async t => {
  const f = runFixture(t), bin = join(f.root, 'bin'), marker = join(f.root, 'tmux-called'); mkdirSync(bin);
  copyFileSync('test/fixtures/fake-tmux.js', join(bin, 'tmux')); chmodSync(join(bin, 'tmux'), 0o755);
  writeFileSync(join(bin, 'tmux.json'), JSON.stringify({ mode: 'fail', log: marker }));
  testEnv(t, { PATH: bin + ':' + process.env.PATH!, GBDEV_DASHBOARD: '', GBDEV_TMUX_BIN: '' }); delete process.env.GBDEV_DASHBOARD; delete process.env.GBDEV_TMUX_BIN;
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded'); assert.equal(existsSync(marker), false); assert.equal(activeEnsures.size, 0);
});

test('M4 AC-25 run start CLI JSON adds hints and keeps persisted run schema unchanged', async t => {
  const f = runFixture(t); testEnv(t, { GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config });
  const file = join(f.root, 'request.json'); writeFileSync(file, JSON.stringify(f.request));
  const stdout = execFileSync(process.execPath, [resolve('dist/cli.js'), 'run', 'start', '--request', file, '--json'], { env: process.env, encoding: 'utf8', timeout: 10000 });
  const { result } = JSON.parse(stdout);
  try {
    assert.equal(result.dashboard.attach_hint, null); assert.equal(result.dashboard.watch_hint, `gbdev run watch ${result.run_id}`);
    assert.ok(!('dashboard' in readRun(f.store, result.run_id)));
    await until(() => ['succeeded', 'failed', 'cancelled'].includes(readRun(f.store, result.run_id).state), 20000);
    assert.equal(readRun(f.store, result.run_id).state, 'succeeded');
  } finally {
    try { await cancelRun(f.store, result.run_id); }
    finally { await waitForCliChildren([result.run_id]); }
  }
});

test('M4 T10 exact event allowlist and nested supervisors share one top-level debounce', async t => {
  const f = tmuxFixture(t); let now = 0, launches = 0;
  await withDashboard(f.paths, 'r_20261028_1200_abcd', () => {}, async () => {
    await withDashboard(f.paths, 'p_20261028_1200_abcd', () => assert.fail('nested warning sink'), async () => {
      assert.equal(launches, 1);
      for (const type of ['lane_assigned', 'lane_released', 'plan_ready', 'run_state_change', 'decision_required', 'step_started', 'state_change']) {
        now += 5000; const before: number = launches; dashboardEvent(f.home, type, { state: 'running' }); assert.equal(launches, before + 1, type);
      }
      now += 5000; const before: number = launches;
      dashboardEvent(f.home, 'state_change', { state: 'succeeded' }); dashboardEvent(f.home, 'heartbeat', {}); dashboardEvent(f.home + '-other', 'lane_assigned', {});
      assert.equal(launches, before);
    });
  }, { now: () => now, launch: () => { launches++; } });
});

test('M4 T13 warning persists at most once across supervisor restarts and spawn does not await ensure', async t => {
  const f = tmuxFixture(t), store = new JobStore(f.paths), unit = job(); store.create(unit);
  f.control.mode = 'hang'; f.saveControl();
  for (let i = 0; i < 2; i++) {
    const start = Date.now(); const value = await dashboardSupervision(store, unit.job_id, async () => 'worker-independent');
    assert.equal(value, 'worker-independent'); assert.ok(Date.now() - start < 1000); assert.ok(activeEnsures.size > 0);
    const child = [...activeEnsures][0]!;
    assert.equal(Number(execFileSync('ps', ['-p', String(child.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim()), child.pid);
    assert.notEqual(child.pid, process.pid);
    await until(() => activeEnsures.size === 0, 18000);
  }
  const warnings = readFileSync(join(f.home, 'jobs', unit.job_id, 'events.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(warnings.length, 1); assert.deepEqual(warnings[0].data, { code: 'dashboard_unavailable', reason: 'tmux_timeout' });
  assert.equal(store.read(unit.job_id).state, unit.state);
});

for (const mode of ['foreign', 'old-version', 'missing']) test(`M4 AC-25 ${mode} start hint never suggests attaching to unavailable or foreign session`, async t => {
  const f = tmuxFixture(t), calls = immediateHintTmux(t, mode);
  if (mode === 'missing') process.env.GBDEV_TMUX_BIN = join(f.root, 'missing');
  const unit = job(), output = await addDashboard(f.paths, unit, unit.job_id, 'job');
  assert.equal(output.dashboard.enabled, true); assert.equal(output.dashboard.attach_hint, null);
  assert.equal(output.dashboard.reason, mode === 'foreign' ? 'foreign_session' : mode === 'old-version' ? 'tmux_too_old' : 'tmux_not_found');
  assert.equal(output.dashboard.watch_hint, `gbdev logs ${unit.job_id} --follow`);
  assert.deepEqual(calls.map(args => args[0]), mode === 'missing' ? [] : mode === 'old-version' ? ['-V'] : ['-V', 'has-session', 'show-options']);
});

for (const max of [1, 2]) test(`M4 AC-22 reopen survives over-cap eviction for a full interval max=${max}`, async t => {
  const f = tmuxFixture(t), now = Date.parse('2026-10-28T12:00:00Z');
  writeFileSync(f.config, JSON.stringify({ version: 1, dashboard: { max_windows: max, retain_finished_min: 1 } }));
  const [a, b, c] = ['000a', '000b', '000c'].map(suffix => `j_20261028_1200_${suffix}`) as [string, string, string];
  f.save('jobs', a, { ...job(a), state: 'running' });
  const ended = (id: string, end: number) => f.save('jobs', id, { ...job(id), state: 'succeeded', state_history: [{ state: 'succeeded', at: new Date(end).toISOString(), by: 'gbdev' }] });
  if (max === 2) ended(b, now - 10000);
  ended(c, now - 3600000);
  await ensureDashboard(f.paths, undefined, now);
  const opened = await ensureDashboard(f.paths, c, now); assert.equal(opened.reason, null);
  assert.ok(opened.windows.some(w => w.unit_id === c));
  if (max === 2) assert.ok(!opened.windows.some(w => w.unit_id === b), 'newer B, not reopened C, is evicted in the target round');
  const originalWid = opened.windows.find(w => w.unit_id === c)!.window_id;
  const own = () => f.state().sessions[identity(f.home).session].windows as { name: string; id: string; options: Record<string, string> }[];
  assert.equal(own().find(w => w.name === c)!.options['@gbdev_reopened_at'], String(now));
  for (const elapsed of [1, 30000, 59999]) {
    const status = await ensureDashboard(f.paths, undefined, now + elapsed); assert.equal(status.reason, null);
    assert.ok(status.windows.some(w => w.unit_id === c && w.window_id === originalWid), 'same reopened window survives despite cap pressure');
    assert.ok(status.windows.some(w => w.unit_id === a));
    if (max === 2 && elapsed === 1) assert.equal(status.windows.length, 3, 'recreated B supplies real cap pressure in the next ensure round');
    assert.equal(own().find(w => w.name === c)!.options['@gbdev_reopened_at'], String(now), 'ordinary ensure does not renew retention');
  }
  // Fake panes do not exit: force cap pressure after expiry, then require eviction.
  if (max === 2) {
    const d = 'j_20261028_1200_000d'; f.save('jobs', d, { ...job(d), state: 'running' });
  }
  const expired = await ensureDashboard(f.paths, undefined, now + 60000);
  assert.ok(!expired.windows.some(w => w.unit_id === c));
  assert.ok(f.calls().some(call => call.argv[0] === 'kill-window' && call.argv.at(-1) === originalWid));
});

test('M4 start hint hanging tmux has a short total budget and preserves payload and state', async t => {
  const f = tmuxFixture(t), unit = job(); f.save('jobs', unit.job_id, unit);
  f.control.mode = 'hang'; f.saveControl();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const before = JSON.stringify(unit);
  let settled = false;
  const pending = addDashboard(f.paths, unit, unit.job_id, 'job').then(value => { settled = true; return value; });
  t.mock.timers.tick(999); await Promise.resolve();
  assert.equal(settled, false, 'hanging probe still has 1ms of its start budget');
  t.mock.timers.tick(1);
  const { dashboard, ...legacy } = await pending;
  assert.equal(Date.now(), 11000, 'start probe expires at 1s, not the normal 10s budget');
  assert.equal(dashboard.enabled, true); assert.equal(dashboard.reason, 'tmux_timeout');
  assert.equal(dashboard.attach_hint, null); assert.equal(dashboard.watch_hint, `gbdev logs ${unit.job_id} --follow`);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(readFileSync(join(f.home, 'jobs', unit.job_id, 'job.json'), 'utf8'), before);
});

test('M4 warning message then exit after lock rejection does not spend another retry', async () => {
  let now = 0, attempts = 0;
  const failures: ((reason: string) => void)[] = [], warnings: string[] = [];
  const trigger = new DashboardTrigger(fail => failures.push(fail), reason => {
    attempts++;
    if (attempts === 1) return Promise.reject(new Error('lock busy'));
    warnings.push(reason); return Promise.resolve();
  }, () => now);
  trigger.fire(); failures[0]!('tmux_timeout'); // IPC message
  await new Promise(resolve => setImmediate(resolve)); // Lock write has failed before exit.
  failures[0]!('tmux_error'); // Nonzero exit of the same ensure must not retry.
  assert.equal(attempts, 1); assert.deepEqual(warnings, []);
  now = 5000; trigger.fire(); failures[1]!('foreign_session'); failures[1]!('tmux_error');
  assert.equal(attempts, 2);
  await new Promise(resolve => setImmediate(resolve));
  now = 10000; trigger.fire(); failures[2]!('tmux_error');
  assert.equal(attempts, 2); assert.deepEqual(warnings, ['foreign_session']);
});

test('M4 warning rejected write releases pending before the next ensure failure microtask', async () => {
  let now = 0, attempts = 0;
  const failures: ((reason: string) => void)[] = [];
  const trigger = new DashboardTrigger(fail => failures.push(fail), () => {
    attempts++;
    return attempts === 1 ? Promise.reject(new Error('lock busy')) : Promise.resolve();
  }, () => now);
  trigger.fire(); failures[0]!('tmux_timeout');
  await Promise.resolve();
  now = 5000; trigger.fire(); failures[1]!('tmux_error');
  assert.equal(attempts, 2, 'next ensure retries without waiting for a separate finally microtask');
  await Promise.resolve();
  now = 10000; trigger.fire(); failures[2]!('tmux_error'); assert.equal(attempts, 2);
});

test('M4 warning lock failure is retryable and concurrent callbacks persist at most once', async t => {
  const f = tmuxFixture(t), store = new JobStore(f.paths), unit = job(); store.create(unit);
  // An unreadable lock path makes acquireLock fail before the event write.
  mkdirSync(f.paths.lock);
  let failed!: (reason: string) => void, now = 0;
  await dashboardSupervision(store, unit.job_id, async () => {
    failed('tmux_timeout'); failed('tmux_error');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(existsSync(join(f.home, 'jobs', unit.job_id, 'events.jsonl')), false);
    rmSync(f.paths.lock, { recursive: true });
    now = 5000; dashboardEvent(f.home, 'state_change', { state: 'running' });
    failed('tmux_timeout'); failed('tmux_error');
    await new Promise(resolve => setImmediate(resolve));
    failed('foreign_session');
  }, { now: () => now, launch: callback => { failed = callback; } });
  const lines = readFileSync(join(f.home, 'jobs', unit.job_id, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]!).data.reason, 'tmux_timeout');
});


test('M4 AC-12 start CLI exit code matches disabled baseline for every tmux failure', async t => {
  const tmux = tmuxFixture(t); let baseline: number | null | undefined;
  for (const mode of ['disabled', 'missing', 'fail', 'hang', 'old-version']) await t.test(mode, async t => {
    const f = runFixture(t); f.request.tasks = f.request.tasks!.slice(0, 1); f.request.lanes = 1;
    const request = join(f.root, 'request.json'); writeFileSync(request, JSON.stringify(f.request));
    tmux.control.mode = mode; tmux.saveControl();
    const output = spawnSync(process.execPath, [resolve('dist/cli.js'), 'run', 'start', '--request', request, '--json'], {
      env: { ...process.env, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config, GBDEV_DASHBOARD: mode === 'disabled' ? '0' : '1', GBDEV_TMUX_BIN: mode === 'missing' ? join(tmux.root, 'missing') : tmux.bin },
      encoding: 'utf8', timeout: 10000,
    });
    const result = JSON.parse(output.stdout).result;
    try {
      assert.equal(output.error, undefined); assert.equal(output.signal, null);
      assert.equal(output.status, 0, output.stdout + output.stderr);
      if (mode === 'disabled') baseline = output.status; else assert.equal(output.status, baseline);
      if (mode === 'hang') { assert.equal(result.dashboard.reason, 'tmux_timeout'); assert.equal(result.dashboard.attach_hint, null); }
      await until(() => ['succeeded', 'failed', 'cancelled'].includes(readRun(f.store, result.run_id).state), 20000);
      assert.equal(readRun(f.store, result.run_id).state, 'succeeded');
    } finally {
      if (result?.run_id) {
        try { await cancelRun(f.store, result.run_id); }
        finally { await waitForCliChildren([result.run_id]); }
      }
    }
  });
});

test('M4 D-M4-3 startup empty lanes still creates fixed topology before debounced assignments', async t => {
  const f = tmuxFixture(t), run = JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8')), assigned = structuredClone(run.lanes);
  run.lanes = []; run.state = 'starting'; f.save('runs', run.run_id, run);
  writeFileSync(join(f.home, 'runs', run.run_id, 'request.json'), JSON.stringify({ schema: 'gbdev.run-request.v1', lanes: 2 }));
  let now = 0; const tasks: Promise<unknown>[] = [];
  await withDashboard(f.paths, run.run_id, () => {}, async () => {
    await Promise.all(tasks);
    const panes = () => f.state().sessions[identity(f.home).session].windows.find((w: { name: string }) => w.name === run.run_id).panes as { id: string; key: string }[];
    const first = panes();
    assert.deepEqual(first.map(p => p.key.split(':').at(-1)), ['status', 'lane-1', 'lane-2', 'integration']);
    assert.deepEqual(first.map(p => p.id), ['%2', '%3', '%4', '%5']); // fake tmux starts its index at %1
    run.lanes = assigned; run.state = 'running'; f.save('runs', run.run_id, run);
    now = 2000; dashboardEvent(f.home, 'lane_assigned', {}); dashboardEvent(f.home, 'step_started', {});
    assert.equal(tasks.length, 1, 'T10 stays leading-only; no periodic or trailing repair');
    assert.deepEqual(panes(), first, 'lanes already exist when assignment is debounced');
    const n = f.calls().length; now = 155000; dashboardEvent(f.home, 'step_started', {}); await Promise.all(tasks);
    assert.equal(tasks.length, 2); assert.deepEqual(panes(), first);
    assert.ok(f.calls().slice(n).every(c => !['split-window', 'respawn-pane', 'new-window'].includes(c.argv[0]!)));
  }, { now: () => now, launch: () => { tasks.push(ensureDashboard(f.paths, run.run_id)); } });
});

test('M4 D-M4-3 planned lane projection validates count and preserves observed lanes', t => {
  const f = tmuxFixture(t), run = JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8'));
  run.lanes = []; f.save('runs', run.run_id, run);
  const request = join(f.home, 'runs', run.run_id, 'request.json');
  for (const lanes of [0, 5, 2.5, '2', null]) {
    writeFileSync(request, JSON.stringify({ schema: 'gbdev.run-request.v1', lanes }));
    assert.equal(desired(f.home, run.run_id).windows[0]!.panes.length, 2);
  }
  writeFileSync(request, JSON.stringify({ schema: 'gbdev.run-request.v1', lanes: 2 }));
  assert.equal(desired(f.home, run.run_id).windows[0]!.panes.length, 4);
  run.lanes = JSON.parse(readFileSync('test/fixtures/m3-run.json', 'utf8')).lanes; f.save('runs', run.run_id, run);
  writeFileSync(request, JSON.stringify({ schema: 'wrong', lanes: 4 }));
  assert.deepEqual(desired(f.home, run.run_id).windows[0]!.panes.map(p => p.name), ['status', 'lane-1', 'lane-2', 'integration']);
});
