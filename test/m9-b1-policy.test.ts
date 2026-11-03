import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { policyFixture } from './helpers/m9.js';
import { isPolicyWhitelistPath } from '../src/core/policy.js';
import { generateHandoff } from '../src/pipeline/handoff.js';
import { renderPriorSteps } from '../src/pipeline/prompt.js';
import { localIso } from '../src/core/time.js';

const cases = [
  { id: 'ec62', text: 'temporary workspace directory taskhub/.omc appeared empty during the session', path: 'taskhub/.omc' },
  { id: '60dc', text: 'Created worktree-local .tmp as TMPDIR for offline cargo tests (outside allowed_paths taskhub/**); removed before exit.', path: '.tmp' },
  { id: '06ec', text: '首次 cargo fmt 预检查遗漏了要求的 --offline 参数；该命令未执行构建或安装，也未观察到网络访问。后续格式化和最终检查均显式使用 --offline。', path: null },
];
for (const c of cases) for (const sandbox of ['workspace-write', 'read-only'] as const) {
  test(`M9 O8/O13 finalize replay ${c.id} ${sandbox}`, async t => {
    const f = policyFixture(t, sandbox);
    f.task.allowed_paths = ['taskhub/**'];
    await f.baseline();
    if (c.id === 'ec62') mkdirSync(join(f.repo, c.path!), { recursive: true });
    const incidents = c.path ? [{ violation_index: 0, category: 'temporary_workspace_file', path: c.path, cleaned: true }] : [];
    f.report({ policy_violations: [c.text], policy_incidents: incidents });
    const r = await f.finish();
    assert.equal(r.state, 'succeeded', r.failure_reason ?? '');
    assert.deepEqual(r.gbdev_observed.policy_violations, []);
    assert.deepEqual(r.gbdev_observed.outside_allowed_paths, []);
    assert.equal(r.gbdev_observed.policy_assessment?.warnings[0]?.text, c.text);
    const persisted = JSON.parse(readFileSync(f.paths.result, 'utf8'));
    assert.deepEqual(persisted.gbdev_observed.policy_assessment, r.gbdev_observed.policy_assessment);
    const events = readFileSync(f.paths.events, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const event = events.find(e => e.type === 'policy_self_report_downgraded');
    assert.equal(event.data.text, c.text);
    assert.deepEqual(event.data.incidents, incidents);
    assert.match(event.data.reason, /without_observed_violation/);
    const h = generateHandoff(r, { pipeline_id: 'p_test', seq: 1, instance: 'implement#1', role: 'executor', output: 'change', created_at: localIso() });
    assert.ok(renderPriorSteps([h]).includes(c.text));
    assert.deepEqual(h.warnings.filter(w => w.startsWith('policy_self_report')), [`policy_self_report:${c.text}`]);
  });
}

test('M9 whitelist matches nested .omc directory and descendants', () => {
  for (const path of ['taskhub/.omc', 'taskhub/.omc/notepad.md', '.omc/notepad.md', '.omc']) assert.ok(isPolicyWhitelistPath(path), path);
  assert.equal(isPolicyWhitelistPath('taskhub/.omc-other'), false);
});

for (const kind of ['observed', 'residue', 'mixed_incidents', 'readonly_observed'] as const) {
  test(`M9 real violations remain fatal: ${kind}`, async t => {
    const f = policyFixture(t, kind === 'readonly_observed' ? 'read-only' : 'workspace-write');
    await f.baseline();
    if (kind !== 'mixed_incidents') writeFileSync(join(f.repo, 'outside.txt'), 'leftover');
    f.report({ policy_violations: ['self report'], policy_incidents: kind === 'mixed_incidents' ? [
      { violation_index: 0, category: 'temporary_workspace_file', path: 'cleaned', cleaned: true },
      { violation_index: 0, category: 'temporary_workspace_file', path: 'unresolved', cleaned: false },
    ] : [{ violation_index: 0, category: 'temporary_workspace_file', path: kind === 'residue' ? 'outside.txt' : 'cleaned', cleaned: kind !== 'residue' }] });
    const r = await f.finish();
    assert.equal(r.state, 'failed');
    assert.equal(r.gbdev_observed.policy_assessment?.warnings.length, 0);
    assert.ok(r.gbdev_observed.policy_assessment?.fatal.length);
    if (kind === 'observed') assert.ok(r.gbdev_observed.policy_assessment?.fatal.includes('outside_allowed_paths'));
    if (kind === 'readonly_observed') assert.ok(r.gbdev_observed.policy_assessment?.fatal.includes('readonly_modified'));
  });
}

test('M9 nested whitelist residue retains B4 repair ownership, hash validation and snapshot exclusion', async t => {
  const f = policyFixture(t);
  f.task.allowed_paths = ['**'];
  writeFileSync(join(f.repo, '.git/info/exclude'), '');
  await f.baseline();
  mkdirSync(join(f.repo, 'taskhub/.omc'), { recursive: true });
  writeFileSync(join(f.repo, 'taskhub/.omc/notes'), 'untracked temp');
  f.report({ policy_violations: ['unresolved temp'], policy_incidents: [{ violation_index: 0, category: 'temporary_workspace_file', path: 'taskhub/.omc/notes', cleaned: false }] });
  const r = await f.finish();
  assert.equal(r.failure_reason, 'policy_repair_required');
  assert.equal(r.gbdev_observed.snapshot_commit, null);
  assert.equal(r.gbdev_observed.policy_assessment?.warnings.length, 0);
  assert.equal(r.gbdev_observed.policy_assessment?.repairable[0]?.owner_job_id, f.status.job_id);
  const { policyRepairMismatch } = await import('../src/pipeline/fixLoop.js');
  const step = { attempts: [{ job_id: f.status.job_id }] } as import('../src/contracts/pipelineRun.js').PipelineStep;
  assert.equal(policyRepairMismatch(f.store, step, f.repo), null);
  writeFileSync(join(f.repo, 'taskhub/.omc/notes'), 'changed after worker');
  assert.match(policyRepairMismatch(f.store, step, f.repo)!, /policy_repair_scope_mismatch/);
});

test('M9 cleaned claim cannot hide ignored residue that git snapshot omits', async t => {
  const f = policyFixture(t);
  await f.baseline();
  mkdirSync(join(f.repo, 'taskhub/.omc'), { recursive: true });
  writeFileSync(join(f.repo, 'taskhub/.omc/hidden'), 'still present');
  f.report({ policy_violations: ['claimed cleanup'], policy_incidents: [{ violation_index: 0, category: 'temporary_workspace_file', path: 'taskhub/.omc', cleaned: true }] });
  const r = await f.finish();
  assert.equal(r.state, 'failed');
  assert.equal(r.gbdev_observed.policy_assessment?.warnings.length, 0);
  assert.ok(r.gbdev_observed.policy_assessment?.fatal.includes('claimed cleanup'));
});

test('M9 task decision exposes self-report warnings to the run decider', async t => {
  const { fixture } = await import('./helpers/m3.js');
  const f = fixture(t);
  f.request.tasks = [f.request.tasks![0]!];
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'report_fields', fields: {
    status: 'needs_input', policy_violations: ['Corrected local procedure'], policy_incidents: [],
    open_questions: [{ id: 'Q1', question: 'Choose A or B', options: ['A', 'B'], default: null, blocking: true }],
  } }] };
  const { run } = await f.execute();
  assert.equal(run.attention[0]?.reason, 'task_paused');
  assert.match(run.attention[0]!.detail, /Policy warnings:.*Corrected local procedure/);
  assert.ok(run.attention[0]!.allowed_actions.includes('answer'));
});
