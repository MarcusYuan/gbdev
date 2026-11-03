import { fake } from '../src/providers/fake.js';
import { isRetryableRateLimit } from '../src/run/scheduler.js';
import { ensureRetryChain, inheritMissingResultRetry, loadRetryChain, saveRetryChain } from '../src/core/launchRetry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validateConfig } from '../src/core/config.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { classifyLaunchFailure, launchBackoffDelayMs, DEFAULT_WORKER_LAUNCH } from '../src/core/retryPolicy.js';
import { superviseJob } from '../src/core/supervise.js';
import { localIso, setActiveClock, type Clock } from '../src/core/time.js';
import { validateEvent } from '../src/contracts/event.js';
import { GbdevError } from '../src/contracts/error.js';
import { job } from './helpers.js';
import { tmpRepo } from './helpers/tmpRepo.js';

function fakeClock(start = Date.now()): Clock & { sleeps: number[] } {
  let now = start;
  let mono = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    monotonic: () => mono,
    async sleep(ms: number, signal?: AbortSignal) {
      if (signal?.aborted) { const e = new Error('aborted'); (e as Error & { name: string }).name = 'AbortError'; throw e; }
      sleeps.push(ms);
      now += ms;
      mono += ms;
    },
  };
}

function seedLaunchJob(h: ReturnType<typeof tmpRepo>, store: JobStore, opts: {
  jobId?: string; scenario?: string; sleepMs?: number; role?: string; sandbox?: 'read-only' | 'workspace-write';
  plan?: Record<string, unknown>;
} = {}) {
  const jobId = opts.jobId ?? `j_20261031_1200_${Math.random().toString(16).slice(2, 6)}`;
  const status = {
    ...job(jobId),
    state: 'starting' as const,
    repo: h.repo,
    worktree: h.repo,
    provider: 'fake' as const,
    role: opts.role ?? 'reviewer',
    sandbox: (opts.sandbox ?? 'read-only') as 'read-only',
    base_sha: h.git('rev-parse', 'HEAD').trim(),
    deadline_at: localIso(new Date(Date.now() + 120_000)),
    state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }],
    step_instance: 'run:final_review#1',
    attempt: 1,
  };
  store.create(status);
  const paths = jobPaths(store.paths, jobId);
  atomicWriteJson(paths.brief, {
    ...h.task, provider: 'fake', role: status.role, sandbox: status.sandbox,
    acceptance_criteria: [], stall_timeout_s: 600,
  });
  atomicWriteJson(join(paths.dir, 'provider.json'), {
    bin: process.execPath, writable_roots: [],
    schema_options: { pipelineStep: true, output: 'verdict' },
  });
  writeFileSync(paths.prompt, 'review please');
  writeFileSync(paths.rawJsonl, '');
  writeFileSync(paths.workerLog, '');
  delete process.env.GBDEV_FAKE_PLAN;
  delete process.env.GBDEV_FAKE_SCENARIO;
  delete process.env.GBDEV_FAKE_DELAY_MS;
  if (opts.plan) {
    const planPath = join(h.root, `plan-${jobId}.json`);
    writeFileSync(planPath, JSON.stringify(opts.plan));
    process.env.GBDEV_FAKE_PLAN = planPath;
  } else {
    process.env.GBDEV_FAKE_SCENARIO = opts.scenario ?? 'launch_empty';
    if (opts.sleepMs !== undefined) process.env.GBDEV_FAKE_DELAY_MS = String(opts.sleepMs);
  }
  return { status, paths, jobId };
}

test('AC-B7-1: fast empty exit classifies as launch_failed, not worker_result_missing', async t => {
  const clock = fakeClock();
  setActiveClock(clock);
  t.after(() => { setActiveClock(null); delete process.env.GBDEV_FAKE_SCENARIO; delete process.env.GBDEV_FAKE_DELAY_MS; delete process.env.GBDEV_FAKE_PLAN; });
  const h = tmpRepo(t, 'launch_empty', { acceptance_criteria: [], role: 'reviewer', sandbox: 'read-only' }, { GBDEV_FAKE_DELAY_MS: '50' });
  const store = new JobStore(resolvePaths(h.env));
  const { jobId } = seedLaunchJob(h, store, { scenario: 'launch_empty', sleepMs: 50 });
  await superviseJob(jobId, store);
  const result = JSON.parse(readFileSync(join(h.home, 'jobs', jobId, 'result.json'), 'utf8'));
  assert.equal(result.state, 'failed');
  assert.equal(result.failure_reason, 'launch_failed');
  assert.ok(!(result.failure_reasons ?? []).includes('worker_result_missing'));
});

test('AC-B7-2/3: three executions, two launch_retry, backoff 2000 then 8000 via injected clock', async t => {
  const clock = fakeClock();
  setActiveClock(clock);
  t.after(() => { setActiveClock(null); delete process.env.GBDEV_FAKE_SCENARIO; delete process.env.GBDEV_FAKE_DELAY_MS; delete process.env.GBDEV_FAKE_PLAN; });
  const h = tmpRepo(t, 'launch_empty', { acceptance_criteria: [], role: 'reviewer', sandbox: 'read-only' });
  writeFileSync(h.config, JSON.stringify({
    version: 1, allowed_repos: [h.repo],
    worker_launch: { failure_threshold_ms: 5000, max_retries: 2, backoff_initial_ms: 2000, backoff_multiplier: 4, backoff_max_ms: 30000 },
  }));
  const store = new JobStore(resolvePaths(h.env));
  const { jobId, paths } = seedLaunchJob(h, store, { scenario: 'launch_empty', sleepMs: 30 });
  await superviseJob(jobId, store);
  const result = JSON.parse(readFileSync(join(paths.dir, 'result.json'), 'utf8'));
  assert.equal(result.failure_reason, 'launch_failed');
  assert.equal(result.execution_count ?? result.launch_retries_used + 1, 3);
  assert.equal(result.launch_retries_used, 2);
  assert.equal(result.auto_retries_exhausted, true);
  const events = readFileSync(paths.events, 'utf8').trim().split('\n').filter(Boolean).map(l => validateEvent(JSON.parse(l)));
  const retries = events.filter(e => e.type === 'launch_retry');
  assert.equal(retries.length, 2);
  assert.equal(retries[0]!.data.delay_ms, 2000);
  assert.equal(retries[1]!.data.delay_ms, 8000);
  assert.ok(clock.sleeps.some(s => s === 2000 || s <= 2000));
  assert.ok(existsSync(join(paths.dir, 'launch-attempts', '1')));
  assert.ok(existsSync(join(paths.dir, 'launch-attempts', '2')));
  assert.ok(existsSync(join(paths.dir, 'launch-attempts', '3')));
});

test('AC-B7-3: threshold boundary and illegal config', () => {
  assert.equal(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 4999, raw_events: 0, parseable_json_events: 0,
    final_message: null, threshold_ms: 5000,
  }), 'launch_failed');
  assert.notEqual(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 5000, raw_events: 0, parseable_json_events: 0,
    final_message: null, threshold_ms: 5000,
  }), 'launch_failed');
  assert.equal(launchBackoffDelayMs(1, DEFAULT_WORKER_LAUNCH), 2000);
  assert.equal(launchBackoffDelayMs(2, DEFAULT_WORKER_LAUNCH), 8000);
  assert.throws(() => validateConfig({ version: 1, worker_launch: { max_retries: 99 } }), (e: unknown) => e instanceof GbdevError && e.contract.code === 'config_invalid');
  assert.throws(() => validateConfig({ version: 1, worker_launch: { unknown: 1 } }), (e: unknown) => e instanceof GbdevError && e.contract.code === 'config_invalid');
  assert.throws(() => validateConfig({ version: 1, review_prompt: { max_bytes: 100 } }), (e: unknown) => e instanceof GbdevError && e.contract.code === 'config_invalid');
});

test('AC-B7-4: first empty then success — one job, success, archive retained', async t => {
  const clock = fakeClock();
  setActiveClock(clock);
  t.after(() => {
    setActiveClock(null);
    delete process.env.GBDEV_FAKE_PLAN;
    delete process.env.GBDEV_FAKE_SCENARIO;
    delete process.env.GBDEV_LAUNCH_EXECUTION;
  });
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [], role: 'reviewer', sandbox: 'read-only' });
  const store = new JobStore(resolvePaths(h.env));
  const planPath = join(h.root, 'b7-plan.json');
  writeFileSync(planPath, JSON.stringify({
    'run:final_review#1': {
      scenario: 'launch_empty', sleep_ms: 30,
      by_execution: {
        '1': { scenario: 'launch_empty', sleep_ms: 30 },
        '2': { scenario: 'review_approve', sleep_ms: 10 },
      },
    },
  }));
  process.env.GBDEV_FAKE_PLAN = planPath;
  delete process.env.GBDEV_FAKE_SCENARIO;
  const { jobId, paths } = seedLaunchJob(h, store, {});
  // Override seed defaults with the plan above.
  process.env.GBDEV_FAKE_PLAN = planPath;
  await superviseJob(jobId, store);
  const result = JSON.parse(readFileSync(join(paths.dir, 'result.json'), 'utf8'));
  assert.equal(result.state, 'succeeded', `failure_reason=${result.failure_reason} attempts=${existsSync(join(paths.dir, 'launch-attempts', '2'))}`);
  assert.notEqual(result.failure_reason, 'launch_failed');
  assert.ok(existsSync(join(paths.dir, 'launch-attempts', '1')));
  const events = readFileSync(paths.events, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.filter((e: { type: string }) => e.type === 'launch_retry').length, 1);
});

test('AC-B7-5: JSON without trailing newline / non-empty final / fast verdict are not launch_failed', () => {
  assert.notEqual(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 100, raw_events: 0, parseable_json_events: 1,
    final_message: null, threshold_ms: 5000,
  }), 'launch_failed');
  assert.notEqual(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 100, raw_events: 0, parseable_json_events: 0,
    final_message: 'hello', threshold_ms: 5000,
  }), 'launch_failed');
  assert.equal(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 100, raw_events: 0, parseable_json_events: 0,
    final_message: '  ', threshold_ms: 5000,
  }), 'launch_failed');
});

test('AC-B7-6: cancel/timeout/stall beat launch_failed', () => {
  assert.equal(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 100, raw_events: 0, parseable_json_events: 0,
    final_message: null, forced: 'cancelled', threshold_ms: 5000,
  }), 'cancelled');
  assert.equal(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 100, raw_events: 0, parseable_json_events: 0,
    final_message: null, forced: 'timeout', threshold_ms: 5000,
  }), 'timeout');
  assert.equal(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 100, raw_events: 0, parseable_json_events: 0,
    final_message: null, forced: 'worker_stalled', threshold_ms: 5000,
  }), 'worker_stalled');
  assert.equal(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 100, raw_events: 0, parseable_json_events: 0,
    final_message: null, provider_failure: 'provider_error: rate', threshold_ms: 5000,
  }), 'provider_failure');
});

test('AC-B7-8: cancel during backoff prevents further spawn', async t => {
  const clock = fakeClock();
  setActiveClock(clock);
  t.after(() => { setActiveClock(null); delete process.env.GBDEV_FAKE_SCENARIO; delete process.env.GBDEV_FAKE_DELAY_MS; });
  const h = tmpRepo(t, 'launch_empty', { acceptance_criteria: [], role: 'reviewer', sandbox: 'read-only' });
  const store = new JobStore(resolvePaths(h.env));
  const { jobId, paths } = seedLaunchJob(h, store, { scenario: 'launch_empty', sleepMs: 20 });
  const controller = new AbortController();
  // Abort shortly after first failure schedules backoff.
  const originalSleep = clock.sleep.bind(clock);
  clock.sleep = async (ms, signal) => {
    controller.abort();
    atomicWriteJson(paths.cancelRequest, { by: 'test', reason: 'cancel_during_backoff' });
    return originalSleep(ms, signal ?? controller.signal);
  };
  await superviseJob(jobId, store, controller.signal);
  const chain = JSON.parse(readFileSync(join(paths.dir, 'launch-retry-chain.json'), 'utf8'));
  assert.ok(chain.executions_completed <= 2);
  const attempts = ['1', '2', '3'].filter(n => existsSync(join(paths.dir, 'launch-attempts', n)));
  assert.ok(attempts.length < 3, `expected <3 executions after cancel, got ${attempts.length}`);
});

test('AC-B7-16: slow empty-ish exit with final message stays worker_result_missing path via classify', () => {
  // Duration at/above threshold → not B7 launch_failed.
  assert.equal(classifyLaunchFailure({
    spawned: true, closed: true, worker_duration_ms: 5000, raw_events: 0, parseable_json_events: 0,
    final_message: null, threshold_ms: 5000,
  }), 'missing_result');
});

test('AC-B7-6: stderr-only rate limit owns retry classification, without B7 retries', async t => {
  const h = tmpRepo(t, 'rate_limit', { acceptance_criteria: [], role: 'reviewer', sandbox: 'read-only' });
  const store = new JobStore(resolvePaths(h.env));
  t.after(() => { delete process.env.GBDEV_FAKE_SCENARIO; });
  const { jobId, paths } = seedLaunchJob(h, store, { scenario: 'rate_limit' });
  await superviseJob(jobId, store);
  const result = JSON.parse(readFileSync(paths.result, 'utf8'));
  assert.equal(result.failure_reason, 'rate_limit');
  assert.equal(result.launch_retries_used, 0);
  assert.equal(result.execution_count, 1);
  assert.equal(readFileSync(paths.events, 'utf8').includes('"type":"launch_retry"'), false);
});

test('AC-B7-6: outer rate-limit retry excludes B7 failures and exhausted chains', () => {
  for (const failure_reason of ['launch_failed', 'prompt_too_large']) {
    assert.equal(isRetryableRateLimit({ state: 'failed', failure_reason }, '429 quota'), false);
  }
  assert.equal(isRetryableRateLimit({ state: 'failed', failure_reason: 'worker_result_missing', auto_retries_exhausted: true }, '429 quota'), false);
  assert.equal(isRetryableRateLimit({ state: 'failed', failure_reason: 'rate_limit' }, ''), true);
});

test('E2BIG from actual spawn is prompt_too_large, exhausted, and never retried', async t => {
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [], role: 'reviewer', sandbox: 'read-only' });
  const store = new JobStore(resolvePaths(h.env));
  const { jobId, paths } = seedLaunchJob(h, store);
  t.after(() => { delete process.env.GBDEV_FAKE_SCENARIO; });
  t.mock.method(fake, 'buildInvocation', () => ({ cmd: process.execPath, args: ['x'.repeat(4_000_000)], cwd: h.repo }));
  await superviseJob(jobId, store);
  const result = JSON.parse(readFileSync(paths.result, 'utf8'));
  assert.equal(result.failure_reason, 'prompt_too_large');
  assert.equal(result.worker_exit_code, null);
  assert.equal(result.auto_retries_exhausted, true);
  assert.equal(result.last_classification, 'prompt_too_large');
  assert.equal(result.launch_retries_used, 0);
  assert.equal(store.read(jobId).auto_retries_exhausted, true);
  assert.equal(readFileSync(paths.events, 'utf8').includes('"type":"launch_retry"'), false);
});

test('AC-B7-7: inheritance preserves frozen launch budget and consumes missing-result retry once', t => {
  const h = tmpRepo(t);
  const store = new JobStore(resolvePaths(h.env));
  const a = jobPaths(store.paths, 'j_20261031_1200_ab11'), b = jobPaths(store.paths, 'j_20261031_1200_ab12');
  mkdirSync(a.dir, { recursive: true }); mkdirSync(b.dir, { recursive: true });
  const prior = ensureRetryChain(a, { job_id: 'j_20261031_1200_ab11' });
  prior.launch_retries_used = 1;
  prior.executions_completed = 2;
  saveRetryChain(a, prior);
  const inherited = inheritMissingResultRetry(a, b, { job_id: 'j_20261031_1200_ab12' })!;
  assert.equal(inherited.chain_id, prior.chain_id);
  assert.equal(inherited.launch_retries_used, 1);
  assert.equal(inherited.executions_completed, 2);
  assert.deepEqual(inherited.policy, prior.policy);
  assert.equal(inherited.missing_result_retry_used, true);
  assert.equal(loadRetryChain(a)?.missing_result_retry_used, true);
  assert.throws(() => inheritMissingResultRetry(b, a, prior.owner), /missing_result_retry_exhausted/);
  assert.equal(ensureRetryChain(b, inherited.owner, { ...DEFAULT_WORKER_LAUNCH, max_retries: 5 }).policy.max_retries, 2);
});


test('B7 × B3: launch_empty retry keeps the first baseline byte-for-byte', async t => {
  const clock = fakeClock(); setActiveClock(clock);
  const saved = { ...process.env };
  t.after(() => {
    setActiveClock(null);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const h = tmpRepo(t, 'launch_empty', { acceptance_criteria: [], role: 'reviewer', sandbox: 'read-only' });
  Object.assign(process.env, h.env);
  const store = new JobStore(resolvePaths(h.env));
  writeFileSync(join(h.repo, 'src/carry.txt'), 'inherited before execution one');
  const { jobId, paths } = seedLaunchJob(h, store, { plan: {
    'run:final_review#1': { by_execution: { '1': 'launch_empty', '2': 'review_approve' } },
  } });
  let original = '';
  const sleep = clock.sleep.bind(clock);
  clock.sleep = async (ms, signal) => {
    if (!original) {
      original = readFileSync(join(paths.dir, 'workspace-before.json'), 'utf8');
      writeFileSync(join(h.repo, 'src/carry.txt'), 'changed between executions');
    }
    await sleep(ms, signal);
  };
  await superviseJob(jobId, store);
  assert.ok(original);
  assert.equal(readFileSync(join(paths.dir, 'workspace-before.json'), 'utf8'), original);
  const result = JSON.parse(readFileSync(paths.result, 'utf8'));
  assert.equal(result.execution_count, 2);
  assert.equal(result.launch_retries_used, 1);
  assert.equal(result.state, 'failed');
  assert.ok(result.gbdev_observed.policy_violations.includes('readonly_modified'));
  assert.deepEqual(result.gbdev_observed.job_files_changed, ['src/carry.txt']);
});
