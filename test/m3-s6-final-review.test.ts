import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers/m3.js';
import { assertReviewPrompt } from './helpers/reviewPrompt.js';
import { runJobs } from '../src/run/invariants.js';
import { jobPaths } from '../src/core/paths.js';
import { VERDICT_RETRY_NOTICE } from '../src/core/prompt.js';
import { stepResult } from '../src/pipeline/store.js';
import { extractWorkerResult } from '../src/contracts/workerResult.js';

for (const role of ['reviewer', 'verifier'] as const) {
  test(`D1/D2 final ${role}: prose approve without review retries, then verdict_missing not rejected`, async t => {
    const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.final_review = role;
    for (const attempt of [1, 2]) f.fakePlan[`run:final_review#${attempt}`] = 'review_no_verdict';
    const { run, result } = await f.execute();
    const reviews = runJobs(f.store, run).filter(j => j.step_instance?.startsWith('run:final_review#')).sort((a, b) => a.attempt! - b.attempt!);
    assert.equal(reviews.length, 2);
    for (const job of reviews) {
      assert.equal(job.role, role); assert.equal(job.state, 'succeeded');
      const paths = jobPaths(f.paths, job.job_id), prompt = readFileSync(paths.prompt, 'utf8');
      assertReviewPrompt(prompt);
      assert.equal(prompt.includes(VERDICT_RETRY_NOTICE), job.attempt === 2);
      const final = readFileSync(join(paths.dir, 'final.md'), 'utf8');
      assert.match(final, /Verdict: approve/); assert.equal(extractWorkerResult(final).review, undefined);
      assert.equal(stepResult(f.store, job.job_id).worker_reported?.review, undefined);
    }
    assert.equal(run.state, 'needs_decision');
    assert.equal(run.attention[0]!.reason, 'final_review_revise');
    assert.match(run.attention[0]!.detail, /final review verdict missing.*verdict_missing/);
    assert.deepEqual(run.attention[0]!.allowed_actions, ['add_fix_task', 'accept_final']);
    assert.equal(result.final_review!.verdict, null); assert.deepEqual(result.final_review!.findings, []);
    f.invariants(run.run_id);
  });

  test(`D1/D2 final ${role}: structured approve succeeds without retry or attention`, async t => {
    const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.final_review = role;
    const { run, result } = await f.execute();
    assert.equal(run.state, 'succeeded'); assert.deepEqual(run.attention, []);
    assert.equal(result.final_review!.verdict, 'approve');
    const reviews = runJobs(f.store, run).filter(j => j.step_instance?.startsWith('run:final_review#'));
    assert.equal(reviews.length, 1);
    const prompt = readFileSync(jobPaths(f.paths, reviews[0]!.job_id).prompt, 'utf8');
    assertReviewPrompt(prompt); assert.ok(!prompt.includes(VERDICT_RETRY_NOTICE));
    f.invariants(run.run_id);
  });
}

test('D1 final review missing verdict then structured approve recovers on attempt 2', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.final_review = 'reviewer';
  f.fakePlan['run:final_review#1'] = 'review_no_verdict'; f.fakePlan['run:final_review#2'] = 'review_approve';
  const { run, result } = await f.execute();
  assert.equal(run.state, 'succeeded'); assert.equal(result.final_review!.verdict, 'approve');
  const reviews = runJobs(f.store, run).filter(j => j.step_instance?.startsWith('run:final_review#')).sort((a, b) => a.attempt! - b.attempt!);
  assert.equal(reviews.length, 2); assert.equal(reviews[1]!.parent_job_id, reviews[0]!.job_id);
  assert.ok(readFileSync(jobPaths(f.paths, reviews[1]!.job_id).prompt, 'utf8').includes(VERDICT_RETRY_NOTICE));
  f.invariants(run.run_id);
});
