import { captureWorkspaceSnapshotSync, WORKSPACE_BEFORE } from '../src/core/workspaceSnapshot.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { supervise } from '../src/commands/supervise.js';
import { validateJobResult } from '../src/contracts/jobResult.js';
import { failureResult, finalOutcome } from '../src/core/finalize.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { localIso } from '../src/core/time.js';
import { resolvePaths, jobPaths } from '../src/core/paths.js';
import { job, worker } from './helpers.js';
import { tmpRepo } from './helpers/tmpRepo.js';

test('B1 README missing-report failure example explicitly describes workspace-write and matches finalOutcome', () => {
  const readme = readFileSync(resolve('docs/reference.md'), 'utf8');
  const section = readme.split('### job-result（gbdev 汇总）')[1]!.split('## Provider')[0]!;
  assert.match(section, /workspace-write/);
  const value = validateJobResult(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)![1]!));
  const outcome = finalOutcome(value.worker_exit_code, value.worker_reported, value.gbdev_observed.policy_violations,
    undefined, value.gbdev_observed.checks);
  assert.equal(value.state, outcome.state);
  assert.equal(value.failure_reason, outcome.failure_reason);
  assert.deepEqual(value.failure_reasons, outcome.failure_reasons);
  assert.deepEqual(value.worker_result_warnings, []);
});

test('B2/B3 start worktree failure preserves start_failed plus invalid snapshot in both records', async t => {
  const h = tmpRepo(t);
  const gitBin = execFileSync('/bin/sh', ['-c', 'command -v git'], { env: h.env, encoding: 'utf8' }).trim();
  const bin = join(h.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('worktree') && args.includes('add')) process.exit(1);
const result = spawnSync(${JSON.stringify(gitBin)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  // Extensionless Node scripts default to CommonJS outside a package.
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
  h.env.PATH = `${bin}:${h.env.PATH}`;
  const output = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(output.exit, 1);
  assert.equal(!output.envelope.ok && output.envelope.error.code, 'worktree_failed');
  const ids = readdirSync(join(h.home, 'jobs'));
  assert.equal(ids.length, 1);
  const status = h.getJob(ids[0]!);
  const result = h.result(ids[0]!);
  assert.match(result.failure_reason!, /^start_failed:/);
  assert.equal(status.failure_reason, result.failure_reason);
  assert.deepEqual(result.failure_reasons, [result.failure_reason, 'workspace_snapshot_invalid']);
  assert.deepEqual(status.failure_reasons, [result.failure_reason, 'workspace_snapshot_invalid']);
  assert.equal(result.worker_exit_code, null);
});

for (const mode of ['cancelled-before-spawn', 'timeout-before-spawn', 'spawn-error'] as const) {
  test(`B2 supervisor ${mode} never invents worker_exit_nonzero:null`, async t => {
    const h = tmpRepo(t, 'ok', { acceptance_criteria: [] });
    const store = new JobStore(resolvePaths(h.env));
    const status = { ...job(), state: 'starting' as const, repo: h.repo, worktree: h.repo, base_sha: h.git('rev-parse', 'HEAD').trim(),
      deadline_at: mode === 'timeout-before-spawn' ? job().deadline_at : localIso(new Date(Date.now() + 60_000)),
      state_history: [{ state: 'starting' as const, at: job().created_at, by: 'gbdev' }] };
    store.create(status);
    const paths = jobPaths(store.paths, status.job_id);
    atomicWriteJson(paths.brief, { ...h.task, provider: 'codex' });
    atomicWriteJson(join(paths.dir, 'provider.json'), { bin: join(h.root, 'missing-provider') });
    writeFileSync(paths.prompt, 'A task.');
    if (mode === 'cancelled-before-spawn') writeFileSync(paths.cancelRequest, '{}');
    await supervise(store, status.job_id);
    const done = store.read(status.job_id);
    assert.equal(done.state, mode === 'spawn-error' ? 'failed' : mode === 'timeout-before-spawn' ? 'timeout' : 'cancelled');
    const result = h.result(status.job_id);
    assert.equal(result.worker_exit_code, null);
    assert.deepEqual(result.failure_reasons, ['worker_result_missing']);
    assert.deepEqual(done.failure_reasons, result.failure_reasons);
  });
}

test('B2 unknown/unclosed recovery omits 3b; confirmed signal close retains it', t => {
  const h = tmpRepo(t);
  const store = new JobStore(resolvePaths(h.env));
  const status = { ...job(), repo: h.repo, worktree: h.repo, base_sha: h.git('rev-parse', 'HEAD').trim() };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(paths.brief, h.task);
  atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE), captureWorkspaceSnapshotSync(h.repo, { job_id: status.job_id, phase: 'before_worker' }));
  writeFileSync(paths.finalMessage, JSON.stringify(worker()));
  assert.deepEqual(failureResult(store, status, null).failure_reasons, []);
  assert.deepEqual(failureResult(store, status, null, true).failure_reasons, ['worker_exit_nonzero:null']);
  assert.deepEqual(failureResult(store, status, 7, true).failure_reasons, ['worker_exit_nonzero:7']);
});

test('B2 spawned worker killed by deadline records actual null close exit', async t => {
  const h = tmpRepo(t, 'slow', { acceptance_criteria: [], timeout_min: 1 }, { GBDEV_TIMEOUT_SCALE: '1000' });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'timeout');
  assert.equal(existsSync(join(h.jobDir(done.job_id), 'fake-processes.json')), true);
  assert.equal(h.result(done.job_id).worker_exit_code, null);
  assert.deepEqual(done.failure_reasons, ['worker_exit_nonzero:null', 'worker_result_missing']);
});

test('B4 SPEC finalization explicitly skips omitted check_cmd', () => {
  const spec = readFileSync(resolve('docs/specs/SPEC.md'), 'utf8');
  assert.match(spec, /6\. 依次[^\n]*省略 check_cmd 则跳过/);
});
