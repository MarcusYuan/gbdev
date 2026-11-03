import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRun } from '../src/commands/run.js';
import { requireDecision } from '../src/run/decisions.js';
import { writeRun as writePipeline } from '../src/pipeline/store.js';
import { fixture } from './helpers/m3.js';
import { ownedPipeline } from './helpers/m9-process.js';

for (const role of ['reviewer', 'fixer'] as const) test(`O15 ${role} blocked preserves step/job/cause and environment evidence`, async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false), owned = ownedPipeline(f, run, role), p = owned.pipeline;
  const cause = `worker_blocked: ${role} sandbox denies /bin/ps (Operation not permitted), cargo test exits non-zero`;
  owned.job.failure_reason = cause; owned.job.worker_reported!.blockers = [{ kind: 'env', detail: cause }];
  if (role === 'reviewer') owned.job.worker_reported!.review = { verdict: 'approve', findings: [] };
  owned.saveJob(); p.decision!.detail = cause; p.state = 'blocked'; p.state_reason = 'blocked'; writePipeline(f.store, p);
  const item = requireDecision(f.store, run, run.tasks[0]!, 'task_paused', 'blocked', ['retry', 'drop_task']);
  assert.match(item.detail, /worker_blocked:.*sandbox denies/); assert.match(item.detail, /Operation not permitted/);
  for (const text of [item.detail, item.summary!]) { assert.ok(text.includes(p.decision!.instance)); assert.ok(text.includes(owned.job.job_id)); }
  assert.match(item.summary!, /环境\/沙箱限制/); assert.match(item.summary!, /worker_blocked/);
  assert.match(item.summary!, /retry 时附说明（跳过受沙箱限制的命令，按其余证据评审）/);
  if (role === 'reviewer') assert.match(item.summary!, /reviewer 结论 approve，但因环境限制 blocked/);
  else assert.doesNotMatch(item.summary!, /reviewer 结论/);
  assert.deepEqual(item.allowed_actions, ['retry', 'drop_task']); assert.ok(item.summary!.length <= 300);
  assert.equal(p.steps[0]!.sandbox, role === 'reviewer' ? 'read-only' : 'workspace-write');
});

test('O15 ordinary blocked without environment evidence/verdict has no sandbox annotation', async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false), owned = ownedPipeline(f, run);
  owned.job.failure_reason = 'worker_blocked: missing requirements'; owned.job.worker_reported!.blockers = [{ kind: 'other', detail: 'missing requirements' }]; owned.saveJob();
  const item = requireDecision(f.store, run, run.tasks[0]!, 'task_paused', 'blocked', ['retry']);
  assert.match(item.detail, /missing requirements/); assert.doesNotMatch(item.summary!, /沙箱|reviewer 结论|环境限制/);
});

for (const role of ['reviewer', 'fixer'] as const) test(`O15 actual ${role} env blocked propagates from G4 pipeline to run attention`, async t => {
  const f = fixture(t); f.request.tasks = f.request.tasks!.slice(0, 1); f.request.lanes = 1;
  if (role === 'fixer') f.fakePlan['review#1'] = 'review_revise';
  f.fakePlan[role === 'reviewer' ? 'review#1' : 'fix#1'] = { scenario: role === 'reviewer' ? 'review_approve' : 'fix_noop', actions: [{ type: 'report_fields', fields: { status: 'blocked', blockers: [{ kind: 'env', detail: `${role} sandbox denies /bin/ps (Operation not permitted), cargo test exits non-zero.` }] } }] };
  const { run } = await f.execute();
  assert.equal(run.state, 'needs_decision'); const attention = run.attention[0]!;
  assert.equal(attention.reason, 'task_paused'); assert.match(attention.detail, /worker_blocked:.*sandbox denies/);
  assert.ok(attention.summary!.includes(role === 'reviewer' ? 'review#1' : 'fix#1')); assert.match(attention.summary!, /j_\d{8}_\d{4}_/);
  if (role === 'reviewer') assert.match(attention.summary!, /approve/); assert.match(attention.summary!, /环境\/沙箱限制/);
  const pipeline = JSON.parse(readFileSync(join(f.paths.home, 'pipelines', attention.pipeline_id!, 'pipeline.json'), 'utf8'));
  assert.equal(pipeline.state, 'blocked'); assert.ok(pipeline.paused_since); assert.ok(pipeline.decision.summary);
  assert.ok(run.paused_since); assert.deepEqual(attention.allowed_actions, ['retry', 'drop_task']);
});

test('O15 text-only EPERM evidence is classified without an env blocker, exhausted retry is not suggested', async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false), owned = ownedPipeline(f, run);
  owned.job.failure_reason = 'worker_blocked: EPERM while executing command'; owned.job.worker_reported!.blockers = []; owned.saveJob();
  const p = owned.pipeline; p.steps[0]!.attempts = Array.from({ length: 3 }, (_, i) => ({ ...p.steps[0]!.attempts[0]!, attempt: i + 1 })); writePipeline(f.store, p);
  const item = requireDecision(f.store, run, run.tasks[0]!, 'task_paused', 'blocked', ['retry', 'drop_task']);
  assert.match(item.summary!, /环境\/沙箱限制/); assert.match(item.summary!, /建议动作：drop_task/);
  assert.doesNotMatch(item.summary!, /retry 时/); assert.deepEqual(item.allowed_actions, ['drop_task']);
});
