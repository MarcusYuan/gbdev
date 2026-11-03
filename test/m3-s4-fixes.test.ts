import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { acquireLock as acquireTestLock } from '../src/core/lock.js';
import test from 'node:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './helpers/m3.js';
import { startRun, cancelRun } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { readRun, runPaths } from '../src/run/store.js';
import { mergeRecords } from '../src/run/result.js';
import { git, head } from '../src/core/git.js';
import { findExecutable, terminateGroup } from '../src/core/proc.js';
import { testEnv } from './helpers/run.js';
import { GbdevError } from '../src/contracts/error.js';
import { acquireIntegrationLock } from '../src/run/integrationLock.js';

test('F14 cancel timeout returns retryable cancel_pending, never active success', async t => {
  const f = fixture(t); const run = await startRun(f.store, f.request, false);
  const { localSupervisors } = await import('../src/run/reconcile.js'); localSupervisors.add(run.run_id); t.after(() => localSupervisors.delete(run.run_id));
  const { writeRun } = await import('../src/run/store.js'); run.supervisor_pid = process.pid; writeRun(f.store, run);
  await assert.rejects(cancelRun(f.store, run.run_id, 5), e => e instanceof GbdevError && e.contract.code === 'run_not_settled' && e.contract.retryable && e.contract.details.reason === 'cancel_pending');
});
test('F14 cancellation interrupts slow merge-tree instead of blocking event loop', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  const real = findExecutable('git')!, bin = join(f.root, 'bin'), marker = join(f.root, 'precheck'); mkdirSync(bin);
  const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" merge-tree "*) echo waiting > ${q(marker)}; sleep 30;; esac\nexec ${q(real)} "$@"\n`, { mode: 0o755 }); testEnv(t, { PATH: `${bin}:${process.env.PATH}` });
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { try { await cancelRun(f.store, initial.run_id); } finally { await work; } };
  await until(() => existsSync(marker)); const time = Date.now(); const done = await cancelRun(f.store, initial.run_id); await work;
  assert.equal(done.state, 'cancelled'); assert.ok(Date.now() - time < 5000); f.invariants(initial.run_id);
});
test('F16 publish failure cannot leave an integrated merge record ahead of verified_sha', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; const initial = await startRun(f.store, f.request, false); let injected = false;
  await superviseRun(f.store, initial.run_id, { beforePublish(run) { if (!injected && run.integration.verified_sha !== run.base_sha) { injected = true; throw new Error('injected_publish_failure'); } } });
  const run = readRun(f.store, initial.run_id); assert.equal(injected, true); assert.equal(run.state, 'failed'); assert.equal(run.integration.verified_sha, f.base); assert.equal(head(run.integration.worktree), f.base);
  assert.ok(mergeRecords(f.store, run).every(m => m.result !== 'integrated')); f.invariants(run.run_id);
});
test('F17 moving unrelated refs during run is not integration_corrupt', async t => {
  const f = fixture(t); git(f.repo, ['branch', 'unrelated']); const initial = await startRun(f.store, f.request, false);
  f.commit(f.repo, 'user changes unrelated branch tip'); const moved = head(f.repo); git(f.repo, ['update-ref', 'refs/heads/unrelated', moved]); git(f.repo, ['reset', '--hard', f.base]);
  await superviseRun(f.store, initial.run_id); assert.equal(readRun(f.store, initial.run_id).state, 'succeeded'); f.invariants(initial.run_id);
});
test('F18 SIGKILL waits for group disappearance, timeout throws without proceeding', async t => {
  let alive = true, killed = false, probes = 0;
  const mock = t.mock.method(process, 'kill', (_pid: number, signal?: string | number) => { if (signal === 'SIGKILL') killed = true; if (signal === 0 && killed && ++probes >= 3) alive = false; if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return true; });
  await terminateGroup(123456, 0, 1000); assert.ok(probes >= 3); mock.mock.restore();
  t.mock.method(process, 'kill', () => true); await assert.rejects(terminateGroup(123456, 0, 0), /process_group_still_alive/);
});
test('F19 cancel while waiting for integration lock does not mask error with release TypeError', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { try { await cancelRun(f.store, initial.run_id); } finally { await work; } };
  await until(() => readRun(f.store, initial.run_id).state === 'running'); const lock = acquireIntegrationLock(f.paths, initial.run_id, 'merge');
  await until(() => { const r = readRun(f.store, initial.run_id); return r.tasks[0]!.state === 'merge_queued' && !r.merge_queue.length; });
  writeFileSync(runPaths(f.store, initial.run_id).cancel, '{}'); lock.release(); await work;
  const run = readRun(f.store, initial.run_id); assert.equal(run.state, 'cancelled'); assert.doesNotMatch(readFileSync(runPaths(f.store, initial.run_id).events, 'utf8'), /TypeError/);
});

test('F20 CLI errors accurately name events and since options', async () => {
  const { runCli } = await import('../src/cli.js');
  for (const option of ['--events', '--since']) {
    let output = ''; const code = await runCli(['status', option, ...(option === '--since' ? ['1'] : []), '--json'], { stdout: s => { output += s; }, stderr: s => { output += s; } });
    assert.equal(code, 2); assert.match(output, /--events\/--since.*run status/);
  }
});

test('F18 recovery refuses reset while a recorded integration writer group is alive', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t), run = await startRun(f.store, f.request, false);
  const { openIntegration } = await import('../src/run/integration.js'); const { restoreRunIntegration } = await import('../src/run/reconcile.js');
  const { spawnProcess, groupAlive } = await import('../src/core/proc.js');
  run.integration = await openIntegration({ ...f, run_id: run.run_id }, f.base);
  writeFileSync(join(run.integration.worktree, 'unverified-evidence'), 'keep while writer alive');
  const child = await spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  cleanup = async () => { if (groupAlive(child.pid!)) await terminateGroup(child.pid!, 100); };
  const dir = join(runPaths(f.store, run.run_id).dir, 'processes'); mkdirSync(dir); writeFileSync(join(dir, `${child.pid}.json`), JSON.stringify({ pgid: child.pid, worktree: run.integration.worktree }));
  await assert.rejects(restoreRunIntegration(f.store, run), /process_group_still_alive/); assert.equal(existsSync(join(run.integration.worktree, 'unverified-evidence')), true);
  await terminateGroup(child.pid!, 100); await restoreRunIntegration(f.store, run); assert.equal(existsSync(join(run.integration.worktree, 'unverified-evidence')), false);
});

test('AC-S4.4 global lock publishes PID atomically even if killed immediately after publication', t => {
  const f = fixture(t), path = join(f.root, 'crash-global-lock');
  const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.linkSync;
fs.linkSync = (from, to) => { if (!/^\\d+\\n$/.test(fs.readFileSync(from, 'utf8')) || fs.existsSync(to)) process.exit(91); original(from, to); process.kill(process.pid, 'SIGKILL'); };
syncBuiltinESMExports(); const { acquireLock } = await import('./dist/core/lock.js'); acquireLock(process.argv[1]);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr); assert.match(readFileSync(path, 'utf8'), /^\d+\n$/);
  const lock = acquireTestLock(path); lock.release(); assert.equal(existsSync(path), false);
});
