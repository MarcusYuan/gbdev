import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validateEvent } from '../src/contracts/event.js';
import { validateJobStatus } from '../src/contracts/jobStatus.js';
import { isProcessAlive } from '../src/core/lock.js';
import { eventually, tmpRepo, unwrap } from './helpers/tmpRepo.js';

test('integration 1: start (stdin) detaches, wait succeeds, persisted result includes git facts, diff and checks', async t => {
  const h = tmpRepo(t);
  const started = await h.launch(true);
  assert.ok(['starting', 'running'].includes(started.state));
  assert.match(started.branch, /^gbdev\/j_/);
  assert.equal(h.git('rev-parse', 'HEAD').trim(), started.base_sha);
  const done = await h.wait(started.job_id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.state_history.map(entry => entry.state), ['queued', 'starting', 'running', 'succeeded']);
  assert.ok(done.pid);
  const result = h.result(done.job_id);
  assert.equal(result.worker_exit_code, 0);
  assert.equal(result.worker_reported?.status, 'succeeded');
  assert.notEqual(result.gbdev_observed.head_before, result.gbdev_observed.head_after);
  assert.equal(result.gbdev_observed.commits.length, 1);
  assert.deepEqual(result.gbdev_observed.files_changed, ['src/ok.txt']);
  assert.equal(result.gbdev_observed.snapshot_commit, null);
  assert.equal(result.gbdev_observed.checks[0]?.exit_code, 0);
  assert.match(readFileSync(join(h.jobDir(done.job_id), 'checks/AC1.log'), 'utf8'), /checked/);
  assert.match(readFileSync(result.paths.diff, 'utf8'), /fake ok/);
  assert.equal(h.git('branch', '--show-current').trim(), 'main');
  assert.equal(h.git('status', '--porcelain'), '');
  const events = readFileSync(result.paths.events, 'utf8').trim().split('\n').map(line => validateEvent(JSON.parse(line)));
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
  assert.ok(events.some(e => e.type === 'worker_output' && e.source === 'worker'));
  assert.ok(events.some(e => e.type === 'check'));
  assert.deepEqual(done.last_event, { seq: events.at(-1)!.seq, type: 'state_change', at: events.at(-1)!.at });
  const listed = unwrap((await h.command(['status'])).envelope);
  assert.ok(Array.isArray(listed));
  assert.deepEqual(listed.map(validateJobStatus), [done]);
  // Terminal cancellation is idempotent: no history, events or result changes.
  assert.deepEqual(unwrap((await h.command(['cancel', done.job_id])).envelope), done);
});

test('integration 2: needs_input preserves open_questions verbatim', async t => {
  const h = tmpRepo(t, 'needs_input', { acceptance_criteria: [] });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'needs_input');
  assert.deepEqual(h.result(done.job_id).worker_reported?.open_questions, [
    { id: 'Q1', question: 'Which behavior?', options: ['A', 'B'], default: 'A', blocking: true },
  ]);
  assert.deepEqual(h.result(done.job_id).gbdev_observed.checks, []);
});

test('fake blocked: worker blockers are preserved', async t => {
  const h = tmpRepo(t, 'blocked', { acceptance_criteria: [] });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'blocked');
  assert.deepEqual(h.result(done.job_id).worker_reported?.blockers, [{ kind: 'env', detail: 'Intentional fake blocker' }]);
});

for (const scenario of ['crash', 'no_json']) {
  test(`integration 3: ${scenario} fails, with null worker_reported and diagnostic event`, async t => {
    const h = tmpRepo(t, scenario);
    const done = await h.wait((await h.launch()).job_id);
    assert.equal(done.state, 'failed');
    const result = h.result(done.job_id);
    assert.equal(result.worker_reported, null);
    assert.equal(result.worker_exit_code, scenario === 'crash' ? 23 : 0);
    const reason = scenario === 'crash' ? 'worker_exit_nonzero:23' : 'worker_result_missing';
    assert.equal(done.failure_reason, reason);
    assert.equal(result.failure_reason, reason);
    assert.match(readFileSync(result.paths.events, 'utf8'), scenario === 'crash' ? /worker_crashed/ : /result_missing/);
  });
}

async function expectProcessesGone(file: string) {
  const pids = JSON.parse(readFileSync(file, 'utf8')) as { worker: number; descendant: number };
  await eventually(() => !isProcessAlive(pids.worker) && !isProcessAlive(pids.descendant) ? true : undefined);
}

test('integration 4: scaled timeout kills provider process group including descendant', async t => {
  const h = tmpRepo(t, 'slow', { timeout_min: 1 }, { GBDEV_TIMEOUT_SCALE: '1800' });
  const started = await h.launch();
  const file = join(h.jobDir(started.job_id), 'fake-processes.json');
  await eventually(() => existsSync(file) ? true : undefined);
  const done = await h.wait(started.job_id);
  assert.equal(done.state, 'timeout');
  assert.equal(h.result(done.job_id).state, 'timeout');
  assert.equal(done.failure_reason, 'timeout');
  assert.equal(h.result(done.job_id).failure_reason, 'timeout');
  await expectProcessesGone(file);
});

test('integration 5 + 6: wait_timeout leaves running job, second start is busy, cancel kills its group', async t => {
  const h = tmpRepo(t, 'slow');
  const started = await h.launch();
  const file = join(h.jobDir(started.job_id), 'fake-processes.json');
  await eventually(() => existsSync(file) ? true : undefined);
  const timed = await h.command(['wait', started.job_id, '--timeout-ms', '30']);
  assert.equal(timed.exit, 1);
  assert.equal(timed.envelope.ok, false);
  if (!timed.envelope.ok) {
    assert.equal(timed.envelope.error.code, 'wait_timeout');
    assert.equal(timed.envelope.error.retryable, true);
  }
  const busy = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(busy.exit, 1);
  assert.equal(busy.envelope.ok, false);
  if (!busy.envelope.ok) {
    assert.equal(busy.envelope.error.code, 'busy');
    assert.equal(busy.envelope.error.details.running_job_id, started.job_id);
  }
  assert.equal(h.getJob(started.job_id).state, 'running');
  const cancelled = validateJobStatus(unwrap((await h.command(['cancel', started.job_id])).envelope));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.state_history.at(-1)?.by, 'grok-bot');
  assert.equal(h.result(started.job_id).state, 'cancelled');
  await expectProcessesGone(file);
});

test('cancel: emits live worker summaries and escalates SIGTERM-resistant group to SIGKILL after ten seconds', async t => {
  const h = tmpRepo(t, 'slow', {}, { GBDEV_FAKE_IGNORE_TERM: '1', GBDEV_FAKE_OUTPUT_EVENTS: '1' });
  const started = await h.launch();
  const file = join(h.jobDir(started.job_id), 'fake-processes.json');
  await eventually(() => existsSync(file) ? true : undefined);
  await eventually(() => readFileSync(join(h.jobDir(started.job_id), 'events.jsonl'), 'utf8').includes('worker_output') ? true : undefined);
  const before = Date.now();
  const done = validateJobStatus(unwrap((await h.command(['cancel', started.job_id])).envelope));
  assert.equal(done.state, 'cancelled');
  assert.ok(Date.now() - before >= 10_000);
  await expectProcessesGone(file);
});

test('integration 7: outside_paths is mechanically observed, not taken from worker assertions', async t => {
  const h = tmpRepo(t, 'outside_paths');
  const done = await h.wait((await h.launch()).job_id);
  const result = h.result(done.job_id);
  assert.equal(done.state, 'failed');
  assert.equal(result.worker_reported?.status, 'succeeded');
  assert.deepEqual(result.worker_reported.policy_violations, []);
  assert.deepEqual(result.gbdev_observed.outside_allowed_paths, ['outside.txt']);
  assert.deepEqual(result.gbdev_observed.policy_violations, ['outside_allowed_paths']);
  assert.match(done.failure_reason!, /policy_violations: outside_allowed_paths/);
  assert.match(result.failure_reason!, /policy_violations: outside_allowed_paths/);
});

test('integration 8: readonly_violation leaves dirty changes intact and never snapshots', async t => {
  const h = tmpRepo(t, 'readonly_violation', { role: 'reviewer', sandbox: 'read-only' });
  const done = await h.wait((await h.launch()).job_id);
  const result = h.result(done.job_id);
  assert.equal(done.state, 'failed');
  assert.deepEqual(result.gbdev_observed.policy_violations, ['readonly_modified']);
  assert.deepEqual(result.gbdev_observed.files_changed, ['src/readonly.txt']);
  assert.equal(result.gbdev_observed.snapshot_commit, null);
  assert.equal(result.gbdev_observed.head_before, result.gbdev_observed.head_after);
  assert.equal(result.gbdev_observed.worktree_dirty_at_exit, true);
  assert.match(readFileSync(join(done.worktree, 'src/readonly.txt'), 'utf8'), /readonly_violation/);
});

test('integration 9: dirty_exit creates snapshot commit and records pre-snapshot dirty state', async t => {
  const h = tmpRepo(t, 'dirty_exit', { acceptance_criteria: [{ id: 'AC1', text: 'Dirty output snapshotted', check_cmd: 'test -f src/dirty.txt' }] });
  const done = await h.wait((await h.launch()).job_id);
  const result = h.result(done.job_id);
  assert.equal(done.state, 'succeeded');
  assert.equal(result.gbdev_observed.worktree_dirty_at_exit, true);
  assert.equal(result.gbdev_observed.snapshot_commit, result.gbdev_observed.head_after);
  assert.match(result.gbdev_observed.commits[0]!, new RegExp(`gbdev: snapshot ${done.job_id}`));
  assert.deepEqual(result.gbdev_observed.files_changed, ['src/dirty.txt']);
  assert.match(readFileSync(result.paths.diff, 'utf8'), /fake dirty_exit/);
  assert.equal(result.gbdev_observed.checks[0]?.exit_code, 0);
});

for (const mode of ['staged', 'committed']) {
  test(`readonly observation: ${mode} changes are detected without a snapshot`, async t => {
    const h = tmpRepo(t, 'readonly_violation', { sandbox: 'read-only' }, { GBDEV_FAKE_READONLY_MODE: mode });
    const done = await h.wait((await h.launch()).job_id);
    const observed = h.result(done.job_id).gbdev_observed;
    assert.equal(done.state, 'failed');
    assert.ok(observed.policy_violations.includes('readonly_modified'));
    assert.ok(observed.files_changed.includes('src/readonly.txt'));
    assert.equal(observed.snapshot_commit, null);
    if (mode === 'staged') {
      assert.deepEqual(observed.outside_allowed_paths, ['staged.txt']);
      assert.equal(observed.worktree_dirty_at_exit, true);
    } else {
      assert.notEqual(observed.head_before, observed.head_after);
      assert.equal(observed.worktree_dirty_at_exit, false);
    }
  });
}

test('status: missing supervisor is failed as worker_crashed and its orphaned group is terminated', async t => {
  const h = tmpRepo(t, 'slow');
  const started = await h.launch();
  const file = join(h.jobDir(started.job_id), 'fake-processes.json');
  await eventually(() => existsSync(file) ? true : undefined);
  const running = h.getJob(started.job_id);
  process.kill(running.pid!, 'SIGKILL');
  await eventually(() => !isProcessAlive(running.pid!) ? true : undefined);
  const done = validateJobStatus(unwrap((await h.command(['status', started.job_id])).envelope));
  assert.equal(done.state, 'failed');
  assert.match(readFileSync(join(h.jobDir(done.job_id), 'events.jsonl'), 'utf8'), /worker_crashed/);
  assert.equal(done.failure_reason, 'worker_crashed');
  assert.equal(h.result(done.job_id).failure_reason, done.failure_reason);
  await expectProcessesGone(file);
});

test('concurrent starts: exactly one acquires concurrency slot', async t => {
  const h = tmpRepo(t, 'slow');
  const outputs = await Promise.all([h.command(['start', '--brief', h.briefFile]), h.command(['start', '--brief', h.briefFile])]);
  assert.equal(outputs.filter(o => o.envelope.ok).length, 1);
  const success = outputs.find(o => o.envelope.ok)!;
  const started = validateJobStatus(unwrap(success.envelope));
  const failed = outputs.find(o => !o.envelope.ok)!.envelope;
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, 'busy');
  const cancelled = validateJobStatus(unwrap((await h.command(['cancel', started.job_id])).envelope));
  assert.equal(cancelled.state, 'cancelled');
});

test('finalization: cancellation interrupts acceptance check group and criterion IDs cannot traverse paths', async t => {
  const check = `node -e 'require("node:fs").writeFileSync("check-started", "yes"); setInterval(() => {}, 1000)'`;
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [{ id: '../../escaped', text: 'Slow check', check_cmd: check }] });
  const started = await h.launch();
  await eventually(() => existsSync(join(started.worktree, 'check-started')) ? true : undefined);
  const done = validateJobStatus(unwrap((await h.command(['cancel', started.job_id])).envelope));
  assert.equal(done.state, 'cancelled');
  assert.equal(h.result(done.job_id).gbdev_observed.checks[0]?.log, 'checks/criterion-0.log');
  assert.equal(existsSync(join(h.home, 'escaped.log')), false);
});

test('start: missing base_ref fails without an active job', async t => {
  const h = tmpRepo(t, 'ok', { base_ref: 'missing-ref' });
  const output = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(output.exit, 1);
  if (!output.envelope.ok) assert.equal(output.envelope.error.code, 'worktree_failed');
  writeFileSync(h.briefFile, JSON.stringify({ ...h.task, base_ref: 'HEAD' }));
  assert.equal((await h.wait((await h.launch()).job_id)).state, 'succeeded');
});
