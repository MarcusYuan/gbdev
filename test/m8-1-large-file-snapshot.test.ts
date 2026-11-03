import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, openSync, closeSync, readSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRepo } from './helpers/tmpRepo.js';
import { job, worker } from './helpers.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { localIso } from '../src/core/time.js';
import { superviseJob } from '../src/core/supervise.js';
import { finalize } from '../src/core/finalize.js';
import {
  assertSnapshotDecidable, captureWorkspaceSnapshot, captureWorkspaceSnapshotSync, jobFilesChanged, racyUnknownDelayMs,
  readWorkspaceSnapshot, SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_HASH_BYTES, workspaceGenerationFingerprint, WORKSPACE_BEFORE,
} from '../src/core/workspaceSnapshot.js';

const BIG = 12 * 1024 * 1024; // > SNAPSHOT_MAX_HASH_BYTES, like MediaCrawler docs/STZHONGS.TTF
const commitAll = (f: { git: (...a: string[]) => string }, msg: string) => {
  f.git('add', '-A');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
};
function bigBuffer(fill = 7): Buffer { return Buffer.alloc(BIG, fill); }
/** Overwrite one byte in place: same size, then restore the original mtime (ctime still moves). */
function flipByteKeepMtime(file: string): void {
  const before = statSync(file);
  const fd = openSync(file, 'r+');
  try {
    const one = Buffer.alloc(1);
    readSync(fd, one, 0, 1, 1024);
    one[0] = one[0]! ^ 0xff;
    writeSync(fd, one, 0, 1, 1024);
  } finally { closeSync(fd); }
  utimesSync(file, before.atime, before.mtime);
}

function fixture(t: TestContext, sandbox: 'read-only' | 'workspace-write' = 'read-only') {
  const h = tmpRepo(t, 'review_approve', { role: sandbox === 'read-only' ? 'reviewer' : 'executor', sandbox, acceptance_criteria: [] });
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('GBDEV_')) delete process.env[key];
  Object.assign(process.env, h.env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  const store = new JobStore(resolvePaths(h.env));
  const status = { ...job(undefined, new Date()), state: 'starting' as const, repo: h.repo, worktree: h.repo,
    base_sha: h.git('rev-parse', 'HEAD').trim(), role: h.task.role, sandbox,
    state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }] };
  const created = () => {
    status.base_sha = h.git('rev-parse', 'HEAD').trim();
    store.create(status);
    const paths = jobPaths(store.paths, status.job_id);
    atomicWriteJson(paths.brief, h.task);
    atomicWriteJson(join(paths.dir, 'provider.json'), { bin: process.execPath, writable_roots: [], schema_options: { pipelineStep: true, output: sandbox === 'read-only' ? 'verdict' : 'change' } });
    writeFileSync(paths.prompt, 'test large file snapshot');
    writeFileSync(paths.workerLog, '');
    writeFileSync(paths.rawJsonl, '');
    return paths;
  };
  let paths: ReturnType<typeof jobPaths> | undefined;
  const ready = () => (paths ??= created());
  const baseline = async () => {
    const p = ready();
    const snap = await captureWorkspaceSnapshot(h.repo, { job_id: status.job_id, phase: 'before_worker' });
    atomicWriteJson(join(p.dir, WORKSPACE_BEFORE), snap);
    return snap;
  };
  const finish = async () => {
    const p = ready();
    writeFileSync(p.finalMessage, '```json\n' + JSON.stringify({ ...worker(), review: { verdict: 'approve', findings: [] } }) + '\n```');
    return finalize(store, status, h.task, 0);
  };
  return { ...h, store, status, ready, baseline, finish };
}

test('M8.1 clean tracked 12MB file: baseline uses git index identity, no hashing, job succeeds', async t => {
  const f = fixture(t);
  mkdirSync(join(f.repo, 'docs'));
  writeFileSync(join(f.repo, 'docs/STZHONGS.TTF'), bigBuffer());
  commitAll(f, 'add big font');
  f.ready();
  // Even a zero hash budget cannot make a git-clean file unknown.
  const snap = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'before_worker' }, { maxTotalHashBytes: 0 });
  const big = snap.entries.find(e => e.path === 'docs/STZHONGS.TTF')!;
  assert.equal(big.content_unknown, undefined);
  assert.equal(big.content_source, 'git_index');
  assert.match(big.content_hash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(big.content_stat, undefined);
  assert.deepEqual(jobFilesChanged(snap, snap), []);
  assertSnapshotDecidable(snap);
  // B2: a git-proven generation is cacheable and stable.
  const fp = workspaceGenerationFingerprint(snap);
  assert.notEqual(fp, null);
  assert.equal(workspaceGenerationFingerprint(captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_checks' })), fp);
  // Full supervised reviewer job end to end: baseline captured, worker runs, nothing attributed.
  await superviseJob(f.status.job_id, f.store);
  const r = f.result(f.status.job_id);
  assert.equal(r.state, 'succeeded', JSON.stringify(r.failure_reasons ?? r.failure_reason));
  assert.notEqual(r.failure_reason, 'workspace_snapshot_invalid');
  assert.deepEqual(r.gbdev_observed.job_files_changed ?? [], []);
  assert.deepEqual(r.gbdev_observed.policy_violations, []);
  const stored = readWorkspaceSnapshot(join(f.jobDir(f.status.job_id), WORKSPACE_BEFORE));
  assert.equal(stored.entries.find(e => e.path === 'docs/STZHONGS.TTF')?.content_source, 'git_index');
});

test('M8.1 CLI writer job in a repo with a committed 12MB file succeeds', async t => {
  const h = tmpRepo(t);
  mkdirSync(join(h.repo, 'docs'));
  writeFileSync(join(h.repo, 'docs/STZHONGS.TTF'), bigBuffer());
  commitAll(h, 'add big font');
  const status = await h.launch();
  const done = await h.wait(status.job_id);
  assert.equal(done.state, 'succeeded');
  const r = h.result(status.job_id);
  assert.notEqual(r.failure_reason, 'workspace_snapshot_invalid');
  assert.ok(!(r.gbdev_observed.job_files_changed ?? []).includes('docs/STZHONGS.TTF'));
});

for (const how of ['rewrite', 'same-size-same-mtime'] as const) {
  test(`M8.1 modifying the clean tracked 12MB file (${how}) is attributed to the job`, async t => {
    const f = fixture(t);
    mkdirSync(join(f.repo, 'docs'));
    const file = join(f.repo, 'docs/STZHONGS.TTF');
    writeFileSync(file, bigBuffer());
    commitAll(f, 'add big font');
    const before = await f.baseline();
    assert.equal(before.entries.find(e => e.path === 'docs/STZHONGS.TTF')?.content_source, 'git_index');
    if (how === 'rewrite') writeFileSync(file, bigBuffer(9));
    else flipByteKeepMtime(file);
    const r = await f.finish();
    assert.equal(r.state, 'failed');
    assert.notEqual(r.failure_reason, "workspace_snapshot_invalid", JSON.stringify(r));
    assert.deepEqual(r.gbdev_observed.job_files_changed, ['docs/STZHONGS.TTF']);
    assert.ok(r.gbdev_observed.policy_violations.includes('readonly_modified'));
  });
}

test('M8.1 assume-unchanged tracked file is not vouched for by git and its edit is still seen', async t => {
  const f = fixture(t);
  f.git('update-index', '--assume-unchanged', 'src/initial.txt');
  const before = await f.baseline();
  const entry = before.entries.find(e => e.path === 'src/initial.txt')!;
  assert.equal(entry.content_source, undefined);
  writeFileSync(join(f.repo, 'src/initial.txt'), 'INITIAL\n');
  assert.equal(f.git('status', '--porcelain'), '', 'git itself hides the edit');
  const r = await f.finish();
  assert.deepEqual(r.gbdev_observed.job_files_changed, ['src/initial.txt']);
  assert.ok(r.gbdev_observed.policy_violations.includes('readonly_modified'));
});

test('M8.1 inherited untracked 12MB file: unchanged is not attributed, edits are, job never fails on budget', async t => {
  const f = fixture(t);
  const file = join(f.repo, 'src/dump.bin');
  writeFileSync(file, bigBuffer());
  f.ready();
  const before = await f.baseline(); // just written: capture waits out the racy window and re-stats
  const big = before.entries.find(e => e.path === 'src/dump.bin')!;
  assert.equal(big.content_unknown, true);
  assert.equal(big.content_stat?.size, String(BIG));
  assert.equal(big.content_stat?.racy, undefined);
  assert.equal(workspaceGenerationFingerprint(before), null, 'B2 still never caches unhashed content');
  // Unchanged: decidable via stat identity.
  const same = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' });
  assert.deepEqual(jobFilesChanged(before, same), []);
  // Same-size edit with restored mtime: ctime moves, so it is attributed.
  flipByteKeepMtime(file);
  const r = await f.finish();
  assert.equal(r.state, 'failed');
  assert.notEqual(r.failure_reason, 'workspace_snapshot_invalid');
  assert.deepEqual(r.gbdev_observed.job_files_changed, ['src/dump.bin']);
  assert.ok(r.gbdev_observed.policy_violations.includes('readonly_modified'));
});

test('M8.1 supervised reviewer with an inherited untracked 12MB file succeeds (racy baseline waited out)', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src/dump.bin'), bigBuffer()); // just written: racy at first capture
  f.ready();
  await superviseJob(f.status.job_id, f.store);
  const r = f.result(f.status.job_id);
  assert.equal(r.state, 'succeeded', JSON.stringify(r.failure_reasons ?? r.failure_reason));
  assert.deepEqual(r.gbdev_observed.job_files_changed ?? [], []);
  const baseline = readWorkspaceSnapshot(join(f.jobDir(f.status.job_id), WORKSPACE_BEFORE));
  assert.equal(baseline.entries.find(e => e.path === 'src/dump.bin')?.content_stat?.racy, undefined);
});

test('M8.1 a big file written right before the worker exits is still attributed (after_worker settles)', async t => {
  const f = fixture(t, 'workspace-write');
  await f.baseline();
  writeFileSync(join(f.repo, 'src/out.bin'), bigBuffer());
  const r = await f.finish();
  assert.notEqual(r.failure_reason, 'workspace_snapshot_invalid', JSON.stringify(r.failure_reasons));
  assert.ok(r.gbdev_observed.job_files_changed?.includes('src/out.bin'));
});

test('M8.1 untracked big file created by the job is attributed (writer commits nothing outside scope)', async t => {
  const f = fixture(t);
  const before = await f.baseline();
  writeFileSync(join(f.repo, 'src/new-big.bin'), Buffer.alloc(SNAPSHOT_MAX_HASH_BYTES + 1));
  const after = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' });
  assert.deepEqual(jobFilesChanged(before, after), ['src/new-big.bin']);
});

test('M8.1 undecidable unhashed evidence still fails closed and names the path', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src/dump.bin'), Buffer.alloc(64));
  f.ready();
  const opts = { maxHashBytes: 16, settleRacy: false };
  // Racy and identical: a same-tick edit cannot be excluded.
  const racy = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'before_worker' }, opts);
  assert.equal(racy.entries.find(e => e.path === 'src/dump.bin')?.content_stat?.racy, true);
  assert.ok(racyUnknownDelayMs(racy) > 0);
  const again = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }, opts);
  assert.throws(() => jobFilesChanged(racy, again), /unknown for src\/dump\.bin: .*racy window/);
  // Legacy evidence without a stat identity.
  const legacy = structuredClone(racy);
  delete legacy.entries.find(e => e.path === 'src/dump.bin')!.content_stat;
  assert.throws(() => assertSnapshotDecidable(legacy), /unknown for src\/dump\.bin: .*no stat identity/);
  assert.throws(() => jobFilesChanged(legacy, again), /unknown for src\/dump\.bin/);
});

test('M8.1 clean tracked files do not count toward the hashed-file limit', async t => {
  const f = fixture(t);
  const n = SNAPSHOT_MAX_FILES + 200;
  mkdirSync(join(f.repo, 'many'));
  for (let i = 0; i < n; i++) writeFileSync(join(f.repo, 'many', `f${i}.txt`), `${i}\n`);
  commitAll(f, 'many files');
  f.ready();
  const snap = await captureWorkspaceSnapshot(f.repo, { job_id: f.status.job_id, phase: 'before_worker' });
  assert.ok(snap.entries.length > SNAPSHOT_MAX_FILES);
  assert.ok(snap.entries.filter(e => e.path.startsWith('many/')).every(e => e.content_source === 'git_index'));
  atomicWriteJson(join(f.root, 'snap.json'), snap);
  assert.equal(readWorkspaceSnapshot(join(f.root, 'snap.json')).entries.length, snap.entries.length);
  // Activity probes (byte hashes only) keep the original cap.
  await assert.rejects(captureWorkspaceSnapshot(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }, { gitIndexIdentity: false }), /file count/);
  // Dirtying them makes them hashed again, so the hashed-file cap still applies.
  for (let i = 0; i < n; i++) writeFileSync(join(f.repo, 'many', `f${i}.txt`), `x${i}\n`);
  await assert.rejects(captureWorkspaceSnapshot(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }), /file count.*dirty\/untracked/);
});

test('M8.1 review: racy is judged at stat time, so a slow capture does not leave a stale racy flag', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src/dump.bin'), Buffer.alloc(64));
  writeFileSync(join(f.repo, 'a.txt'), 'hashed first');
  f.ready();
  const snap = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'before_worker' }, {
    maxHashBytes: 32, settleRacy: false,
    onHashChunk: path => { if (path === 'a.txt') { const until = Date.now() + 1_200; while (Date.now() < until) { /* slow capture */ } } },
  });
  assert.equal(snap.entries.find(e => e.path === 'src/dump.bin')?.content_stat?.racy, undefined);
  assertSnapshotDecidable(snap);
});

test('M8.1 review: a racy unhashed baseline is not decidable and is rejected before the worker', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src/dump.bin'), Buffer.alloc(64));
  f.ready();
  const snap = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'before_worker' }, { maxHashBytes: 16, settleRacy: false });
  assert.throws(() => assertSnapshotDecidable(snap), /unknown for src\/dump\.bin: .*racy window/);
});

test('M8.1 review: a git-vouched file edited during capture is a race, not a stale clean identity', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'a.txt'), 'hashed first');
  f.ready();
  const edit = (path: string) => { if (path === 'a.txt') writeFileSync(join(f.repo, 'src/initial.txt'), 'edited mid-capture\n'); };
  await assert.rejects(captureWorkspaceSnapshot(f.repo, { job_id: f.status.job_id, phase: 'before_worker' }, { onHashChunk: edit }),
    /File changed during observation: src\/initial\.txt/);
});

test('M8.1 review: git_index evidence cannot also carry a stat identity', async t => {
  const f = fixture(t);
  f.ready();
  const snap = await captureWorkspaceSnapshot(f.repo, { job_id: f.status.job_id, phase: 'before_worker' });
  const entry = snap.entries.find(e => e.path === 'src/initial.txt')!;
  assert.equal(entry.content_source, 'git_index');
  entry.content_stat = { size: '1', mtime_ns: '1', ctime_ns: '1', ino: '1', dev: '1' };
  atomicWriteJson(join(f.root, 'bad.json'), snap);
  assert.throws(() => readWorkspaceSnapshot(join(f.root, 'bad.json')), /Invalid workspace entry/);
});
