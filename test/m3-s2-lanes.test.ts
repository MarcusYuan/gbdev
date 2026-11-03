import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LaneManager } from '../src/run/lanes.js';
import { openIntegration } from '../src/run/integration.js';
import { git, head, mergeNoFf, worktreeListPorcelain } from '../src/core/git.js';
import { chooseLane } from '../src/run/scheduler.js';
import { runFixture } from './helpers/run.js';
import { errorCode } from './helpers.js';
test('AC-S2.2 three real git lanes each run two tasks from then-current verified_sha; park preserves branches and cache', async t => {
  const f = runFixture(t), options = { ...f, worktree_setup_cmd: 'mkdir -p cache; echo setup >> cache/setup' };
  const integration = await openIntegration(options, f.base), manager = new LaneManager(options);
  const lanes = await Promise.all([1, 2, 3].map(n => manager.create(n, f.base)));
  let verified = f.base;
  for (let round = 1; round <= 2; round++) for (const lane of lanes) {
    const task = `task-${lane.lane}-${round}`, started = manager.start(lane, task, verified);
    assert.equal(started.base_sha, verified); assert.equal(head(lane.worktree), verified);
    writeFileSync(join(lane.worktree, 'src', `${task}.txt`), task);
    const tip = f.commit(lane.worktree, task), parked = manager.park(lane, verified);
    assert.equal(parked.head_sha, tip); assert.equal(git(f.repo, ['rev-parse', started.branch]).trim(), tip);
    assert.equal(head(lane.worktree), verified); assert.equal(git(lane.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'HEAD');
    // Fixture advances verified integration without implementing a merge queue or gate.
    verified = mergeNoFf({ ...f, branch: integration.branch, worktree: integration.worktree }, tip, `fixture: ${task}`);
    assert.equal(readFileSync(join(lane.worktree, 'cache/setup'), 'utf8'), 'setup\n');
  }
  assert.deepEqual(lanes.map(l => [l.state, l.tasks_done]), [['idle', 2], ['idle', 2], ['idle', 2]]);
  assert.equal(head(f.repo), f.base); assert.equal(worktreeListPorcelain(f.repo).length, 5);
});
test('AC-S2.3 dirty idle lane is broken and never selected or started; evidence retained', async t => {
  const f = runFixture(t), manager = new LaneManager(f), lane = await manager.create(1, f.base);
  writeFileSync(join(lane.worktree, 'untracked'), 'evidence');
  assert.deepEqual(manager.available(), []); assert.equal(lane.state, 'broken');
  assert.equal(chooseLane({ id: 'a', state: 'ready', depends_on: [], file_scope: ['src/**'], provider: 'fake', lane: null }, [], manager.lanes), undefined);
  assert.throws(() => manager.start(lane, 'a', f.base), errorCode('run_state_conflict'));
  assert.equal(readFileSync(join(lane.worktree, 'untracked'), 'utf8'), 'evidence');
  assert.throws(() => git(f.repo, ['show-ref', '--verify', `refs/heads/gbdev/${f.run_id}/t/a`]));
});
test('dirty busy lane cannot park or discard tracked changes', async t => {
  const f = runFixture(t), manager = new LaneManager(f), lane = await manager.create(1, f.base); manager.start(lane, 'a', f.base);
  writeFileSync(join(lane.worktree, 'src/base.txt'), 'dirty');
  assert.throws(() => manager.park(lane, f.base), /lane_broken/); assert.equal(lane.state, 'broken'); assert.equal(readFileSync(join(lane.worktree, 'src/base.txt'), 'utf8'), 'dirty');
});
for (const problem of ['missing', 'unexpected-head', 'unexpected-branch'] as const) test(`lane health: ${problem} becomes broken`, async t => {
  const f = runFixture(t), manager = new LaneManager(f), lane = await manager.create(1, f.base);
  if (problem === 'missing') rmSync(lane.worktree, { recursive: true });
  else if (problem === 'unexpected-head') f.commit(lane.worktree, 'unrecorded detached commit');
  else git(lane.worktree, ['switch', '-c', 'foreign']);
  assert.deepEqual(manager.available(), []); assert.equal(lane.state, 'broken');
});
for (const cmd of ['echo setup-failed; exit 9', 'echo setup-timeout; sleep 10']) test(`lane setup failure is broken and logged: ${cmd}`, async t => {
  const f = runFixture(t), manager = new LaneManager({ ...f, worktree_setup_cmd: cmd, setup_timeout_ms: 50 });
  await assert.rejects(manager.create(1, f.base), /worktree_setup_failed/);
  assert.equal(manager.lanes[0]!.state, 'broken'); assert.ok(existsSync(manager.lanes[0]!.worktree));
  assert.match(readFileSync(join(f.paths.home, 'runs', f.run_id, 'setup-lane-1.log'), 'utf8'), /setup-/);
});
test('integration create/open runs setup once; dirty or wrong HEAD is never silently repaired', async t => {
  const f = runFixture(t), options = { ...f, worktree_setup_cmd: 'mkdir -p cache; echo once >> cache/setup' };
  const integration = await openIntegration(options, f.base);
  assert.deepEqual(await openIntegration(options, f.base), integration);
  assert.equal(readFileSync(join(integration.worktree, 'cache/setup'), 'utf8'), 'once\n');
  writeFileSync(join(integration.worktree, 'dirty'), 'evidence'); await assert.rejects(openIntegration(options, f.base), /integration_corrupt/);
  rmSync(join(integration.worktree, 'dirty')); f.commit(integration.worktree, 'unexpected'); await assert.rejects(openIntegration(options, f.base), /integration_corrupt/);
});
test('task rebuild names preserve previous branch; duplicate branch failure breaks lane', async t => {
  const f = runFixture(t), manager = new LaneManager(f), lane = await manager.create(1, f.base);
  const old = manager.start(lane, 'a', f.base); manager.park(lane, f.base);
  const rebuilt = manager.start(lane, 'a', f.base, 2); assert.match(rebuilt.branch, /\/a-r2$/); manager.park(lane, f.base);
  assert.equal(git(f.repo, ['rev-parse', old.branch]).trim(), f.base);
  assert.throws(() => manager.start(lane, 'a', f.base), /lane_broken/); assert.equal(lane.state, 'broken');
});
test('integration setup failure preserves worktree and log', async t => {
  const f = runFixture(t);
  await assert.rejects(openIntegration({ ...f, worktree_setup_cmd: 'echo failed; exit 1' }, f.base), /worktree_setup_failed/);
  assert.match(readFileSync(join(f.paths.home, 'runs', f.run_id, 'setup-integration.log'), 'utf8'), /failed/);
  assert.equal(worktreeListPorcelain(f.repo).length, 2);
});
test('F9 integration setup retries after failure and becomes open only after success', async t => {
  const f = runFixture(t), options = { ...f, worktree_setup_cmd: 'mkdir -p cache; echo attempt >> cache/attempts; test -f cache/retry || { touch cache/retry; exit 1; }' };
  await assert.rejects(openIntegration(options, f.base), /worktree_setup_failed/);
  const integration = await openIntegration(options, f.base);
  assert.equal(readFileSync(join(integration.worktree, 'cache/attempts'), 'utf8'), 'attempt\nattempt\n');
  await openIntegration(options, f.base);
  assert.equal(readFileSync(join(integration.worktree, 'cache/attempts'), 'utf8'), 'attempt\nattempt\n');
});
test('F10 reconstructed LaneManager inspects persisted parked detached lane', async t => {
  const f = runFixture(t), manager = new LaneManager(f), lane = await manager.create(1, f.base);
  manager.start(lane, 'a', f.base); manager.park(lane, f.base);
  const persisted = JSON.parse(JSON.stringify(manager.lanes));
  const reconstructed = new LaneManager(f, persisted);
  assert.equal(reconstructed.inspect(reconstructed.lanes[0]!), true); assert.equal(reconstructed.available().length, 1);
});
for (const bad of ['main', 'abcdef0', 'a'.repeat(39), 'a'.repeat(41)]) test(`F12 integration rejects non-full SHA ${bad}`, async t => {
  const f = runFixture(t);
  await assert.rejects(openIntegration(f, bad), errorCode('guard_violation'));
  assert.equal(worktreeListPorcelain(f.repo).length, 1);
});
