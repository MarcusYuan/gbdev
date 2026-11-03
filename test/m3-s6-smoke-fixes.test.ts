import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './helpers/m3.js';
import { startRun, cancelRun, runCommand } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { jsonFile, readRun, runPaths } from '../src/run/store.js';
import { runJobs } from '../src/run/invariants.js';
import { cleanupRun } from '../src/run/cleanup.js';
import { jobPaths } from '../src/core/paths.js';
import { git } from '../src/core/git.js';
import type { JobResult } from '../src/contracts/jobResult.js';
import type { Run } from '../src/contracts/run.js';

test('D11 R5 planner request specifies both pure-function contracts and node:test paths', () => {
  const request = JSON.parse(readFileSync('docs/smoke-m3/r5-request.json', 'utf8'));
  assert.equal(request.decompose, 'planner'); assert.equal(request.tasks, null);
  for (const contract of ['src/double.js', 'double(n)', 'n*2', 'src/is-even.js', 'isEven(n)', 'Number.isInteger(n) && n % 2 === 0', 'test/double.test.js', 'test/is-even.test.js', 'node:test', 'node:assert/strict', 'assert.equal']) assert.ok(request.goal.includes(contract), contract);
  assert.match(request.context, /import test from 'node:test'/);
  assert.match(request.context, /test\('描述', \(\) => \{ assert.equal/);
});

for (const status of ['needs_input', 'failed'] as const) test(`D12 planner ${status} exposes structured questions and bounded summary without prompt`, async t => {
  const f = fixture(t); f.request.decompose = 'planner'; f.request.tasks = null;
  f.request.context = 'PRIVATE_PROMPT_SENTINEL_DO_NOT_EXPOSE';
  const summary = status === 'needs_input' ? '请明确两个函数的名称、路径和契约。' : 'Missing contract.\n' + '具体问题'.repeat(100) + 'SUMMARY_TAIL_MUST_BE_TRUNCATED';
  const questions = [{ id: 'Q1', question: '两个函数的名称和契约是什么？', options: ['double/isEven', '其他'], default: null, blocking: true }];
  for (const n of [1, 2]) f.fakePlan[`run:planner#${n}`] = { actions: [{ type: 'report_fields', fields: { status, summary, open_questions: questions } }] };
  const { run } = await f.execute();
  assert.equal(run.state, 'needs_decision'); assert.equal(run.plan.plan_attempts, status === 'needs_input' ? 1 : 2);
  const decision = run.attention[0]!;
  assert.equal(decision.reason, 'plan_invalid'); assert.deepEqual(decision.pending_questions, questions);
  assert.deepEqual(decision.allowed_actions, ['replan', 'approve_plan', ...(status === 'needs_input' ? ['answer'] : [])]);
  const excerpt = summary.replace(/\s+/g, ' ').trim().slice(0, 300);
  assert.ok(decision.detail.endsWith(': ' + excerpt)); assert.ok(excerpt.length <= 300);
  assert.doesNotMatch(decision.detail, /Planner did not succeed|PRIVATE_PROMPT_SENTINEL|SUMMARY_TAIL_MUST_BE_TRUNCATED/);
  for (const n of status === 'needs_input' ? [1] : [1, 2]) {
    const plan = jsonFile<{ errors: string[] }>(join(runPaths(f.store, run.run_id).dir, 'plans', `plan-${n}.json`));
    assert.deepEqual(plan.errors, [decision.detail]);
  }
  const response = await runCommand(f.store, ['status', run.run_id], {});
  assert.deepEqual((response.result as Run).attention[0]!.pending_questions, questions);
  assert.equal(run.tasks.length, 0); assert.equal(run.integration.verified_sha, f.base);
  assert.ok(runJobs(f.store, run).every(j => j.provider === 'fake'));
});

test('D13 cancelled task HEAD matches its snapshot and cleanup unmerged_task_commits', async t => {
  let stop: (() => Promise<void>) | undefined;
  t.after(async () => stop?.()); // Registered before fixture removal; settle even on assertion failure.
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  // Guarantee the premise: implementation has produced a snapshot while the task
  // is still running in review. Immediate dirty-worker cancellation need not snapshot.
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'cancel snapshot\n' }] };
  f.fakePlan['review#1'] = 'slow';
  f.savePlan();
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  stop = async () => { try { await cancelRun(f.store, initial.run_id); } finally { await work; } };
  await until(() => runJobs(f.store, readRun(f.store, initial.run_id)).some(j => j.state === 'running' && j.step_instance === 'review#1'));
  assert.equal(readRun(f.store, initial.run_id).tasks[0]!.state, 'running');
  assert.equal(readRun(f.store, initial.run_id).tasks[0]!.head_sha, null);
  await stop();
  const done = readRun(f.store, initial.run_id), task = done.tasks[0]!;
  assert.equal(done.state, 'cancelled'); assert.equal(task.state, 'cancelled');
  const job = runJobs(f.store, done).find(j => j.step_instance === 'implement#1')!;
  const result = jsonFile<JobResult>(jobPaths(f.paths, job.job_id).result);
  const snapshot = result.gbdev_observed.snapshot_commit;
  assert.ok(snapshot, JSON.stringify(result)); assert.notEqual(snapshot, initial.base_sha);
  assert.equal(task.head_sha, snapshot); assert.equal(result.gbdev_observed.head_after, snapshot);
  assert.equal(git(f.repo, ['show', `${snapshot}:src/a.txt`]), 'cancel snapshot\n');
  assert.equal(done.integration.verified_sha, initial.base_sha); assert.equal(done.integration.head_sha, initial.base_sha);
  assert.ok(done.lanes.every(l => l.state === 'idle')); assert.equal(done.supervisor_pid, null);
  const response = await runCommand(f.store, ['status', done.run_id], {});
  assert.equal((response.result as Run).tasks[0]!.head_sha, snapshot);
  const cleanup = await cleanupRun(f.store, done.run_id);
  const retained = cleanup.branches.find(b => b.branch === task.branch)!;
  assert.equal(retained.tip, snapshot); assert.equal(retained.retained_reason, 'unmerged_task_commits'); assert.equal(retained.deleted, false);
  assert.ok(cleanup.worktrees.every(w => w.removed));
});
