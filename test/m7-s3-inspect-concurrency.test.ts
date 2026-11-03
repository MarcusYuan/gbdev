import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { GbdevError } from '../src/contracts/error.js';
import { assertIdle } from '../src/commands/pipeline.js';
import { JobStore } from '../src/core/jobStore.js';
import { inspectLeasePath } from '../src/core/paths.js';
import { locked } from '../src/core/runtime.js';
import { localIso } from '../src/core/time.js';
import { acquireInspectAdmission, releaseInspectReservation } from '../src/core/workerReservations.js';
import { acquireSlot } from '../src/run/scheduler.js';
import { DEFAULT_PARALLEL } from '../src/core/runConfig.js';
import { runJobs } from '../src/run/invariants.js';
import type { Run } from '../src/contracts/run.js';
import { isTerminal } from '../src/contracts/jobStatus.js';
import { job } from './helpers.js';
import { eventually, tmpRepo } from './helpers/tmpRepo.js';
import { runFixture } from './helpers/run.js';

function lease(store: JobStore, jobId: string, pid: number | null, startedAt: string): void {
  mkdirSync(join(store.paths.home, 'inspect'), { recursive: true });
  writeFileSync(inspectLeasePath(store.paths), JSON.stringify({
    job_id: jobId, provider: 'fake', supervisor_pid: pid, worker_pgid: null, started_at: startedAt,
  }));
}

test('one live inspect lease, dead reclaim, and capacity do not change ordinary scheduling', async t => {
  const fx = runFixture(t);
  const store = new JobStore(fx.paths);
  const occupant = job('j_20261031_1204_aaa1');
  occupant.repo = fx.repo;
  occupant.base_sha = fx.base;
  occupant.state = 'running';
  occupant.state_history.push({ state: 'running', at: occupant.updated_at, by: 'test' });
  occupant.provider = 'fake';
  store.create(occupant);
  writeFileSync(fx.paths.config, JSON.stringify({ version: 1, allowed_repos: [fx.repo], parallel: { max_workers: 1, provider_limits: { codex: 1, cursor: 1, fake: 1 } } }));
  await assert.rejects(() => locked(store, () => acquireInspectAdmission(store, 'fake', 'j_20261031_1204_aaa2')), (error: GbdevError) => error.contract.code === 'busy' && error.contract.details.reason === 'provider_capacity');
  assert.equal(existsSync(inspectLeasePath(store.paths)), false);
  assert.equal(existsSync(join(fx.paths.home, 'jobs', 'j_20261031_1204_aaa2')), false);
  occupant.state = 'succeeded';
  occupant.state_history.push({ state: 'succeeded', at: occupant.updated_at, by: 'test' });
  store.write(occupant);
  lease(store, 'j_20261031_1204_dead', 2147483646, '2020-01-01T00:00:00.000Z');
  await locked(store, () => acquireInspectAdmission(store, 'fake', 'j_20261031_1204_aaa3'));
  const held = JSON.parse(readLease(store)) as { job_id: string };
  assert.equal(held.job_id, 'j_20261031_1204_aaa3');
  releaseInspectReservation(store, 'j_20261031_1204_aaa3');
  releaseInspectReservation(store, 'j_20261031_1204_aaa3');
  assert.equal(existsSync(inspectLeasePath(store.paths)), false);
  lease(store, 'j_20261031_1204_live', process.pid, new Date().toISOString());
  await assert.rejects(() => locked(store, () => acquireInspectAdmission(store, 'fake', 'j_20261031_1204_aaa4')), (error: GbdevError) => error.contract.code === 'busy' && error.contract.details.running_job_id === 'j_20261031_1204_live');
  const inspect = job('j_20261031_1204_aaa5');
  inspect.kind = 'inspect';
  inspect.repo = fx.repo;
  inspect.base_sha = fx.base;
  inspect.state = 'running';
  inspect.state_history.push({ state: 'running', at: inspect.updated_at, by: 'test' });
  inspect.branch = 'gbdev/r_20261031_1204_abcd/integration';
  inspect.role = 'inspector';
  inspect.sandbox = 'read-only';
  inspect.inspection = {
    workspace_owned: true, detached: true, question: 'q', paths: [], diff: false, tests: false,
    target: { kind: 'job', id: occupant.job_id, run_id: null, task_id: null, job_id: occupant.job_id, pipeline_id: null },
    snapshot: { mode: 'committed', target_sha: fx.base, diff_base_sha: fx.base, captured_at: localIso(), uncommitted_included: false },
  };
  store.create(inspect);
  assertIdle(store);
  const run = { run_id: 'r_20261031_1204_abcd', tasks: [], integration: { branch: inspect.branch } } as unknown as Run;
  assert.equal(runJobs(store, run).some(item => item.job_id === inspect.job_id), false);
});

function readLease(store: JobStore): string {
  return readFileSync(inspectLeasePath(store.paths), 'utf8');
}

test('a running inspect does not block start and a second inspect is busy', async t => {
  const fx = tmpRepo(t, 'ok');
  mkdirSync(join(fx.root, 'roles'), { recursive: true });
  writeFileSync(join(fx.root, 'roles', 'inspector.json'), JSON.stringify({ schema: 'gbdev.role.v1', name: 'inspector', provider: 'fake' }));
  const parent = await fx.launch();
  await fx.wait(parent.job_id);
  fx.env.GBDEV_FAKE_SCENARIO = 'slow';
  const first = await fx.command(['inspect', parent.job_id, '--question', 'Hold the lease']);
  assert.equal(first.envelope.ok, true);
  if (!first.envelope.ok) return;
  const inspectId = (first.envelope.result as { job_id: string }).job_id;
  t.after(async () => { try { if (!isTerminal(fx.getJob(inspectId).state)) await fx.command(['cancel', inspectId]); } catch { /* gone */ } });
  await eventually(() => fx.getJob(inspectId).state === 'running' ? true : undefined);
  const started = await fx.command(['start', '--brief', fx.briefFile]);
  assert.equal(started.envelope.ok, true);
  const second = await fx.command(['inspect', parent.job_id, '--question', 'Second inspect']);
  assert.equal(second.envelope.ok, false);
  if (!second.envelope.ok) {
    assert.equal(second.envelope.error.code, 'busy');
    assert.equal(second.envelope.error.details.running_job_id, inspectId);
  }
  const jobs = readdirSync(join(fx.home, 'jobs'));
  assert.equal(jobs.filter(name => name !== parent.job_id && name !== inspectId && !(started.envelope.ok && name === (started.envelope.result as { job_id: string }).job_id)).length, 0);
});


test('run acquireSlot counts inspect total/provider capacity under the admission lock', async t => {
  const fx = runFixture(t), store = new JobStore(fx.paths);
  const slots: Run['slots'] = { max_workers: 3, in_use: 0, by_provider: { fake: 0, codex: 0, cursor: 0 }, cooldown_until: {} };
  const config = { ...DEFAULT_PARALLEL, max_workers: 1, provider_limits: { fake: 1, codex: 1, cursor: 1 } };
  const before = JSON.stringify(slots);
  lease(store, 'j_20261031_1204_beef', process.pid, '2020-01-01T00:00:00.000Z');
  await locked(store, () => {
    assert.equal(acquireSlot(slots, config, 'fake', Date.now(), store), null);
    assert.equal(acquireSlot(slots, config, 'codex', Date.now(), store), null);
    assert.equal(acquireSlot(slots, { ...config, max_workers: 3 }, 'fake', Date.now(), store), null);
    assert.equal(acquireSlot(slots, { ...config, max_workers: 3 }, 'codex', Date.now(), store)?.in_use, 1);
  });
  assert.equal(JSON.stringify(slots), before);
  // Even a recently written lease with a known dead supervisor is not a startup reservation.
  lease(store, 'j_20261031_1204_beef', 2147483646, new Date().toISOString());
  await locked(store, () => {
    assert.deepEqual(acquireSlot(slots, config, 'fake', Date.now(), store), acquireSlot(slots, config, 'fake', Date.now()));
    assert.equal(existsSync(inspectLeasePath(store.paths)), false);
  });
});

for (const max of [1, 3]) test(`start refuses active inspect at ${max === 1 ? 'total' : 'provider'} capacity and resumes after release`, async t => {
  const fx = tmpRepo(t, 'ok');
  mkdirSync(join(fx.root, 'roles'), { recursive: true });
  writeFileSync(join(fx.root, 'roles', 'inspector.json'), JSON.stringify({ schema: 'gbdev.role.v1', name: 'inspector', provider: 'fake' }));
  const parent = await fx.launch(); await fx.wait(parent.job_id);
  writeFileSync(fx.config, JSON.stringify({ version: 1, allowed_repos: [fx.repo], parallel: { max_workers: max, provider_limits: { fake: 1, codex: 1, cursor: 1 } } }));
  fx.env.GBDEV_FAKE_SCENARIO = 'inspect_hold';
  const first = await fx.command(['inspect', parent.job_id, '--question', 'Hold capacity']);
  assert.equal(first.envelope.ok, true); if (!first.envelope.ok) return;
  const id = (first.envelope.result as { job_id: string }).job_id;
  await eventually(() => fx.getJob(id).state === 'running' ? true : undefined);
  const before = readdirSync(join(fx.home, 'jobs'));
  const denied = await fx.command(['start', '--brief', fx.briefFile]);
  assert.equal(denied.envelope.ok, false);
  if (!denied.envelope.ok) { assert.equal(denied.envelope.error.code, 'busy'); assert.equal(denied.envelope.error.details.reason, 'provider_capacity'); }
  assert.deepEqual(readdirSync(join(fx.home, 'jobs')), before);
  if (max === 1) {
    const info = JSON.parse(readFileSync(join(fx.jobDir(id), 'process.json'), 'utf8'));
    process.kill(info.supervisor_pid, 'SIGKILL');
    await eventually(() => { try { process.kill(info.supervisor_pid, 0); return undefined; } catch { return true; } });
  } else await fx.command(['cancel', id]);
  fx.env.GBDEV_FAKE_SCENARIO = 'ok';
  // start itself must recover a dead inspect supervisor and its remaining worker.
  const next = await fx.launch(); await fx.wait(next.job_id);
  assert.equal(fx.getJob(id).state, max === 1 ? 'failed' : 'cancelled');
  assert.equal(existsSync(join(fx.home, 'inspect', 'lease.json')), false);
});
