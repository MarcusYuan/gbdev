import assert from 'node:assert/strict';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { acquireLock, isProcessAlive, withLock } from '../src/core/lock.js';
import { atomicWriteJson, JobStore } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { errorCode, job, temporary } from './helpers.js';

test('lock: O_EXCL prevents concurrent owners, pid content, idempotent release and reacquisition', t => {
  const path = join(temporary(t), 'home', 'lock');
  const lock = acquireLock(path);
  t.after(() => lock.release());
  assert.equal(readFileSync(path, 'utf8').trim(), String(process.pid));
  assert.throws(() => acquireLock(path), errorCode('busy'));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import {acquireLock} from "./dist/core/lock.js"; try { acquireLock(process.argv[1]); process.exitCode = 9; } catch(e) { console.log(e.contract.code); }', path],
    { encoding: 'utf8', env: {} });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'busy');
  lock.release();
  lock.release();
  assert.equal(existsSync(path), false);
  acquireLock(path).release();
});

test('lock: dead pid locks are reclaimed; malformed/zero/live owners are not stolen', t => {
  const path = join(temporary(t), 'lock');
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', env: {} });
  assert.equal(child.status, 0);
  const pid = Number(child.stdout.trim());
  assert.equal(isProcessAlive(pid), false);
  writeFileSync(path, `${pid}\n`);
  const lock = acquireLock(path);
  assert.equal(readFileSync(path, 'utf8').trim(), String(process.pid));
  lock.release();
  for (const content of ['', 'broken', '0', '-1', '1e2', '999999999999999999999999', String(process.pid)]) {
    writeFileSync(path, content);
    assert.throws(() => acquireLock(path), errorCode('busy'));
    assert.equal(readFileSync(path, 'utf8'), content);
  }
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), true);
});

test('lock: releasing an old handle must not remove a replacement lock', t => {
  const path = join(temporary(t), 'lock');
  const old = acquireLock(path);
  t.after(() => old.release());
  unlinkSync(path);
  const replacement = acquireLock(path);
  t.after(() => replacement.release());
  old.release();
  assert.equal(existsSync(path), true);
  assert.throws(() => acquireLock(path), errorCode('busy'));
});

test('lock: withLock releases on return, synchronous throw and asynchronous rejection', async t => {
  const path = join(temporary(t), 'lock');
  assert.equal(await withLock(path, () => 42), 42);
  assert.equal(existsSync(path), false);
  await assert.rejects(withLock(path, () => { throw new Error('sync'); }), /sync/);
  assert.equal(existsSync(path), false);
  await assert.rejects(withLock(path, async () => { throw new Error('async'); }), /async/);
  assert.equal(existsSync(path), false);
});

test('atomic JSON: rename replaces the file atomically, keeps old handles intact and leaves no tmp', t => {
  const root = temporary(t);
  const file = join(root, 'job.json');
  atomicWriteJson(file, { version: 1 });
  const fd = openSync(file, 'r');
  t.after(() => closeSync(fd));
  const before = fstatSync(fd);
  atomicWriteJson(file, { version: 2 });
  assert.notEqual(statSync(file).ino, before.ino);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2 });
  assert.deepEqual(JSON.parse(readFileSync(fd, 'utf8')), { version: 1 });
  assert.deepEqual(readdirSync(root), ['job.json']);
  const directory = join(root, 'directory');
  mkdirSync(directory);
  assert.throws(() => atomicWriteJson(directory, { x: 1 }));
  assert.equal(readdirSync(root).some(name => name.endsWith('.tmp')), false);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => atomicWriteJson(file, circular));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2 });
});

test('job store: create/read/update, duplicate protection, no implicit creation or partial writes', t => {
  const paths = resolvePaths({ GBDEV_HOME: join(temporary(t), 'home') });
  const store = new JobStore(paths);
  const value = job();
  assert.deepEqual(store.list(), []);
  store.create(value);
  assert.deepEqual(store.read(value.job_id), value);
  assert.throws(() => store.create(value), errorCode('internal_error'));
  const running = { ...value, state: 'running' as const, pid: process.pid,
    state_history: [...value.state_history, { state: 'running' as const, at: value.updated_at, by: 'gbdev' }] };
  store.write(running);
  assert.deepEqual(store.read(value.job_id), running);
  assert.throws(() => store.write({ ...running, pid: -1 }), errorCode('config_invalid'));
  assert.deepEqual(store.read(value.job_id), running);
  const missing = job('j_20261025_1131_ffff');
  assert.throws(() => store.read(missing.job_id), errorCode('job_not_found'));
  assert.throws(() => store.write(missing), errorCode('job_not_found'));
  assert.throws(() => store.read('../escape'), errorCode('config_invalid'));
  assert.deepEqual(readdirSync(jobPaths(paths, value.job_id).dir), ['job.json']);
});

test('job store: latest 50 jobs sorted by actual creation instant, ignores unrelated entries', t => {
  const paths = resolvePaths({ GBDEV_HOME: temporary(t) });
  const store = new JobStore(paths);
  for (let i = 0; i < 52; i++) {
    store.create(job(`j_20261025_1131_${i.toString(16).padStart(4, '0')}`, new Date(Date.UTC(2026, 9, 25, 18, i))));
  }
  mkdirSync(join(paths.jobs, 'not-a-job'));
  writeFileSync(join(paths.jobs, 'j_20261025_1131_ffff'), 'not a directory');
  const jobs = store.list();
  assert.equal(jobs.length, 50);
  assert.equal(jobs[0]!.job_id, 'j_20261025_1131_0033');
  assert.equal(jobs.at(-1)!.job_id, 'j_20261025_1131_0002');
  assert.equal(store.list(1).length, 1);
  for (const bad of [0, 51, 1.5]) assert.throws(() => store.list(bad), errorCode('config_invalid'));
});

test('job store: corrupted JSON, invalid schema and directory/job_id mismatch are reported, not hidden', t => {
  const paths = resolvePaths({ GBDEV_HOME: temporary(t) });
  const store = new JobStore(paths);
  const value = job();
  store.create(value);
  for (const content of ['{broken', '{}', JSON.stringify(job('j_20261025_1131_ffff'))]) {
    writeFileSync(jobPaths(paths, value.job_id).job, content);
    assert.throws(() => store.read(value.job_id), errorCode('internal_error'));
    assert.throws(() => store.list(), errorCode('internal_error'));
  }
});
