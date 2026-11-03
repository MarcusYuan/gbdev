import { assertOrchestratorNote } from './helpers/orchestratorNote.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './helpers/m3.js';
import { testEnv } from './helpers/run.js';
import { startRun, resumeRun, cancelRun } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { readRun, runPaths, jsonFile } from '../src/run/store.js';
import { runJobs } from '../src/run/invariants.js';
import { prepareDecisions, readRuntime } from '../src/run/decisions.js';
import { jobPaths } from '../src/core/paths.js';
import type { Run, RunAction } from '../src/contracts/run.js';
import type { TaskGraph } from '../src/contracts/taskGraph.js';
import { GbdevError } from '../src/contracts/error.js';
import { extractWorkerResult } from '../src/contracts/workerResult.js';
import { worker } from './helpers.js';
function input(run: Run, action: RunAction) { const d = run.attention[0]!; return { schema: 'gbdev.run-resume.v1', run_id: run.run_id, decision_id: d.decision_id, action, task_id: d.task_id, answers: null, task_graph: null, note: null }; }
function planner(f: ReturnType<typeof fixture>) { const graph: TaskGraph = { schema: 'gbdev.task-graph.v1', summary: 'Two tasks', tasks: f.request.tasks! }; f.request.decompose = 'planner'; f.request.tasks = null; return graph; }
const reason = (value: string) => (e: unknown) => e instanceof GbdevError && e.contract.details.reason === value;

test('AC-S5.1 planner cycle emits plan_invalid, retries once, then needs_decision', async t => {
  const f = fixture(t); planner(f);
  for (const n of [1, 2]) f.fakePlan[`run:planner#${n}`] = { actions: [{ type: 'emit_task_graph_cycle' }] };
  const { run } = await f.execute(); assert.equal(run.state, 'needs_decision', JSON.stringify(run)); assert.equal(run.plan.plan_attempts, 2);
  assert.equal(run.attention[0]!.reason, 'plan_invalid'); assert.deepEqual(run.attention[0]!.allowed_actions, ['replan', 'approve_plan']);
  const events = readFileSync(runPaths(f.store, run.run_id).events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.filter(e => e.type === 'plan_invalid').length, 2); assert.match(events.find(e => e.type === 'plan_invalid').data.errors.join(' '), /cycle/i);
  assert.equal(runJobs(f.store, run).length, 2); assert.equal(run.tasks.length, 0); assert.equal(run.integration.verified_sha, f.base);
  const prompt = readFileSync(jobPaths(f.paths, runJobs(f.store, run).find(j => j.step_instance === 'run:planner#2')!.job_id).prompt, 'utf8'); assert.match(prompt, /Dependency cycle/);
  for (const job of runJobs(f.store, run)) {
    const plannerPrompt = readFileSync(jobPaths(f.paths, job.job_id).prompt, 'utf8');
    assert.match(plannerPrompt, /Return task_graph.*final worker-result JSON/);
    assert.match(plannerPrompt, /Only reference trusted check IDs; never invent commands/);
    const graph = extractWorkerResult(plannerPrompt).task_graph!;
    assert.equal(graph.schema, 'gbdev.task-graph.v1'); assert.equal(graph.tasks.length, 1);
    assert.deepEqual(Object.keys(graph.tasks[0]!).sort(), ['acceptance_criteria', 'context', 'depends_on', 'file_scope', 'goal', 'id', 'notes', 'pipeline', 'size', 'title']);
    assert.deepEqual(Object.keys(graph.tasks[0]!.acceptance_criteria[0]!).sort(), ['check', 'id', 'text']);
  }
  for (const job of runJobs(f.store, run)) { assert.equal(job.sandbox, 'read-only'); const schema = jsonFile<{ required: string[] }>(join(jobPaths(f.paths, job.job_id).dir, 'worker-result.schema.json')); assert.ok(schema.required.includes('task_graph')); }
  f.invariants(run.run_id);
});

test('plan_review approval validates edited graph atomically and only then executes', async t => {
  const f = fixture(t), graph = planner(f); f.fakePlan['run:planner#1'] = { actions: [{ type: 'emit_task_graph', graph }] };
  const { run } = await f.execute(); assert.equal(run.state, 'plan_review', JSON.stringify(run)); assert.equal(run.tasks.length, 0);
  const invalid = structuredClone(graph); invalid.tasks[0]!.acceptance_criteria[0]!.check = 'unknown';
  const originalRequest = readFileSync(runPaths(f.store, run.run_id).request, 'utf8');
  const before = readFileSync(runPaths(f.store, run.run_id).run, 'utf8');
  await assert.rejects(resumeRun(f.store, run.run_id, { ...input(run, 'approve_plan'), task_graph: invalid }, false), e => e instanceof GbdevError && e.contract.code === 'run_invalid');
  assert.equal(readFileSync(runPaths(f.store, run.run_id).run, 'utf8'), before);
  graph.tasks = [graph.tasks[0]!]; await resumeRun(f.store, run.run_id, { ...input(run, 'approve_plan'), task_graph: graph, note: 'Execute only this approved task.' }, false); await superviseRun(f.store, run.run_id);
  assert.equal(readFileSync(runPaths(f.store, run.run_id).request, 'utf8'), originalRequest, 'F28 original request is immutable');
  assert.deepEqual(jsonFile<TaskGraph>(join(runPaths(f.store, run.run_id).dir, 'task-graph.json')).tasks, graph.tasks);
  const done = readRun(f.store, run.run_id); assert.equal(done.state, 'succeeded', JSON.stringify(done)); assert.equal(done.tasks.length, 1); assert.equal(done.plan.approved_by, 'grok-bot'); assertOrchestratorNote(readFileSync(jobPaths(f.paths, runJobs(f.store, done).find(j => j.role === 'executor')!.job_id).prompt, 'utf8'), 'Execute only this approved task.'); f.invariants(run.run_id);
});

test('F21 every planner allowed action stages without deferred; replan capped at three including initial', async t => {
  const f = fixture(t), graph = planner(f); for (const n of [1, 2, 3]) f.fakePlan[`run:planner#${n}`] = { actions: [{ type: 'emit_task_graph', graph }] };
  let { run } = await f.execute();
  for (const action of run.attention[0]!.allowed_actions) assert.doesNotThrow(() => prepareDecisions(f.store, run, f.request, input(run, action), readRuntime(f.store, run)));
  for (const n of [2, 3]) {
    await resumeRun(f.store, run.run_id, { ...input(run, 'replan'), note: 'Try a smaller plan' }, false); await superviseRun(f.store, run.run_id); run = readRun(f.store, run.run_id); assert.equal(run.plan.plan_attempts, n); assert.equal(run.state, 'plan_review');
  }
  assert.deepEqual(run.attention[0]!.allowed_actions, ['approve_plan']);
  const forged = structuredClone(run); forged.attention[0]!.allowed_actions.push('replan');
  assert.throws(() => prepareDecisions(f.store, forged, f.request, input(forged, 'replan'), readRuntime(f.store, run)), reason('plan_attempts_exhausted'));
  assertOrchestratorNote(readFileSync(jobPaths(f.paths, runJobs(f.store, run).find(j => j.step_instance === 'run:planner#3')!.job_id).prompt, 'utf8'), 'Try a smaller plan');
  await resumeRun(f.store, run.run_id, input(run, 'approve_plan'), false); await superviseRun(f.store, run.run_id); assert.equal(readRun(f.store, run.run_id).state, 'succeeded');
});

test('plan_invalid approval requires explicit replacement; invalid check reference also retries', async t => {
  const f = fixture(t), graph = planner(f), bad = structuredClone(graph); bad.tasks[0]!.acceptance_criteria[0]!.check = 'untrusted';
  for (const n of [1, 2]) f.fakePlan[`run:planner#${n}`] = { actions: [{ type: 'emit_task_graph', graph: bad }] };
  const { run } = await f.execute(); assert.equal(run.attention[0]!.reason, 'plan_invalid');
  await assert.rejects(resumeRun(f.store, run.run_id, input(run, 'approve_plan'), false), e => e instanceof GbdevError && e.contract.code === 'run_invalid');
  for (const action of run.attention[0]!.allowed_actions) assert.doesNotThrow(() => prepareDecisions(f.store, run, f.request, { ...input(run, action), task_graph: action === 'approve_plan' ? graph : null }, readRuntime(f.store, run)));
  await resumeRun(f.store, run.run_id, { ...input(run, 'approve_plan'), task_graph: graph }, false); await superviseRun(f.store, run.run_id); assert.equal(readRun(f.store, run.run_id).state, 'succeeded');
});

test('planner modifications fail run and preserve dirty evidence', async t => {
  const f = fixture(t), graph = planner(f); f.fakePlan['run:planner#1'] = { scenario: 'readonly_violation', actions: [{ type: 'emit_task_graph', graph }] };
  const { run } = await f.execute(); assert.equal(run.state, 'failed'); assert.equal(run.failure_reason, 'planner_modified_worktree'); assert.ok(existsSync(join(run.integration.worktree, 'src/readonly.txt')));
});

test('F21 final-fix executes normal lane merge gate flow, caps at two and never advertises deferred', async t => {
  const f = fixture(t); f.request.final_review = 'reviewer';
  for (const n of [1, 2, 3]) f.fakePlan[`run:final_review#${n}`] = 'review_revise';
  let { run } = await f.execute();
  for (const n of [1, 2]) {
    assert.deepEqual(run.attention[0]!.allowed_actions, ['add_fix_task', 'accept_final']);
    for (const action of run.attention[0]!.allowed_actions) assert.doesNotThrow(() => prepareDecisions(f.store, run, f.request, input(run, action), readRuntime(f.store, run)));
    f.fakePlan[`final-fix-${n}/fix#1`] = { actions: [{ type: 'write_file', path: `src/final-${n}.txt`, content: 'fixed\n' }] }; f.savePlan();
    await resumeRun(f.store, run.run_id, { ...input(run, 'add_fix_task'), note: `Address final findings ${n} only.` }, false); await superviseRun(f.store, run.run_id); run = readRun(f.store, run.run_id);
    const fix = run.tasks.find(t => t.task_id === `final-fix-${n}`)!; assert.equal(fix.state, 'integrated', JSON.stringify(run)); assert.equal(fix.attempts[0]!.kind, 'final_fix'); assert.ok(existsSync(join(run.integration.worktree, `src/final-${n}.txt`)));
    const job = runJobs(f.store, run).find(j => j.task_id === fix.task_id && j.role === 'fixer')!;
    assert.match(readFileSync(jobPaths(f.paths, job.job_id).prompt, 'utf8'), /Fix the fake issue/);
    assertOrchestratorNote(readFileSync(jobPaths(f.paths, job.job_id).prompt, 'utf8'), `Address final findings ${n} only.`);
  }
  assert.deepEqual(run.attention[0]!.allowed_actions, ['accept_final']);
  await assert.rejects(resumeRun(f.store, run.run_id, input(run, 'add_fix_task'), false), e => e instanceof GbdevError && e.contract.code === 'run_state_conflict');
  const forged = structuredClone(run); forged.attention[0]!.allowed_actions.push('add_fix_task');
  assert.throws(() => prepareDecisions(f.store, forged, f.request, input(forged, 'add_fix_task'), readRuntime(f.store, run)), reason('final_fixes_exhausted'));
  await resumeRun(f.store, run.run_id, input(run, 'accept_final'), false); assert.equal(readRun(f.store, run.run_id).outcome, 'accepted_by_decider'); f.invariants(run.run_id);
});

test('final verifier is supported; reject retries once before final_review_rejected', async t => {
  const f = fixture(t); f.request.final_review = 'verifier'; f.fakePlan['run:final_review#1'] = 'review_reject'; f.fakePlan['run:final_review#2'] = 'review_reject';
  const { run } = await f.execute(); assert.equal(run.attention[0]!.reason, 'final_review_rejected'); const reviews = runJobs(f.store, run).filter(j => j.step_instance?.startsWith('run:final_review#')); assert.equal(reviews.length, 2); assert.ok(reviews.every(j => j.role === 'verifier'));
});

test('final-fix respects max_tasks budget and removes unavailable action', async t => {
  const f = fixture(t); f.request.max_tasks = 2; f.request.final_review = 'reviewer'; f.fakePlan['run:final_review#1'] = 'review_revise';
  const { run } = await f.execute(); assert.deepEqual(run.attention[0]!.allowed_actions, ['accept_final']);
});

test('F23 live cancellation uses asynchronous HEAD/park reads and reliably settles', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.fakePlan['a/implement#1'] = 'slow'; f.savePlan(); const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { try { await cancelRun(f.store, initial.run_id); } finally { await work; } };
  await until(() => runJobs(f.store, readRun(f.store, initial.run_id)).some(j => j.state === 'running'));
  assert.equal((await cancelRun(f.store, initial.run_id)).state, 'cancelled'); await work;
  const source = readFileSync('src/run/supervisor.ts', 'utf8').split('async function superviseRunOwned')[1]!;
  assert.doesNotMatch(source, /\bhead\(|manager\.park\(/); assert.match(source, /await headAsync/); f.invariants(initial.run_id);
});

for (const tail of ['No further action needed...', '\nMore explanation.']) test(`F24 accepts closing fence with trailing prose ${JSON.stringify(tail)}`, () => {
  const warnings: string[] = []; assert.deepEqual(extractWorkerResult('```json\n' + JSON.stringify(worker()) + '\n```' + tail, warnings), worker()); assert.ok(warnings.some(w => /trailing content/.test(w)));
});
test('F24 selects last valid worker-result, rejects unclosed or wholly invalid blocks', () => {
  const block = (x: unknown) => '```json\n' + JSON.stringify(x) + '\n```';
  const last = { ...worker(), summary: 'last valid' }, warnings: string[] = [];
  assert.deepEqual(extractWorkerResult(block(worker()) + '\n' + block(last) + '\n```json\n{bad}\n```extra', warnings), last); assert.ok(warnings.length);
  for (const text of ['```json\n{}\n```', '```json\n{bad}\n```', block(last) + '\n```json\n{']) assert.throws(() => extractWorkerResult(text));
});
test('F24 persisted worker_result_warnings and prompt require result JSON as final content', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!];
  testEnv(t, { GBDEV_FAKE_RESULT_SUFFIX: 'No further action needed...' });
  const { run } = await f.execute(); assert.equal(run.state, 'succeeded');
  for (const job of runJobs(f.store, run)) { const p = jobPaths(f.paths, job.job_id); const result = jsonFile<{ worker_result_warnings: string[] }>(p.result); assert.ok(result.worker_result_warnings.some(w => /trailing content/.test(w))); assert.match(readFileSync(p.prompt, 'utf8'), /MUST be the last content/); }
});

test('planner budget extension resumes planning, never runs an unapproved empty graph', async t => {
  const f = fixture(t), graph = planner(f); f.request.max_total_jobs = 1;
  f.fakePlan['run:planner#1'] = { actions: [{ type: 'emit_task_graph_cycle' }] }; f.fakePlan['run:planner#2'] = { actions: [{ type: 'emit_task_graph', graph }] };
  const { run } = await f.execute(); assert.equal(run.attention[0]!.reason, 'run_budget_exhausted'); assert.equal(run.plan.plan_attempts, 1);
  await resumeRun(f.store, run.run_id, input(run, 'extend_budget'), false); await superviseRun(f.store, run.run_id);
  const next = readRun(f.store, run.run_id); assert.equal(next.state, 'plan_review'); assert.equal(next.plan.plan_attempts, 2); assert.equal(next.tasks.length, 0);
});

test('F21 exhausted M2 retry is not advertised by run attention', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = 'blocked';
  let { run } = await f.execute();
  for (let n = 0; n < 2; n++) { assert.deepEqual(run.attention[0]!.allowed_actions, ['retry', 'drop_task']); await resumeRun(f.store, run.run_id, { ...input(run, 'retry'), note: `Retry blocked attempt ${n}.` }, false); await superviseRun(f.store, run.run_id); run = readRun(f.store, run.run_id); assertOrchestratorNote(readFileSync(jobPaths(f.paths, runJobs(f.store, run).find(j => j.role === 'executor' && j.attempt === n + 2)!.job_id).prompt, 'utf8'), `Retry blocked attempt ${n}.`); }
  assert.deepEqual(run.attention[0]!.allowed_actions, ['drop_task']);
});

for (const action of ['extra_round', 'accept'] as const) test(`F21 advertised pipeline action ${action} resumes without deferred`, async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.final_review = 'reviewer'; f.fakePlan['review#1'] = 'review_reject'; const { run } = await f.execute();
  assert.deepEqual(run.attention[0]!.allowed_actions, ['extra_round', 'accept', 'drop_task']);
  for (const offered of run.attention[0]!.allowed_actions) assert.doesNotThrow(() => prepareDecisions(f.store, run, f.request, input(run, offered), readRuntime(f.store, run)));
  f.fakePlan['review#2'] = 'review_approve'; f.savePlan(); await resumeRun(f.store, run.run_id, { ...input(run, action), note: `Authorized ${action} continuation.` }, false); await superviseRun(f.store, run.run_id);
  assert.equal(readRun(f.store, run.run_id).state, 'succeeded');
  const next = runJobs(f.store, run).find(j => action === 'extra_round' ? j.role === 'fixer' : j.step_instance === 'run:final_review#1')!;
  assertOrchestratorNote(readFileSync(jobPaths(f.paths, next.job_id).prompt, 'utf8'), `Authorized ${action} continuation.`); f.invariants(run.run_id);
});

test('final-fix ID collision preserves provided tasks and does not advertise an impossible action', async t => {
  const f = fixture(t); f.request.tasks = [{ ...f.request.tasks![0]!, id: 'final-fix-1' }]; f.request.final_review = 'reviewer'; f.fakePlan['run:final_review#1'] = 'review_revise';
  f.fakePlan['final-fix-1/implement#1'] = f.fakePlan['a/implement#1']; const { run } = await f.execute(); assert.equal(run.tasks[0]!.state, 'integrated'); assert.deepEqual(run.attention[0]!.allowed_actions, ['accept_final']);
});
