import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validatePipelineRun } from '../src/contracts/pipelineRun.js';
import { readSupersededBy, supersededBy } from '../src/core/superseded.js';
import { cli, id, inventory, inventoryFixture, snapshot } from './helpers/m9-b3.js';

test('O6 later attempt wins over completed parent; list and status text hide without rewriting facts', async t => {
  const f = inventoryFixture(t), p = f.pipeline(1, 'succeeded'), old = f.job(1, 'needs_input'), latest = f.job(2, 'succeeded');
  old.pipeline_id = p.pipeline_id; old.step_instance = p.steps[0]!.instance; old.attempt = 1; f.store.write(old);
  latest.pipeline_id = p.pipeline_id; latest.step_instance = old.step_instance; latest.attempt = 2; f.store.write(latest);
  p.steps[0]!.attempts = [{ attempt: 1, job_id: old.job_id, job_state: old.state, failure_reason: null }, { attempt: 2, job_id: latest.job_id, job_state: latest.state, failure_reason: null }];
  f.save(`pipelines/${p.pipeline_id}/pipeline.json`, p);
  const before = snapshot(f.home), oldFile = join(f.home, 'jobs', old.job_id, 'job.json'), bytes = readFileSync(oldFile);
  const hidden = await inventory(['list']); assert.equal(hidden.result.hidden_superseded, 1); assert.equal(hidden.result.total, 2);
  assert.deepEqual(hidden.result.items.map(e => e.id), [latest.job_id]);
  const all = await inventory(['list', '--all']); assert.equal(all.result.hidden_superseded, 0);
  assert.equal(all.result.items.find(e => e.id === old.job_id)?.superseded_by, latest.job_id);
  assert.equal(all.result.items.find(e => e.id === latest.job_id)?.superseded_by, null);
  assert.match((await cli(['list'])).stdout, /1 个已被接管的 job 已隐藏，--all 显示/);
  assert.match((await cli(['list', '--all'])).stdout, new RegExp(`superseded by ${latest.job_id}`));
  assert.deepEqual(snapshot(f.home), before);
  const status = await cli(['status']); assert.equal(status.code, 0); assert.ok(!status.stdout.includes(old.job_id)); assert.match(status.stdout, /1 个已被接管/);
  assert.match((await cli(['status', '--all'])).stdout, new RegExp(`superseded by ${latest.job_id}`));
  const json = JSON.parse((await cli(['status', '--json'])).stdout);
  assert.equal(json.result_schema, 'gbdev.job-status.v1'); assert.equal(json.result.length, 2);
  assert.ok(json.result.every((j: object) => !('superseded_by' in j)));
  const single = JSON.parse((await cli(['status', old.job_id, '--json'])).stdout); assert.equal(single.result.job_id, old.job_id);
  assert.deepEqual(readFileSync(oldFile), bytes);
});

test('O6 status --all accepts only the text list; JSON inventory uses list', async t => {
  const f = inventoryFixture(t), j = f.job(1, 'succeeded');
  const text = await cli(['status', '--all']);
  assert.equal(text.code, 0); assert.match(text.stdout, new RegExp(j.job_id));
  for (const args of [['status', '--all', '--json'], ['status', '--json', '--all'], ['status', j.job_id, '--all', '--json']]) {
    const output = await cli(args); assert.equal(output.code, 2);
    const error = JSON.parse(output.stdout).error;
    assert.equal(error.code, 'usage_error');
    assert.match(error.message, /--all requires dashboard, list or status text list/);
    assert.match(error.message, /without id or --json/);
  }
  const single = await cli(['status', j.job_id, '--all']);
  assert.equal(single.code, 2); assert.match(single.stderr, /--all requires dashboard, list or status text list/);
  const all = await cli(['list', '--all', '--json']);
  assert.equal(all.code, 0); assert.equal(JSON.parse(all.stdout).result.items[0].id, j.job_id);
});

test('O6 active parent with no newer attempt, other instance, missing and corrupt parent stay visible', async t => {
  const f = inventoryFixture(t), p = f.pipeline(1), j = f.job(1, 'needs_input');
  j.pipeline_id = p.pipeline_id; j.step_instance = p.steps[0]!.instance; j.attempt = 1; f.store.write(j);
  const attempt = { attempt: 1, job_id: j.job_id, job_state: j.state, failure_reason: null };
  p.steps[0]!.attempts = [attempt]; p.steps[1]!.attempts = [{ ...attempt, attempt: 2, job_id: id('j', 2) }];
  f.save(`pipelines/${p.pipeline_id}/pipeline.json`, p);
  assert.equal(readSupersededBy(f.store, j), null); assert.equal((await inventory(['list'])).result.shown, 1);
  f.save(`pipelines/${p.pipeline_id}/pipeline.json`, { broken: true }); assert.equal(readSupersededBy(f.store, j), null);
  rmSync(join(f.home, 'pipelines', p.pipeline_id, 'pipeline.json')); assert.equal(readSupersededBy(f.store, j), null);
  assert.equal((await inventory(['list'])).result.items[0]?.superseded_by, null);
});

test('O6 pure projection handles attempt order, higher number, parent terminal states and successful exclusions', t => {
  const f = inventoryFixture(t), p = f.pipeline(1), r = f.run(1, 'succeeded'), j = f.job(1, 'needs_input');
  j.pipeline_id = p.pipeline_id; j.step_instance = p.steps[0]!.instance; j.attempt = 2;
  const old = { attempt: 2, job_id: j.job_id, job_state: j.state, failure_reason: null };
  p.steps[0]!.attempts = [{ ...old, attempt: 3, job_id: id('j', 3) }, old];
  assert.equal(supersededBy(j, p, null), id('j', 3));
  p.steps[0]!.attempts = [old, { ...old, job_id: id('j', 2) }]; assert.equal(supersededBy(j, p, null), id('j', 2));
  p.steps[0]!.attempts = [];
  for (const state of ['succeeded', 'failed', 'cancelled'] as const) { p.state = state; assert.equal(supersededBy(j, p, null), `pipeline ${p.pipeline_id} (${state})`); }
  p.state = 'running'; j.run_id = r.run_id;
  for (const state of ['needs_input', 'blocked', 'failed', 'timeout', 'cancelled'] as const) { j.state = state; assert.equal(supersededBy(j, p, r), `run ${r.run_id} (succeeded)`); }
  for (const state of ['queued', 'starting', 'running', 'succeeded', 'reviewed', 'integrated', 'discarded'] as const) { j.state = state; assert.equal(supersededBy(j, p, r), null); }
  j.state = 'needs_input'; delete j.run_id;
  p.workspace = { ...p.workspace, mode: 'per_lane', run_id: r.run_id, task_id: 'task', lane: 'lane-1' };
  assert.equal(supersededBy(j, p, r), `run ${r.run_id} (succeeded)`);
  r.state = 'needs_decision'; assert.equal(supersededBy(j, p, r), null);
});

test('O6 parent run fallback uses tolerant reads and never hides standalone jobs without ownership', t => {
  const f = inventoryFixture(t), r = f.run(1, 'succeeded'), j = f.job(1, 'needs_input');
  assert.equal(readSupersededBy(f.store, j), null); j.run_id = r.run_id;
  assert.equal(readSupersededBy(f.store, j), `run ${r.run_id} (succeeded)`);
  f.save(`runs/${r.run_id}/run.json`, {}); assert.equal(readSupersededBy(f.store, j), null);
});

test('O6 corrupt attempt entries skip newer attempts but retain terminal pipeline/run evidence', async t => {
  const f = inventoryFixture(t), p = f.pipeline(1), r = f.run(1), j = f.job(1, 'needs_input');
  j.pipeline_id = p.pipeline_id; j.step_instance = p.steps[0]!.instance; j.attempt = 1; f.store.write(j);
  p.workspace = { ...p.workspace, mode: 'per_lane', run_id: r.run_id, task_id: 'task', lane: 'lane-1' };
  p.integration = { run_id: r.run_id, task_id: 'task', integration_branch: 'test', merge_state: 'pending', merged_sha: null, target_branch: null, approved_by_user_at: null };
  validatePipelineRun(p);
  const old = { attempt: 1, job_id: j.job_id, job_state: j.state, failure_reason: null };
  const newer = { ...old, attempt: 2, job_id: id('j', 2) };
  for (const corrupt of [null, { ...newer, attempt: 0 }, { ...newer, job_id: 'invalid' }]) {
    // Persist malformed JSON entries to exercise tolerant parent reads, not only the pure helper.
    p.steps[0]!.attempts = JSON.parse(JSON.stringify([old, newer, corrupt]));
    p.state = 'running'; r.state = 'running';
    f.save(`pipelines/${p.pipeline_id}/pipeline.json`, p); f.save(`runs/${r.run_id}/run.json`, r);
    assert.equal(readSupersededBy(f.store, j), null, 'corrupt attempts cannot prove later ownership');
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      p.state = state; f.save(`pipelines/${p.pipeline_id}/pipeline.json`, p);
      assert.equal(readSupersededBy(f.store, j), `pipeline ${p.pipeline_id} (${state})`);
    }
    p.state = 'running'; f.save(`pipelines/${p.pipeline_id}/pipeline.json`, p);
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      r.state = state; f.save(`runs/${r.run_id}/run.json`, r);
      assert.equal(readSupersededBy(f.store, j), `run ${r.run_id} (${state})`);
    }
    const before = snapshot(f.home);
    assert.equal((await inventory(['list'])).result.hidden_superseded, 1);
    assert.equal((await inventory(['list', '--all'])).result.items[0]?.superseded_by, `run ${r.run_id} (cancelled)`);
    assert.deepEqual(snapshot(f.home), before);
  }
});
