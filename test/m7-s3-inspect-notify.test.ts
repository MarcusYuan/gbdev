import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validateJobResult } from '../src/contracts/jobResult.js';
import { atomicWriteJson, JobStore } from '../src/core/jobStore.js';
import { jobPaths } from '../src/core/paths.js';
import { locked, transition } from '../src/core/runtime.js';
import { localIso } from '../src/core/time.js';
import { deliver, pendingNotices } from '../src/notify/deliver.js';
import { installNotifyTesting, notifyEvent } from '../src/notify/enqueue.js';
import { job } from './helpers.js';
import { runFixture } from './helpers/run.js';

test('inspect terminals enqueue after the result is stored and stay within the payload budget', async t => {
  const fx = runFixture(t);
  const store = new JobStore(fx.paths);
  const secret = join(fx.root, 'secret');
  writeFileSync(secret, JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: 'http://127.0.0.1:1/unused', key: 'super-secret-value' }));
  chmodSync(secret, 0o600);
  const config = JSON.parse(readFileSync(fx.paths.config, 'utf8')) as Record<string, unknown>;
  config.notify = { enabled: true, key_name: 'X-Key', secret_file: secret };
  writeFileSync(fx.paths.config, JSON.stringify(config));
  const seen: string[] = [];
  t.after(installNotifyTesting(fx.paths.home, {
    env: { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1' },
    launch: () => {
      for (let n = 1; n <= 4; n++) {
        const id = `j_20261031_1205_000${n}`;
        if (existsSync(join(store.paths.home, 'jobs', id))) assert.equal(existsSync(jobPaths(store.paths, id).result), true);
      }
      seen.push('launch');
    },
  }));
  const question = 'Does the payload contain this question?';
  const answer = 'Committed evidence does not show a definitive defect.';
  let seq = 0;
  for (const state of ['succeeded', 'failed', 'cancelled', 'timeout'] as const) {
    seq += 1;
    const id = `j_20261031_1205_000${seq}`;
    const status = job(id);
    status.kind = 'inspect';
    status.role = 'inspector';
    status.sandbox = 'read-only';
    status.provider = 'fake';
    status.repo = fx.repo;
    status.base_sha = fx.base;
    status.inspection = {
      workspace_owned: true, detached: true, question, paths: [], diff: false, tests: false,
      target: { kind: 'job', id, run_id: null, task_id: null, job_id: id, pipeline_id: null },
      snapshot: { mode: 'committed', target_sha: fx.base, diff_base_sha: fx.base, captured_at: localIso(), uncommitted_included: false },
    };
    store.create(status);
    const paths = jobPaths(store.paths, id);
    const result = {
      schema: 'gbdev.job-result.v1' as const, job_id: id, state, session_id: null, worker_exit_code: 0, duration_s: 0,
      worker_reported: null, worker_result_warnings: [], failure_reason: state === 'succeeded' ? null : state,
      failure_reasons: state === 'succeeded' ? [] : [state], inspection: state === 'succeeded' ? {
        schema: 'gbdev.inspect-result.v1' as const, job_id: id, answer, excerpts: [], warnings: ['uncommitted_excluded' as const], truncated: false,
        target: status.inspection.target, snapshot: status.inspection.snapshot,
        coverage: { files: { requested: [], omitted: [] }, diff: { requested: false, available: false, truncated: false }, tests: { requested: false, available: false, checks: [], truncated: false } },
      } : null,
      gbdev_observed: { head_before: fx.base, head_after: fx.base, commits: [], files_changed: [], outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null, checks: [], policy_violations: [] },
      paths: { final_message: paths.finalMessage, diff: paths.diff, events: paths.events, worker_log: paths.workerLog },
    };
    validateJobResult(result);
    atomicWriteJson(paths.result, result);
    await locked(store, () => transition(store, store.read(id), state));
    await locked(store, () => transition(store, store.read(id), state));
    assert.equal(store.read(id).state, state);
  }
  const outbox = readdirSync(join(fx.paths.home, 'notify', 'outbox'));
  assert.equal(outbox.length, 4);
  assert.ok(seen.length >= 1);
  for (const file of outbox) {
    const raw = readFileSync(join(fx.paths.home, 'notify', 'outbox', file), 'utf8');
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 2048);
    assert.equal(raw.includes(question), false);
    assert.equal(raw.includes(answer), false);
    assert.equal(raw.includes('super-secret-value'), false);
    assert.equal(raw.includes(fx.repo), false);
  }
  const ids = [1, 2, 3, 4].map(n => `j_20261031_1205_000${n}`);
  const snapshots = ids.map(id => ({ job: readFileSync(jobPaths(fx.paths, id).job), result: readFileSync(jobPaths(fx.paths, id).result) }));
  const unchanged = () => ids.forEach((id, i) => {
    assert.deepEqual(readFileSync(jobPaths(fx.paths, id).job), snapshots[i]!.job);
    assert.deepEqual(readFileSync(jobPaths(fx.paths, id).result), snapshots[i]!.result);
  });
  // Replay the exact terminal source sequence, not just a no-op transition.
  for (const id of ids) await locked(store, () => {
    const current = store.read(id), source = current.last_event!;
    assert.equal(notifyEvent(store, { kind: 'job', id, state: current.state }, 'state_change', { state: current.state }, source.seq, source.at, current), true);
  });
  assert.equal(pendingNotices(fx.paths.home).length, 4); unchanged();
  config.notify = { enabled: false, key_name: 'X-Key', secret_file: secret };
  writeFileSync(fx.paths.config, JSON.stringify(config));
  await locked(store, () => {
    const current = store.read(ids[0]!);
    assert.equal(notifyEvent(store, { kind: 'job', id: current.job_id, state: current.state }, 'state_change', { state: current.state }, 999, localIso(), current), false);
  });
  await deliver(store, { env: { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1' }, post: async () => assert.fail('disabled notify cannot deliver') });
  unchanged(); assert.equal(pendingNotices(fx.paths.home).length, 4);
  config.notify = { enabled: true, key_name: 'X-Key', secret_file: secret };
  writeFileSync(fx.paths.config, JSON.stringify(config));
  let sends = 0;
  await deliver(store, { env: { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1' }, post: async () => {
    sends++; return { status: 400, error: null, retry_after_ms: null };
  } });
  assert.ok(sends > 0); unchanged();
  assert.equal(pendingNotices(fx.paths.home).length, 0);
  assert.equal(readdirSync(join(fx.paths.home, 'notify', 'dead')).length, 4);

});
