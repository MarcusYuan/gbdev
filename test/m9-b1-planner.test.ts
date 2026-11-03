import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers/m3.js';
import { result as sampleResult } from './helpers.js';
import { startRun, resumeRun, runCommand } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { readRun, runPaths, writeRun } from '../src/run/store.js';
import { readRuntime, prepareDecisions, requireDecision, writeRuntime } from '../src/run/decisions.js';
import { plannerTransientFailure } from '../src/run/planner.js';
import { runJobs } from '../src/run/invariants.js';
import { jobPaths } from '../src/core/paths.js';
import { fake } from '../src/providers/fake.js';
import type { Run } from '../src/contracts/run.js';

const questions = [{ id: 'Q1', question: 'Which implementation?', options: ['A', 'B'], default: null, blocking: true }];
const input = (run: Run, action: 'answer' | 'approve_plan') => ({ schema: 'gbdev.run-resume.v1', run_id: run.run_id, decision_id: run.attention[0]!.decision_id, task_id: null, action, task_graph: null, note: null, answers: action === 'answer' ? [{ question_id: 'Q1', answer: 'Use implementation B' }] : null });

for (const validGraph of [true, false]) test(`M9 needs_input ${validGraph ? 'valid graph' : 'no graph'} has answer; answer at attempt 3 reruns planner`, async t => {
  const f = fixture(t);
  const graph = { schema: 'gbdev.task-graph.v1', summary: 'Proposed plan', tasks: f.request.tasks };
  f.request.decompose = 'planner'; f.request.tasks = null;
  f.fakePlan['run:planner#1'] = { actions: [{ type: 'report_fields', fields: { status: 'needs_input', open_questions: questions, policy_violations: ['Cleaned planning scratch notes'], policy_incidents: [], ...(validGraph ? { task_graph: graph } : {}) } }] };
  let { run } = await f.execute();
  assert.equal(run.state, validGraph ? 'plan_review' : 'needs_decision');
  assert.equal(run.attention[0]!.reason, validGraph ? 'plan_review' : 'plan_invalid');
  assert.deepEqual(run.attention[0]!.pending_questions, questions);
  assert.match(run.attention[0]!.detail, /Policy warnings:.*Cleaned planning scratch notes/);
  assert.ok(run.attention[0]!.allowed_actions.includes('answer'));
  assert.equal(run.plan.plan_attempts, 1);
  const projected = await runCommand(f.store, ['status', run.run_id], {});
  assert.deepEqual((projected.result as Run).attention[0]!.pending_questions, questions);
  run.plan.plan_attempts = 3;
  const old = run.attention.shift()!;
  requireDecision(f.store, run, null, old.reason, old.detail, ['answer', 'replan', 'approve_plan'], questions);
  assert.ok(run.attention[0]!.allowed_actions.includes('answer'));
  assert.ok(!run.attention[0]!.allowed_actions.includes('replan'));
  writeRun(f.store, run);
  assert.throws(() => prepareDecisions(f.store, run, f.request, { ...input(run, 'answer'), answers: [] }, readRuntime(f.store, run)));
  assert.throws(() => prepareDecisions(f.store, run, f.request, { ...input(run, 'answer'), answers: [{ question_id: 'Q1', answer: '   ' }] }, readRuntime(f.store, run)));
  await resumeRun(f.store, run.run_id, input(run, 'answer'), false);
  assert.equal(readRun(f.store, run.run_id).state, 'planning');
  f.fakePlan['run:planner#2'] = { actions: [{ type: 'emit_task_graph', graph }] }; f.savePlan();
  await superviseRun(f.store, run.run_id);
  run = readRun(f.store, run.run_id);
  assert.equal(run.state, 'plan_review');
  assert.equal(run.plan.plan_attempts, 3);
  const job = runJobs(f.store, run).find(j => j.step_instance === 'run:planner#2')!;
  const prompt = readFileSync(jobPaths(f.paths, job.job_id).prompt, 'utf8');
  assert.match(prompt, /Which implementation\?/);
  assert.match(prompt, /Use implementation B/);
  await resumeRun(f.store, run.run_id, input(run, 'approve_plan'), false);
  assert.equal(readRun(f.store, run.run_id).plan.approved_by, 'grok-bot');
  assert.equal(readRun(f.store, run.run_id).tasks.length, 2);
});

test('M9 run answer has independent limit and forged allowed_actions cannot bypass it', async t => {
  const f = fixture(t); f.request.decompose = 'planner'; f.request.tasks = null;
  const run = await startRun(f.store, f.request, false);
  const runtime = readRuntime(f.store, run);
  runtime.plan_answers = Array.from({ length: 3 }, () => ({ questions, answers: [{ question_id: 'Q1', answer: 'A' }] }));
  writeRuntime(f.store, run, runtime);
  const d = requireDecision(f.store, run, null, 'plan_invalid', 'questions', ['answer', 'approve_plan'], questions);
  assert.deepEqual(d.allowed_actions, ['approve_plan']);
  d.allowed_actions.push('answer');
  assert.throws(() => prepareDecisions(f.store, run, f.request, input(run, 'answer'), runtime), /plan_answers_exhausted/);
});

for (const kind of ['quick_exit', 'rate_limit', 'launch_failed'] as const) test(`M9 ${kind} consumes jobs but not plan attempts; three automatic retries then decision`, async t => {
  const f = fixture(t); f.request.decompose = 'planner'; f.request.tasks = null;
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8'));
  config.parallel = { rate_limit_cooldown_s: 0 };
  config.worker_launch = { max_retries: 0 };
  writeFileSync(f.paths.config, JSON.stringify(config));
  const code = kind === 'quick_exit' ? 'console.log(JSON.stringify({type:"turn.started"}));process.exit(1)' : kind === 'rate_limit' ? 'console.error("429 Too Many Requests");process.exit(1)' : 'process.exit(1)';
  t.mock.method(fake, 'buildInvocation', (ctx: { worktree: string; jobDir: string }) => ({ cmd: process.execPath, args: ['-e', code], cwd: ctx.worktree, finalMessageFile: join(ctx.jobDir, 'final.md') }));
  const { run } = await f.execute();
  assert.equal(run.state, 'needs_decision', run.failure_reason ?? '');
  assert.equal(run.attention[0]!.reason, 'plan_invalid');
  assert.equal(run.plan.plan_attempts, 0);
  assert.equal(run.budget.jobs_used, 4);
  assert.equal(readRuntime(f.store, run).plan_transient_retries?.[kind], 3);
  const events = readFileSync(runPaths(f.store, run.run_id).events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(events.filter(e => e.type === 'provider_cooldown').length >= 3);
  assert.equal(events.filter(e => e.type === 'plan_invalid').length, 4);
});

test('M9 transient classifier preserves substantive/provider-valid/policy failures', () => {
  const r = sampleResult(); r.state = 'failed'; r.failure_reason = 'worker_exit_nonzero:1'; r.worker_exit_code = 1; r.duration_s = 30; r.worker_reported = null;
  assert.equal(plannerTransientFailure(r), 'quick_exit');
  r.duration_s = 60; assert.equal(plannerTransientFailure(r), null);
  r.failure_reason = 'provider_error: offline'; assert.equal(plannerTransientFailure(r), 'provider_failure');
  r.worker_reported = sampleResult().worker_reported; assert.equal(plannerTransientFailure(r), null);
  r.failure_reason = 'rate_limit'; r.gbdev_observed.policy_violations = ['outside_allowed_paths']; assert.equal(plannerTransientFailure(r), null);
});

for (const crash of [false, true]) test(`M9 answer transient exhaustion clears freebie and replan costs an attempt: crash=${crash}`, async t => {
  const f = fixture(t), graph = { schema: 'gbdev.task-graph.v1', summary: 'Recovered plan', tasks: f.request.tasks };
  f.request.decompose = 'planner'; f.request.tasks = null;
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8'));
  config.parallel = { rate_limit_cooldown_s: 0 };
  config.worker_launch = { max_retries: 0 };
  writeFileSync(f.paths.config, JSON.stringify(config));
  f.fakePlan['run:planner#1'] = { actions: [{ type: 'report_fields', fields: { status: 'needs_input', open_questions: questions } }] };
  let { run } = await f.execute();
  assert.equal(run.plan.plan_attempts, 1);
  await resumeRun(f.store, run.run_id, input(run, 'answer'), false);
  assert.equal(readRuntime(f.store, run).plan_answer_pending, true);
  const original = fake.buildInvocation.bind(fake);
  const failure = t.mock.method(fake, 'buildInvocation', (ctx: { worktree: string; jobDir: string }) => ({
    cmd: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"turn.started"}));process.exit(1)'],
    cwd: ctx.worktree, finalMessageFile: join(ctx.jobDir, 'final.md'),
  }));
  if (crash) {
    run = readRun(f.store, run.run_id);
    const runtime = readRuntime(f.store, run);
    runtime.plan_transient_retries = { quick_exit: 3 };
    writeRuntime(f.store, run, runtime);
    const { planRun } = await import('../src/run/planner.js');
    const snapshots = JSON.parse(readFileSync(runPaths(f.store, run.run_id).snapshot, 'utf8'));
    await assert.rejects(planRun(f.store, run, f.request, snapshots['internal:planner'], {
      async acquireSlot() {}, async releaseSlot() {}, async onRateLimit() {},
    }, new AbortController().signal, runtime, async () => {
      assert.ok(JSON.parse(readFileSync(join(runPaths(f.store, run.run_id).dir, 'plans/plan-2.json'), 'utf8')).job_id);
      throw new Error('injected crash before exhausted publish');
    }), /injected crash/);
    assert.equal(runtime.plan_answer_pending, true);
    assert.equal(runtime.plan_sequence, 1);
    assert.equal(run.plan.plan_attempts, 1);
    assert.equal(readRuntime(f.store, run).plan_answer_pending, true);
    assert.equal(readRun(f.store, run.run_id).state, 'planning');
  }
  await superviseRun(f.store, run.run_id);
  run = readRun(f.store, run.run_id);
  const exhausted = readRuntime(f.store, run);
  assert.equal(run.state, 'needs_decision');
  assert.equal(run.attention[0]!.reason, 'plan_invalid');
  assert.equal(run.plan.plan_attempts, 1);
  assert.equal(exhausted.plan_transient_retries?.quick_exit, 3);
  assert.equal(exhausted.plan_answer_pending, false);
  assert.equal(exhausted.plan_answers?.length, 1);
  if (!crash) assert.equal(run.budget.jobs_used, 5);
  assert.ok(run.attention[0]!.allowed_actions.includes('replan'));
  failure.mock.mockImplementation(original);
  f.fakePlan[`run:planner#${exhausted.plan_sequence! + 1}`] = { actions: [{ type: 'emit_task_graph', graph }] }; f.savePlan();
  await resumeRun(f.store, run.run_id, { ...input(run, 'approve_plan'), action: 'replan' }, false);
  await superviseRun(f.store, run.run_id);
  run = readRun(f.store, run.run_id);
  assert.equal(run.state, 'plan_review');
  assert.equal(run.plan.plan_attempts, 2);
  assert.equal(readRuntime(f.store, run).plan_answer_pending, false);
});

test('M9 transient failure automatically retries after cooldown and successful graph costs one plan attempt', async t => {
  const f = fixture(t), graph = { schema: 'gbdev.task-graph.v1', summary: 'Recovered', tasks: f.request.tasks };
  f.request.decompose = 'planner'; f.request.tasks = null;
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.parallel = { rate_limit_cooldown_s: 1 };
  writeFileSync(f.paths.config, JSON.stringify(config));
  f.fakePlan['run:planner#2'] = { actions: [{ type: 'emit_task_graph', graph }] };
  const original = fake.buildInvocation.bind(fake);
  let calls = 0;
  t.mock.method(fake, 'buildInvocation', (...args: Parameters<typeof original>) => !args[0].jobDir || calls++ ? original(...args) : ({ cmd: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"turn.started"}));process.exit(1)'], cwd: args[0].worktree, finalMessageFile: join(args[0].jobDir, 'final.md') }));
  const { run } = await f.execute();
  assert.equal(run.state, 'plan_review', JSON.stringify(run));
  assert.equal(run.plan.plan_attempts, 1);
  assert.equal(run.budget.jobs_used, 2);
  const events = readFileSync(runPaths(f.store, run.run_id).events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const cooldown = events.find(e => e.type === 'provider_cooldown');
  const second = runJobs(f.store, run).find(j => j.step_instance === 'run:planner#2')!;
  assert.ok(Date.parse(second.created_at) >= Date.parse(cooldown.data.until));
  await resumeRun(f.store, run.run_id, input(run, 'approve_plan'), false);
  assert.equal(readRun(f.store, run.run_id).tasks.length, 2);
});

for (const validGraph of [true, false]) test(`M9 planner crash after artifact before publish retains answer: graph=${validGraph}`, async t => {
  const f = fixture(t), graph = { schema: 'gbdev.task-graph.v1', summary: 'Plan', tasks: f.request.tasks };
  f.request.decompose = 'planner'; f.request.tasks = null;
  const response = { actions: [{ type: 'report_fields', fields: { status: 'needs_input', open_questions: questions, ...(validGraph ? { task_graph: graph } : {}) } }] };
  f.fakePlan['run:planner#1'] = response;
  let { run } = await f.execute();
  run.plan.plan_attempts = 3; writeRun(f.store, run);
  await resumeRun(f.store, run.run_id, input(run, 'answer'), false);
  run = readRun(f.store, run.run_id);
  const runtime = readRuntime(f.store, run);
  f.fakePlan['run:planner#2'] = response; f.savePlan();
  const { planRun } = await import('../src/run/planner.js');
  const snapshots = JSON.parse(readFileSync(runPaths(f.store, run.run_id).snapshot, 'utf8'));
  let publishes = 0;
  await assert.rejects(planRun(f.store, run, f.request, snapshots['internal:planner'], {
    async acquireSlot() {}, async releaseSlot() {}, async onRateLimit() {},
  }, new AbortController().signal, runtime, async () => {
    publishes++;
    const artifact = JSON.parse(readFileSync(join(runPaths(f.store, run.run_id).dir, 'plans/plan-2.json'), 'utf8'));
    assert.ok(artifact.job_id);
    throw new Error('injected crash before terminal publish');
  }), /injected crash/);
  assert.equal(publishes, 1);
  assert.equal(runtime.plan_sequence, 1);
  assert.equal(runtime.plan_answer_pending, true);
  assert.equal(run.plan.plan_attempts, 3);
  assert.equal(readRun(f.store, run.run_id).state, 'planning');
  assert.equal(readRuntime(f.store, run).plan_answer_pending, true);
  await superviseRun(f.store, run.run_id);
  run = readRun(f.store, run.run_id);
  assert.equal(run.state, validGraph ? 'plan_review' : 'needs_decision');
  assert.equal(run.plan.plan_attempts, 3);
  assert.equal(readRuntime(f.store, run).plan_sequence, 2);
  assert.equal(readRuntime(f.store, run).plan_answer_pending, false);
  assert.ok(JSON.parse(readFileSync(join(runPaths(f.store, run.run_id).dir, 'plans/plan-2.json'), 'utf8')).job_id);
});

test('M9 all three answer reruns execute after ordinary plan attempts are exhausted', async t => {
  const f = fixture(t), graph = { schema: 'gbdev.task-graph.v1', summary: 'Plan', tasks: f.request.tasks };
  f.request.decompose = 'planner'; f.request.tasks = null;
  for (let sequence = 1; sequence <= 4; sequence++) f.fakePlan[`run:planner#${sequence}`] = {
    actions: [{ type: 'report_fields', fields: { status: 'needs_input', open_questions: questions, task_graph: graph } }],
  };
  let { run } = await f.execute();
  run.plan.plan_attempts = 3; writeRun(f.store, run);
  for (let answer = 1; answer <= 3; answer++) {
    assert.ok(run.attention[0]!.allowed_actions.includes('answer'));
    await resumeRun(f.store, run.run_id, input(run, 'answer'), false);
    assert.equal(readRuntime(f.store, run).plan_answer_pending, true);
    await superviseRun(f.store, run.run_id);
    run = readRun(f.store, run.run_id);
    assert.equal(run.state, 'plan_review');
    assert.equal(run.plan.plan_attempts, 3);
    assert.equal(readRuntime(f.store, run).plan_answers?.length, answer);
    assert.equal(readRuntime(f.store, run).plan_sequence, answer + 1);
    assert.equal(readRuntime(f.store, run).plan_answer_pending, false);
    assert.ok(runJobs(f.store, run).some(j => j.step_instance === `run:planner#${answer + 1}`));
  }
  assert.equal(run.budget.jobs_used, 4);
  assert.ok(!run.attention[0]!.allowed_actions.includes('answer'));
  assert.ok(!run.attention[0]!.allowed_actions.includes('replan'));
  assert.throws(() => prepareDecisions(f.store, run, f.request, input(run, 'answer'), readRuntime(f.store, run)));
  await resumeRun(f.store, run.run_id, input(run, 'approve_plan'), false);
  assert.equal(readRun(f.store, run.run_id).tasks.length, 2);
});
