import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  environmentFingerprint, executionIdentityKey, runCheckProcess, runJobChecks, safeCheckLogNames, type RunJobChecksOptions,
} from '../src/core/checks.js';
import { captureWorkspaceSnapshotSync, workspaceGenerationFingerprint, WORKSPACE_BEFORE } from '../src/core/workspaceSnapshot.js';
import { groupAlive } from '../src/core/proc.js';
import { finalOutcome } from '../src/core/finalize.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { isProcessAlive } from '../src/core/lock.js';
import { optionalText } from '../src/core/runtime.js';
import { localIso } from '../src/core/time.js';
import { fixInput } from '../src/pipeline/fixLoop.js';
import { pipelineFixture } from './helpers/pipeline.js';
import { eventually, tmpRepo, unwrap } from './helpers/tmpRepo.js';
import { job, worker } from './helpers.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { JobResult } from '../src/contracts/jobResult.js';

function shPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function checkJob(t: TestContext) {
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [] });
  const store = new JobStore(resolvePaths(h.env));
  const status = {
    ...job(undefined, new Date()), state: 'running' as const, repo: h.repo, worktree: h.repo,
    base_sha: h.git('rev-parse', 'HEAD').trim(), role: h.task.role, sandbox: 'workspace-write' as const,
    state_history: [{ state: 'running' as const, at: localIso(), by: 'gbdev' }],
  };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(paths.brief, h.task);
  atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE), captureWorkspaceSnapshotSync(h.repo, {
    job_id: status.job_id, phase: 'before_worker',
  }));
  writeFileSync(paths.finalMessage, '```json\n' + JSON.stringify(worker()) + '\n```');
  writeFileSync(paths.workerLog, '');
  writeFileSync(paths.rawJsonl, '');
  mkdirSync(paths.checks, { recursive: true });
  return { ...h, store, status, paths };
}

function phase(f: ReturnType<typeof checkJob>, criteria: RunJobChecksOptions['criteria'],
  options: Partial<RunJobChecksOptions> = {}) {
  return runJobChecks({
    criteria, cwd: f.repo, jobDir: f.paths.dir, env: f.env,
    cancelRequest: f.paths.cancelRequest, processInfo: f.paths.processInfo, ...options,
  });
}

for (const snapshotOptions of [{ maxHashBytes: 16 }, { maxTotalHashBytes: 16 }]) {
  test(`B2 unknown content is never reused: ${JSON.stringify(snapshotOptions)}`, async t => {
    const f = checkJob(t);
    mkdirSync(join(f.repo, '.omc'));
    const watched = join(f.repo, '.omc/notepad.md');
    writeFileSync(watched, 'a'.repeat(32));
    const before = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }, snapshotOptions);
    assert.equal(before.entries.find(e => e.path === '.omc/notepad.md')!.content_unknown, true);
    assert.equal(workspaceGenerationFingerprint(before), null);
    const count = join(f.root, 'unknown-count');
    const same = `echo x >> ${shPath(count)}`;
    const rewrite = `printf '%s' '${'b'.repeat(32)}' > .omc/notepad.md`;
    const physical: string[] = [];
    const results = await phase(f, [
      { id: 'A', check_cmd: same }, { id: 'REWRITE', check_cmd: rewrite }, { id: 'B', check_cmd: same },
    ], { workspace: before, snapshotOptions, onPhysicalStart: cmd => { physical.push(cmd); } });
    assert.deepEqual(physical, [same, rewrite, same]);
    assert.equal(readFileSync(count, 'utf8'), 'x\nx\n');
    assert.ok(results.every(c => c.exit_code === 0 && c.reused_from === undefined));
    const after = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_checks' }, snapshotOptions);
    // Same size, mode, index state and unknown flags: metadata cannot prove unchanged content.
    const withoutStat = (s: typeof before) => s.entries.map(({ content_stat: _stat, ...rest }) => rest);
    assert.deepEqual(withoutStat(after), withoutStat(before));
  });
}

test('B2 unknown before a check cannot cache even when the after snapshot is complete', async t => {
  const f = checkJob(t);
  const snapshotOptions = { maxHashBytes: 16 };
  writeFileSync(join(f.repo, 'src/initial.txt'), 'x'.repeat(32));
  const same = 'printf short > src/initial.txt';
  let physical = 0;
  const results = await phase(f, ['A', 'B', 'C'].map(id => ({ id, check_cmd: same })), {
    snapshotOptions, onPhysicalStart: () => { physical++; },
  });
  assert.equal(physical, 2);
  assert.equal(results[0]!.execution_id, undefined);
  assert.equal(results[2]!.reused_from, 'B');
});

test('B2 complete before / unknown after clears older cached groups', async t => {
  const f = checkJob(t);
  const same = 'echo same';
  const grow = `printf '%s' '${'x'.repeat(32)}' > src/initial.txt`;
  const physical: string[] = [];
  const results = await phase(f, [
    { id: 'A', check_cmd: same }, { id: 'GROW', check_cmd: grow }, { id: 'B', check_cmd: same },
  ], { snapshotOptions: { maxHashBytes: 16 }, onPhysicalStart: cmd => { physical.push(cmd); } });
  assert.deepEqual(physical, [same, grow, same]);
  assert.equal(results[2]!.reused_from, undefined);
});

for (const failInitial of [true, false]) {
  test(`B2 failed generation capture disables reuse (initial=${failInitial})`, async t => {
    const f = checkJob(t);
    let fail = failInitial;
    let physical = 0;
    const results = await phase(f, [
      { id: 'A', check_cmd: 'echo same' }, { id: 'MID', check_cmd: 'echo middle' },
      { id: 'B', check_cmd: 'echo same' }, { id: 'C', check_cmd: 'echo same' },
    ], {
      snapshotOptions: { cancelled: () => fail },
      onCheck: check => { if (check.id === 'MID') fail = true; },
      onPhysicalStart: () => { physical++; },
    });
    assert.equal(physical, 4);
    assert.equal(results.length, 4);
    assert.ok(results.every(c => c.exit_code === 0 && c.reused_from === undefined));
  });
}

test('AC-B2-3 runJobChecks canonicalizes symlink cwd and separates distinct cwd identities', async t => {
  const f = checkJob(t);
  const alias = join(f.root, 'repo-alias'), other = join(f.root, 'repo-copy');
  symlinkSync(f.repo, alias, 'dir');
  cpSync(f.repo, other, { recursive: true });
  const count = join(f.root, 'cwd-count');
  const same = `echo x >> ${shPath(count)}; pwd -P`;
  let physical = 0;
  const results = [];
  for (const cwd of [f.repo, alias, other]) {
    const checks = await phase(f, ['A', 'B'].map(id => ({ id, check_cmd: same })), {
      cwd, onPhysicalStart: () => { physical++; },
    });
    assert.equal(checks[1]!.reused_from, 'A');
    assert.equal(checks[1]!.execution_id, checks[0]!.execution_id);
    results.push(checks);
  }
  // Separate phases each execute once; aliases share an identity, never a cross-phase cache.
  assert.equal(physical, 3);
  assert.equal(readFileSync(count, 'utf8'), 'x\nx\nx\n');
  assert.equal(results[0]![0]!.execution_id, results[1]![0]!.execution_id);
  assert.notEqual(results[0]![0]!.execution_id, results[2]![0]!.execution_id);
});

test('AC-B2-3 intermediate empty commit changes only HEAD and forces re-execution', async t => {
  const f = checkJob(t);
  const count = join(f.root, 'head-count');
  const same = `echo x >> ${shPath(count)}`;
  const commit = 'git -c core.hooksPath=/dev/null -c user.name=Test -c user.email=test@localhost -c commit.gpgsign=false commit --allow-empty -m check-head';
  const before = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' });
  const physical: string[] = [];
  const results = await phase(f, [
    { id: 'A', check_cmd: same }, { id: 'HEAD', check_cmd: commit }, { id: 'B', check_cmd: same },
  ], { onPhysicalStart: cmd => { physical.push(cmd); } });
  const after = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_checks' });
  assert.notEqual(after.head_sha, before.head_sha);
  assert.equal(workspaceGenerationFingerprint(after), workspaceGenerationFingerprint(before));
  assert.deepEqual(physical, [same, commit, same]);
  assert.equal(readFileSync(count, 'utf8'), 'x\nx\n');
  assert.ok(results.every(c => c.exit_code === 0 && c.reused_from === undefined));
});

for (const path of ['.omc/notepad.md', 'src/new-untracked.txt']) {
  test(`AC-B2-4 intermediate creation of ${path} invalidates existing cache`, async t => {
    const f = checkJob(t);
    // The explicit watched extra must work even when excluded from git status.
    writeFileSync(join(f.repo, '.git/info/exclude'), '.omc/\n');
    const beforeHead = f.git('rev-parse', 'HEAD');
    const count = join(f.root, 'new-file-count');
    const same = `echo x >> ${shPath(count)}`;
    const create = `mkdir -p .omc; echo new > ${path}`;
    const physical: string[] = [];
    const results = await phase(f, [
      { id: 'A', check_cmd: same }, { id: 'CREATE', check_cmd: create }, { id: 'B', check_cmd: same },
    ], { onPhysicalStart: cmd => { physical.push(cmd); } });
    assert.equal(f.git('rev-parse', 'HEAD'), beforeHead);
    assert.deepEqual(physical, [same, create, same]);
    assert.equal(readFileSync(count, 'utf8'), 'x\nx\n');
    assert.ok(results.every(c => c.exit_code === 0 && c.reused_from === undefined));
  });
}

test('AC-B2-5 retry phase and new task on the same cwd/HEAD/env start with empty caches', async t => {
  const f = checkJob(t);
  const count = join(f.root, 'attempt-count');
  const same = `echo x >> ${shPath(count)}`;
  const beforeHead = f.git('rev-parse', 'HEAD');
  let physical = 0;
  for (const jobDir of [f.paths.dir, f.paths.dir, join(f.root, 'new-task')]) {
    const results = await phase(f, ['A', 'B'].map(id => ({ id, check_cmd: same })), {
      jobDir, onPhysicalStart: () => { physical++; },
    });
    assert.equal(results[0]!.reused_from, undefined);
    assert.equal(results[1]!.reused_from, 'A');
  }
  assert.equal(f.git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(physical, 3);
  assert.equal(readFileSync(count, 'utf8'), 'x\nx\nx\n');
});

test('AC-B2-5 manual pipeline retry executes checks again at unchanged HEAD', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'blocked' });
  const count = join(f.root, 'manual-retry-count');
  const same = `echo x >> ${shPath(count)}`;
  const start = await f.start({ acceptance_criteria: ['A', 'B'].map(id => ({ id, text: id, check_cmd: same })) });
  const first = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(first.state, 'blocked');
  assert.equal(readFileSync(count, 'utf8'), 'x\n');
  unwrap((await f.resume(start.pipeline_id, 'retry')).envelope);
  const retried = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(retried.state, 'blocked');
  assert.equal(retried.steps[0]!.attempts.length, 2);
  const [a, b] = retried.steps[0]!.attempts;
  assert.notEqual(a!.job_id, b!.job_id);
  const firstResult = f.result(a!.job_id), secondResult = f.result(b!.job_id);
  assert.equal(firstResult.gbdev_observed.head_after, secondResult.gbdev_observed.head_after);
  assert.equal(readFileSync(count, 'utf8'), 'x\nx\n');
  for (const result of [firstResult, secondResult]) assert.equal(result.gbdev_observed.checks[1]!.reused_from, 'A');
});

for (const timeouts of [[1, 0.005], [0.005, 1]]) {
  test(`AC-B2-7 shared timeout uses shortest limit independent of order: ${timeouts}`, async t => {
    const f = checkJob(t);
    const count = join(f.root, 'shared-timeout-count');
    // Natural success at 2s distinguishes the 300ms minimum from the one-minute member.
    const slow = `echo x >> ${shPath(count)}; exec node -e 'setTimeout(() => process.exit(0), 2000)'`;
    let physical = 0;
    const results = await phase(f, timeouts.map((timeout_min, i) => ({ id: `T${i}`, check_cmd: slow, timeout_min })), {
      onPhysicalStart: () => { physical++; },
    });
    assert.equal(physical, 1);
    assert.equal(readFileSync(count, 'utf8'), 'x\n');
    assert.deepEqual(results.map(c => c.exit_code), [null, null]);
    assert.ok(results[0]!.execution_id);
    assert.equal(results[1]!.execution_id, results[0]!.execution_id);
    assert.equal(results[1]!.reused_from, 'T0');
    for (const check of results) assert.equal(existsSync(join(f.paths.dir, check.log)), true);
    assert.equal(JSON.parse(readFileSync(f.paths.processInfo, 'utf8')).check_pgid, null);
  });
}

test('AC-B2-1 four identical cmds: one physical run, four results and logs', async t => {
  const f = checkJob(t);
  const outside = join(f.root, 'phys-count');
  const same = `echo x >> ${shPath(outside)} && echo shared-body`;
  let physical = 0;
  const results = await runJobChecks({
    criteria: [1, 2, 3, 4].map(n => ({ id: `AC${n}`, check_cmd: same })),
    env: f.env, cwd: f.repo,
    jobDir: f.paths.dir,
    cancelRequest: f.paths.cancelRequest,
    processInfo: f.paths.processInfo,
    workspace: captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }),
    onPhysicalStart: () => { physical += 1; },
  });
  assert.equal(physical, 1);
  assert.equal(results.length, 4);
  assert.equal(readFileSync(outside, 'utf8').trim().split('\n').length, 1);
  for (const [i, check] of results.entries()) {
    assert.equal(check.exit_code, 0);
    assert.equal(check.id, `AC${i + 1}`);
    assert.equal(check.log, `checks/AC${i + 1}.log`);
    assert.match(readFileSync(join(f.paths.dir, check.log), 'utf8'), /shared-body/);
    assert.equal(check.execution_id, results[0]!.execution_id);
    if (i === 0) assert.equal(check.reused_from, undefined);
    else assert.equal(check.reused_from, 'AC1');
    assert.ok(check.checked_sha);
  }
});

test('AC-B2-2 shared exit 7: four failure reasons, fixer gets one log body', async t => {
  const f = checkJob(t);
  const cmd = 'echo fail-body; exit 7';
  let physical = 0;
  const results = await runJobChecks({
    criteria: ['AC1', 'AC2', 'AC3', 'AC4'].map(id => ({ id, check_cmd: cmd })),
    env: f.env, cwd: f.repo,
    jobDir: f.paths.dir,
    cancelRequest: f.paths.cancelRequest,
    processInfo: f.paths.processInfo,
    workspace: captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }),
    onPhysicalStart: () => { physical += 1; },
  });
  assert.equal(physical, 1);
  assert.deepEqual(results.map(r => r.exit_code), [7, 7, 7, 7]);
  const outcome = finalOutcome(0, worker(), [], undefined, results);
  assert.equal(outcome.failure_reason, 'check_failed:AC1');
  assert.deepEqual(outcome.failure_reasons, [
    'check_failed:AC1', 'check_failed:AC2', 'check_failed:AC3', 'check_failed:AC4',
  ]);

  const persisted = {
    schema: 'gbdev.job-result.v1', job_id: f.status.job_id, state: 'failed', session_id: null,
    worker_exit_code: 0, duration_s: 1, failure_reason: 'check_failed:AC1',
    failure_reasons: outcome.failure_reasons, worker_result_warnings: [],
    worker_reported: worker(),
    gbdev_observed: {
      head_before: f.status.base_sha, head_after: f.status.base_sha, commits: [], files_changed: [],
      outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null,
      checks: results, policy_violations: [],
    },
    paths: { final_message: f.paths.finalMessage, diff: f.paths.diff, events: f.paths.events, worker_log: f.paths.workerLog },
  } satisfies JobResult;
  atomicWriteJson(f.paths.result, persisted);
  const input = fixInput(f.store, { attempts: [{ job_id: f.status.job_id }] } as PipelineRun['steps'][number]);
  assert.equal(input.findings.filter(x => x.id.startsWith('C')).length, 1);
  assert.match(input.findings[0]!.message, /checks AC1, AC2, AC3, AC4 failed/);
  assert.equal(input.logs.length, 1);
  assert.match(input.logs[0]!.text, /fail-body/);
});

test('AC-B2-3 cwd/argv/env/HEAD changes never share a key', () => {
  const base = {
    canonical_cwd: '/repo',
    executable: '/bin/sh',
    argv: ['-c', 'true'],
    env_fingerprint: environmentFingerprint({ A: '1' }),
    head_sha: 'aaa',
    workspace_generation: 'gen1',
  };
  const k0 = executionIdentityKey(base);
  assert.notEqual(k0, executionIdentityKey({ ...base, canonical_cwd: '/other' }));
  assert.notEqual(k0, executionIdentityKey({ ...base, argv: ['-c', 'true '] }));
  assert.notEqual(k0, executionIdentityKey({ ...base, env_fingerprint: environmentFingerprint({ A: '2' }) }));
  assert.notEqual(k0, executionIdentityKey({ ...base, head_sha: 'bbb' }));
  assert.notEqual(k0, executionIdentityKey({ ...base, workspace_generation: 'gen2' }));
});

test('AC-B2-3 within separate phases: env change forces re-exec', async t => {
  const f = checkJob(t);
  const outside = join(f.root, 'env-count');
  const cmd = `echo 1 >> ${shPath(outside)}`;
  const ws = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' });
  let physical = 0;
  await runJobChecks({
    criteria: [{ id: 'AC1', check_cmd: cmd }],
    cwd: f.repo, jobDir: f.paths.dir, cancelRequest: f.paths.cancelRequest, processInfo: f.paths.processInfo,
    workspace: ws, env: { ...f.env, B2_MARKER: 'one' },
    onPhysicalStart: () => { physical += 1; },
  });
  await runJobChecks({
    criteria: [{ id: 'AC1', check_cmd: cmd }],
    cwd: f.repo, jobDir: f.paths.dir, cancelRequest: f.paths.cancelRequest, processInfo: f.paths.processInfo,
    workspace: ws, env: { ...f.env, B2_MARKER: 'two' },
    onPhysicalStart: () => { physical += 1; },
  });
  assert.equal(physical, 2);
  assert.equal(readFileSync(outside, 'utf8').trim().split('\n').length, 2);
});

test('AC-B2-4 same HEAD: mutating check invalidates reuse for the next identical cmd', async t => {
  const f = checkJob(t);
  const outside = join(f.root, 'mut-count');
  const cmd = `echo n >> ${shPath(outside)}; echo mutated >> src/initial.txt; echo body`;
  let physical = 0;
  const results = await runJobChecks({
    criteria: [{ id: 'AC1', check_cmd: cmd }, { id: 'AC2', check_cmd: cmd }],
    env: f.env, cwd: f.repo,
    jobDir: f.paths.dir,
    cancelRequest: f.paths.cancelRequest,
    processInfo: f.paths.processInfo,
    workspace: captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }),
    onPhysicalStart: () => { physical += 1; },
  });
  assert.equal(physical, 2);
  assert.equal(results.length, 2);
  assert.equal(readFileSync(outside, 'utf8').trim().split('\n').length, 2);
  assert.equal(results[0]!.execution_id, undefined);
  assert.equal(results[1]!.execution_id, undefined);
});

test('AC-B2-5 separate jobs do not reuse even with identical cmd/HEAD', async t => {
  const root = tmpRepo(t, 'ok', { acceptance_criteria: [] }).root;
  const outside = join(root, 'cross-job');
  const cmd = `echo 1 >> ${shPath(outside)} && echo ok`;
  let physical = 0;
  for (let i = 0; i < 3; i++) {
    const f = checkJob(t);
    await runJobChecks({
      criteria: [{ id: 'AC1', check_cmd: cmd }, { id: 'AC2', check_cmd: cmd }],
      env: f.env, cwd: f.repo, jobDir: f.paths.dir, cancelRequest: f.paths.cancelRequest, processInfo: f.paths.processInfo,
      workspace: captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }),
      onPhysicalStart: () => { physical += 1; },
    });
  }
  assert.equal(physical, 3);
  assert.equal(readFileSync(outside, 'utf8').trim().split('\n').length, 3);
});

test('AC-B2-6 dangerous ids, duplicate sanitized names, no path escape', async t => {
  const f = checkJob(t);
  const names = safeCheckLogNames([
    { id: '../../escaped', check_cmd: 'true' },
    { id: 'AC1', check_cmd: 'true' },
    { id: 'AC1', check_cmd: 'true' },
    { id: 'weird id', check_cmd: 'true' },
  ]);
  assert.equal(names.get(0), 'criterion-0');
  assert.equal(names.get(1), 'AC1');
  assert.equal(names.get(2), 'AC1-2');
  assert.equal(names.get(3), 'criterion-3');

  const results = await runJobChecks({
    criteria: [
      { id: '../../escaped', check_cmd: 'echo one' },
      { id: 'AC1', check_cmd: 'echo two' },
      { id: 'AC1', check_cmd: 'echo two' },
      { id: 'weird id', check_cmd: 'echo three' },
    ],
    env: f.env, cwd: f.repo, jobDir: f.paths.dir, cancelRequest: f.paths.cancelRequest, processInfo: f.paths.processInfo,
    workspace: captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }),
  });
  assert.equal(results[0]!.log, 'checks/criterion-0.log');
  assert.equal(results[1]!.log, 'checks/AC1.log');
  assert.equal(results[2]!.log, 'checks/AC1-2.log');
  assert.equal(results[3]!.log, 'checks/criterion-3.log');
  assert.equal(existsSync(join(f.home, 'escaped.log')), false);
  assert.match(readFileSync(join(f.paths.dir, results[0]!.log), 'utf8'), /one/);
  assert.match(readFileSync(join(f.paths.dir, results[1]!.log), 'utf8'), /two/);
  assert.match(readFileSync(join(f.paths.dir, results[2]!.log), 'utf8'), /two/);
  assert.equal(results[2]!.reused_from, 'AC1');
  assert.match(readFileSync(join(f.paths.dir, results[3]!.log), 'utf8'), /three/);
});

test('AC-B2-7 cancel stops remaining groups and clears process group', async t => {
  const f = checkJob(t);
  const started = join(f.repo, 'src', 'slow-started');
  const childPid = join(f.root, 'child-pid');
  const slow = `node -e 'require("fs").writeFileSync(${JSON.stringify(started)},"1");require("fs").writeFileSync(${JSON.stringify(childPid)},String(process.pid));setInterval(()=>{},1000)'`;
  const other = 'echo should-not-run > src/other.txt; exit 0';
  const run = runJobChecks({
    criteria: [
      { id: 'SLOW', check_cmd: slow },
      { id: 'SLOW2', check_cmd: slow },
      { id: 'OTHER', check_cmd: other },
    ],
    env: f.env, cwd: f.repo, jobDir: f.paths.dir, cancelRequest: f.paths.cancelRequest, processInfo: f.paths.processInfo,
    workspace: captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }),
  });
  await eventually(() => existsSync(started) ? true : undefined);
  writeFileSync(f.paths.cancelRequest, JSON.stringify({ by: 'test' }));
  const results = await run;
  assert.equal(results.length, 3);
  assert.notEqual(results[0]!.exit_code, 0);
  assert.equal(results[1]!.exit_code, null);
  assert.equal(results[2]!.exit_code, null);
  for (const check of results.slice(1)) assert.equal(readFileSync(join(f.paths.dir, check.log), 'utf8'), '');
  assert.equal(existsSync(join(f.repo, 'src/other.txt')), false);
  const info = JSON.parse(optionalText(f.paths.processInfo) ?? '{}') as { check_pgid?: number | null };
  assert.equal(info.check_pgid, null);
  const pid = Number(readFileSync(childPid, 'utf8'));
  await eventually(() => !isProcessAlive(pid) ? true : undefined);
  if (pid > 1) assert.equal(groupAlive(pid), false);
});

test('AC-B2-7 timeout clears process group; pre-cancelled phase never succeeds later groups', async t => {
  const f = checkJob(t);
  const started = join(f.root, 'timeout-started');
  const childPid = join(f.root, 'timeout-pid');
  const slow = `node -e 'require("fs").writeFileSync(${JSON.stringify(started)},"1");require("fs").writeFileSync(${JSON.stringify(childPid)},String(process.pid));setInterval(()=>{},1000)'`;
  const codePromise = runCheckProcess(
    slow, f.repo, join(f.paths.dir, 'slow.log'), f.paths.cancelRequest, f.paths.processInfo, f.env, 300,
  );
  await eventually(() => existsSync(started) ? true : undefined);
  const code = await codePromise;
  assert.notEqual(code, 0);
  const info = JSON.parse(optionalText(f.paths.processInfo) ?? '{}') as { check_pgid?: number | null };
  assert.equal(info.check_pgid, null);
  const pid = Number(readFileSync(childPid, 'utf8'));
  await eventually(() => !isProcessAlive(pid) ? true : undefined);

  writeFileSync(f.paths.cancelRequest, JSON.stringify({ by: 'test' }));
  const results = await runJobChecks({
    criteria: [{ id: 'A', check_cmd: 'exit 0' }, { id: 'B', check_cmd: 'exit 0' }],
    env: f.env, cwd: f.repo, jobDir: f.paths.dir, cancelRequest: f.paths.cancelRequest, processInfo: f.paths.processInfo,
    workspace: captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }),
  });
  assert.deepEqual(results.map(r => r.exit_code), [null, null]);
  for (const check of results) assert.equal(readFileSync(join(f.paths.dir, check.log), 'utf8'), '');
});

test('B2 single check keeps legacy serialization shape (no optional fields)', async t => {
  const f = checkJob(t);
  const results = await runJobChecks({
    criteria: [{ id: 'AC1', check_cmd: 'echo solo; exit 0' }],
    env: f.env, cwd: f.repo, jobDir: f.paths.dir, cancelRequest: f.paths.cancelRequest, processInfo: f.paths.processInfo,
    workspace: captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' }),
  });
  assert.deepEqual(results, [{ id: 'AC1', cmd: 'echo solo; exit 0', exit_code: 0, log: 'checks/AC1.log' }]);
});

test('B2 workspace generation fingerprint changes when watched file content changes', t => {
  const f = checkJob(t);
  const before = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' });
  const g1 = workspaceGenerationFingerprint(before);
  writeFileSync(join(f.repo, 'src/initial.txt'), 'changed-by-test\n');
  const after = captureWorkspaceSnapshotSync(f.repo, { job_id: f.status.job_id, phase: 'after_worker' });
  assert.notEqual(workspaceGenerationFingerprint(after), g1);
});

test('B2 finalize end-to-end dedupes four identical criteria', async t => {
  const markerRoot = tmpRepo(t, 'ok', { acceptance_criteria: [] }).root;
  const outside = join(markerRoot, 'fin-count');
  const h = tmpRepo(t, 'ok', {
    acceptance_criteria: [1, 2, 3, 4].map(n => ({
      id: `AC${n}`, text: `t${n}`,
      check_cmd: `echo 1 >> ${shPath(outside)} && echo ok`,
    })),
  });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded');
  const result = h.result(done.job_id);
  assert.equal(result.gbdev_observed.checks.length, 4);
  assert.equal(readFileSync(outside, 'utf8').trim().split('\n').length, 1);
  assert.ok(result.gbdev_observed.checks.every(c => c.execution_id === result.gbdev_observed.checks[0]!.execution_id));
  for (const check of result.gbdev_observed.checks) {
    assert.match(readFileSync(join(h.jobDir(done.job_id), check.log), 'utf8'), /ok/);
  }
});

test('B2 pipeline fixer new job re-executes the same check command', async t => {
  const f = pipelineFixture(t, {
    'implement#1': 'check_fail_then_fix',
    'fix#1': 'fix_ok',
    'review#1': 'review_approve',
    'review#2': 'review_approve',
  });
  const outside = join(f.root, 'pipe-count');
  const check = `echo 1 >> ${shPath(outside)}; if test -f src/check-fail.txt; then exit 1; fi; echo pass`;
  const start = await f.start({
    acceptance_criteria: [
      { id: 'AC1', text: 'a', check_cmd: check },
      { id: 'AC2', text: 'b', check_cmd: check },
    ],
  });
  const done = await f.wait(start.pipeline_id) as { state: string };
  assert.equal(done.state, 'succeeded');
  const lines = readFileSync(outside, 'utf8').trim().split('\n').length;
  assert.equal(lines, 2, 'one physical execution in implement and one in fixer; reviewer has no checks');
});
