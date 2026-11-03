import { IntegrationFollower } from '../src/render/views/integration.js';
import { ViewFiles } from '../src/render/views/common.js';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { allRuns as runList } from '../src/run/store.js';
import { allRuns as pipelineList } from '../src/pipeline/store.js';
import { compareInstant, compareInstantDesc, instantMs } from '../src/core/time.js';
import { buildEvidencePack, buildTestEvidence } from '../src/inspect/evidence.js';
import type { ResolvedInspectTarget } from '../src/inspect/target.js';
import { JobStore } from '../src/core/jobStore.js';
import { jobPaths } from '../src/core/paths.js';
import { runFixture } from './helpers/run.js';
import { job, result } from './helpers.js';
import { earlier, later, id, inventory, inventoryFixture } from './helpers/m9-b3.js';

test('O14 mixed DST offsets, equal instants and invalid timestamps have deterministic ordering', () => {
  assert.equal(instantMs(earlier), Date.parse('2026-11-01T08:30:00Z')); assert.equal(instantMs(later), Date.parse('2026-11-01T09:10:00+00:00'));
  assert.ok(compareInstantDesc(earlier, later) > 0); assert.ok(compareInstant(earlier, later) < 0);
  assert.equal(compareInstantDesc(later, '2026-11-01T09:10:00+00:00'), 0); assert.equal(instantMs('invalid'), null);
  for (const compare of [compareInstant, compareInstantDesc]) {
    assert.ok(compare('invalid', earlier) > 0); assert.ok(compare(later, 'invalid') < 0); assert.ok(compare('bad-a', 'bad-b') < 0);
  }
});

test('O14 run/pipeline/job stores and all CLI lists order by real instant, then descending id', async t => {
  const f = inventoryFixture(t);
  for (const kind of ['run', 'pipeline', 'job'] as const) {
    f[kind](1, 'succeeded', earlier); f[kind](2, 'succeeded', later); f[kind](3, 'succeeded', '2026-11-01T09:10:00+00:00');
  }
  assert.deepEqual(runList(f.store).map(r => r.run_id), [3, 2, 1].map(n => id('r', n)));
  assert.deepEqual(pipelineList(f.store).map(p => p.pipeline_id), [3, 2, 1].map(n => id('p', n)));
  assert.deepEqual(f.store.list().map(j => j.job_id), [3, 2, 1].map(n => id('j', n)));
  for (const [args, kind] of [[['run', 'list'], 'r'], [['pipeline', 'list'], 'p'], [['list'], 'j']] as const) {
    assert.deepEqual((await inventory([...args])).result.items.map(e => e.id), [3, 2, 1].map(n => id(kind, n)));
  }
});

test('O14 inspect evidence orders real finished_at and keeps existing ascending source/check tie-break', t => {
  const f = inventoryFixture(t);
  const records = [
    { source_id: 'a', finished_at: earlier }, { source_id: 'b', finished_at: later },
    { source_id: 'a', finished_at: '2026-11-01T09:10:00+00:00' }, { source_id: 'invalid', finished_at: '' },
  ].map(r => ({ ...r, check_id: 'test', exit_code: 0, checked_sha: null, log_path: null }));
  assert.deepEqual(buildTestEvidence(records, f.home, true, '').tests.map(e => e.source_id), ['a', 'b', 'a', 'invalid']);
});

test('O14 inspect pipeline updated_at cutoff uses instants, with no-target cutoff unbounded', t => {
  inventoryFixture(t); // Isolate HOME and all gbdev path variables before creating a temporary git repo.
  const f = runFixture(t), store = new JobStore(f.paths), pipelineId = id('p', 1);
  const jobs = [earlier, later, '2026-11-01T09:10:00+00:00'].map((at, index) => {
    const j = job(id('j', index + 1)); j.repo = f.repo; j.worktree = f.repo; j.base_sha = f.base;
    j.state = 'succeeded'; j.state_history.push({ state: j.state, at, by: 'test' }); j.updated_at = at; j.pipeline_id = pipelineId; store.create(j);
    const paths = jobPaths(f.paths, j.job_id); mkdirSync(paths.checks); writeFileSync(join(paths.checks, 'AC1.log'), `check ${index}`);
    const report = result(); report.job_id = j.job_id; report.gbdev_observed.head_after = f.base;
    writeFileSync(paths.result, JSON.stringify(report)); return j;
  });
  const resolved: ResolvedInspectTarget = { repo: f.repo, source_branch: 'main', source_worktree: f.repo, target_sha: f.base, diff_base_sha: f.base, warnings: [],
    target: { kind: 'job', id: jobs[0]!.job_id, job_id: jobs[0]!.job_id, pipeline_id: pipelineId, run_id: null, task_id: null } };
  const sources = () => buildEvidencePack(store, f.repo, resolved, [], false, true).tests.map(e => e.source_id);
  assert.deepEqual(sources(), [jobs[0]!.job_id]);
  resolved.target.id = jobs[1]!.job_id; resolved.target.job_id = jobs[1]!.job_id;
  assert.deepEqual(sources(), [jobs[1]!.job_id, jobs[2]!.job_id, jobs[0]!.job_id]);
  resolved.target.job_id = null;
  assert.deepEqual(sources(), [jobs[1]!.job_id, jobs[2]!.job_id, jobs[0]!.job_id]);
});

test('O14 integration follower discovers jobs oldest first across DST, then ascending id', t => {
  const f = inventoryFixture(t), r = f.run(1);
  for (const [n, at] of [[1, later], [2, earlier], [3, '2026-11-01T09:10:00+00:00']] as const) {
    const j = f.job(n, 'succeeded', at); j.run_id = r.run_id; f.store.write(j);
  }
  const follower = new IntegrationFollower(new ViewFiles(f.home), r.run_id, { once: true });
  t.after(() => follower.close());
  const separators = follower.poll(r, Date.parse('2026-11-01T12:00:00+00:00')).filter(l => l.tag === 'STEP' && l.text.startsWith('────')).map(l => l.text);
  assert.equal(separators.length, 3);
  for (const [i, n] of [2, 1, 3].entries()) assert.ok(separators[i]?.includes(id('j', n)), JSON.stringify(separators));
});
