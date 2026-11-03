import { fixture } from './helpers/m3.js';
import { runJobs } from '../src/run/invariants.js';
import { loadRetryChain } from '../src/core/launchRetry.js';
import { resumeRun } from '../src/commands/run.js';
import { superviseRun } from '../src/run/supervisor.js';
import { readRun } from '../src/run/store.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { GbdevError } from '../src/contracts/error.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import {
  assertPipelineVerdictAccept, assertFinalReviewVerdictAccept, readFinalReview, finalReviewValidAttempts,
} from '../src/core/verdictAcceptance.js';
import { localIso } from '../src/core/time.js';
import { temporary, job as sampleJob, result as sampleResult } from './helpers.js';
import { preparePipelineResume } from '../src/pipeline/resume.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { Run } from '../src/contracts/run.js';

function minimalRun(home: string, runId = 'r_20261031_1200_abcd'): Run {
  const at = localIso();
  return {
    schema: 'gbdev.run.v1', run_id: runId, state: 'needs_decision', state_reason: null, outcome: null, failure_reason: null,
    repo: '/repo', base_ref: 'main', base_sha: 'aaaaaaaa', executor_host: 'local',
    lanes: [], integration: {
      branch: 'gbdev/int', worktree: join(home, 'wt'), verified_sha: 'bbbbbbbb', head_sha: 'bbbbbbbb',
      merging: null, merges: 0, rollbacks: 0, target_branch: null, landed_sha: null, approved_by_user_at: null,
    },
    tasks: [{
      task_id: 't1', state: 'integrated', lane: null, branch: null, depends_on: [], attempts: [],
      head_sha: 'bbbbbbbb', base_sha: 'aaaaaaaa', merge_seq: [], merged_sha: 'bbbbbbbb', integration_fixes: 0,
      scope_exceeded: [], decision_id: null,
    }],
    progress: { total: 1, pending: 0, ready: 0, running: 0, paused: 0, merge_queued: 0, merging: 0, integrated: 1, needs_decision: 0, dropped: 0, failed: 0 },
    merge_queue: [], attention: [{
      decision_id: 'd_launch', scope: 'run', task_id: null, reason: 'launch_failed',
      allowed_actions: ['retry'], detail: 'launch failed', pipeline_id: null, merge_seq: null,
      pending_questions: [], created_at: at,
    }],
    slots: { max_workers: 1, in_use: 0, by_provider: { codex: 0, cursor: 0 }, cooldown_until: {} },
    budget: { jobs_used: 1, max_total_jobs: 40, max_tasks: 8, extended: false },
    plan: { source: 'provided', approved_at: at, approved_by: 'test', plan_attempts: 1 },
    supervisor_pid: null, heartbeat_at: null, created_at: at, updated_at: at, deadline_at: localIso(new Date(Date.now() + 60_000)),
    state_history: [{ state: 'needs_decision', at, by: 'gbdev', reason: null }], warnings: [],
  };
}

test('AC-B7-10/11: accept_final hard-rejects launch_failed even with true+note', t => {
  const home = temporary(t);
  mkdirSync(join(home, 'runs', 'r_20261031_1200_abcd'), { recursive: true });
  mkdirSync(join(home, 'jobs', 'j_20261031_1200_abcd'), { recursive: true });
  const previousHome = process.env.GBDEV_HOME;
  process.env.GBDEV_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.GBDEV_HOME;
    else process.env.GBDEV_HOME = previousHome;
  });
  const store = new JobStore(resolvePaths({ GBDEV_HOME: home }));
  const run = minimalRun(home);
  atomicWriteJson(join(home, 'runs', run.run_id, 'final-review.json'), {
    job_id: 'j_20261031_1200_abcd', verdict: null, findings: [],
    failure_reason: 'launch_failed', review_completed: false, round_id: 'final:r:aa:bb',
  });
  atomicWriteJson(join(home, 'jobs', 'j_20261031_1200_abcd', 'result.json'), {
    schema: 'gbdev.job-result.v1', job_id: 'j_20261031_1200_abcd', state: 'failed', worker_exit_code: 0,
    duration_s: 0.3, worker_reported: null, worker_result_warnings: [], failure_reason: 'launch_failed', failure_reasons: ['launch_failed'],
    session_id: null,
    gbdev_observed: { head_before: 'b', head_after: 'b', commits: [], files_changed: [], outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null, checks: [], policy_violations: [] },
    paths: { final_message: 'f', diff: 'd', events: 'e', worker_log: 'w' },
  });
  assert.equal(readFinalReview(store, run)?.failure_reason, 'launch_failed');
  assert.throws(
    () => assertFinalReviewVerdictAccept(store, run, {
      action: 'accept_final', note: 'I read the diff and tests; accept.', verdict_missing_reviewed: true, decision_id: 'd_launch',
    }),
    (e: unknown) => e instanceof GbdevError && e.contract.code === 'run_state_conflict'
      && e.contract.details.reason === 'launch_failed_not_acceptable',
  );
  assert.throws(
    () => assertFinalReviewVerdictAccept(store, run, {
      action: 'accept_final', note: null, decision_id: 'd_launch',
    }),
    (e: unknown) => e instanceof GbdevError && e.contract.details.reason === 'launch_failed_not_acceptable',
  );
});

test('AC-B7-11: prompt_too_large not acceptable', t => {
  const home = temporary(t);
  mkdirSync(join(home, 'runs', 'r_20261031_1200_ab01'), { recursive: true });
  mkdirSync(join(home, 'jobs', 'j_20261031_1200_ab01'), { recursive: true });
  const store = new JobStore(resolvePaths({ GBDEV_HOME: home }));
  const run = { ...minimalRun(home, 'r_20261031_1200_ab01'), attention: [{
    ...minimalRun(home).attention[0]!, decision_id: 'd_prompt', reason: 'prompt_too_large' as const,
  }] };
  atomicWriteJson(join(home, 'runs', run.run_id, 'final-review.json'), {
    job_id: 'j_20261031_1200_ab01', verdict: null, findings: [], failure_reason: 'prompt_too_large', review_completed: false,
  });
  atomicWriteJson(join(home, 'jobs', 'j_20261031_1200_ab01', 'result.json'), {
    schema: 'gbdev.job-result.v1', job_id: 'j_20261031_1200_ab01', state: 'failed', worker_exit_code: null,
    duration_s: 0, worker_reported: null, worker_result_warnings: [], failure_reason: 'prompt_too_large', failure_reasons: ['prompt_too_large'],
    session_id: null,
    gbdev_observed: { head_before: 'b', head_after: 'b', commits: [], files_changed: [], outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null, checks: [], policy_violations: [] },
    paths: { final_message: 'f', diff: 'd', events: 'e', worker_log: 'w' },
  });
  assert.throws(
    () => assertFinalReviewVerdictAccept(store, run, {
      action: 'accept_final', note: 'note', verdict_missing_reviewed: true, decision_id: 'd_prompt',
    }),
    (e: unknown) => e instanceof GbdevError && e.contract.details.reason === 'prompt_too_large_not_acceptable',
  );
});

test('AC-B7-12: launch_failed attempts do not count toward S2 valid retries', t => {
  const home = temporary(t);
  mkdirSync(join(home, 'runs', 'r_20261031_1200_ab02'), { recursive: true });
  for (const id of ['j_20261031_1200_aaa1', 'j_20261031_1200_aaa2']) {
    mkdirSync(join(home, 'jobs', id), { recursive: true });
    atomicWriteJson(join(home, 'jobs', id, 'job.json'), {
      schema: 'gbdev.job-status.v1', job_id: id, state: 'failed', provider: 'fake', role: 'reviewer', sandbox: 'read-only',
      repo: '/r', worktree: '/w', branch: 'gbdev/x', base_sha: 'b', pid: 1, created_at: localIso(), updated_at: localIso(),
      deadline_at: localIso(), state_history: [{ state: 'failed', at: localIso(), by: 'gbdev' }], last_event: null,
      parent_job_id: null, run_id: 'r_20261031_1200_ab02', step_instance: 'run:final_review#1', attempt: 1,
      failure_reason: 'launch_failed', failure_reasons: ['launch_failed'],
    });
    atomicWriteJson(join(home, 'jobs', id, 'result.json'), {
      schema: 'gbdev.job-result.v1', job_id: id, state: 'failed', worker_exit_code: 0, duration_s: 0.2,
      worker_reported: null, worker_result_warnings: [], failure_reason: 'launch_failed', failure_reasons: ['launch_failed'], session_id: null,
      gbdev_observed: { head_before: 'b', head_after: 'b', commits: [], files_changed: [], outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null, checks: [], policy_violations: [] },
      paths: { final_message: 'f', diff: 'd', events: 'e', worker_log: 'w' },
    });
  }
  const store = new JobStore(resolvePaths({ GBDEV_HOME: home }));
  const run = minimalRun(home, 'r_20261031_1200_ab02');
  atomicWriteJson(join(home, 'runs', run.run_id, 'final-review.json'), {
    job_id: 'j_20261031_1200_aaa2', verdict: null, findings: [], failure_reason: 'launch_failed', round_id: 'r1',
  });
  assert.equal(finalReviewValidAttempts(store, run).length, 0);
});

test('AC-B7-9: pipeline resume rejects accept on launch_failed even if allowed_actions stale', t => {
  const home = temporary(t);
  const jobId = 'j_20261031_1200_ab10';
  mkdirSync(join(home, 'pipelines', 'p_20261031_1200_abcd'), { recursive: true });
  mkdirSync(join(home, 'jobs', jobId), { recursive: true });
  const store = new JobStore(resolvePaths({ GBDEV_HOME: home }));
  atomicWriteJson(join(home, 'jobs', jobId, 'result.json'), {
    schema: 'gbdev.job-result.v1', job_id: jobId, state: 'failed', worker_exit_code: 0, duration_s: 0.2,
    worker_reported: null, worker_result_warnings: [], failure_reason: 'launch_failed', failure_reasons: ['launch_failed'], session_id: null,
    gbdev_observed: { head_before: 'b', head_after: 'b', commits: [], files_changed: [], outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null, checks: [], policy_violations: [] },
    paths: { final_message: 'f', diff: 'd', events: 'e', worker_log: 'w' },
  });
  const pipeline: PipelineRun = {
    schema: 'gbdev.pipeline-run.v1', pipeline_id: 'p_20261031_1200_abcd', pipeline: 'review', state: 'needs_decision',
    state_reason: 'launch_failed', outcome: null, failure_reason: 'launch_failed', repo: '/r',
    workspace: { mode: 'shared_run_worktree', worktree: '/w', branch: 'b' },
    base_sha: 'a', diff_base_sha: 'a', head_sha: 'a', round: 1, max_rounds: 2, jobs_used: 1, max_total_jobs: 12,
    current: { instance: 'review#1', job_id: jobId, job_state: 'failed', attempt: 1 },
    steps: [{
      instance: 'review#1', step_id: 'review', kind: 'step', state: 'failed', round: 1, role: 'reviewer', provider: 'fake', sandbox: 'read-only',
      attempts: [{ attempt: 1, job_id: jobId, job_state: 'failed', failure_reason: 'launch_failed' }],
      gate: 'needs_decision', verdict: null, head_before: 'a', head_after: 'a', handoff: null, started_at: localIso(), finished_at: localIso(),
    }],
    // Stale accept still listed — must be rejected by resume guard.
    decision: { reason: 'launch_failed', instance: 'review#1', allowed_actions: ['retry', 'accept'], detail: 'stale' },
    pending_questions: [], supervisor_pid: null, heartbeat_at: null, created_at: localIso(), updated_at: localIso(),
    deadline_at: localIso(new Date(Date.now() + 60_000)),
    state_history: [{ state: 'needs_decision', at: localIso(), by: 'gbdev', reason: 'launch_failed' }],
    warnings: [], integration: null,
  };
  atomicWriteJson(join(home, 'pipelines', pipeline.pipeline_id, 'pipeline.json'), pipeline);
  writeFileSync(join(home, 'pipelines', pipeline.pipeline_id, 'definition.json'), JSON.stringify({ name: 'review', steps: [], fix_loop: null }));
  assert.throws(
    () => preparePipelineResume(store, pipeline, {
      schema: 'gbdev.pipeline-resume.v1', pipeline_id: pipeline.pipeline_id, action: 'accept', answers: [], note: 'x',
    }),
    (e: unknown) => e instanceof GbdevError && (
      e.contract.details.reason === 'launch_failed_not_acceptable' || e.contract.code === 'pipeline_state_conflict'
    ),
  );
});

test('AC-B7-12: actual job round excludes older SHA and same-SHA prior rounds', t => {
  const home = temporary(t), store = new JobStore(resolvePaths({ GBDEV_HOME: home }));
  const run = minimalRun(home);
  mkdirSync(join(home, 'runs', run.run_id), { recursive: true });
  const rounds = ['old-sha-round', 'same-sha-old-round', 'current-round', 'current-round'];
  const ids = rounds.map((round, index) => {
    const id = `j_20261031_1200_abc${index}`;
    store.create({ ...sampleJob(id), state: 'succeeded', run_id: run.run_id, review_round_id: round,
      step_instance: `run:final_review#${index + 1}`, attempt: index + 1,
      state_history: [{ state: 'succeeded', at: localIso(), by: 'test' }] });
    atomicWriteJson(jobPaths(store.paths, id).result, { ...sampleResult(), job_id: id, state: 'succeeded', failure_reason: null });
    return id;
  });
  atomicWriteJson(join(home, 'runs', run.run_id, 'final-review.json'), {
    job_id: ids[3], verdict: null, findings: [], round_id: 'current-round',
  });
  assert.deepEqual(finalReviewValidAttempts(store, run).map(j => j.job_id), ids.slice(2));
  assert.deepEqual(finalReviewValidAttempts(store, run, 'old-sha-round').map(j => j.job_id), ids.slice(0, 1));
  assert.equal(finalReviewValidAttempts(store, run, 'unknown-round').length, 0);
});

test('AC-B7-7: G9 and final-review successors inherit consumed launch budget in production', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.final_review = 'reviewer';
  const plan = { by_execution: {
    '1': { scenario: 'launch_empty', sleep_ms: 1 }, '2': 'review_no_verdict',
    '3': { scenario: 'launch_empty', sleep_ms: 1 }, '4': 'review_approve',
  } };
  f.fakePlan['review#1'] = plan;
  f.fakePlan['run:final_review#1'] = plan;
  f.fakePlan['run:final_review#2'] = plan;
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8'));
  atomicWriteJson(f.paths.config, { ...config, worker_launch: { backoff_initial_ms: 1, backoff_multiplier: 2, backoff_max_ms: 2 } });
  const { run } = await f.execute();
  assert.equal(run.state, 'succeeded', JSON.stringify(run.attention));
  const jobs = runJobs(f.store, run);
  for (const reviews of [jobs.filter(j => j.step_instance === 'review#1'), jobs.filter(j => j.step_instance?.startsWith('run:final_review#'))]) {
    assert.equal(reviews.length, 2);
    reviews.sort((a, b) => a.attempt! - b.attempt!);
    const first = loadRetryChain(jobPaths(f.paths, reviews[0]!.job_id))!;
    const second = loadRetryChain(jobPaths(f.paths, reviews[1]!.job_id))!;
    assert.equal(first.chain_id, second.chain_id);
    assert.equal(first.launch_retries_used, 1);
    assert.equal(second.launch_retries_used, 2);
    assert.equal(second.executions_completed, 4);
    assert.equal(first.missing_result_retry_used, true);
    assert.equal(second.missing_result_retry_used, true);
  }
});

test('AC-B7-10: manual resume enters finalizing and runs a fresh final-review job/chain', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.request.final_review = 'reviewer';
  f.fakePlan['run:final_review#1'] = { scenario: 'launch_empty', sleep_ms: 1 };
  const config = JSON.parse(readFileSync(f.paths.config, 'utf8'));
  atomicWriteJson(f.paths.config, { ...config, worker_launch: { max_retries: 0 } });
  const { run: paused } = await f.execute();
  assert.equal(paused.state, 'needs_decision');
  assert.equal(paused.attention[0]!.reason, 'launch_failed');
  assert.deepEqual(paused.attention[0]!.allowed_actions, ['retry']);
  const old = runJobs(f.store, paused).find(j => j.step_instance === 'run:final_review#1')!;
  f.fakePlan['run:final_review#2'] = 'review_approve'; f.savePlan();
  await resumeRun(f.store, paused.run_id, {
    schema: 'gbdev.run-resume.v1', run_id: paused.run_id, decision_id: paused.attention[0]!.decision_id,
    action: 'retry', task_id: null, answers: null, task_graph: null, note: 'Retry after provider recovery.',
  }, false);
  await superviseRun(f.store, paused.run_id);
  const run = readRun(f.store, paused.run_id);
  assert.equal(run.state, 'succeeded');
  assert.equal(run.state_history.filter(s => s.state === 'finalizing').length, 2);
  const next = runJobs(f.store, run).find(j => j.step_instance === 'run:final_review#2')!;
  assert.ok(next);
  assert.notEqual(next.chain_id, old.chain_id);
  assert.notEqual(next.review_round_id, old.review_round_id);
  assert.equal(next.state, 'succeeded');
  assert.equal(run.tasks[0]!.attempts.length, paused.tasks[0]!.attempts.length);
});

for (const failure of ['launch_failed', 'prompt_too_large', 'timeout', 'worker_stalled', 'cancelled', 'rate_limit', 'rate-limit', 'provider_cooldown', null]) {
  test(`AC-B7-12 pipeline: ${failure ?? 'real missing verdict'} attempts gate true+note acceptance`, t => {
    const home = temporary(t), store = new JobStore(resolvePaths({ GBDEV_HOME: home }));
    const pipelineId = 'p_20261031_1200_ab12';
    mkdirSync(join(home, 'pipelines', pipelineId), { recursive: true });
    atomicWriteJson(join(home, 'pipelines', pipelineId, 'roles.snapshot.json'), { steps: { review: { output: 'verdict' } } });
    const reasons = failure ? [failure, failure, 'worker_result_missing'] : ['worker_result_missing', 'worker_result_missing'];
    const attempts = reasons.map((reason, index) => {
      const id = `j_20261031_1200_ac0${index}`;
      mkdirSync(join(home, 'jobs', id), { recursive: true });
      const state = reason === 'cancelled' || reason === 'timeout' ? reason : 'failed';
      atomicWriteJson(jobPaths(store.paths, id).result, {
        ...sampleResult(), job_id: id, state, worker_reported: null,
        failure_reason: reason, failure_reasons: [reason],
      });
      return { job_id: id, job_state: state, failure_reason: reason, attempt: index + 1 };
    });
    // Only the acceptance guard's inputs are needed; no supervisor/worker timing.
    const pipeline = {
      pipeline_id: pipelineId, state_reason: 'verdict_missing',
      decision: { reason: 'verdict_missing', instance: 'review#1', allowed_actions: ['accept'] },
      steps: [{ instance: 'review#1', step_id: 'review', attempts }],
    } as unknown as PipelineRun;
    const accept = () => assertPipelineVerdictAccept(store, pipeline, {
      action: 'accept', note: 'Reviewed the diff and check output.', verdict_missing_reviewed: true,
    });
    if (failure) assert.throws(accept, (error: unknown) => error instanceof GbdevError && error.contract.code === 'verdict_retry_required');
    else assert.deepEqual(accept()?.job_ids, attempts.map(a => a.job_id));
  });
}
