import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DECISION_REASONS, validateRun } from '../src/contracts/run.js';
import { startRun } from '../src/commands/run.js';
import { requireDecision } from '../src/run/decisions.js';
import { runPaths, writeRun } from '../src/run/store.js';
import { buildPayload, type PayloadInput } from '../src/notify/payload.js';
import { validateNotifyPayload } from '../src/contracts/notify.js';
import { installNotifyTesting } from '../src/notify/enqueue.js';
import { atomicWriteJson } from '../src/core/jobStore.js';
import { locked } from '../src/core/runtime.js';
import { fixture } from './helpers/m3.js';

const base: PayloadInput = { home_id: 'a1b2c3d4e5f6', unit_kind: 'run', unit_id: 'r_20261101_1200_ab12', event: 'attention', kind: 'task_paused', unit_state: 'running', source_seq: 1, seq: 1, occurred_at: '2026-11-01T12:00:00-08:00', sent_at: '2026-11-01T12:00:00-08:00', gbdev_version: '1.0.0' };
const payload = (input: PayloadInput) => { const result = buildPayload(input); assert.ok(result.ok); return result.payload; };

test('O4 every reason creates a bounded Chinese summary with cause/questions/actions; legacy attention accepted', async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false);
  run.plan.plan_attempts = 1;
  mkdirSync(join(runPaths(f.store, run.run_id).dir, 'plans'), { recursive: true });
  atomicWriteJson(join(runPaths(f.store, run.run_id).dir, 'plans', 'plan-1.json'), { job_id: 'j_20261101_1200_ab12' });
  for (const reason of DECISION_REASONS) {
    const item = requireDecision(f.store, run, null, reason, '具体原因：测试失败 ' + 'x'.repeat(800), ['resume_run'], [{ id: 'Q1', question: '采用哪个方案？', options: [], default: null, blocking: true }]);
    assert.ok(item.summary!.length <= 300); assert.match(item.summary!, /具体原因：测试失败/);
    assert.match(item.summary!, /建议动作：resume_run/); assert.match(item.summary!, /问题 1/); assert.match(item.summary!, /采用哪个方案/);
    assert.match(item.summary!, /worker 报告：/); assert.notEqual(item.summary!.split('；')[0], reason);
    if (reason.startsWith('plan_')) { assert.match(item.summary!, /plans\/plan-1.json/); assert.match(item.summary!, /j_20261101_1200_ab12/); }
  }
  writeRun(f.store, run);
  const records = readFileSync(join(runPaths(f.store, run.run_id).dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.every(r => typeof r.summary === 'string'));
  const legacy = structuredClone(run); for (const a of legacy.attention) delete a.summary;
  assert.doesNotThrow(() => validateRun(legacy));
  assert.throws(() => validateRun({ ...run, attention: [{ ...run.attention[0], summary: 'x'.repeat(301) }] }));
});

test('O4 summary/detail redact before truncation and sanitize terminal controls', async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false);
  const synthetic = 'sk-' + 'a'.repeat(24);
  const item = requireDecision(f.store, run, null, 'task_failed', `\x1b[31m失败 ${synthetic} token=synthetic-value ` + 'y'.repeat(5000), ['resume_run']);
  assert.ok(item.detail.length <= 4000); assert.ok(item.summary!.length <= 300);
  for (const text of [item.detail, item.summary!]) { assert.match(text, /‹redacted›/); assert.ok(!text.includes(synthetic)); assert.doesNotMatch(text, /\x1b|synthetic-value/); }
});

test('O4 payload explicit attention projection, truncation, fallback and whitelist', () => {
  const old = payload(base), synthetic = 'sk-' + 'b'.repeat(24);
  assert.equal(old.summary, 'run r_20261101_1200_ab12 需要决策：task_paused');
  const projected = payload({ ...base, attention_summary: `\x1b[31m任务暂停 ${synthetic} ` + '长'.repeat(500), detail: 'not projected', allowed_actions: ['retry'] } as PayloadInput);
  assert.equal(projected.summary.length, 200); assert.match(projected.summary, /任务暂停 ‹redacted›/);
  assert.deepEqual(Object.keys(projected), Object.keys(old)); assert.doesNotMatch(JSON.stringify(projected), /not projected|allowed_actions|\x1b/);
  assert.doesNotThrow(() => validateNotifyPayload(projected));
  assert.equal(payload({ ...base, event: 'terminal', kind: 'succeeded', unit_state: 'succeeded', attention_summary: 'ignore' }).summary, 'run r_20261101_1200_ab12 已结束：succeeded');
});

test('O4 requireDecision event -> enqueue outbox forwards only sanitized attention summary', async t => {
  const f = fixture(t), config = JSON.parse(readFileSync(f.paths.config, 'utf8'));
  writeFileSync(f.paths.config, JSON.stringify({ ...config, notify: { enabled: true, key_name: 'X-Key' } }));
  t.after(installNotifyTesting(f.paths.home, { launch: () => {}, env: { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1' } }));
  const run = await startRun(f.store, f.request, false);
  const item = await locked(f.store, () => requireDecision(f.store, run, null, 'plan_invalid', '任务图存在循环依赖', ['replan']));
  const dir = join(f.paths.home, 'notify', 'outbox'), files = readdirSync(dir);
  assert.equal(files.length, 1);
  const { meta: _meta, ...notice } = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'));
  assert.equal(notice.summary, item.summary!.slice(0, 200)); assert.match(notice.summary, /循环依赖/);
  assert.doesNotThrow(() => validateNotifyPayload(notice)); assert.equal(notice.detail, undefined);
});

test('O4 planner supplies current artifact identity before runtime publication', async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false);
  run.plan.plan_attempts = 1;
  atomicWriteJson(join(runPaths(f.store, run.run_id).dir, 'runtime.json'), { seeds: {}, modes: {}, resolve_extra: {}, fix_limits: {}, generation: {}, budget_waiting: [], plan_sequence: 2 });
  const item = requireDecision(f.store, run, null, 'plan_review', '新计划', ['approve_plan'], [], { plan_path: 'plans/plan-3.json', job_id: 'j_20261101_1200_cd34' });
  assert.match(item.summary!, /plans\/plan-3.json/); assert.match(item.summary!, /j_20261101_1200_cd34/);
  assert.doesNotMatch(item.summary!, /plan-2.json/);
});
