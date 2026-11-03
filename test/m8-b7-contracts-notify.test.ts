import { temporary, job as sampleJob } from './helpers.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { ViewFiles, launchRetryRows } from '../src/render/views/common.js';
import { WatchView } from '../src/render/views/watch.js';
import { pipelineStatus } from '../src/render/views/pipeline.js';
import { runStatus } from '../src/render/views/runStatus.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { Run } from '../src/contracts/run.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ERROR_RETRYABLE, GbdevError, validateError } from '../src/contracts/error.js';
import { EVENT_TYPES, validateEvent } from '../src/contracts/event.js';
import { NOTIFY_REASON_CODES } from '../src/contracts/notify.js';
import { DECISION_REASONS } from '../src/contracts/run.js';
import { validateRunResult } from '../src/contracts/runResult.js';
import { validateConfig } from '../src/core/config.js';
import { DECISION_ACTIONS, decisionActions, gate } from '../src/pipeline/gate.js';
import { result as sampleResult } from './helpers.js';
import { localIso } from '../src/core/time.js';

test('AC-B7-15/16: contracts include launch_failed, prompt_too_large, launch_retry; schemas agree', () => {
  assert.equal(ERROR_RETRYABLE.launch_failed, true);
  assert.equal(ERROR_RETRYABLE.prompt_too_large, false);
  validateError(new GbdevError('launch_failed', 'x').contract);
  validateError(new GbdevError('prompt_too_large', 'x', { provider: 'cursor', prompt_bytes: 1, max_bytes: 1, diff_externalized: false }).contract);
  assert.ok((EVENT_TYPES as readonly string[]).includes('launch_retry'));
  assert.ok(DECISION_REASONS.includes('launch_failed'));
  assert.ok(DECISION_REASONS.includes('prompt_too_large'));
  assert.ok((NOTIFY_REASON_CODES as readonly string[]).includes('launch_failed'));
  assert.ok((NOTIFY_REASON_CODES as readonly string[]).includes('prompt_too_large'));

  const event = validateEvent({
    schema: 'gbdev.event.v1', job_id: 'j_20261031_1200_abcd', seq: 1, at: localIso(),
    source: 'gbdev', type: 'launch_retry',
    data: { chain_id: 'chain-x', provider: 'fake', reason: 'launch_failed', failed_execution: 1, next_execution: 2, retry_index: 1, max_retries: 2, delay_ms: 2000 },
  });
  assert.equal(event.type, 'launch_retry');

  const runSchema = JSON.parse(readFileSync(join('src/contracts/gbdev.run.v1.schema.json'), 'utf8'));
  assert.ok(runSchema.properties.attention.items.properties.reason.enum.includes('launch_failed'));
  const resultSchema = JSON.parse(readFileSync(join('src/contracts/gbdev.run-result.v1.schema.json'), 'utf8'));
  const fr = resultSchema.properties.final_review.anyOf[0].properties;
  assert.ok(fr.round_id && fr.failure_reason && fr.review_completed);

  // Old final_review without new fields still validates.
  validateRunResult({
    schema: 'gbdev.run-result.v1', run_id: 'r_20261031_1200_abcd', state: 'needs_decision', outcome: null,
    repo: '/r', base_sha: 'a', integration_branch: 'b', integration_sha: 'c',
    diff_stat: { files: 0, insertions: 0, deletions: 0 }, commits: [], tasks: [], dropped_tasks: [], merges: [],
    final_gate: null, final_review: { job_id: 'j_20261031_1200_abcd', verdict: null, findings: [] },
    acceptance_criteria: [], decisions: [], landing: { eligible: false, target_hint: null, landed_sha: null },
    artifacts: { diff: 'd', events: 'e', merges_dir: 'm' }, warnings: [],
  });
});

test('config worker_launch / review_prompt defaults and closure', () => {
  const cfg = validateConfig({ version: 1, worker_launch: {}, review_prompt: {} });
  assert.equal(cfg.worker_launch?.failure_threshold_ms, 5000);
  assert.equal(cfg.worker_launch?.max_retries, 2);
  assert.equal(cfg.review_prompt?.max_bytes, 200000);
  assert.throws(() => validateConfig({ version: 1, worker_launch: { backoff_max_ms: 1, backoff_initial_ms: 100 } }));
});

test('gate: launch_failed / prompt_too_large pause before G9; no accept', () => {
  const base = { ...sampleResult(), state: 'failed' as const, worker_reported: null, failure_reason: 'launch_failed', failure_reasons: ['launch_failed'] };
  const g = gate(base, 'verdict');
  assert.equal(g.rule, 'B7');
  assert.equal(g.reason, 'launch_failed');
  assert.equal(g.action, 'settle');
  assert.deepEqual(DECISION_ACTIONS.launch_failed, ['retry']);
  assert.deepEqual(decisionActions('launch_failed', true, 2, 1), ['retry']);
  assert.deepEqual(decisionActions('launch_failed', true, 2, 3), []);
  const p = gate({ ...base, failure_reason: 'prompt_too_large', failure_reasons: ['prompt_too_large'] }, 'verdict');
  assert.equal(p.reason, 'prompt_too_large');
  // Ordinary missing still G9.
  const missing = gate({ ...base, failure_reason: 'worker_result_missing', failure_reasons: ['worker_result_missing'] }, 'verdict');
  assert.equal(missing.rule, 'G9');
});

test('notify payload reason whitelist includes B7 codes and size guard concept', () => {
  assert.ok(NOTIFY_REASON_CODES.includes('launch_failed' as typeof NOTIFY_REASON_CODES[number]));
  // Summary-style bound: a 2048-byte JSON payload ceiling remains the notify contract.
  const summary = '最终评审启动失败：未产生有效评审输出；当前不能接受，需修复后 retry 或人工介入';
  assert.ok(Buffer.byteLength(JSON.stringify({ summary, reason_code: 'launch_failed' }), 'utf8') < 2048);
  assert.ok(!summary.includes('diff --git'));
});

test('AC-B7-15: job, pipeline and run status render persisted backoff then clear it', t => {
  const home = temporary(t), store = new JobStore(resolvePaths({ GBDEV_HOME: home }));
  const id = 'j_20261031_1200_abcd', runId = 'r_20261031_1200_abcd', now = Date.now();
  store.create({ ...sampleJob(id), state: 'running', run_id: runId,
    state_history: [{ state: 'running', at: localIso(), by: 'test' }],
    retry_not_before: localIso(new Date(now + 8000)), launch_retries_used: 2 });
  atomicWriteJson(join(home, 'jobs', id, 'launch-retry-chain.json'), {
    pending_execution: 3, launch_retries_used: 2, policy: { max_retries: 2 },
  });
  const files = new ViewFiles(home);
  const view = new WatchView(home, { kind: 'job', id });
  t.after(() => view.close());
  assert.match(view.poll(now).rows.join('\n'), /等待第 2\/2 次自动重试；退避 8s/);
  const pipeline = { pipeline_id: 'p_20261031_1200_abcd', state: 'running', created_at: localIso(), jobs_used: 1,
    max_total_jobs: 10, current: { instance: 'review#1', job_id: id }, round: 1, max_rounds: 2,
    steps: [], pending_questions: [], workspace: { branch: 'test' }, head_sha: 'a', deadline_at: localIso(),
  } as unknown as PipelineRun;
  assert.match(pipelineStatus(pipeline, now, {}, files).join('\n'), /等待第 2\/2 次自动重试/);
  const run = { run_id: runId, state: 'finalizing', created_at: localIso(), integration: { head_sha: 'a', verified_sha: 'a', branch: 'b' },
    budget: { jobs_used: 1, max_total_jobs: 10, max_tasks: 2 }, progress: { integrated: 0 }, tasks: [], lanes: [], attention: [],
    slots: { in_use: 1, max_workers: 1, by_provider: { codex: 0, cursor: 0 } }, deadline_at: localIso(),
  } as unknown as Run;
  assert.match(runStatus(files, run, now).join('\n'), /等待第 2\/2 次自动重试/);
  assert.deepEqual(launchRetryRows(files, id, now + 9000), []);
  const job = store.read(id); job.retry_not_before = null; store.write(job);
  assert.deepEqual(launchRetryRows(files, id, now), []);
});

test('notify reasons preserve the existing union, add B3/B4, and contain no duplicates', () => {
  const expected = new Set([
    ...DECISION_REASONS, 'run_timeout', 'pipeline_supervisor_crashed', 'worker_stalled', 'worker_crashed',
    'worker_result_missing', 'worker_reported_failed', 'outside_allowed_paths', 'readonly_modified',
    'result_invalid', 'result_missing', 'launch_failed', 'prompt_too_large',
    'workspace_snapshot_invalid', 'policy_repair_required',
  ]);
  assert.deepEqual(new Set(NOTIFY_REASON_CODES), expected);
  assert.equal(NOTIFY_REASON_CODES.length, expected.size);
});
