import assert from 'node:assert/strict';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validatePipelineResume } from '../src/contracts/pipelineResume.js';
import { validateRunResume } from '../src/contracts/runResume.js';
import { GbdevError } from '../src/contracts/error.js';
import { notifyNextStep } from '../src/contracts/notify.js';
import { buildPayload } from '../src/notify/payload.js';
import { resumeRun, runCommand, runText } from '../src/commands/run.js';
import { pipelineResume, pipelineText } from '../src/commands/pipeline.js';
import { JobStore } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { VERDICT_MISSING_STATUS_HINT } from '../src/core/verdictAcceptance.js';
import { preparePipelineResume } from '../src/pipeline/resume.js';
import { pipelinePaths } from '../src/pipeline/store.js';
import { pipelineStatus } from '../src/render/views/pipeline.js';
import { runStatus } from '../src/render/views/runStatus.js';
import { ViewFiles } from '../src/render/views/common.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { Run, RunAction } from '../src/contracts/run.js';
import { readRun, runPaths, jsonFile } from '../src/run/store.js';
import { validateRunResult } from '../src/contracts/runResult.js';
import { pipelineFixture } from './helpers/pipeline.js';
import { fixture } from './helpers/m3.js';
import { errorCode, temporary } from './helpers.js';
import { unwrap } from './helpers/tmpRepo.js';
import { writeFileSync as writeTmp } from 'node:fs';
import { join as joinPath } from 'node:path';

const NOTE = 'Diff base..head reviewed via status; checks green; accept without structured reviewer verdict; residual risk: prose-only worker output.';

function pipelineError(output: Awaited<ReturnType<ReturnType<typeof pipelineFixture>['command']>>, code: string, reason?: string) {
  assert.equal(output.envelope.ok, false);
  if (!output.envelope.ok) {
    assert.equal(output.envelope.error.code, code);
    if (reason) assert.equal(output.envelope.error.details.reason, reason);
  }
}

function runInput(run: Run, action: RunAction, index = 0, patch: Record<string, unknown> = {}) {
  const d = run.attention[index]!;
  return {
    schema: 'gbdev.run-resume.v1', run_id: run.run_id, decision_id: d.decision_id, action,
    task_id: d.task_id, answers: null, task_graph: null, note: null, ...patch,
  };
}

function events(dir: string): { type: string; data: Record<string, unknown> }[] {
  return (readFileSync(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Capture all persisted state, including inputs, continuation, results and audit logs.
function diskState(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => { const path = join(entry.parentPath, entry.name); return [path, readFileSync(path, 'utf8')]; }));
}

for (const scenario of ['review_no_verdict', 'review_bad_verdict', 'no_json'] as const) {
  test(`AC-9 ${scenario}: auto retry then recommended retry; attempt 3 drops retry`, async t => {
    const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': scenario });
    const start = await f.start({ acceptance_criteria: [] });
    const paused = await f.wait(start.pipeline_id) as PipelineRun;
    assert.equal(paused.state_reason, 'verdict_missing');
    assert.equal(paused.steps[1]!.attempts.length, 2);
    assert.equal(paused.decision!.recommended_action, 'retry');
    assert.deepEqual(paused.decision!.accept_requirements, ['verdict_missing_reviewed', 'note']);
    assert.deepEqual(paused.decision!.allowed_actions, ['retry', 'accept']);

    unwrap((await f.resume(start.pipeline_id, 'retry')).envelope);
    const third = await f.wait(start.pipeline_id) as PipelineRun;
    assert.equal(third.steps[1]!.attempts.length, 3);
    assert.equal(third.state_reason, 'verdict_missing');
    assert.equal(third.decision!.recommended_action, null);
    assert.deepEqual(third.decision!.allowed_actions, ['accept']);
    assert.deepEqual(third.decision!.accept_requirements, ['verdict_missing_reviewed', 'note']);
    pipelineError(await f.resume(start.pipeline_id, 'retry'), 'pipeline_state_conflict', 'action_not_allowed');
    assert.equal(third.jobs_used, f.read(start.pipeline_id).jobs_used);
  });
}

test('AC-10 evidence required then successful accept keeps accepted_by_decider', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_no_verdict' });
  const start = await f.start({ acceptance_criteria: [] });
  await f.wait(start.pipeline_id);

  for (const patch of [{}, { verdict_missing_reviewed: false }, { verdict_missing_reviewed: true, note: '   ' }, { verdict_missing_reviewed: true, note: null }]) {
    const refused = await f.resume(start.pipeline_id, 'accept', patch);
    pipelineError(refused, 'verdict_evidence_required');
    if (!refused.envelope.ok) {
      assert.deepEqual(refused.envelope.error.details.required_fields, ['verdict_missing_reviewed', 'note']);
      assert.equal(refused.exit, 1);
    }
    assert.equal(f.read(start.pipeline_id).state, 'needs_decision');
    assert.equal(f.read(start.pipeline_id).decision?.reason, 'verdict_missing');
  }

  const accepted = unwrap((await f.resume(start.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: NOTE })).envelope) as PipelineRun;
  assert.equal(accepted.state, 'succeeded');
  assert.equal(accepted.outcome, 'accepted_by_decider');
  const audit = events(f.pipelineDir(start.pipeline_id)).filter(e => e.type === 'verdict_missing_accepted');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.data.verdict_missing_reviewed, true);
  assert.equal(audit[0]!.data.note, NOTE);
  assert.ok(Array.isArray(audit[0]!.data.job_ids) && (audit[0]!.data.job_ids as string[]).length >= 2);
});

test('AC-11 single attempt / other step / unfinished / budget reason cannot bypass', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_no_verdict' });
  const start = await f.start({ acceptance_criteria: [] });
  await f.wait(start.pipeline_id);
  const path = join(f.pipelineDir(start.pipeline_id), 'pipeline.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as PipelineRun;
  const review = raw.steps[1]!;
  assert.equal(review.attempts.length, 2);
  const retry = structuredClone(review.attempts[1]!);
  review.attempts = [review.attempts[0]!];
  writeFileSync(path, JSON.stringify(raw));
  const refused = await f.resume(start.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: NOTE });
  pipelineError(refused, 'verdict_retry_required');
  if (!refused.envelope.ok) {
    assert.equal(refused.envelope.error.details.retry_available, true);
    assert.equal(refused.exit, 1);
  }

  // A repeated start (including one pending after rate limiting) is not a completed review retry.
  for (const job_state of ['queued', 'starting', 'running'] as const) {
    review.attempts = [review.attempts[0]!, { ...retry, job_state, failure_reason: job_state === 'starting' ? 'rate_limited' : null }];
    writeFileSync(path, JSON.stringify(raw));
    const before = diskState(f.pipelineDir(start.pipeline_id));
    pipelineError(await f.resume(start.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: NOTE }), 'verdict_retry_required');
    assert.deepEqual(diskState(f.pipelineDir(start.pipeline_id)), before);
  }

  // Swap pause reason to budget after G9 — protection remains.
  const f2 = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_no_verdict' });
  const s2 = await f2.start({ acceptance_criteria: [] });
  await f2.wait(s2.pipeline_id);
  const p2 = join(f2.pipelineDir(s2.pipeline_id), 'pipeline.json');
  const mutated = JSON.parse(readFileSync(p2, 'utf8')) as PipelineRun;
  mutated.state_reason = 'job_budget_exhausted';
  mutated.decision = { ...mutated.decision!, reason: 'job_budget_exhausted', allowed_actions: ['accept'] };
  writeFileSync(p2, JSON.stringify(mutated));
  pipelineError(await f2.resume(s2.pipeline_id, 'accept', { note: 'budget accept' }), 'verdict_evidence_required');
  const ok = unwrap((await f2.resume(s2.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: NOTE })).envelope) as PipelineRun;
  assert.equal(ok.outcome, 'accepted_by_decider');

  // Unrelated step attempts do not count: craft decision on implement instance.
  const f3 = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_no_verdict' });
  const s3 = await f3.start({ acceptance_criteria: [] });
  await f3.wait(s3.pipeline_id);
  const p3 = join(f3.pipelineDir(s3.pipeline_id), 'pipeline.json');
  const m3 = JSON.parse(readFileSync(p3, 'utf8')) as PipelineRun;
  m3.decision = { ...m3.decision!, instance: m3.steps[0]!.instance };
  writeFileSync(p3, JSON.stringify(m3));
  pipelineError(await f3.resume(s3.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: NOTE }), 'pipeline_state_conflict', 'verdict_missing_result_mismatch');
});

test('AC-11 latest finished result must still be G9 before evidence validation', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_no_verdict' });
  const start = await f.start({ acceptance_criteria: [] });
  const paused = await f.wait(start.pipeline_id) as PipelineRun;
  const store = new JobStore(resolvePaths(f.env));
  const resultPath = join(f.jobDir(paused.steps[1]!.attempts.at(-1)!.job_id), 'result.json');
  const original = readFileSync(resultPath, 'utf8');
  const result = JSON.parse(original);
  const input = { schema: 'gbdev.pipeline-resume.v1', pipeline_id: start.pipeline_id, action: 'accept', answers: [], note: null };
  const before = diskState(f.pipelineDir(start.pipeline_id));
  try {
    // An earlier G9 and a stale verdict_missing reason cannot override the latest job facts.
    for (const patch of [
      { worker_reported: { ...result.worker_reported, review: { verdict: 'approve', findings: [] } } },
      { state: 'failed', failure_reason: 'check_failed:test' },
      { state: 'failed', failure_reason: 'worker_failed' },
    ]) {
      writeFileSync(resultPath, JSON.stringify({ ...result, ...patch }));
      for (const evidence of [{}, { verdict_missing_reviewed: true, note: NOTE }]) {
        assert.throws(() => preparePipelineResume(store, paused, { ...input, ...evidence }),
          e => e instanceof GbdevError && e.contract.code === 'pipeline_state_conflict' && e.contract.details.reason === 'verdict_missing_result_mismatch');
      }
    }
    // Required result records must not fail open, whether corrupt or absent.
    writeFileSync(resultPath, '{}');
    assert.throws(() => preparePipelineResume(store, paused, input), errorCode('config_invalid'));
    unlinkSync(resultPath);
    assert.throws(() => preparePipelineResume(store, paused, input), { code: 'ENOENT' });
    assert.deepEqual(diskState(f.pipelineDir(start.pipeline_id)), before);
  } finally {
    writeFileSync(resultPath, original);
  }
});

test('AC-12 run task_paused shares pipeline guard; detail tamper ignored', async t => {
  const f = fixture(t);
  f.request.tasks = [f.request.tasks![0]!];
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'a\n' }] };
  f.fakePlan['a/review#1'] = 'review_no_verdict';
  f.fakePlan['review#1'] = 'review_no_verdict';
  const { run } = await f.execute();
  assert.equal(run.state, 'needs_decision');
  assert.equal(run.attention[0]!.reason, 'task_paused');
  assert.ok(run.attention[0]!.accept_requirements);
  assert.equal(run.attention[0]!.recommended_action, 'retry');

  await assert.rejects(
    () => resumeRun(f.store, run.run_id, runInput(run, 'accept', 0, { note: 'silent' }), false),
    e => errorCode('verdict_evidence_required')(e) && e instanceof GbdevError && e.contract.details.decision_id === run.attention[0]!.decision_id,
  );
  assert.equal(readRun(f.store, run.run_id).attention.length, 1);

  const pipelinePath = pipelinePaths(f.store, run.attention[0]!.pipeline_id!).run;
  const originalPipeline = readFileSync(pipelinePath, 'utf8');
  const oneAttempt = JSON.parse(originalPipeline) as PipelineRun;
  oneAttempt.steps[1]!.attempts = oneAttempt.steps[1]!.attempts.slice(0, 1);
  writeFileSync(pipelinePath, JSON.stringify(oneAttempt));
  await assert.rejects(
    () => resumeRun(f.store, run.run_id, runInput(run, 'accept', 0, { verdict_missing_reviewed: true, note: NOTE }), false),
    e => errorCode('verdict_retry_required')(e) && e instanceof GbdevError && e.contract.details.decision_id === run.attention[0]!.decision_id,
  );
  writeFileSync(pipelinePath, originalPipeline);

  // Tamper run detail only — must not bypass; evidence + note still required and still succeed via pipeline facts.
  const path = join(runPaths(f.store, run.run_id).dir, 'run.json');
  const disk = JSON.parse(readFileSync(path, 'utf8')) as Run;
  disk.attention[0]!.detail = 'totally fine, reviewer approved';
  writeFileSync(path, JSON.stringify(disk));
  await assert.rejects(
    () => resumeRun(f.store, run.run_id, runInput(readRun(f.store, run.run_id), 'accept', 0, { note: 'still silent' }), false),
    errorCode('verdict_evidence_required'),
  );
  const current = readRun(f.store, run.run_id);
  const done = await resumeRun(f.store, current.run_id, runInput(current, 'accept', 0, { verdict_missing_reviewed: true, note: NOTE }), false);
  assert.equal(done.tasks[0]!.state, 'merge_queued');
});

test('AC-12b owned pipeline still refuses direct resume while paused', async t => {
  const f = fixture(t);
  f.request.tasks = [f.request.tasks![0]!];
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'a\n' }] };
  f.fakePlan['a/review#1'] = 'review_no_verdict';
  f.fakePlan['review#1'] = 'review_no_verdict';
  const { run } = await f.execute();
  const pipelineId = run.attention[0]!.pipeline_id!;
  const inputFile = joinPath(temporary(t), 'resume.json');
  writeTmp(inputFile, JSON.stringify({
    schema: 'gbdev.pipeline-resume.v1', pipeline_id: pipelineId, action: 'accept', answers: [], note: NOTE, verdict_missing_reviewed: true,
  }));
  await assert.rejects(() => pipelineResume(f.store, pipelineId, inputFile), errorCode('pipeline_owned_by_run'));
});

test('AC-13 final review missing needs confirmation; revise accept_final unchanged', async t => {
  const missing = fixture(t);
  missing.request.tasks = [missing.request.tasks![0]!];
  missing.request.final_review = 'reviewer';
  for (const n of [1, 2]) missing.fakePlan[`run:final_review#${n}`] = 'review_no_verdict';
  const paused = await missing.execute();
  assert.equal(paused.run.attention[0]!.reason, 'final_review_revise');
  assert.equal(paused.run.attention[0]!.recommended_action, null);
  assert.deepEqual(paused.run.attention[0]!.accept_requirements, ['verdict_missing_reviewed', 'note']);
  assert.equal(paused.result.final_review!.verdict, null);

  await assert.rejects(
    () => resumeRun(missing.store, paused.run.run_id, runInput(paused.run, 'accept_final', 0, { note: 'x' }), false),
    errorCode('verdict_evidence_required'),
  );
  const accepted = await resumeRun(missing.store, paused.run.run_id, runInput(paused.run, 'accept_final', 0, {
    verdict_missing_reviewed: true, note: NOTE,
  }), false);
  assert.equal(accepted.state, 'succeeded');
  assert.equal(accepted.outcome, 'accepted_by_decider');
  const result = validateRunResult(jsonFile(runPaths(missing.store, accepted.run_id).result));
  assert.equal(result.final_review!.verdict, null);
  const decision = result.decisions.find(d => d.action === 'accept_final');
  assert.ok(decision);
  assert.equal(decision!.verdict_missing_reviewed, true);
  assert.equal(decision!.note, NOTE);
  assert.ok(decision!.job_ids && decision!.job_ids.length >= 2);

  const revise = fixture(t);
  revise.request.tasks = [revise.request.tasks![0]!];
  revise.request.final_review = 'reviewer';
  revise.fakePlan['run:final_review#1'] = 'review_revise';
  const { run } = await revise.execute();
  assert.equal(run.attention[0]!.reason, 'final_review_revise');
  assert.equal(run.attention[0]!.accept_requirements, undefined);
  const done = await resumeRun(revise.store, run.run_id, runInput(run, 'accept_final', 0, { note: 'Accept documented findings.' }), false);
  assert.equal(done.outcome, 'accepted_by_decider');
  const reviseResult = validateRunResult(jsonFile(runPaths(revise.store, done.run_id).result));
  assert.equal(reviseResult.final_review!.verdict, 'revise');
  assert.ok((reviseResult.final_review!.findings?.length ?? 0) >= 1);
});

test('AC-14 batch atomicity: one illegal item applies nothing', async t => {
  const f = fixture(t);
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'a\n' }] };
  f.fakePlan['a/review#1'] = 'review_no_verdict';
  f.fakePlan['review#1'] = 'review_no_verdict';
  const { run } = await f.execute();
  assert.equal(run.attention.length, 2);
  const before = structuredClone(readRun(f.store, run.run_id));
  const runDir = runPaths(f.store, run.run_id).dir;
  const pipelineDirs = run.attention.map(a => pipelinePaths(f.store, a.pipeline_id!).dir);
  const beforeDisk = [runDir, ...pipelineDirs].map(diskState);
  const bad = [
    runInput(run, 'accept', 0, { verdict_missing_reviewed: true, note: NOTE }),
    runInput(run, 'accept', 1, { note: 'no evidence' }),
  ];
  await assert.rejects(() => resumeRun(f.store, run.run_id, bad, false),
    e => errorCode('verdict_evidence_required')(e) && e instanceof GbdevError && e.contract.details.decision_id === run.attention[1]!.decision_id);
  const after = readRun(f.store, run.run_id);
  assert.deepEqual(after, before);
  assert.deepEqual([runDir, ...pipelineDirs].map(diskState), beforeDisk);

  // Same pending illegal input remains blocked when consumed again.
  await assert.rejects(() => resumeRun(f.store, run.run_id, bad, false), errorCode('verdict_evidence_required'));
  assert.deepEqual([runDir, ...pipelineDirs].map(diskState), beforeDisk);
  const good = runInput(run, 'retry', 0, { note: 'retry review' });
  const retry = await resumeRun(f.store, run.run_id, good, false);
  assert.equal(retry.tasks.find(task => task.task_id === run.attention[0]!.task_id)!.state, 'ready');
  await assert.rejects(
    () => resumeRun(f.store, run.run_id, good, false),
    (e) => e instanceof GbdevError && e.contract.details.reason === 'stale_decision',
  );
});

test('AC-15 non-missing accept unchanged; true rejected off-path; schema types', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'ok', 'review#1': 'review_revise' });
  const start = await f.start({ max_rounds: 0, acceptance_criteria: [] });
  const paused = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(paused.state_reason, 'max_rounds_exceeded');
  const accepted = unwrap((await f.resume(start.pipeline_id, 'accept', { note: 'Accept remaining findings' })).envelope) as PipelineRun;
  assert.equal(accepted.outcome, 'accepted_by_decider');

  const f2 = pipelineFixture(t, { 'implement#1': 'ok', 'review#1': 'review_revise' });
  const s2 = await f2.start({ max_rounds: 0, acceptance_criteria: [] });
  await f2.wait(s2.pipeline_id);
  pipelineError(await f2.resume(s2.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: NOTE }), 'pipeline_state_conflict', 'verdict_missing_reviewed_not_applicable');

  const id = 'p_20261026_1011_abcd';
  const base = { schema: 'gbdev.pipeline-resume.v1', pipeline_id: id, action: 'accept' as const, answers: [], note: null };
  assert.doesNotThrow(() => validatePipelineResume(base, id));
  assert.throws(() => validatePipelineResume({ ...base, verdict_missing_reviewed: 'yes' }, id));
  assert.throws(() => validatePipelineResume({ ...base, extra: true }, id));

  const runBase = {
    schema: 'gbdev.run-resume.v1' as const, run_id: 'r_20261027_0911_5be0', decision_id: 'd4',
    action: 'retry_resolve' as const, task_id: 'health', answers: null, task_graph: null, note: null,
  };
  const attention = [{
    decision_id: 'd4', scope: 'merge' as const, task_id: 'health', reason: 'merge_conflict_unresolved' as const,
    allowed_actions: ['retry_resolve'] as RunAction[], detail: 'x', pipeline_id: null, merge_seq: 1,
    pending_questions: [], created_at: '2026-10-27T09:11:00.000+00:00',
  }];
  assert.doesNotThrow(() => validateRunResume(runBase, { run_id: runBase.run_id, attention }));
  assert.throws(() => validateRunResume({ ...runBase, verdict_missing_reviewed: 'x' }, { run_id: runBase.run_id, attention }), errorCode('run_invalid'));
});

test('AC-16 audit and result retain note/jobs; worker missing result untouched', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_no_verdict' });
  const start = await f.start({ acceptance_criteria: [] });
  const paused = await f.wait(start.pipeline_id) as PipelineRun;
  const reviewJob = paused.steps[1]!.attempts.at(-1)!.job_id;
  const before = readFileSync(join(f.jobDir(reviewJob), 'result.json'), 'utf8');
  unwrap((await f.resume(start.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: NOTE })).envelope);
  assert.equal(readFileSync(join(f.jobDir(reviewJob), 'result.json'), 'utf8'), before);
  const result = JSON.parse(readFileSync(join(f.pipelineDir(start.pipeline_id), 'result.json'), 'utf8'));
  assert.equal(result.outcome, 'accepted_by_decider');
  assert.notEqual(result.final_verdict?.verdict, 'approve');
  const audit = events(f.pipelineDir(start.pipeline_id)).find(e => e.type === 'verdict_missing_accepted');
  assert.ok(audit);
  assert.equal(audit!.data.note, NOTE);
  assert.equal(audit!.data.verdict_missing_reviewed, true);
});

test('AC-17 status projects requirements; old record not rewritten; notify next_step stays status', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'review_no_verdict' });
  const start = await f.start({ acceptance_criteria: [] });
  await f.wait(start.pipeline_id);
  const path = join(f.pipelineDir(start.pipeline_id), 'pipeline.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as PipelineRun;
  delete raw.decision!.recommended_action;
  delete raw.decision!.accept_requirements;
  writeFileSync(path, JSON.stringify(raw));
  const before = readFileSync(path, 'utf8');
  const status = unwrap((await f.command(['pipeline', 'status', start.pipeline_id])).envelope) as PipelineRun;
  assert.deepEqual(status.decision!.accept_requirements, ['verdict_missing_reviewed', 'note']);
  assert.equal(status.decision!.recommended_action, 'retry');
  assert.ok(pipelineText(status).includes(VERDICT_MISSING_STATUS_HINT));
  assert.ok(pipelineText([status]).includes(VERDICT_MISSING_STATUS_HINT));
  assert.ok(pipelineStatus(status, Date.now()).some(row => row.includes(VERDICT_MISSING_STATUS_HINT)));
  assert.equal(readFileSync(path, 'utf8'), before);

  const longNote = 'n'.repeat(1800);
  unwrap((await f.resume(start.pipeline_id, 'accept', { verdict_missing_reviewed: true, note: longNote })).envelope);
  const at = '2026-10-27T09:11:00.000+00:00';
  const payload = buildPayload({
    home_id: 'a1b2c3d4e5f6', unit_kind: 'pipeline', unit_id: start.pipeline_id, event: 'terminal', kind: 'succeeded',
    unit_state: 'succeeded', source_seq: 1, seq: 1, occurred_at: at, sent_at: at, gbdev_version: '1.0.0',
  });
  assert.equal(payload.ok, true);
  if (payload.ok) {
    assert.equal(payload.payload.next_step, notifyNextStep('pipeline', start.pipeline_id));
    assert.match(payload.payload.next_step, /status .* --json$/);
    assert.ok(Buffer.byteLength(payload.json, 'utf8') <= 2048);
    assert.doesNotMatch(payload.json, /nnnn/);
    assert.doesNotMatch(payload.json, /verdict_missing_reviewed/);
    assert.doesNotMatch(payload.json, new RegExp(longNote.slice(0, 32)));
  }
});

test('AC-17 run status projects the shared human-readable hint without rewriting old records', async t => {
  const f = fixture(t);
  f.request.tasks = [f.request.tasks![0]!];
  f.fakePlan['review#1'] = 'review_no_verdict';
  const { run } = await f.execute();
  const path = runPaths(f.store, run.run_id).run;
  for (const attention of run.attention) {
    delete attention.accept_requirements;
    delete attention.recommended_action;
  }
  writeFileSync(path, JSON.stringify(run));
  const before = readFileSync(path, 'utf8');
  const status = (await runCommand(f.store, ['status', run.run_id], {})).result as Run;
  assert.deepEqual(status.attention[0]!.accept_requirements, ['verdict_missing_reviewed', 'note']);
  assert.ok(runText(status).includes(VERDICT_MISSING_STATUS_HINT));
  assert.ok(runText([status]).includes(VERDICT_MISSING_STATUS_HINT));
  assert.ok(runStatus(new ViewFiles(f.paths.home), status, Date.now()).some(row => row.includes(VERDICT_MISSING_STATUS_HINT)));
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.ok(!runText(run).includes(VERDICT_MISSING_STATUS_HINT));
});

test('AC-18 smoke: non-missing revise accept and schema default still work', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'ok', 'review#1': 'review_approve' });
  const start = await f.start({ acceptance_criteria: [] });
  const done = await f.wait(start.pipeline_id, true);
  assert.equal((done as { state: string }).state, 'succeeded');
  assert.ok(!pipelineText(done).includes(VERDICT_MISSING_STATUS_HINT));
});

test('AC-18 report-only read-only job completes without a verdict or acceptance requirements', async t => {
  const f = pipelineFixture(t, { 'plan#1': 'plan_ok' });
  const start = await f.start({
    pipeline: { schema: 'gbdev.pipeline.v1', name: 'report-only', description: 'Plan', steps: [{ id: 'plan', role: 'planner' }], timeout_min: 30 },
    step_overrides: { plan: { provider: 'fake' } },
  });
  const done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded');
  assert.equal(done.outcome, 'completed');
  assert.equal(done.decision, null);
  assert.equal(done.steps[0]!.sandbox, 'read-only');
  assert.equal(done.steps[0]!.attempts.length, 1);
  const job = f.result(done.steps[0]!.attempts[0]!.job_id);
  assert.equal(job.worker_reported?.review, undefined);
  assert.equal(job.state, 'succeeded');
  assert.ok(!pipelineText(done).includes(VERDICT_MISSING_STATUS_HINT));
  assert.equal(events(f.pipelineDir(start.pipeline_id)).filter(e => e.type === 'verdict_missing_accepted').length, 0);
});
