import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipelineFixture } from './helpers/pipeline.js';
import { eventually, tmpRepo } from './helpers/tmpRepo.js';
import type { PipelineStep } from '../src/contracts/pipelineRun.js';
import { fixInput } from '../src/pipeline/fixLoop.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import { gate } from '../src/pipeline/gate.js';
import { generateHandoff } from '../src/pipeline/handoff.js';
import { job, worker, result as sampleResult } from './helpers.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { localIso } from '../src/core/time.js';
import { finalize, finalOutcome } from '../src/core/finalize.js';
import {
  captureWorkspaceSnapshot, WORKSPACE_BEFORE,
} from '../src/core/workspaceSnapshot.js';
import { POLICY_WHITELIST_PATH } from '../src/core/policy.js';
import { buildWorkerResultSchema } from '../src/contracts/workerResultSchema.js';
import { extractWorkerResult, normalizeWorkerResult } from '../src/contracts/workerResult.js';

const NOTEPAD = POLICY_WHITELIST_PATH;
const incident = (cleaned: boolean, index = 0) => ({
  violation_index: index, category: 'temporary_workspace_file' as const, path: NOTEPAD, cleaned,
});

function fixture(t: TestContext, sandbox: 'read-only' | 'workspace-write' = 'workspace-write') {
  const h = tmpRepo(t, sandbox === 'read-only' ? 'review_approve' : 'ok', {
    role: sandbox === 'read-only' ? 'reviewer' : 'executor', sandbox, acceptance_criteria: [],
  });
  const saved = { ...process.env };
  const systemTmp = tmpdir();
  for (const key of Object.keys(process.env)) if (key.startsWith('GBDEV_')) delete process.env[key];
  Object.assign(process.env, h.env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    // Nested fixtures must not leave TMPDIR pointing at a removed execution root.
    if (!process.env.TMPDIR || !existsSync(process.env.TMPDIR)) process.env.TMPDIR = systemTmp;
  });
  writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.omc/\n');
  const store = new JobStore(resolvePaths(h.env));
  const status = {
    ...job(undefined, new Date()), state: 'starting' as const, repo: h.repo, worktree: h.repo,
    base_sha: h.git('rev-parse', 'HEAD').trim(), role: h.task.role, sandbox,
    state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }],
  };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(paths.brief, h.task);
  atomicWriteJson(join(paths.dir, 'provider.json'), {
    bin: process.execPath, writable_roots: sandbox === 'workspace-write' ? [h.repo] : [],
    schema_options: { pipelineStep: true, output: sandbox === 'read-only' ? 'verdict' : 'change', policyIncidents: true },
  });
  writeFileSync(paths.prompt, 'test policy');
  writeFileSync(paths.workerLog, '');
  writeFileSync(paths.rawJsonl, '');
  const baseline = async () => atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE),
    await captureWorkspaceSnapshot(h.repo, { job_id: status.job_id, phase: 'before_worker' }));
  const report = (fields: Record<string, unknown> = {}) => {
    const body = {
      ...worker(), files_changed: [], commits: [], policy_violations: [],
      handoff: { decided: [], rejected: [], risks: [], remaining: [] },
      ...fields,
    };
    writeFileSync(paths.finalMessage, '```json\n' + JSON.stringify(body) + '\n```');
  };
  const finish = async () => finalize(store, status, h.task, 0);
  return { ...h, store, status, paths, baseline, report, finish };
}

test('AC-B4-1 cleaned whitelist notepad downgrades to warning; originals preserved', async t => {
  const f = fixture(t);
  await f.baseline();
  mkdirSync(join(f.repo, '.omc'), { recursive: true });
  writeFileSync(join(f.repo, NOTEPAD), 'temp notes\n');
  unlinkSync(join(f.repo, NOTEPAD));
  f.report({
    policy_violations: ['temporary .omc/notepad.md outside allowed_paths'],
    policy_incidents: [incident(true)],
  });
  // Also create+commit an allowed change so the job has real work.
  mkdirSync(join(f.repo, 'src'), { recursive: true });
  writeFileSync(join(f.repo, 'src/ok.txt'), 'ok\n');
  f.git('add', 'src/ok.txt');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'feat: ok');
  const r = await f.finish();
  assert.equal(r.state, 'succeeded');
  assert.deepEqual(r.worker_reported?.policy_violations, ['temporary .omc/notepad.md outside allowed_paths']);
  assert.equal(r.gbdev_observed.policy_assessment?.warnings.length, 1);
  assert.equal(r.gbdev_observed.policy_assessment?.fatal.length, 0);
  assert.ok(r.worker_result_warnings.some(w => w.startsWith('policy_warning_cleaned:')));
  const handoff = generateHandoff(r, {
    pipeline_id: 'p_test', seq: 1, instance: 'implement#1', role: 'executor', output: 'change', created_at: localIso(),
  });
  assert.ok(handoff.warnings.some(w => w.startsWith('policy_warning_cleaned:')));
});

test('AC-B4-2 cleaned claim without incident is a self-report warning (M9)', async t => {
  const f = fixture(t);
  await f.baseline();
  f.report({ policy_violations: ['temporary .omc/notepad.md cleaned'] });
  const r = await f.finish();
  assert.equal(r.state, 'succeeded');
  assert.equal(r.failure_reason, null);
  assert.equal(r.gbdev_observed.policy_assessment?.warnings.length ?? 0, 1);
});

test('AC-B4-2 baseline-owned notepad cannot downgrade', async t => {
  const f = fixture(t);
  mkdirSync(join(f.repo, '.omc'), { recursive: true });
  writeFileSync(join(f.repo, NOTEPAD), 'inherited\n');
  await f.baseline();
  unlinkSync(join(f.repo, NOTEPAD));
  f.report({
    policy_violations: ['temporary .omc/notepad.md'],
    policy_incidents: [incident(true)],
  });
  const r = await f.finish();
  assert.equal(r.state, 'failed');
  assert.equal(r.gbdev_observed.policy_assessment?.warnings.length ?? 0, 0);
});

for (const c of [
  {
    label: 'path escape',
    setup: async (f: ReturnType<typeof fixture>) => { await f.baseline(); },
    fields: {
      policy_violations: ['escape'],
      policy_incidents: [{ ...incident(true), path: '../outside.txt' }],
    },
  },
  {
    label: 'absolute path',
    setup: async (f: ReturnType<typeof fixture>) => { await f.baseline(); },
    fields: {
      policy_violations: ['abs'],
      policy_incidents: [{ ...incident(true), path: '/tmp/x' }],
    },
  },
  {
    label: 'unknown category',
    setup: async (f: ReturnType<typeof fixture>) => { await f.baseline(); },
    fields: {
      policy_violations: ['x'],
      policy_incidents: [{ violation_index: 0, category: 'network', path: NOTEPAD, cleaned: true }],
    },
  },
  {
    label: 'symlink residue',
    setup: async (f: ReturnType<typeof fixture>) => {
      await f.baseline();
      mkdirSync(join(f.repo, '.omc'), { recursive: true });
      symlinkSync(join(f.root, 'missing-target'), join(f.repo, NOTEPAD));
    },
    fields: {
      policy_violations: ['symlink'],
      policy_incidents: [incident(false)],
    },
  },
  {
    label: 'tracked file',
    setup: async (f: ReturnType<typeof fixture>) => {
      mkdirSync(join(f.repo, '.omc'), { recursive: true });
      writeFileSync(join(f.repo, NOTEPAD), 'tracked\n');
      f.git('add', '-f', NOTEPAD);
      f.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'track notepad');
      f.status.base_sha = f.git('rev-parse', 'HEAD').trim();
      await f.baseline();
      writeFileSync(join(f.repo, NOTEPAD), 'modified tracked\n');
    },
    fields: {
      policy_violations: ['tracked'],
      policy_incidents: [incident(false)],
    },
  },
] as const) {
  test(`AC-B4-3 ${c.label}: invalid metadata and observed residue stay fatal`, async t => {
    const f = fixture(t);
    await c.setup(f);
    f.report(c.fields);
    const r = await f.finish();
    assert.equal(r.state, 'failed');
    assert.match(r.failure_reason ?? '', /^policy_violations:/);
    assert.ok(r.worker_reported);
    if (c.label === 'unknown category') {
      assert.deepEqual(r.worker_reported.policy_incidents, []);
      assert.ok(r.worker_result_warnings.some(w => w.includes('ignored invalid incident')));
    }
    assert.equal(r.gbdev_observed.policy_assessment?.warnings.length ?? 0, 0);
  });
}

test('AC-B4-3 reviewer cleaned self report without observed write warns (M9)', async t => {
  const review = fixture(t, 'read-only');
  await review.baseline();
  mkdirSync(join(review.repo, '.omc'), { recursive: true });
  writeFileSync(join(review.repo, NOTEPAD), 'reviewer wrote\n');
  review.report({
    policy_violations: ['notepad'],
    policy_incidents: [incident(true)],
    review: { verdict: 'approve', findings: [] },
  });
  unlinkSync(join(review.repo, NOTEPAD));
  const reviewed = await review.finish();
  assert.equal(reviewed.state, 'succeeded');
  assert.equal(reviewed.gbdev_observed.policy_assessment?.warnings.length, 1);
});

test('AC-B4-4 leftover whitelist file enters same pipeline fixer without new task attempt', async t => {
  const f = pipelineFixture(t);
  writeFileSync(join(f.root, 'plan.json'), JSON.stringify({
    'implement#1': {
      scenario: 'ok',
      actions: [
        { type: 'write_file', path: NOTEPAD, content: 'leftover\n' },
        {
          type: 'report_fields',
          fields: {
            policy_violations: ['temporary .omc/notepad.md'],
            policy_incidents: [incident(false)],
          },
        },
      ],
    },
    'fix#1': {
      scenario: 'fix_noop',
      actions: [{ type: 'unlink', path: NOTEPAD }],
    },
    'review#1': 'review_approve',
    'review#2': 'review_approve',
  }));
  writeFileSync(join(f.repo, '.git', 'info', 'exclude'), '.omc/\n');
  const start = await f.start();
  const implId = await eventually(() => {
    const run = f.read(start.pipeline_id);
    const id = run.steps[0]?.attempts[0]?.job_id;
    return id && run.steps.some(s => s.kind === 'fix') ? id : undefined;
  });
  const impl = f.result(implId);
  assert.equal(impl.state, 'failed');
  assert.equal(impl.failure_reason, 'policy_repair_required');
  assert.ok(impl.gbdev_observed.policy_assessment?.repairable.length);
  const originalJob = readFileSync(join(f.jobDir(implId), 'job.json'), 'utf8');
  const originalResult = readFileSync(join(f.jobDir(implId), 'result.json'), 'utf8');
  const done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded');
  assert.equal(done.steps[0]?.attempts[0]?.job_id, implId);
  assert.equal(done.steps[0]?.attempts.length, 1);
  assert.equal(done.steps[1]?.kind, 'fix');
  const fixed = f.result(done.steps[1]!.attempts[0]!.job_id);
  assert.equal(fixed.gbdev_observed.head_before, fixed.gbdev_observed.head_after);
  assert.ok(done.warnings.includes('fix_workspace_cleaned'));
  const fixBrief = JSON.parse(readFileSync(join(f.jobDir(fixed.job_id), 'brief.json'), 'utf8'));
  assert.deepEqual(fixBrief.allowed_paths, f.request.allowed_paths);
  assert.match(readFileSync(join(f.jobDir(fixed.job_id), 'prompt.md'), 'utf8'), /policy repair scope: delete untracked file/);
  assert.equal(readFileSync(join(f.jobDir(implId), 'job.json'), 'utf8'), originalJob);
  assert.equal(readFileSync(join(f.jobDir(implId), 'result.json'), 'utf8'), originalResult);
  assert.equal(existsSync(join(f.repo, NOTEPAD)), false);
});

test('AC-B4-5 fixer delete with unchanged HEAD advances (no false fix_no_changes)', () => {
  const prior = sampleResult();
  prior.state = 'failed';
  prior.failure_reason = 'policy_repair_required';
  prior.gbdev_observed.policy_assessment = {
    policy_version: 1,
    warnings: [],
    repairable: [{ code: 'policy_temporary_residue', path: NOTEPAD, owner_job_id: prior.job_id, evidence_ref: 'workspace-after-worker.json' }],
    fatal: [],
  };
  assert.equal(gate(prior, 'change', false, { hasFixLoop: true }).action, 'fix');

  const fixed = sampleResult();
  fixed.gbdev_observed.head_after = fixed.gbdev_observed.head_before;
  fixed.gbdev_observed.workspace_issues = [];
  fixed.gbdev_observed.policy_assessment = { policy_version: 1, warnings: [], repairable: [], fatal: [] };
  const decision = gate(fixed, 'change', false, { kind: 'fix', priorRepairablePaths: [NOTEPAD] });
  assert.equal(decision.action, 'advance');
  assert.ok(decision.warnings?.includes('fix_workspace_cleaned'));
  assert.notEqual(decision.rule, 'FIX_NO_CHANGES');
});

test('AC-B4-6 mixed fatal and repairable does not auto-fix', () => {
  const r = sampleResult();
  r.state = 'failed';
  r.failure_reason = 'policy_violations: readonly_modified';
  r.gbdev_observed.policy_violations = ['outside_allowed_paths', 'readonly_modified'];
  r.gbdev_observed.policy_assessment = {
    policy_version: 1,
    warnings: [],
    repairable: [{ code: 'policy_temporary_residue', path: NOTEPAD, owner_job_id: r.job_id, evidence_ref: 'workspace-after-worker.json' }],
    fatal: ['readonly_modified'],
  };
  const decision = gate(r, 'change', false, { hasFixLoop: true });
  assert.equal(decision.action, 'settle');
  assert.equal(decision.rule, 'G5');
  assert.equal(decision.state, 'failed');
});

test('AC-B4-7 no fix loop / scope mismatch pauses without expanding write scope', async t => {
  const r = sampleResult();
  r.state = 'failed';
  r.failure_reason = 'policy_repair_required';
  r.gbdev_observed.policy_assessment = {
    policy_version: 1, warnings: [],
    repairable: [{ code: 'policy_temporary_residue', path: NOTEPAD, owner_job_id: r.job_id, evidence_ref: 'workspace-after-worker.json' }],
    fatal: [],
  };
  const paused = gate(r, 'change', false, { hasFixLoop: false });
  assert.equal(paused.action, 'settle');
  assert.equal(paused.reason, 'step_failed');

  const f = fixture(t);
  await f.baseline();
  mkdirSync(join(f.repo, '.omc'), { recursive: true });
  symlinkSync(join(f.root, 'nope'), join(f.repo, NOTEPAD));
  f.report({
    policy_violations: ['symlink notepad'],
    policy_incidents: [incident(false)],
  });
  const out = await f.finish();
  assert.equal(out.state, 'failed');
  assert.ok((out.gbdev_observed.policy_assessment?.fatal.length ?? 0) > 0);
  assert.equal(out.gbdev_observed.policy_assessment?.repairable.length ?? 0, 0);
  assert.match(out.failure_reason ?? '', /policy_violations:/);
});

test('AC-B4-8 provider/exit/status/cancel/timeout are not erased by policy warnings', () => {
  const reported = {
    ...worker(),
    policy_violations: ['temporary .omc/notepad.md'],
    policy_incidents: [incident(true)],
  };
  const assessment = {
    policy_version: 1 as const,
    warnings: [{ violation_index: 0, category: 'temporary_workspace_file', path: NOTEPAD, evidence_ref: 'workspace-after-worker.json' }],
    repairable: [],
    fatal: [],
  };
  assert.equal(finalOutcome(1, reported, [], undefined, [], null, 'worker_result_missing', false, false, true, assessment).state, 'failed');
  assert.equal(finalOutcome(0, { ...reported, status: 'failed' }, [], undefined, [], null, 'worker_result_missing', false, false, true, assessment).failure_reasons.includes('worker_reported_failed'), true);
  assert.equal(finalOutcome(0, reported, [], 'timeout', [], null, 'worker_result_missing', false, false, true, assessment).state, 'timeout');
  assert.equal(finalOutcome(0, reported, [], 'cancelled', [], null, 'worker_result_missing', false, false, true, assessment).state, 'cancelled');
  assert.equal(finalOutcome(0, reported, [], undefined, [], 'provider_error: boom', 'worker_result_missing', false, false, true, assessment).failure_reason, 'provider_error: boom');
  // Pure cleaned warning with no other facts succeeds.
  assert.equal(finalOutcome(0, reported, [], undefined, [], null, 'worker_result_missing', false, false, true, assessment).state, 'succeeded');
});

test('B4 policyIncidents schema is opt-in; M2 fixtures unchanged without the flag', () => {
  const baseChange = readFileSync('test/fixtures/worker-result.m2.change.schema.json', 'utf8');
  assert.equal(JSON.stringify(buildWorkerResultSchema({ pipelineStep: true, output: 'change' }), null, 2) + '\n', baseChange);
  const withIncidents = buildWorkerResultSchema({ pipelineStep: true, output: 'change', policyIncidents: true });
  assert.equal(Object.hasOwn(withIncidents.properties, 'policy_incidents'), true);
  const warnings: string[] = [];
  const raw = { ...worker(), policy_violations: ['temporary'], policy_incidents: [incident(true)] };
  normalizeWorkerResult(raw, warnings);
  assert.ok(warnings.some(w => w.includes('policy_incidents')));
  assert.equal(Object.hasOwn(normalizeWorkerResult(raw, [], { policyIncidents: true }), 'policy_incidents'), true);
  assert.deepEqual(extractWorkerResult('```json\n' + JSON.stringify(raw) + '\n```', [], { policyIncidents: true }).policy_incidents, [incident(true)]);
});

test('B4 fixInput surfaces deduplicated policy repair scope findings', t => {
  const f = fixture(t), r = sampleResult();
  r.gbdev_observed.policy_assessment = {
    policy_version: 1, warnings: [], fatal: [],
    repairable: [{ code: 'policy_temporary_residue', path: NOTEPAD, owner_job_id: r.job_id, evidence_ref: 'workspace-after-worker.json', content_hash: 'abc' }],
  };
  r.gbdev_observed.workspace_issues = [{ code: 'policy_temporary_residue', path: NOTEPAD, owner_job_id: r.job_id, source_phase: 'worker', repairable: true }];
  atomicWriteJson(f.paths.result, r);
  const input = fixInput(f.store, { attempts: [{ job_id: r.job_id }] } as PipelineStep);
  assert.equal(input.findings.length, 1);
  assert.equal(input.findings[0]?.file, NOTEPAD);
  assert.match(input.findings[0]!.message, /delete untracked file .*hash=abc/);
  assert.match(input.findings[0]!.suggestion!, /do not modify other paths/);
  assert.deepEqual(input.logs, []);
});

const residueActions = [
  { type: 'write_file', path: NOTEPAD, content: 'leftover\n' },
  { type: 'report_fields', fields: { policy_violations: ['temporary'], policy_incidents: [incident(false)] } },
];

test('AC-B4-1 fake create/delete propagates warnings through job, event, handoff and pipeline', async t => {
  const f = pipelineFixture(t);
  writeFileSync(join(f.root, 'plan.json'), JSON.stringify({
    'implement#1': { scenario: 'ok', actions: [
      ...residueActions, { type: 'unlink', path: NOTEPAD },
      { type: 'report_fields', fields: { policy_incidents: [incident(true)] } },
    ] },
    'review#1': 'review_approve',
  }));
  const started = await f.start(), done = await f.wait(started.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded');
  const step = done.steps[0]!, r = f.result(step.attempts[0]!.job_id);
  assert.equal(r.state, 'succeeded');
  assert.deepEqual(r.worker_reported?.policy_violations, ['temporary']);
  const warning = `policy_warning_cleaned:${NOTEPAD}`;
  assert.ok(r.worker_result_warnings.includes(warning));
  assert.ok(done.warnings.includes(warning));
  assert.ok(JSON.parse(readFileSync(step.handoff!, 'utf8')).warnings.includes(warning));
  const events = readFileSync(r.paths.events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(e => e.type === 'warning' && e.data.code === 'policy_warning_cleaned'));
});

test('AC-B4-3 add/commit/delete/commit cannot downgrade a cleaned incident', async t => {
  const f = fixture(t);
  await f.baseline();
  mkdirSync(join(f.repo, '.omc'), { recursive: true });
  writeFileSync(join(f.repo, NOTEPAD), 'committed temporary');
  f.git('add', '-f', NOTEPAD);
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'add temporary');
  f.git('rm', NOTEPAD);
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'remove temporary');
  assert.equal(f.git('diff', '--name-only', f.status.base_sha, 'HEAD').trim(), '');
  f.report({ policy_violations: ['temporary committed'], policy_incidents: [incident(true)] });
  const r = await f.finish();
  assert.equal(r.state, 'failed');
  assert.match(r.failure_reason!, /^policy_violations:/);
  assert.equal(r.gbdev_observed.policy_assessment?.warnings.length, 0);
});

for (const bad of [null, 'bad', { ...incident(true), category: 'network' }, { ...incident(true), extra: true }, { ...incident(true), cleaned: 'yes' }]) {
  test(`AC-B4-3 invalid incident is ignored with warning: ${JSON.stringify(bad)}`, () => {
    const warnings: string[] = [];
    const r = normalizeWorkerResult({ ...worker(), policy_violations: ['keep failure'], policy_incidents: [bad] }, warnings, { policyIncidents: true });
    assert.deepEqual(r.policy_incidents, []);
    assert.deepEqual(r.policy_violations, ['keep failure']);
    assert.ok(warnings.some(w => w.includes('ignored invalid incident')));
  });
}

test('AC-B4-6 mixed fatal does not merge policy repair workspace issues', async t => {
  const f = fixture(t);
  await f.baseline();
  mkdirSync(join(f.repo, '.omc'), { recursive: true });
  writeFileSync(join(f.repo, NOTEPAD), 'residue');
  f.report({ policy_violations: ['temporary', 'fatal action'], policy_incidents: [incident(false)] });
  const r = await f.finish();
  assert.equal(r.state, 'failed');
  assert.equal(r.gbdev_observed.policy_assessment?.repairable.length, 1);
  assert.ok(r.gbdev_observed.policy_assessment?.fatal.includes('fatal action'));
  assert.ok(!r.gbdev_observed.workspace_issues?.some(i => i.code === 'policy_temporary_residue'));
  assert.equal(gate(r, 'change', false, { hasFixLoop: true }).action, 'settle');
});

for (const [shape, cmd] of [
  ['content', 'echo changed > .omc/notepad.md'],
  ['symlink', 'rm .omc/notepad.md && ln -s ../src/ok.txt .omc/notepad.md'],
  ['directory', 'rm .omc/notepad.md && mkdir .omc/notepad.md'],
  ['tracked', 'git add -f .omc/notepad.md'],
] as const) {
  test(`AC-B4-7 ${shape} changed after worker: pause before fixer creation`, async t => {
    const f = pipelineFixture(t);
    writeFileSync(join(f.root, 'plan.json'), JSON.stringify({ 'implement#1': { scenario: 'ok', actions: residueActions } }));
    const started = await f.start({ acceptance_criteria: [{ id: 'AC1', text: 'mutate residue after worker snapshot', check_cmd: cmd }] });
    const done = await f.wait(started.pipeline_id) as PipelineRun;
    assert.equal(done.state, 'needs_decision');
    assert.equal(done.decision?.reason, 'workspace_unresolved', JSON.stringify(done.decision));
    assert.match(done.decision!.detail, /policy_repair_scope_mismatch/);
    assert.equal(done.jobs_used, 1);
    assert.equal(done.steps.find(s => s.kind === 'fix')?.attempts.length, 0);
  });
}

test('AC-B4-7 exhausted job budget pauses before policy fixer creation', async t => {
  const f = pipelineFixture(t);
  writeFileSync(join(f.root, 'plan.json'), JSON.stringify({ 'implement#1': { scenario: 'ok', actions: residueActions } }));
  const started = await f.start({ max_total_jobs: 1 });
  const done = await f.wait(started.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'needs_decision');
  assert.equal(done.decision?.reason, 'job_budget_exhausted', JSON.stringify(done.decision));
  assert.equal(done.jobs_used, 1);
  assert.equal(done.steps.find(s => s.kind === 'fix')?.attempts.length, 0);
});

for (const primary of ['launch_failed', 'prompt_too_large', 'provider_error: boom', 'worker_exit_nonzero:1', 'worker_reported_failed', 'workspace_snapshot_invalid', 'worker_crashed', 'policy_repair_required']) {
  test(`AC-B4-8 gate matrix repairable + ${primary}`, () => {
    const r = sampleResult();
    r.state = 'failed'; r.failure_reason = primary;
    r.gbdev_observed.policy_assessment = { policy_version: 1, warnings: [], fatal: [],
      repairable: [{ code: 'policy_temporary_residue', path: NOTEPAD, owner_job_id: r.job_id, evidence_ref: 'workspace-after-worker.json' }] };
    const decision = gate(r, 'change', false, { hasFixLoop: true });
    assert.equal(decision.action, primary === 'policy_repair_required' ? 'fix' : 'settle');
    if (['launch_failed', 'prompt_too_large'].includes(primary)) assert.equal(decision.rule, 'B7');
    r.failure_reasons = ['workspace_snapshot_invalid'];
    assert.equal(gate(r, 'change', false, { hasFixLoop: true }).rule, 'B3');
    for (const state of ['timeout', 'cancelled'] as const) {
      r.state = state;
      assert.equal(gate(r, 'change', false, { hasFixLoop: true }).action, 'settle');
    }
  });
}

test('AC-B4-8 repairable finalOutcome preserves reported failure priority', () => {
  const assessment = { policy_version: 1 as const, warnings: [], fatal: [],
    repairable: [{ code: 'policy_temporary_residue', path: NOTEPAD, owner_job_id: 'job', evidence_ref: 'workspace-after-worker.json' }] };
  const out = finalOutcome(0, { ...worker(), status: 'failed' }, [], undefined, [], null, 'worker_result_missing', false, false, true, assessment);
  assert.equal(out.failure_reason, 'worker_reported_failed');
  assert.ok(out.failure_reasons.includes('policy_repair_required'));
});

test('B4 standalone start enables schema and prompt', async t => {
  const f = tmpRepo(t, 'ok');
  const started = await f.launch();
  await f.wait(started.job_id);
  const provider = JSON.parse(readFileSync(join(f.jobDir(started.job_id), 'provider.json'), 'utf8'));
  assert.equal(provider.schema_options.policyIncidents, true);
  assert.match(readFileSync(join(f.jobDir(started.job_id), 'prompt.md'), 'utf8'), /policy_incidents/);
  const r = f.result(started.job_id);
  assert.equal(r.state, 'succeeded');
  const schema = JSON.parse(readFileSync(join(f.jobDir(started.job_id), 'worker-result.schema.json'), 'utf8'));
  assert.ok(schema.properties.policy_incidents);
});

for (const allowedPaths of [['src/**'], ['**']]) {
  test(`B4 unignored residue never enters auto-snapshot with allowed_paths=${allowedPaths.join(',')}`, async t => {
    const f = fixture(t);
    writeFileSync(join(f.repo, '.git', 'info', 'exclude'), '');
    f.task.allowed_paths = allowedPaths;
    await f.baseline();
    writeFileSync(join(f.repo, 'src/ok.txt'), 'committed work');
    f.git('add', 'src/ok.txt');
    f.git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'work');
    const committedHead = f.git('rev-parse', 'HEAD').trim();
    mkdirSync(join(f.repo, '.omc'), { recursive: true });
    writeFileSync(join(f.repo, NOTEPAD), 'temporary');
    f.report({ policy_violations: ['temporary'], policy_incidents: [incident(false)] });
    const r = await f.finish();
    assert.equal(r.failure_reason, 'policy_repair_required');
    assert.equal(r.gbdev_observed.snapshot_commit, null);
    assert.equal(f.git('rev-parse', 'HEAD').trim(), committedHead);
    assert.equal(f.git('ls-files', '--', NOTEPAD), '');
    assert.equal(r.gbdev_observed.policy_assessment?.repairable.length, 1);
  });
}
