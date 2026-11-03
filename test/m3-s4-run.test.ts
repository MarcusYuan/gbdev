import { assertOrchestratorNote } from './helpers/orchestratorNote.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers/m3.js';
import { resumeRun } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { readRun, runPaths } from '../src/run/store.js';
import { mergeRecords } from '../src/run/result.js';
import { runJobs } from '../src/run/invariants.js';
import { git } from '../src/core/git.js';
import type { Run, RunAction } from '../src/contracts/run.js';
import { GbdevError } from '../src/contracts/error.js';
import { jobPaths } from '../src/core/paths.js';
import { extractWorkerResult } from '../src/contracts/workerResult.js';
import { assertReviewPrompt } from './helpers/reviewPrompt.js';
function input(run: Run, action: RunAction, index = 0) { const d = run.attention[index]!; return { schema: 'gbdev.run-resume.v1', run_id: run.run_id, decision_id: d.decision_id, action, task_id: d.task_id, answers: null, task_graph: null, note: null }; }
function conflict(f: ReturnType<typeof fixture>, markers = false) {
  f.request.overlap_policy = 'allow';
  for (const task of f.request.tasks!) { task.file_scope = ['src/base.txt']; f.fakePlan[`${task.id}/implement#1`] = { sleep_ms: task.id === 'a' ? 100 : 1500, actions: [{ type: 'write_file', path: 'src/base.txt', content: `${task.id}\n` }] }; }
  for (let n = 1; n <= 2; n++) f.fakePlan[`run:resolver#2.${n}`] = { actions: [{ type: markers ? 'leave_markers' : 'resolve_conflicts', strategy: 'ours_then_theirs' }] };
  f.fakePlan['run:verifier#2'] = 'review_approve';
}
test('AC-S4.1 conflict resolver -> gate -> verifier approve -> integrated', async t => {
  const f = fixture(t); conflict(f); const { run } = await f.execute(); assert.equal(run.state, 'succeeded', JSON.stringify(run));
  const record = mergeRecords(f.store, run)[1]!; assert.equal(record.precheck.clean, false); assert.equal(record.resolution!.attempts.length, 1); assert.equal(record.resolution!.verifier_verdict, 'approve'); assert.equal(record.gate!.passed, true);
  assert.match(readFileSync(join(run.integration.worktree, 'src/base.txt'), 'utf8'), /a\nb/);
  const events = readFileSync(runPaths(f.store, run.run_id).events, 'utf8'); assert.ok(events.indexOf('resolver_finished') < events.lastIndexOf('gate_finished')); assert.ok(events.lastIndexOf('gate_finished') < events.indexOf('verifier_started')); assert.ok(events.indexOf('verifier_started') < events.indexOf('verifier_finished')); const parsed = events.trim().split('\n').map(l => JSON.parse(l)); assert.ok(!parsed.some(e => e.type === 'gate_started' && e.data.instance?.startsWith('run:verifier'))); f.invariants(run.run_id);
  assert.equal(git(f.repo, ['rev-list', '--parents', '-n', '1', record.merge_sha!]).trim().split(' ').length, 3);
  const jobs = runJobs(f.store, run);
  const resolver = readFileSync(jobPaths(f.paths, jobs.find(j => j.role === 'resolver')!.job_id).prompt, 'utf8');
  const resolution = extractWorkerResult(resolver).resolution!;
  assert.deepEqual(Object.keys(resolution).sort(), ['files', 'unresolved']);
  assert.deepEqual(Object.keys(resolution.files[0]!).sort(), ['note', 'path', 'strategy']);
  assert.match(resolver, /Include resolution in your final worker-result JSON/);
  assert.match(resolver, /both, ours, theirs, or rewrite/); assert.match(resolver, /list every unresolved path/);
  assertReviewPrompt(readFileSync(jobPaths(f.paths, jobs.find(j => j.role === 'verifier')!.job_id).prompt, 'utf8'));
});
test('AC-S4.2 two marker failures pause; retry_resolve once, then reject second extra attempt', async t => {
  const f = fixture(t); conflict(f, true); const { run } = await f.execute(); assert.equal(run.state, 'needs_decision', JSON.stringify(run));
  const record = mergeRecords(f.store, run)[1]!; assert.equal(record.resolution!.attempts.length, 2); assert.ok(record.resolution!.attempts.every(a => a.markers_left.includes('src/base.txt')));
  assert.deepEqual(run.attention[0]!.allowed_actions, ['retry_resolve', 'rebuild_task', 'drop_task']); f.invariants(run.run_id);
  // Resuming a pre-fix run must get the policy even though its role snapshot stays pinned.
  const snapshotPath = runPaths(f.store, run.run_id).snapshot;
  const snapshots = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  snapshots['internal:resolver'].instructions_text.resolver = 'Never change test expectations merely to make tests pass.';
  writeFileSync(snapshotPath, JSON.stringify(snapshots));
  f.fakePlan['run:resolver#3.1'] = { actions: [{ type: 'leave_markers' }] }; f.savePlan();
  await resumeRun(f.store, run.run_id, { ...input(run, 'retry_resolve'), note: 'Pure whitespace returns Hello guest; authorize changing only the r3-trim whitespace assertion.' }, false); await superviseRun(f.store, run.run_id);
  const resolver = runJobs(f.store, run).find(j => j.step_instance === 'run:resolver#3.1')!;
  const prompt = readFileSync(jobPaths(f.paths, resolver.job_id).prompt, 'utf8');
  assert.match(prompt, /<<<GBDEV_UNTRUSTED_DATA/);
  assertOrchestratorNote(prompt, 'Pure whitespace returns Hello guest; authorize changing only the r3-trim whitespace assertion.');
  assert.match(prompt, /explicitly authorizes changing specific test expectations/);
  assert.match(prompt, /within that authorization and allowed_paths/);
  assert.match(prompt, /Never modify package.json or check scripts/);
  assert.match(prompt, /Without explicit authorization.*do not guess: report needs_input/);
  const again = readRun(f.store, run.run_id); assert.ok(!again.attention[0]!.allowed_actions.includes('retry_resolve')); assert.equal(mergeRecords(f.store, again)[2]!.resolution!.attempts.length, 1);
  await assert.rejects(resumeRun(f.store, run.run_id, input(again, 'retry_resolve'), false), e => e instanceof GbdevError && e.contract.code === 'run_state_conflict');
});
test('AC-S4.3 stale decision rejected and invalid batch is atomic', async t => {
  const f = fixture(t); f.fakePlan['a/implement#1'] = 'blocked'; const { run } = await f.execute();
  const answer = input(run, 'drop_task'), stale = { ...answer, decision_id: 'obsolete' }, before = readFileSync(runPaths(f.store, run.run_id).run, 'utf8');
  await assert.rejects(resumeRun(f.store, run.run_id, [answer, stale], false), e => e instanceof GbdevError && e.contract.code === 'run_state_conflict' && e.contract.details.reason === 'stale_decision');
  assert.equal(readFileSync(runPaths(f.store, run.run_id).run, 'utf8'), before);
  await resumeRun(f.store, run.run_id, answer, false); await superviseRun(f.store, run.run_id);
  await assert.rejects(resumeRun(f.store, run.run_id, answer, false), e => e instanceof GbdevError && e.contract.details.reason === 'stale_decision');
});
test('AC-S4.5 budget stops before new job, extend continues, second extension refused', async t => {
  const f = fixture(t); f.request.max_total_jobs = 1; f.request.tasks = [f.request.tasks![0]!];
  const { run } = await f.execute(); assert.equal(run.state, 'needs_decision', JSON.stringify(run)); assert.equal(run.budget.jobs_used, 1); assert.equal(run.attention[0]!.reason, 'run_budget_exhausted');
  await resumeRun(f.store, run.run_id, { ...input(run, 'extend_budget'), note: 'Continue within the extended budget.' }, false); await superviseRun(f.store, run.run_id);
  const done = readRun(f.store, run.run_id); assert.equal(done.state, 'succeeded', JSON.stringify(done)); assert.equal(done.budget.max_total_jobs, 31); assert.equal(done.budget.extended, true); assert.equal(runJobs(f.store, done).length, 2); assertOrchestratorNote(readFileSync(jobPaths(f.paths, runJobs(f.store, done).find(j => j.role === 'reviewer')!.job_id).prompt, 'utf8'), 'Continue within the extended budget.'); f.invariants(run.run_id);
  assert.ok(existsSync(runPaths(f.store, run.run_id).result));
});

test('drop_task cascades dependencies, preserves integrated tasks and records decisions in result', async t => {
  const f = fixture(t); f.request.tasks![1]!.depends_on = ['a']; f.request.final_review = 'reviewer'; f.fakePlan['a/implement#1'] = 'blocked';
  const { run } = await f.execute(); const resumed = await resumeRun(f.store, run.run_id, { ...input(run, 'drop_task'), note: 'Review the run after dropping these tasks.' }, false);
  assert.ok(resumed.tasks.every(t => t.state === 'dropped')); assert.equal(resumed.tasks[1]!.state_reason, 'dependency_dropped:a');
  await superviseRun(f.store, run.run_id); const result = JSON.parse(readFileSync(runPaths(f.store, run.run_id).result, 'utf8'));
  assertOrchestratorNote(readFileSync(jobPaths(f.paths, runJobs(f.store, run).find(j => j.step_instance === 'run:final_review#1')!.job_id).prompt, 'utf8'), 'Review the run after dropping these tasks.');
  assert.deepEqual(result.dropped_tasks, ['a', 'b']); assert.equal(result.decisions[0].action, 'drop_task'); assert.equal(result.outcome, 'integrated_partial');
});
test('task_paused answer resumes the same pipeline on an idle lane and preserves answers', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = 'needs_input';
  const { run } = await f.execute(); assert.equal(run.tasks[0]!.state, 'paused'); assert.deepEqual(run.attention[0]!.allowed_actions, ['answer', 'drop_task']);
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'answered\n' }] }; f.savePlan();
  await resumeRun(f.store, run.run_id, { ...input(run, 'answer'), answers: [{ question_id: 'Q1', answer: 'B' }], note: 'Implement answer B exactly.' }, false); await superviseRun(f.store, run.run_id);
  const done = readRun(f.store, run.run_id); assert.equal(done.state, 'succeeded', JSON.stringify(done)); assert.equal(done.tasks[0]!.attempts.length, 1); assertOrchestratorNote(readFileSync(jobPaths(f.paths, runJobs(f.store, done).find(j => j.role === 'executor' && j.attempt === 2)!.job_id).prompt, 'utf8'), 'Implement answer B exactly.'); f.invariants(run.run_id);
});
test('run budget extension refused twice even if an old action is offered', async t => {
  const f = fixture(t); f.request.max_total_jobs = 1; const { run } = await f.execute();
  const { prepareDecisions, readRuntime } = await import('../src/run/decisions.js');
  const extended = structuredClone(run); extended.budget.extended = true;
  assert.throws(() => prepareDecisions(f.store, extended, f.request, input(extended, 'extend_budget'), readRuntime(f.store, run)), e => e instanceof GbdevError && e.contract.details.reason === 'budget_extension_exhausted');
});
test('provider cooldown persists and each step retries rate limit only once', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = 'rate_limit';
  const fs = await import('node:fs'); const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.parallel = { rate_limit_cooldown_s: 0 }; fs.writeFileSync(f.paths.config, JSON.stringify(config));
  const { run } = await f.execute(); assert.equal(run.state, 'needs_decision'); assert.equal(runJobs(f.store, run).length, 2); assert.ok(run.slots.cooldown_until.fake);
  assert.match(readFileSync(runPaths(f.store, run.run_id).events, 'utf8'), /provider_cooldown/);
});

for (const zero of [true, false]) test(`conflict limits skip resolver: ${zero ? 'zero attempts' : 'too many files'}`, async t => {
  const f = fixture(t); conflict(f);
  const fs = await import('node:fs'); const config = JSON.parse(readFileSync(f.paths.config, 'utf8')); config.run_defaults = zero ? { max_resolver_attempts: 0 } : { max_conflict_files: 1 }; fs.writeFileSync(f.paths.config, JSON.stringify(config));
  if (!zero) for (const id of ['a', 'b']) (f.fakePlan[`${id}/implement#1`] as { actions: unknown[] }).actions.push({ type: 'write_file', path: 'src/same.txt', content: `${id}\n` });
  const { run } = await f.execute(); assert.equal(run.state, 'needs_decision'); assert.equal(mergeRecords(f.store, run)[1]!.resolution!.attempts.length, 0); assert.equal(runJobs(f.store, run).filter(j => j.role === 'resolver').length, 0); f.invariants(run.run_id);
});
test('verifier reject rolls back resolved commit and exposes conflict decision', async t => {
  const f = fixture(t); conflict(f); f.fakePlan['run:verifier#2'] = 'review_reject'; const { run } = await f.execute();
  assert.equal(run.state, 'needs_decision', JSON.stringify(run)); assert.equal(mergeRecords(f.store, run)[1]!.result, 'aborted_verifier_rejected'); assert.equal(run.attention[0]!.reason, 'merge_conflict_unresolved'); f.invariants(run.run_id);
});
test('rebuild preserves old branch and retries are capped at three', async t => {
  const f = fixture(t); conflict(f, true); const { run } = await f.execute(); const old = run.tasks[1]!.branch!, oldHead = run.tasks[1]!.head_sha;
  f.fakePlan['b/implement#1'] = { actions: [{ type: 'write_file', path: 'src/base.txt', content: 'a\nb\n' }] }; f.savePlan();
  await resumeRun(f.store, run.run_id, { ...input(run, 'rebuild_task'), note: 'Rebuild preserving both labels.' }, false); await superviseRun(f.store, run.run_id);
  const done = readRun(f.store, run.run_id); assert.equal(done.state, 'succeeded', JSON.stringify(done)); assert.equal(done.tasks[1]!.attempts.at(-1)!.kind, 'rebuild'); assertOrchestratorNote(readFileSync(jobPaths(f.paths, runJobs(f.store, done).find(j => j.pipeline_id === done.tasks[1]!.attempts.at(-1)!.pipeline_id && j.role === 'executor')!.job_id).prompt, 'utf8'), 'Rebuild preserving both labels.'); assert.match(done.tasks[1]!.branch!, /-r2$/); assert.equal(git(f.repo, ['rev-parse', old]).trim(), oldHead); f.invariants(run.run_id);
});
test('extra_fix resumes gate failure without allowing gate bypass', async t => {
  const f = fixture(t); f.request.max_integration_fixes = 0; f.request.checks[0]!.cmd = 'test ! -f src/a.txt || test ! -f src/b.txt || test -f src/fixed.txt';
  const { run } = await f.execute(); assert.equal(run.attention[0]!.reason, 'integration_gate_failed');
  await resumeRun(f.store, run.run_id, { ...input(run, 'extra_fix'), note: 'Fix the integration failure without changing checks.' }, false); await superviseRun(f.store, run.run_id);
  assert.equal(readRun(f.store, run.run_id).state, 'succeeded'); assertOrchestratorNote(readFileSync(jobPaths(f.paths, runJobs(f.store, run).find(j => j.role === 'fixer')!.job_id).prompt, 'utf8'), 'Fix the integration failure without changing checks.'); f.invariants(run.run_id);
});
test('accept_final keeps findings and marks accepted_by_decider', async t => {
  const f = fixture(t); f.request.final_review = 'reviewer'; f.fakePlan['run:final_review#1'] = 'review_revise'; const { run } = await f.execute();
  const beforeJobs = runJobs(f.store, run).length;
  const done = await resumeRun(f.store, run.run_id, { ...input(run, 'accept_final'), note: 'Accept the documented findings.' }, false); assert.equal(runJobs(f.store, done).length, beforeJobs, 'accept_final has no next job'); assert.equal(done.state, 'succeeded'); assert.equal(done.outcome, 'accepted_by_decider');
  const result = JSON.parse(readFileSync(runPaths(f.store, run.run_id).result, 'utf8')); assert.equal(result.final_review.findings.length, 1); assert.equal(result.decisions[0].action, 'accept_final');
});

test('live resume inbox is consumed without stopping independent tasks; repeated input is stale', async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); f.fakePlan['a/implement#1'] = 'blocked'; f.fakePlan['b/implement#1'] = { sleep_ms: 4500, actions: [{ type: 'write_file', path: 'src/b.txt', content: 'b\n' }] }; f.savePlan();
  const { startRun, cancelRun } = await import('../src/commands/run.js'); const { until } = await import('./helpers/m3.js');
  const initial = await startRun(f.store, f.request, false), work = superviseRun(f.store, initial.run_id);
  cleanup = async () => { try { await cancelRun(f.store, initial.run_id); } finally { await work; } };
  await until(() => readRun(f.store, initial.run_id).attention.length > 0);
  const run = readRun(f.store, initial.run_id); assert.equal(run.state, 'running');
  await resumeRun(f.store, initial.run_id, input(run, 'drop_task'), false);
  await assert.rejects(resumeRun(f.store, initial.run_id, input(run, 'drop_task'), false), e => e instanceof GbdevError && e.contract.details.reason === 'stale_decision');
  await work; const done = readRun(f.store, initial.run_id); assert.equal(done.state, 'succeeded'); assert.equal(done.tasks[0]!.state, 'dropped'); assert.equal(done.tasks[1]!.state, 'integrated'); f.invariants(initial.run_id);
});
