import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { isProcessAlive } from '../src/core/lock.js';
import { cli, deadPid, id, inventory, inventoryFixture, snapshot } from './helpers/m9-b3.js';

for (const kind of ['run', 'pipeline', 'job'] as const) {
  const args = kind === 'job' ? ['list'] : [kind, 'list'];
  test(`O5 ${kind}: readonly snapshots, filters, summaries, stale, corrupt JSON and text`, async t => {
    const f = inventoryFixture(t);
    f.run(1); f.pipeline(1); f.job(1);
    f[kind](2, 'succeeded');
    if (kind !== 'job') f[kind](3, 'needs_decision');
    else f.job(3, 'queued');
    assert.equal(isProcessAlive(deadPid), false);
    const folder = kind === 'job' ? 'jobs' : `${kind}s`, file = kind === 'job' ? 'job.json' : kind === 'run' ? 'run.json' : 'pipeline.json';
    const prefix = kind === 'job' ? 'j' : kind === 'run' ? 'r' : 'p';
    const badDir = join(f.home, folder, id(prefix, 4)); mkdirSync(badDir); writeFileSync(join(badDir, file), '{');
    f.save(`${folder}/${id(prefix, 5)}/${file}`, { invalid: true });
    // A held lock proves list never attempts a mutating lock acquisition.
    writeFileSync(join(f.home, 'lock'), `${process.pid}\n`);
    const before = snapshot(f.home);
    const output = await inventory(args);
    assert.equal(output.schema, kind === 'pipeline' ? 'gbdev.pipeline-runs.v1' : `gbdev.${kind}-list.v1`);
    assert.equal(output.result.total, 3); assert.equal(output.result.skipped, 2); assert.equal(output.result.shown, 3);
    const item = output.result.items.find(e => e.id === id(prefix, 1))!;
    assert.equal(item.state, 'running'); assert.equal(item.stale, true);
    for (const key of ['state_reason', 'created_at', 'updated_at', 'deadline_at', 'attention_count', 'decision_count']) assert.ok(key in item);
    const fields = kind === 'run' ? ['lanes', 'tasks'] : kind === 'pipeline' ? ['run_id', 'task_id', 'template', 'current_step'] : ['role', 'provider', 'pipeline_id', 'run_id', 'task_id', 'superseded_by'];
    for (const key of fields) assert.ok(key in item);
    assert.equal((await inventory([...args, '--active'])).result.shown, 2);
    assert.equal((await inventory([...args, '--state', 'running,succeeded', '--state', 'queued'])).result.shown, kind === 'job' ? 3 : 2);
    assert.equal((await inventory([...args, '--active', '--state', 'succeeded'])).result.shown, 0);
    assert.equal((await inventory([...args, '--limit', '1'])).result.shown, 1);
    const text = await cli(args); assert.equal(text.code, 0);
    assert.equal(text.stdout.split('\n').filter(l => l.startsWith(`${prefix}_`)).length, 3);
    assert.match(text.stdout, /pid gone, .*status .*to reconcile/); assert.match(text.stdout, /--active/);
    assert.deepEqual(snapshot(f.home), before);
  });
  test(`O5 ${kind}: empty and nonexistent home never creates directories`, async t => {
    const f = inventoryFixture(t), before = snapshot(f.root);
    assert.equal((await inventory(args)).result.total, 0); assert.deepEqual(snapshot(f.root), before);
    process.env.GBDEV_HOME = join(f.root, 'absent');
    assert.equal((await inventory(args)).result.shown, 0); assert.equal(existsSync(process.env.GBDEV_HOME), false);
  });
  test(`O5 ${kind}: state/limit/option errors are usage_error`, async t => {
    const f = inventoryFixture(t), before = snapshot(f.root);
    for (const extra of [['--state', 'bad'], ['--state', 'running,'], ['--state', kind === 'job' ? 'planning' : 'timeout'], ['--limit', '0'], ['--limit', '501'], ['--limit', '-1'], ['--limit', '1.5'], ['--limit', '1e2'], ['--limit', ''], ['extra'], ['--request', 'x'], ['--all-homes']]) {
      const output = await cli([...args, ...extra, '--json']); assert.equal(output.code, 2, output.stdout);
      assert.equal(JSON.parse(output.stdout).error.code, 'usage_error');
    }
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('O5 pipeline --standalone and safe aligned single-line text', async t => {
  const f = inventoryFixture(t); const p = f.pipeline(1), owned = f.pipeline(2);
  owned.workspace = { ...owned.workspace, mode: 'per_lane', run_id: id('r', 1), task_id: 'task', lane: 'lane-1' };
  owned.integration = { run_id: id('r', 1), task_id: 'task', integration_branch: 'test', merge_state: 'pending', merged_sha: null, target_branch: null, approved_by_user_at: null };
  p.state_reason = '\u001b[31mred\nnewline\t' + 'x'.repeat(200);
  f.save(`pipelines/${p.pipeline_id}/pipeline.json`, p); f.save(`pipelines/${owned.pipeline_id}/pipeline.json`, owned);
  const output = await inventory(['pipeline', 'list', '--standalone']); assert.equal(output.result.shown, 1); assert.equal(output.result.items[0]?.id, p.pipeline_id);
  assert.equal(output.result.items[0]?.state_reason?.length, 160);
  const text = (await cli(['pipeline', 'list'])).stdout;
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f]/);
  const rows = text.split('\n').filter(l => l.startsWith('p_')); assert.equal(rows.length, 2);
  assert.equal(rows[0]?.indexOf('running'), rows[1]?.indexOf('running'));
});

test('O5 default limit 20, upper bound 500 and filtering before truncation', async t => {
  const f = inventoryFixture(t);
  for (let n = 1; n <= 25; n++) f.job(n, n === 1 ? 'running' : 'succeeded');
  assert.equal((await inventory(['list'])).result.shown, 20);
  assert.equal((await inventory(['list', '--limit', '500'])).result.shown, 25);
  assert.equal((await inventory(['list', '--state', 'running', '--limit', '1'])).result.items[0]?.id, id('j', 1));
  const invalid = await cli(['status', '--active', '--json']); assert.equal(invalid.code, 2);
});

test('O5 worker PID gone is a derived hint, not a rewrite', async t => {
  const f = inventoryFixture(t), j = f.job(1); j.pid = process.pid; f.store.write(j);
  f.save(`jobs/${j.job_id}/process.json`, { supervisor_pid: process.pid, worker_pid: deadPid });
  const before = snapshot(f.home);
  assert.equal((await inventory(['list'])).result.items[0]?.stale, true);
  assert.deepEqual(snapshot(f.home), before);
  assert.equal(JSON.parse(readFileSync(join(f.home, 'jobs', j.job_id, 'job.json'), 'utf8')).state, 'running');
});

for (const withId of [false, true]) test(`O5 list preserves the whole home while status ${withId ? 'with' : 'without'} id reconciles the same dead job`, async t => {
  const f = inventoryFixture(t), j = f.job(1);
  assert.equal(isProcessAlive(j.pid!), false);
  const before = snapshot(f.home);
  const listed = await inventory(['list']);
  assert.equal(listed.result.items[0]?.state, 'running');
  assert.equal(listed.result.items[0]?.stale, true);
  assert.deepEqual(snapshot(f.home), before);

  const output = await cli(['status', ...(withId ? [j.job_id] : []), '--json']);
  assert.equal(output.code, 0, output.stdout + output.stderr);
  const result = JSON.parse(output.stdout).result;
  assert.equal((withId ? result : result[0]).state, 'failed');
  assert.equal(f.store.read(j.job_id).state, 'failed');
  const after = snapshot(f.home), jobFile = join(f.home, 'jobs', j.job_id, 'job.json');
  assert.notDeepEqual(after, before);
  assert.notEqual(after[jobFile]?.body, before[jobFile]?.body);
});

test('O5 help distinguishes readonly inventory from reconcile and advertises all list variants', async t => {
  inventoryFixture(t);
  const out = await cli(['--help']);
  for (const command of ['run list', 'pipeline list', 'list [--active]']) assert.ok(out.stdout.includes(command));
  assert.match(out.stdout, /--standalone/);
  for (const prefix of ['', 'run ', 'pipeline ']) {
    const line = out.stdout.split('\n').find(line => line.startsWith(`${prefix}status [`));
    assert.ok(line); assert.ok(line.includes(`reconciles; read-only inventory: ${prefix}list`));
  }
  for (const kind of ['run', 'pipeline']) {
    const usage = await cli([kind, 'status', 'extra', 'extra', '--json']);
    assert.equal(usage.code, 2);
    assert.ok(JSON.parse(usage.stdout).error.message.includes(`reconciles; read-only inventory: ${kind} list`));
  }
});

test('O5 built CLI startup remains readonly for every list command', t => {
  const f = inventoryFixture(t); f.run(1); f.pipeline(1); f.job(1);
  const before = snapshot(f.home);
  for (const args of [['run', 'list'], ['pipeline', 'list'], ['list']]) {
    const output = execFileSync(process.execPath, ['dist/cli.js', ...args, '--json'], { encoding: 'utf8', env: { ...process.env } });
    const envelope = JSON.parse(output); assert.equal(envelope.ok, true); assert.equal(envelope.result.items[0].stale, true);
  }
  assert.deepEqual(snapshot(f.home), before);
});
