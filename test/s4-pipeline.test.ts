import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, openSync, closeSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipelineFixture } from './helpers/pipeline.js';
import { eventually, unwrap } from './helpers/tmpRepo.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { PipelineResult } from '../src/contracts/pipelineResult.js';
import { groupAlive } from '../src/core/proc.js';
import { JobStore } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { createRun, pipelinePaths, transitionRun } from '../src/pipeline/store.js';
import { locked } from '../src/core/runtime.js';

function error(output: Awaited<ReturnType<ReturnType<typeof pipelineFixture>['command']>>, code: string, reason?: string) {
  assert.equal(output.envelope.ok, false);
  if (!output.envelope.ok) { assert.equal(output.envelope.error.code, code); if (reason) assert.equal(output.envelope.error.details.reason, reason); }
}
const changing = { 'implement#1': 'dirty_exit', 'review#1': 'review_revise_changing', 'fix#1': 'fix_ok', 'review#2': 'review_revise_changing', 'fix#2': 'fix_ok', 'review#3': 'review_revise_changing' };
test('AC-S4.1 revise → fix → approve; two snapshots, cumulative and incremental review, G11', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_revise', 'fix#1': 'fix_ok', 'review#2': 'review_approve' });
  const start = await f.start({ acceptance_criteria: [] }), result = await f.wait(start.pipeline_id, true) as PipelineResult;
  assert.equal(result.state, 'succeeded'); assert.equal(result.round, 1); assert.equal(result.jobs_used, 4);
  assert.equal(result.commits.filter(c => c.includes('gbdev: snapshot')).length, 2);
  const run = f.read(start.pipeline_id), fix = run.steps[2]!, review = run.steps[3]!;
  const prompt = readFileSync(join(f.jobDir(fix.attempts[0]!.job_id), 'prompt.md'), 'utf8');
  assert.match(prompt, /F1/); assert.match(prompt, /必须 \/ MUST/);
  assert.ok(readFileSync(join(f.jobDir(review.attempts[0]!.job_id), 'prompt.md'), 'utf8').includes(`git diff ${run.steps[1]!.head_after}..HEAD`));
  assert.match(readFileSync(join(f.pipelineDir(run.pipeline_id), 'events.jsonl'), 'utf8'), /"rule":"G11"/);
});
test('AC-S4.2 changing revise reaches two rounds; extra_round approves; accept keeps open findings', async t => {
  const f = pipelineFixture(t, changing), start = await f.start({ acceptance_criteria: [] });
  const paused = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(paused.round, 2); assert.equal(paused.state_reason, 'max_rounds_exceeded');
  assert.deepEqual(paused.decision!.allowed_actions, ['extra_round', 'accept']);
  f.plan({ ...changing, 'fix#3': 'fix_ok', 'review#4': 'review_approve' });
  unwrap((await f.resume(start.pipeline_id, 'extra_round')).envelope);
  const done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded'); assert.equal(done.round, 3); assert.equal(done.max_rounds, 3);
  f.plan(changing);
  const other = await f.start({ acceptance_criteria: [] }); await f.wait(other.pipeline_id);
  const accepted = unwrap((await f.resume(other.pipeline_id, 'accept', { note: 'Accept remaining findings' })).envelope) as PipelineRun;
  assert.equal(accepted.state, 'succeeded'); assert.equal(accepted.outcome, 'accepted_by_decider');
  assert.equal(accepted.state_history.at(-1)!.by, 'grok-bot'); assert.equal(accepted.state_history.at(-1)!.reason, 'Accept remaining findings');
  const result = unwrap((await f.command(['pipeline', 'result', other.pipeline_id])).envelope) as PipelineResult;
  assert.equal(result.final_verdict!.open_findings.length, 1);
});
test('AC-S4.3 repeated blocking findings stop; fix_no_changes permits retry and accept', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_revise', 'fix#1': 'fix_ok', 'review#2': 'review_revise_same' });
  const a = await f.start({ acceptance_criteria: [] }), repeated = await f.wait(a.pipeline_id) as PipelineRun;
  assert.equal(repeated.state_reason, 'findings_repeated'); assert.equal(repeated.round, 1);
  f.plan({ 'implement#1': 'dirty_exit', 'review#1': 'review_revise', 'fix#1': 'fix_noop', 'review#2': 'review_approve' });
  const b = await f.start({ acceptance_criteria: [] }), noop = await f.wait(b.pipeline_id) as PipelineRun;
  assert.equal(noop.state_reason, 'fix_no_changes'); assert.deepEqual(noop.decision!.allowed_actions, ['retry', 'accept']);
  f.plan({ 'fix#1': 'fix_ok', 'review#2': 'review_approve' });
  unwrap((await f.resume(b.pipeline_id, 'retry', { note: 'Fix F1 now' })).envelope);
  const done = await f.wait(b.pipeline_id) as PipelineRun; assert.equal(done.state, 'succeeded');
  const step = done.steps.find(s => s.kind === 'fix')!;
  assert.equal(step.attempts.length, 2); assert.equal(f.getJob(step.attempts[1]!.job_id).parent_job_id, step.attempts[0]!.job_id);
  assert.match(readFileSync(join(f.jobDir(step.attempts[1]!.job_id), 'prompt.md'), 'utf8'), /Note from the orchestrator: Fix F1 now/);
});
for (const scenario of ['review_no_verdict', 'review_bad_verdict', 'no_json']) test(`AC-S4.4 ${scenario}: one automatic retry, then verdict_missing; manual attempt 3`, async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': scenario });
  const start = await f.start({ acceptance_criteria: [] }), paused = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(paused.state_reason, 'verdict_missing'); assert.equal(paused.jobs_used, 3);
  assert.equal(paused.steps[1]!.attempts.length, 2);
  assert.match(readFileSync(join(f.jobDir(paused.current!.job_id), 'prompt.md'), 'utf8'), /MUST end with valid worker-result JSON/);
  unwrap((await f.resume(start.pipeline_id, 'retry')).envelope);
  const third = await f.wait(start.pipeline_id) as PipelineRun; assert.equal(third.steps[1]!.attempts.length, 3); assert.equal(third.state_reason, 'verdict_missing');
  // M7 S2: after attempt 3, unavailable retry is not advertised; resume retry is action_not_allowed.
  assert.deepEqual(third.decision!.allowed_actions, ['accept']);
  assert.equal(third.decision!.recommended_action ?? null, null);
  error(await f.resume(start.pipeline_id, 'retry'), 'pipeline_state_conflict', 'action_not_allowed');
});
test('AC-S4.5 failed check synthesizes C1 and last 80 log lines; fix then inserted re-review with original pending suffix preserved', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'check_fail_then_fix', 'fix#1': 'fix_ok', 'review#2': 'review_approve', 'review#1': 'review_approve' });
  const check = `if test -f src/check-fail.txt; then i=1; while test "$i" -le 100; do echo "log-$i"; i=$((i + 1)); done; exit 1; fi`;
  const start = await f.start({ acceptance_criteria: [{ id: 'AC1', text: 'fixed', check_cmd: check }] }), done = await f.wait(start.pipeline_id, true) as PipelineResult;
  assert.equal(done.state, 'succeeded'); assert.equal(done.jobs_used, 4); assert.equal(done.round, 1);
  const run = f.read(start.pipeline_id), fix = run.steps.find(s => s.kind === 'fix')!;
  const prompt = readFileSync(join(f.jobDir(fix.attempts[0]!.job_id), 'prompt.md'), 'utf8');
  assert.match(prompt, /"id": "C1"/); assert.match(prompt, /check AC1 failed:/); assert.match(prompt, /log-21/); assert.match(prompt, /log-100/); assert.doesNotMatch(prompt, /log-20\\n/);
  assert.equal(done.final_checks!.job_id, fix.attempts[0]!.job_id); assert.equal(done.final_checks!.checks[0]!.exit_code, 0);
});
test('AC-S4.6 answer validation, attempts cap, successful answer uses immutable snapshot and prior summary', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'needs_input', 'review#1': 'review_approve' });
  const start = await f.start({ acceptance_criteria: [] }); await f.wait(start.pipeline_id);
  error(await f.resume(start.pipeline_id, 'retry'), 'pipeline_state_conflict');
  const missing = await f.resume(start.pipeline_id, 'answer', { answers: [{ question_id: 'unknown', answer: 'A' }] });
  error(missing, 'config_invalid'); if (!missing.envelope.ok) assert.deepEqual(missing.envelope.error.details.missing_ids, ['Q1']);
  error(await f.resume(start.pipeline_id, 'answer', { answers: [] }), 'config_invalid');
  const answers = [{ question_id: 'Q1', answer: 'B' }];
  for (let i = 2; i <= 3; i++) { unwrap((await f.resume(start.pipeline_id, 'answer', { answers })).envelope); assert.equal((await f.wait(start.pipeline_id) as PipelineRun).current!.attempt, i); }
  error(await f.resume(start.pipeline_id, 'answer', { answers }), 'pipeline_state_conflict', 'attempts_exhausted');
  const other = await f.start({ acceptance_criteria: [] }); await f.wait(other.pipeline_id);
  mkdirSync(join(f.root, 'roles')); writeFileSync(join(f.root, 'roles', 'executor.json'), '{invalid');
  f.plan({ 'implement#1': 'dirty_exit', 'review#1': 'review_approve' });
  unwrap((await f.resume(other.pipeline_id, 'answer', { answers })).envelope);
  const done = await f.wait(other.pipeline_id) as PipelineRun; assert.equal(done.state, 'succeeded');
  const [a, b] = done.steps[0]!.attempts;
  const brief = JSON.parse(readFileSync(join(f.jobDir(b!.job_id), 'brief.json'), 'utf8'));
  assert.deepEqual(brief.answers, answers); assert.equal(brief.parent_job_id, a!.job_id); assert.match(brief.brief_id, /:2$/);
  assert.match(readFileSync(join(f.jobDir(b!.job_id), 'prompt.md'), 'utf8'), /Previous attempt summary:[\s\S]*GBDEV_UNTRUSTED_DATA[\s\S]*Fake scenario: needs_input/);
});
test('AC-S4.7 job budget checked before creation (including retry), accept only', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_no_verdict' });
  for (const budget of [1, 2]) {
    const start = await f.start({ max_total_jobs: budget, acceptance_criteria: [] }), run = await f.wait(start.pipeline_id) as PipelineRun;
    assert.equal(run.state_reason, 'job_budget_exhausted'); assert.equal(run.jobs_used, budget); assert.deepEqual(run.decision!.allowed_actions, ['accept']);
    assert.equal(run.steps.flatMap(s => s.attempts).length, budget);
    error(await f.resume(run.pipeline_id, 'retry'), 'pipeline_state_conflict');
    if (budget === 1) {
      // Never reached a review/G9 — bare accept remains the budget recovery path.
      assert.equal((unwrap((await f.resume(run.pipeline_id, 'accept')).envelope) as PipelineRun).outcome, 'accepted_by_decider');
    } else {
      // M7 S2: G9 then budget cut keeps missing-verdict protection (one review attempt only).
      error(await f.resume(run.pipeline_id, 'accept'), 'verdict_retry_required');
      error(await f.resume(run.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: 'still needs a completed review retry' }), 'verdict_retry_required');
    }
  }
});
test('AC-S4.7 scaled pipeline deadline cancels active worker and descendants; releases slot', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'slow' }); f.env.GBDEV_TIMEOUT_SCALE = '100';
  const start = await f.start({ timeout_min: 30 });
  const processes = await eventually(() => { const run = f.read(start.pipeline_id); const p = run.current && join(f.jobDir(run.current.job_id), 'fake-processes.json'); return p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as { worker: number } : undefined; });
  const run = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(run.state, 'failed'); assert.equal(run.failure_reason, 'pipeline_timeout'); assert.equal(run.jobs_used, 1);
  assert.equal(f.getJob(run.current!.job_id).state, 'cancelled'); assert.equal(groupAlive(processes.worker), false);
  f.env.GBDEV_FAKE_SCENARIO = 'ok'; assert.equal((await f.command(['start', '--brief', f.briefFile])).exit, 0);
});
test('S4 deadline also terminates acceptance checks, not only provider phase', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit' }); f.env.GBDEV_TIMEOUT_SCALE = '100';
  const start = await f.start({ timeout_min: 30, acceptance_criteria: [{ id: 'AC1', text: 'long check', check_cmd: 'sleep 30' }] });
  const run = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(run.failure_reason, 'pipeline_timeout'); assert.equal(f.getJob(run.current!.job_id).state, 'cancelled');
});
test('S4 resume busy, terminal conflict, absolute five-round cap, request id mismatch', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'needs_input' }), paused = await f.start({ acceptance_criteria: [] }); await f.wait(paused.pipeline_id);
  f.env.GBDEV_FAKE_SCENARIO = 'slow'; const job = await f.launchStandalone();
  error(await f.resume(paused.pipeline_id, 'answer', { answers: [{ question_id: 'Q1', answer: 'A' }] }), 'busy');
  await f.command(['cancel', job.job_id]);
  error(await f.resume(paused.pipeline_id, 'answer', { pipeline_id: 'p_20261026_1011_abcd' }), 'config_invalid');
  f.plan({ 'implement#1': 'dirty_exit', 'review#1': 'review_reject' });
  const reject = await f.start({ max_rounds: 5, acceptance_criteria: [] }); await f.wait(reject.pipeline_id);
  assert.deepEqual(f.read(reject.pipeline_id).decision!.allowed_actions, ['accept']);
  error(await f.resume(reject.pipeline_id, 'extra_round'), 'pipeline_state_conflict');
  unwrap((await f.resume(reject.pipeline_id, 'accept')).envelope); error(await f.resume(reject.pipeline_id, 'accept'), 'pipeline_state_conflict');
});

test('E1/E8 stable missing result repairs via result and wait; diff uses atomic replacement', async t => {
  const f = pipelineFixture(t), start = await f.start(); const original = await f.wait(start.pipeline_id, true) as PipelineResult;
  const resultPath = join(f.pipelineDir(start.pipeline_id), 'result.json'), diffPath = join(f.pipelineDir(start.pipeline_id), 'diff.patch');
  for (const args of [['pipeline', 'result', start.pipeline_id], ['pipeline', 'wait', start.pipeline_id, '--timeout-ms', '1000', '--with-result']]) {
    rmSync(resultPath); writeFileSync(diffPath, 'incomplete');
    const oldDiff = openSync(diffPath, 'r');
    const repaired = unwrap((await f.command(args)).envelope) as PipelineResult;
    assert.equal(readFileSync(oldDiff, 'utf8'), 'incomplete'); closeSync(oldDiff);
    assert.deepEqual(repaired, original); assert.ok(existsSync(resultPath)); assert.notEqual(readFileSync(diffPath, 'utf8'), 'incomplete');
    assert.equal(readdirSync(f.pipelineDir(start.pipeline_id)).some(n => n.endsWith('.tmp')), false);
  }
});
test('E1 aggregate rename failure leaves the previous stable state intact', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'needs_input' }), start = await f.start(); await f.wait(start.pipeline_id);
  const store = new JobStore(resolvePaths(f.env)), paths = pipelinePaths(store, start.pipeline_id), before = readFileSync(paths.run, 'utf8');
  rmSync(paths.result); mkdirSync(paths.result);
  await assert.rejects(locked(store, () => transitionRun(store, f.read(start.pipeline_id), 'cancelled')));
  assert.equal(readFileSync(paths.run, 'utf8'), before);
  rmSync(paths.result, { recursive: true });
  assert.equal((await f.command(['pipeline', 'result', start.pipeline_id])).exit, 0);
});
test('E2 empty, malformed and invalid runs do not block standalone start, pipeline start or status', async t => {
  const f = pipelineFixture(t);
  for (const [suffix, content] of [['0001', null], ['0002', '{bad'], ['0003', '{}']] as const) {
    const dir = join(f.home, 'pipelines', `p_20261026_1011_${suffix}`); mkdirSync(dir, { recursive: true }); if (content) writeFileSync(join(dir, 'pipeline.json'), content);
  }
  const job = unwrap((await f.command(['start', '--brief', f.briefFile])).envelope) as { job_id: string }; await f.waitJob(job.job_id);
  const start = await f.start(); await f.wait(start.pipeline_id);
  const list = unwrap((await f.command(['pipeline', 'status'])).envelope) as PipelineRun[]; assert.equal(list.length, 1);
  assert.equal(list[0]!.pipeline_id, start.pipeline_id);
  const store = new JobStore(resolvePaths(f.env));
  const bad = { ...f.read(start.pipeline_id), pipeline_id: 'p_20261026_1011_ffff' };
  Object.defineProperty(bad, 'updated_at', { set() { throw new Error('injected write failure'); } });
  assert.throws(() => createRun(store, bad), /injected write failure/); assert.equal(existsSync(pipelinePaths(store, bad.pipeline_id).dir), false);
});
test('E5 cleanup dry-run reconciles killed supervisor before reporting actions', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'slow' }), start = await f.start();
  const run = await eventually(() => { const r = f.read(start.pipeline_id); return r.current && existsSync(join(f.jobDir(r.current.job_id), 'fake-processes.json')) ? r : undefined; });
  process.kill(run.supervisor_pid!, 'SIGKILL');
  const output = await eventually(async () => { const r = await f.command(['pipeline', 'cleanup', start.pipeline_id, '--dry-run']); return r.envelope.ok ? r : undefined; });
  const actions = unwrap(output.envelope) as { worktree_removed: boolean; would_remove_worktree: boolean };
  assert.equal(f.read(start.pipeline_id).failure_reason, 'pipeline_supervisor_crashed'); assert.equal(actions.worktree_removed, false); assert.equal(actions.would_remove_worktree, true); assert.equal(existsSync(start.workspace.worktree), true);
});

test('S4 G6 failed fix reuses waiting review and preserves the linear suffix', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'check_fail_then_fix', 'fix#1': 'fix_noop', 'fix#2': 'fix_ok', 'review#2': 'review_approve', 'review#1': 'review_approve', 'plan#1': 'plan_ok' });
  const start = await f.start({ pipeline: { schema: 'gbdev.pipeline.v1', name: 'suffix-test', description: 'Review then report', steps: [{ id: 'implement', role: 'executor' }, { id: 'review', role: 'reviewer' }, { id: 'plan', role: 'planner' }], fix_loop: { after: 'review', fix_role: 'fixer', max_rounds: 2 }, timeout_min: 240 },
    step_overrides: { ...f.request.step_overrides, plan: { provider: 'fake' } }, acceptance_criteria: [{ id: 'AC1', text: 'fixed', check_cmd: 'test ! -f src/check-fail.txt' }] });
  const run = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(run.state, 'succeeded'); assert.equal(run.round, 2);
  assert.deepEqual(run.steps.map(s => s.instance), ['implement#1', 'fix#1', 'fix#2', 'review#2', 'review#1', 'plan#1']);
  assert.equal(run.steps[1]!.gate, 'fix'); assert.equal(run.steps[1]!.attempts[0]!.job_state, 'failed');
});
test('S4 G10 inconsistent approve runs fix, records normalization without mutating the job', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_approve_with_critical', 'fix#1': 'fix_ok', 'review#2': 'review_approve' });
  const start = await f.start({ acceptance_criteria: [] }), done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded'); assert.equal(done.round, 1); assert.ok(done.warnings.includes('verdict_inconsistent'));
  assert.equal(done.steps[1]!.verdict, 'revise'); assert.equal(f.result(done.steps[1]!.attempts[0]!.job_id).worker_reported!.review!.verdict, 'approve');
  assert.match(readFileSync(join(f.pipelineDir(done.pipeline_id), 'events.jsonl'), 'utf8'), /"rule":"G10"/);
});
test('E3 deadline expired before first step creates no jobs; resume expired run creates no new attempts', async t => {
  const f = pipelineFixture(t); f.env.GBDEV_TIMEOUT_SCALE = '0.1';
  const start = await f.start({ timeout_min: 30 }), run = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(run.failure_reason, 'pipeline_timeout'); assert.equal(run.jobs_used, 0);
  delete f.env.GBDEV_TIMEOUT_SCALE;
  f.plan({ 'implement#1': 'needs_input' });
  const other = await f.start({ acceptance_criteria: [] }); await f.wait(other.pipeline_id);
  const paused = f.read(other.pipeline_id); paused.deadline_at = paused.created_at;
  writeFileSync(join(f.pipelineDir(other.pipeline_id), 'pipeline.json'), JSON.stringify(paused));
  unwrap((await f.resume(other.pipeline_id, 'answer', { answers: [{ question_id: 'Q1', answer: 'A' }] })).envelope);
  const expired = await f.wait(other.pipeline_id) as PipelineRun;
  assert.equal(expired.failure_reason, 'pipeline_timeout'); assert.equal(expired.jobs_used, 1); assert.equal(expired.steps[0]!.attempts.length, 1);
});
test('E1 aggregate ahead of paused state after interrupted accept is rebuilt from pipeline.json', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_reject' }), start = await f.start({ acceptance_criteria: [] });
  await f.wait(start.pipeline_id); const path = join(f.pipelineDir(start.pipeline_id), 'pipeline.json'), paused = readFileSync(path, 'utf8');
  unwrap((await f.resume(start.pipeline_id, 'accept')).envelope);
  // Simulate the crash window: aggregate rename succeeded, stable pipeline rename did not.
  writeFileSync(path, paused);
  const result = unwrap((await f.command(['pipeline', 'result', start.pipeline_id])).envelope) as PipelineResult;
  assert.equal(result.state, 'needs_decision'); assert.equal(result.state_reason, 'review_rejected'); assert.equal(result.outcome, null);
});

test('S4 resume works with a caffeinate wrapper whose PID differs from supervisor', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'needs_input', 'review#1': 'review_approve' }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'caffeinate'), `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nconst child = spawn(process.argv[3], process.argv.slice(4), { stdio: 'inherit' });\nchild.on('exit', code => { process.exitCode = code ?? 1; });\n`, { mode: 0o700 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const start = await f.start({ acceptance_criteria: [] }); await f.wait(start.pipeline_id);
  f.plan({ 'implement#1': 'dirty_exit', 'review#1': 'review_approve' });
  unwrap((await f.resume(start.pipeline_id, 'answer', { answers: [{ question_id: 'Q1', answer: 'A' }] })).envelope);
  assert.equal((await f.wait(start.pipeline_id) as PipelineRun).state, 'succeeded');
});

test('E2 reconcileAll isolates a damaged run and still recovers another run', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'needs_input' });
  const a = await f.start({ acceptance_criteria: [] }); await f.wait(a.pipeline_id);
  const b = await f.start({ acceptance_criteria: [] }); await f.wait(b.pipeline_id);
  for (const initial of [a, b]) {
    const run = f.read(initial.pipeline_id); run.state = 'running'; run.supervisor_pid = null;
    if (initial === b) run.current!.job_id = 'j_20261026_1011_ffff';
    writeFileSync(join(f.pipelineDir(run.pipeline_id), 'pipeline.json'), JSON.stringify(run));
  }
  const { reconcileAll } = await import('../src/pipeline/reconcile.js');
  await reconcileAll(new JobStore(resolvePaths(f.env)));
  assert.equal(f.read(a.pipeline_id).failure_reason, 'pipeline_supervisor_crashed');
  assert.equal(f.read(b.pipeline_id).state, 'running');
  const busy = await f.launch();
  error(busy, 'busy');
  if (!busy.envelope.ok) assert.equal(busy.envelope.error.details.running_pipeline_id, b.pipeline_id);
  // The malformed current job is kept for inspection, not silently discarded.
  const broken = f.read(b.pipeline_id); broken.state = 'needs_input'; broken.current = null;
  writeFileSync(join(f.pipelineDir(b.pipeline_id), 'pipeline.json'), JSON.stringify(broken));
});
