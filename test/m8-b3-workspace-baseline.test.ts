import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture as runFixture } from './helpers/m3.js';
import { readRun as readPipeline } from '../src/pipeline/store.js';
import { pipelineFixture } from './helpers/pipeline.js';
import { eventually, tmpRepo } from './helpers/tmpRepo.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import { gate } from '../src/pipeline/gate.js';
import { fixInput } from '../src/pipeline/fixLoop.js';
import { job, worker } from './helpers.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { localIso } from '../src/core/time.js';
import { superviseJob } from '../src/core/supervise.js';
import { isRetryableRateLimit } from '../src/run/scheduler.js';
import { failureResult, finalize } from '../src/core/finalize.js';
import { fake } from '../src/providers/fake.js';
import { GbdevError } from '../src/contracts/error.js';
import {
  captureWorkspaceSnapshot, captureWorkspaceSnapshotSync, diffSnapshotPaths, readWorkspaceSnapshot,
  SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_HASH_BYTES, WORKSPACE_BEFORE, WORKSPACE_AFTER_WORKER,
} from '../src/core/workspaceSnapshot.js';

// Seed all inherited state before supervise/spawn; no production timing seam.
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
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(paths.brief, h.task);
  atomicWriteJson(join(paths.dir, 'provider.json'), { bin: process.execPath, writable_roots: [], schema_options: { pipelineStep: true, output: sandbox === 'read-only' ? 'verdict' : 'change' } });
  writeFileSync(paths.prompt, 'test workspace baseline');
  writeFileSync(paths.workerLog, '');
  writeFileSync(paths.rawJsonl, '');
  const baseline = async () => atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE), await captureWorkspaceSnapshot(h.repo, { job_id: status.job_id, phase: 'before_worker' }));
  const report = () => writeFileSync(paths.finalMessage, '```json\n' + JSON.stringify({ ...worker(), review: { verdict: 'approve', findings: [] } }) + '\n```');
  const finish = async () => { report(); return finalize(store, status, h.task, 0); };
  return { ...h, store, status, paths, baseline, report, finish };
}

test('AC-B3-1 inherited ignored notepad is captured before spawn and not attributed to reviewer', async t => {
  const f = fixture(t);
  mkdirSync(join(f.repo, '.omc'));
  writeFileSync(join(f.repo, '.git', 'info', 'exclude'), '.omc/\n');
  writeFileSync(join(f.repo, '.omc/notepad.md'), 'inherited notes\n');
  await superviseJob(f.status.job_id, f.store);
  const r = f.result(f.status.job_id);
  assert.equal(r.state, 'succeeded');
  assert.deepEqual(r.gbdev_observed.policy_violations, []);
  assert.deepEqual(r.gbdev_observed.outside_allowed_paths, []);
  assert.ok(r.gbdev_observed.inherited_dirty_paths?.includes('.omc/notepad.md'));
  assert.deepEqual(r.gbdev_observed.job_files_changed, []);
});

test('AC-B3-2 same-length overwrite of an inherited dirty file fails the job', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src/carry.txt'), '0123456789\n');
  await f.baseline();
  writeFileSync(join(f.repo, 'src/carry.txt'), 'abcdefghij\n');
  const r = await f.finish();
  assert.equal(r.state, 'failed');
  assert.deepEqual(r.gbdev_observed.job_files_changed, ['src/carry.txt']);
  assert.ok(r.gbdev_observed.policy_violations.includes('readonly_modified'));
});

for (const change of ['create', 'delete', 'symlink', 'mode', 'index', 'HEAD'] as const) {
  test(`AC-B3-3 job-level ${change} is a reviewer violation`, async t => {
    const f = fixture(t);
    const target = join(f.repo, 'src/initial.txt');
    if (change === 'symlink') symlinkSync(join(f.root, 'outside-unreadable'), join(f.repo, 'src/link'));
    if (change === 'index') writeFileSync(target, 'already dirty\n');
    await f.baseline();
    if (change === 'create') writeFileSync(join(f.repo, 'src/new.txt'), 'new');
    if (change === 'delete') unlinkSync(target);
    if (change === 'symlink') { unlinkSync(join(f.repo, 'src/link')); symlinkSync(join(f.root, 'different-missing-target'), join(f.repo, 'src/link')); }
    if (change === 'mode') chmodSync(target, 0o755);
    if (change === 'index') f.git('add', 'src/initial.txt');
    if (change === 'HEAD') f.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'worker head movement');
    const r = await f.finish();
    assert.equal(r.state, 'failed');
    assert.ok(r.gbdev_observed.policy_violations.includes('readonly_modified'));
    if (change !== 'HEAD') assert.equal(r.gbdev_observed.job_files_changed?.length, 1);
    else assert.notEqual(r.gbdev_observed.head_before, r.gbdev_observed.head_after);
  });
}

test('AC-B3-4/5 pipeline check residue enters same fixer, preserves history/HEAD and does not blame reviewer', async t => {
  const f = pipelineFixture(t);
  writeFileSync(join(f.root, 'plan.json'), JSON.stringify({
    'implement#1': 'ok',
    'fix#1': { scenario: 'fix_ok', sleep_ms: 700, actions: [{ type: 'write_file', path: 'src/check-leftover.txt', content: 'handled\n' }] },
    'review#1': 'review_approve', 'review#2': 'review_approve',
  }));
  const start = await f.start({ acceptance_criteria: [{ id: 'AC1', text: 'check residue', check_cmd: 'test -f src/fix.txt || touch src/check-leftover.txt' }] });
  const implId = await eventually(() => {
    const id = f.read(start.pipeline_id).steps[0]?.attempts[0]?.job_id;
    return id && f.read(start.pipeline_id).steps.some(s => s.kind === 'fix' && s.attempts.length) ? id : undefined;
  });
  const originalJob = readFileSync(join(f.jobDir(implId), 'job.json'), 'utf8');
  const originalResult = readFileSync(join(f.jobDir(implId), 'result.json'), 'utf8');
  const impl = f.result(implId);
  const done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded');
  assert.equal(done.pipeline_id, start.pipeline_id);
  assert.equal(done.round, 1);
  assert.equal(done.steps[1]?.kind, 'fix');
  assert.equal(done.steps[0]?.attempts[0]?.job_id, implId);
  assert.ok(done.steps.every(s => s.attempts.length <= 1));
  assert.ok(done.steps.flatMap(s => s.attempts).every(a => a.attempt === 1));
  assert.equal(readFileSync(join(f.jobDir(implId), 'job.json'), 'utf8'), originalJob);
  assert.equal(readFileSync(join(f.jobDir(implId), 'result.json'), 'utf8'), originalResult);
  assert.equal(done.steps[1]?.head_before, impl.gbdev_observed.head_after);
  const fixId = done.steps[1]!.attempts[0]!.job_id;
  const baseline = readWorkspaceSnapshot(join(f.jobDir(fixId), WORKSPACE_BEFORE));
  assert.equal(baseline.previous_job_id, implId);
  assert.equal(baseline.head_sha, impl.gbdev_observed.head_after);
  assert.ok(impl.gbdev_observed.check_files_changed?.includes('src/check-leftover.txt'));
  assert.ok(impl.gbdev_observed.workspace_issues?.some(i => i.owner_job_id === implId && i.source_phase === 'check' && i.repairable));
  assert.ok(!impl.gbdev_observed.job_files_changed?.includes('src/check-leftover.txt'));
  const reviewers = done.steps.filter(s => s.role === 'reviewer' && s.attempts.length);
  assert.ok(reviewers.length > 0);
  for (const step of reviewers) {
    const review = f.result(step.attempts[0]!.job_id);
    assert.deepEqual(review.gbdev_observed.job_files_changed, []);
    assert.deepEqual(review.gbdev_observed.policy_violations, []);
    assert.deepEqual(review.gbdev_observed.outside_allowed_paths, []);
  }
});

test('AC-B3-6 unknown inherited file survives reviewer and blocks pipeline delivery', async t => {
  const f = pipelineFixture(t, { 'review#1': 'needs_input' });
  const start = await f.start({ pipeline: 'review-only', step_overrides: { review: { provider: 'fake' } }, diff_base_ref: 'HEAD', acceptance_criteria: [] });
  const paused = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(paused.state, 'needs_input');
  const carry = join(paused.workspace.worktree, 'src/unknown-carry.txt');
  writeFileSync(carry, 'mystery\n');
  f.plan({ 'review#1': 'review_approve' });
  const resume = await f.resume(start.pipeline_id, 'answer', { answers: [{ question_id: 'Q1', answer: 'continue' }] });
  assert.equal(resume.envelope.ok, true);
  const done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'needs_decision');
  assert.equal(done.state_reason, 'workspace_unresolved');
  const r = f.result(done.steps[0]!.attempts.at(-1)!.job_id);
  assert.equal(r.state, 'succeeded');
  assert.deepEqual(r.gbdev_observed.policy_violations, []);
  assert.ok(r.gbdev_observed.workspace_issues?.some(i => !i.repairable && i.owner_job_id === null && i.path === 'src/unknown-carry.txt'));
  assert.equal(readFileSync(carry, 'utf8'), 'mystery\n');
});

for (const damage of ['missing', 'invalid-json', 'invalid-shape', 'wrong-job', 'after-unwritable'] as const) {
  test(`AC-B3-7 ${damage}: valid report cannot override evidence failure or invent attribution`, async t => {
    const f = fixture(t, 'workspace-write');
    writeFileSync(join(f.repo, 'outside.txt'), 'inherited');
    await f.baseline();
    if (damage === 'missing') unlinkSync(join(f.paths.dir, WORKSPACE_BEFORE));
    if (damage === 'invalid-json') writeFileSync(join(f.paths.dir, WORKSPACE_BEFORE), '{');
    if (damage === 'invalid-shape') atomicWriteJson(join(f.paths.dir, WORKSPACE_BEFORE), { version: 1, entries: [{}] });
    if (damage === 'wrong-job') {
      const b = readWorkspaceSnapshot(join(f.paths.dir, WORKSPACE_BEFORE));
      atomicWriteJson(join(f.paths.dir, WORKSPACE_BEFORE), { ...b, job_id: 'other' });
    }
    if (damage === 'after-unwritable') mkdirSync(join(f.paths.dir, WORKSPACE_AFTER_WORKER));
    writeFileSync(join(f.repo, 'src/new.txt'), 'worker');
    const beforeIndex = f.git('ls-files', '-s');
    const r = await f.finish();
    assert.equal(r.state, 'failed');
    assert.equal(r.failure_reason, 'workspace_snapshot_invalid');
    assert.ok(r.failure_reasons?.includes('workspace_snapshot_invalid'));
    assert.equal(new GbdevError('workspace_snapshot_invalid', '').contract.retryable, false);
    assert.deepEqual(r.gbdev_observed.policy_violations, []);
    assert.deepEqual(r.gbdev_observed.outside_allowed_paths, []);
    assert.equal(r.gbdev_observed.snapshot_commit, null);
    assert.ok(r.gbdev_observed.workspace_issues?.some(i => i.code === 'workspace_snapshot_invalid'));
    assert.equal(f.git('ls-files', '-s'), beforeIndex);
    assert.equal(f.git('rev-parse', 'HEAD').trim(), f.status.base_sha);
    assert.equal(gate(r, 'change', false, { hasFixLoop: true }).detail, 'workspace_snapshot_invalid');
  });
}

for (const damage of ['none', 'missing', 'corrupt', 'changed'] as const) {
  test(`AC-B3-7 recovery ${damage}: current after snapshot, same baseline, no false blame`, async t => {
    const f = fixture(t);
    writeFileSync(join(f.repo, 'outside.txt'), 'inherited');
    await f.baseline();
    f.report();
    if (damage === 'missing') unlinkSync(join(f.paths.dir, WORKSPACE_BEFORE));
    if (damage === 'corrupt') writeFileSync(join(f.paths.dir, WORKSPACE_BEFORE), '{}');
    if (damage === 'changed') writeFileSync(join(f.repo, 'outside.txt'), 'modified!');
    // Stale/corrupt after evidence must be replaced, not used or silently ignored.
    writeFileSync(join(f.paths.dir, WORKSPACE_AFTER_WORKER), '{}');
    const r = failureResult(f.store, f.status, null);
    if (damage === 'missing' || damage === 'corrupt') {
      assert.equal(r.failure_reason, 'worker_crashed');
      assert.ok(r.failure_reasons?.includes('workspace_snapshot_invalid'));
      assert.equal(r.gbdev_observed.snapshot_commit, null);
      assert.equal(r.gbdev_observed.job_files_changed, undefined);
      const decision = gate(r, 'change', false, { hasFixLoop: true });
      assert.equal(decision.action, 'settle');
      assert.equal(decision.state, 'needs_decision');
      assert.equal(decision.rule, 'B3');
      assert.equal(isRetryableRateLimit(r, '429 rate limit'), false);
    } else {
      readWorkspaceSnapshot(join(f.paths.dir, WORKSPACE_AFTER_WORKER));
      assert.equal(r.failure_reason, 'worker_crashed');
    }
    assert.equal(r.state, 'failed');
    assert.deepEqual(r.gbdev_observed.policy_violations, damage === 'changed' ? ['outside_allowed_paths', 'readonly_modified'] : []);
  });
}

for (const failed of [false, true]) {
  test(`AC-B3-8 inherited staged content exists before baseline; ${failed ? 'failed' : 'successful'} job preserves index`, async t => {
    const f = fixture(t, 'workspace-write');
    writeFileSync(join(f.repo, 'src/inherited-staged.txt'), 'inherited');
    f.git('add', 'src/inherited-staged.txt');
    const originalIndex = readFileSync(join(f.repo, '.git/index'));
    await f.baseline();
    writeFileSync(join(f.repo, 'src/new.txt'), 'worker');
    f.report();
    const r = await finalize(f.store, f.status, f.task, failed ? 1 : 0);
    assert.equal(r.state, failed ? 'failed' : 'succeeded');
    assert.equal(r.gbdev_observed.snapshot_commit, null);
    assert.ok(r.gbdev_observed.workspace_issues?.some(i => i.code === 'inherited_staged_blocks_snapshot'));
    assert.equal(f.git('rev-parse', 'HEAD').trim(), f.status.base_sha);
    assert.deepEqual(readFileSync(join(f.repo, '.git/index')), originalIndex);
    assert.equal(readFileSync(join(f.repo, 'src/inherited-staged.txt'), 'utf8'), 'inherited');
    assert.equal(readFileSync(join(f.repo, 'src/new.txt'), 'utf8'), 'worker');
  });
}

test('B3 after-check capture failure is unconditional even with a valid worker report', async t => {
  const f = fixture(t);
  await f.baseline();
  f.task.acceptance_criteria = [{ id: 'AC1', text: 'break watched root', check_cmd: 'mv .git .git-saved' }];
  const r = await f.finish();
  assert.equal(r.failure_reason, 'workspace_snapshot_invalid');
  assert.equal(r.state, 'failed');
  assert.ok(r.failure_reasons?.includes('workspace_snapshot_invalid'));
  assert.equal(r.worker_reported?.status, 'succeeded');
});

for (const sandbox of ['read-only', 'workspace-write'] as const) {
  test(`M9 ${sandbox}: after-check missing git fails closed without throwing from finalize`, async t => {
    const f = fixture(t, sandbox);
    await f.baseline();
    f.task.acceptance_criteria = [{ id: 'AC1', text: 'remove git metadata', check_cmd: 'mv .git .git-saved' }];
    await assert.doesNotReject(async () => {
      const r = await f.finish();
      assert.equal(r.state, 'failed');
      assert.equal(r.failure_reason, 'workspace_snapshot_invalid');
      assert.ok(r.failure_reasons?.includes('workspace_snapshot_invalid'));
      assert.ok(r.gbdev_observed.workspace_issues?.some(issue => issue.code === 'workspace_snapshot_invalid'));
      assert.equal(r.worker_reported?.status, 'succeeded');
      assert.equal(r.gbdev_observed.checks[0]?.exit_code, 0);
      assert.equal(f.store.read(f.status.job_id).state, 'failed');
      assert.equal(f.result(f.status.job_id).failure_reason, 'workspace_snapshot_invalid');
    });
  });
}

test('B3 oversized files are unknown, file-count overflow fails closed, cancellation is bounded', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src/big.bin'), Buffer.alloc(SNAPSHOT_MAX_HASH_BYTES + 1));
  const meta = { job_id: f.status.job_id, phase: 'before_worker' as const };
  const a = await captureWorkspaceSnapshot(f.repo, meta);
  const b = captureWorkspaceSnapshotSync(f.repo, { ...meta, phase: 'after_worker' });
  assert.equal(a.entries.find(e => e.path === 'src/big.bin')?.content_unknown, true);
  // M8.1: unhashed but stat-identical (capture settles the racy window) is unchanged; a rewrite is changed.
  assert.ok(!diffSnapshotPaths(a, b).includes('src/big.bin'));
  appendFileSync(join(f.repo, 'src/big.bin'), 'x');
  assert.ok(diffSnapshotPaths(a, captureWorkspaceSnapshotSync(f.repo, { ...meta, phase: 'after_worker' })).includes('src/big.bin'));
  await assert.rejects(captureWorkspaceSnapshot(f.repo, meta, { signal: AbortSignal.abort() }), /cancelled/);
  assert.throws(() => captureWorkspaceSnapshotSync(f.repo, meta, { deadlineAt: 1 }), /deadline/);
  for (let i = 0; i < SNAPSHOT_MAX_FILES; i++) writeFileSync(join(f.repo, `src/f${i}`), '');
  await assert.rejects(captureWorkspaceSnapshot(f.repo, meta), /file count/);
});

test('B3 intermediate symlink cannot make a watched extra read outside the workspace', async t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'notepad.md'), 'not workspace evidence');
  symlinkSync(outside, join(f.repo, '.omc'));
  await assert.rejects(captureWorkspaceSnapshot(f.repo, { job_id: f.status.job_id, phase: 'before_worker' }), /Symlink ancestor/);
});

test('B3 quick read-only workspace probe errors block launch retry', async t => {
  const f = fixture(t);
  const invocation = fake.buildInvocation.bind(fake);
  t.mock.method(fake, 'buildInvocation', (ctx: Parameters<typeof fake.buildInvocation>[0]) => {
    unlinkSync(join(ctx.jobDir, WORKSPACE_BEFORE));
    return invocation(ctx);
  });
  await superviseJob(f.status.job_id, f.store);
  const r = f.result(f.status.job_id);
  assert.equal(r.failure_reason, 'workspace_snapshot_invalid');
  assert.equal(readFileSync(f.paths.events, 'utf8').includes('"type":"launch_retry"'), false);
});

test('B3 fixInput retains review findings alongside workspace findings', async t => {
  const f = fixture(t);
  await f.baseline();
  const r = await f.finish();
  r.worker_reported!.review = { verdict: 'revise', findings: [{ id: 'F1', severity: 'major', file: 'src/initial.txt', line: 1, message: 'Review defect', suggestion: null }] };
  r.gbdev_observed.workspace_issues = [{ code: 'check_workspace_delta', path: 'src/leftover', source_phase: 'check', owner_job_id: r.job_id, repairable: true }];
  atomicWriteJson(f.paths.result, r);
  const input = fixInput(f.store, { attempts: [{ job_id: r.job_id }] } as PipelineRun['steps'][number]);
  assert.deepEqual(input.findings.map(i => i.id), ['F1', 'W1']);
  assert.equal(input.findings[0]?.message, 'Review defect');
  r.failure_reason = 'check_failed:AC1';
  r.gbdev_observed.checks = [{ id: 'AC1', cmd: 'false', exit_code: 1, log: 'checks/AC1.log' }];
  atomicWriteJson(f.paths.result, r);
  assert.deepEqual(fixInput(f.store, { attempts: [{ job_id: r.job_id }] } as PipelineRun['steps'][number]).findings.map(i => i.id), ['C1', 'F1', 'W1']);
});

test('B3 lane reuse takes a fresh job baseline without rewriting prior result', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'src/carry.txt'), 'prior lane residue');
  await f.baseline();
  const first = await f.finish();
  const firstBytes = readFileSync(f.paths.result, 'utf8');
  const next = { ...f.status, job_id: 'j_20261031_1200_abcd', state: 'starting' as const };
  f.store.create(next);
  const paths = jobPaths(f.store.paths, next.job_id);
  atomicWriteJson(paths.brief, f.task);
  atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE), await captureWorkspaceSnapshot(f.repo, { job_id: next.job_id, phase: 'before_worker' }));
  writeFileSync(paths.finalMessage, readFileSync(f.paths.finalMessage));
  const second = await finalize(f.store, next, f.task, 0);
  assert.equal(first.state, 'succeeded'); assert.equal(second.state, 'succeeded');
  assert.deepEqual(second.gbdev_observed.job_files_changed, []);
  assert.deepEqual(second.gbdev_observed.policy_violations, []);
  assert.equal(readFileSync(f.paths.result, 'utf8'), firstBytes);
  rmSync(join(paths.dir, WORKSPACE_BEFORE));
});


test('B3 undecidable unhashed evidence fails closed without policy blame or snapshot', async t => {
  const f = fixture(t, 'workspace-write');
  writeFileSync(join(f.repo, 'src/big.bin'), Buffer.alloc(SNAPSHOT_MAX_HASH_BYTES + 1));
  await f.baseline();
  // M8.1: an unhashed file is decidable through its stat identity; evidence without one is not.
  const file = join(f.paths.dir, WORKSPACE_BEFORE);
  const legacy = JSON.parse(readFileSync(file, 'utf8')) as { entries: { path: string; content_stat?: unknown }[] };
  delete legacy.entries.find(e => e.path === 'src/big.bin')!.content_stat;
  atomicWriteJson(file, legacy);
  const r = await f.finish();
  assert.equal(r.failure_reason, 'workspace_snapshot_invalid');
  assert.deepEqual(r.gbdev_observed.policy_violations, []);
  assert.deepEqual(r.gbdev_observed.outside_allowed_paths, []);
  assert.equal(r.gbdev_observed.snapshot_commit, null);
});


test('AC-B3-5 run-bound pipeline fixer does not add a task attempt', async t => {
  const f = runFixture(t);
  f.request.tasks = [{ ...f.request.tasks![0]!, file_scope: ['src/**'], acceptance_criteria: [
    { id: 'AC1', text: 'check leaves a repairable file', check: 'residue' },
  ] }];
  f.request.checks.push({ id: 'residue', cmd: 'test -f src/fixed.txt || touch src/residue.txt', timeout_min: 1 });
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'a' }] };
  f.fakePlan['review#2'] = 'review_approve';
  f.fakePlan['a/fix#1'] = { actions: [
    { type: 'write_file', path: 'src/residue.txt', content: 'handled' },
    { type: 'write_file', path: 'src/fixed.txt', content: 'fixed' },
  ] };
  const { run } = await f.execute();
  assert.equal(run.state, 'succeeded', JSON.stringify(run.attention));
  const task = run.tasks[0]!;
  assert.equal(task.attempts.length, 1);
  assert.equal(task.attempts[0]?.kind, 'initial');
  const pipeline = readPipeline(f.store, task.attempts[0]!.pipeline_id);
  assert.equal(pipeline.state, 'succeeded');
  assert.equal(pipeline.round, 1);
  assert.equal(pipeline.steps[1]?.kind, 'fix');
  assert.ok(pipeline.steps.flatMap(s => s.attempts).every(a => a.attempt === 1));
  const priorId = pipeline.steps[0]!.attempts[0]!.job_id;
  const prior = JSON.parse(readFileSync(jobPaths(f.store.paths, priorId).result, 'utf8'));
  assert.equal(pipeline.steps[1]?.head_before, prior.gbdev_observed.head_after);
  assert.equal(f.store.read(priorId).state, 'succeeded');
});

for (const forced of ['cancelled', 'timeout', 'worker_stalled'] as const) {
  test(`B3 after-worker snapshot failure preserves ${forced} state, cause and gate`, async t => {
    const f = fixture(t);
    await f.baseline();
    f.report();
    // The baseline is valid; only publishing the after-worker snapshot fails.
    mkdirSync(join(f.paths.dir, WORKSPACE_AFTER_WORKER));
    if (forced === 'cancelled') atomicWriteJson(f.paths.cancelRequest, { at: localIso() });
    const r = await finalize(f.store, f.status, f.task, 0, forced === 'cancelled' ? undefined : forced);
    const expectedState = forced === 'worker_stalled' ? 'failed' : forced;
    const expectedReason = forced === 'cancelled' ? null : forced;
    assert.equal(r.state, expectedState);
    assert.equal(r.failure_reason, expectedReason);
    assert.ok(r.failure_reasons?.includes('workspace_snapshot_invalid'));
    assert.ok(r.gbdev_observed.workspace_issues?.some(i => i.code === 'workspace_snapshot_invalid'));
    assert.equal(f.store.read(f.status.job_id).state, expectedState);
    assert.equal(f.store.read(f.status.job_id).failure_reason, expectedReason);
    for (const output of ['change', 'verdict'] as const) {
      assert.deepEqual(gate(r, output), gate({ ...r, failure_reasons: [] }, output));
      assert.deepEqual(gate(r, output, true), gate({ ...r, failure_reasons: [] }, output, true));
    }
  });
}
