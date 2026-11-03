import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criteriaFromBrief, logicalTaskCheckId, runCheckProcess, runJobChecks } from '../src/core/checks.js';
import { finalize } from '../src/core/finalize.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { validateBrief } from '../src/contracts/brief.js';
import { validateRunRequest } from '../src/contracts/runRequest.js';
import { validateConfig } from '../src/core/config.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { valueForDefinition } from '../src/run/requests.js';
import { captureWorkspaceSnapshotSync, WORKSPACE_BEFORE } from '../src/core/workspaceSnapshot.js';
import { localIso } from '../src/core/time.js';
import { pipelineFixture } from './helpers/pipeline.js';
import { fixture as runFixture } from './helpers/m3.js';
import { tmpRepo } from './helpers/tmpRepo.js';
import { testEnv } from './helpers/run.js';
import { runJobs } from '../src/run/invariants.js';
import { mergeRecords } from '../src/run/result.js';
import { errorCode, job, temporary, worker } from './helpers.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { JobResult } from '../src/contracts/jobResult.js';

function shPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

for (const limit of ['deadline', 'catalog_timeout'] as const) {
  test(`AC-B5-5/6 ${limit} actually times out the shared physical process`, async t => {
    const f = tmpRepo(t, 'ok', { acceptance_criteria: [] });
    const jobDir = join(f.root, 'check-job');
    const counter = join(f.root, 'physical-count');
    const skipped = join(f.root, 'after-deadline');
    // Success after 3s distinguishes a real timeout from merely forwarding metadata.
    const cmd = `echo x >> ${shPath(counter)}; exec node -e 'setTimeout(() => process.exit(0), 3000)'`;
    const timeoutMin = limit === 'deadline' ? 1 : 0.005;
    const started = Date.now();
    let physical = 0;
    const results = await runJobChecks({
      criteria: criteriaFromBrief({
        acceptance_criteria: [1, 2, 3, 4].map(n => ({ id: `AC${n}`, check_cmd: cmd })),
        execution_checks: [
          { id: 'fmt', cmd, timeout_min: timeoutMin },
          ...(limit === 'deadline' ? [{ id: 'later', cmd: `echo x > ${shPath(skipped)}`, timeout_min: 1 }] : []),
        ],
      }),
      cwd: f.repo, jobDir, cancelRequest: join(jobDir, 'cancel.json'),
      processInfo: join(jobDir, 'process.json'), env: f.env,
      ...(limit === 'deadline' ? { deadlineAt: started + 1000 } : {}),
      onPhysicalStart: () => { physical++; },
    });
    assert.equal(physical, 1);
    assert.equal(readFileSync(counter, 'utf8'), 'x\n');
    assert.deepEqual(results.map(c => c.exit_code), Array(results.length).fill(null));
    assert.ok(results[0]!.execution_id);
    for (const [index, check] of results.slice(0, 5).entries()) {
      assert.equal(check.execution_id, results[0]!.execution_id);
      assert.equal(check.reused_from, index === 0 ? undefined : 'AC1');
      assert.ok(existsSync(join(jobDir, check.log)));
    }
    assert.equal(results[4]!.source, 'task_check');
    assert.equal(JSON.parse(readFileSync(join(jobDir, 'process.json'), 'utf8')).check_pgid, null);
    if (limit === 'deadline') {
      assert.ok(Date.now() - started < timeoutMin * 60_000);
      assert.equal(existsSync(skipped), false);
      assert.equal(readFileSync(join(jobDir, results[5]!.log), 'utf8'), '');
    }
  });
}

test('B5 expired process deadline records null and an empty log without spawning', async t => {
  const f = tmpRepo(t);
  const marker = join(f.root, 'must-not-run');
  const log = join(f.root, 'expired.log');
  let physical = 0;
  const code = await runCheckProcess(`echo x > ${shPath(marker)}`, f.repo, log,
    join(f.root, 'cancel.json'), join(f.root, 'process.json'), f.env, 60_000,
    Date.now() - 1, () => { physical++; });
  assert.equal(code, null);
  assert.equal(physical, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(log, 'utf8'), '');
});

for (const owner of ['job', 'pipeline', 'run'] as const) {
  test(`B5 finalize clamps to the remaining ${owner} deadline`, async t => {
    const f = tmpRepo(t, 'ok', { acceptance_criteria: [] });
    testEnv(t, Object.fromEntries(Object.entries(f.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
    const marker = join(f.root, 'must-not-run');
    f.task.execution_checks = [{ id: 'fmt', cmd: `echo x > ${shPath(marker)}`, timeout_min: 1 }];
    const store = new JobStore(resolvePaths(f.env));
    const future = localIso(new Date(Date.now() + 60_000)), expired = localIso(new Date(Date.now() - 1000));
    const pipelineId = 'p_20261031_1131_a7f3', runId = 'r_20261031_1131_a7f3';
    const status = {
      ...job(undefined, new Date()), state: 'running' as const, repo: f.repo, worktree: f.repo,
      base_sha: f.git('rev-parse', 'HEAD').trim(), deadline_at: owner === 'job' ? expired : future,
      pipeline_id: pipelineId, run_id: runId,
      state_history: [{ state: 'running' as const, at: localIso(), by: 'gbdev' }],
    };
    store.create(status);
    for (const [folder, id, file, deadline] of [
      ['pipelines', pipelineId, 'pipeline.json', owner === 'pipeline' ? expired : future],
      ['runs', runId, 'run.json', owner === 'run' ? expired : future],
    ]) {
      const dir = join(store.paths.home, folder!, id!);
      mkdirSync(dir, { recursive: true });
      atomicWriteJson(join(dir, file!), { deadline_at: deadline });
    }
    const paths = jobPaths(store.paths, status.job_id);
    atomicWriteJson(paths.brief, f.task);
    atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE), captureWorkspaceSnapshotSync(f.repo, {
      job_id: status.job_id, phase: 'before_worker',
    }));
    writeFileSync(paths.finalMessage, '```json\n' + JSON.stringify(worker()) + '\n```');
    await finalize(store, status, f.task, 0);
    const result = JSON.parse(readFileSync(paths.result, 'utf8')) as JobResult;
    assert.equal(existsSync(marker), false);
    assert.equal(result.failure_reason, 'check_failed:task_check:fmt');
    assert.equal(result.gbdev_observed.checks[0]!.exit_code, null);
    assert.equal(readFileSync(join(paths.dir, result.gbdev_observed.checks[0]!.log), 'utf8'), '');
  });
}

test('AC-B5-5 unknown/duplicate task_checks rejected before workers; timeout from catalog', t => {
  const root = temporary(t);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, allowed_repos: [root] }));
  const config = validateConfig({ version: 1, allowed_repos: [root] });
  const registry = new PipelineRegistry(join(root, 'config.json'));
  const base = {
    schema: 'gbdev.run-request.v1' as const,
    request_id: 'r_b5',
    repo: root,
    base_ref: 'HEAD',
    goal: 'g',
    context: '',
    constraints: [],
    allowed_paths: ['src/**'],
    checks: [{ id: 'fmt', cmd: 'true', timeout_min: 7 }, { id: 'test', cmd: 'true', timeout_min: 3 }],
    integration_checks: ['fmt'],
    acceptance_criteria: [],
    decompose: 'planner' as const,
    tasks: null,
    network: false as const,
  };
  assert.throws(() => validateRunRequest({ ...base, task_checks: ['missing'] }, config, registry), errorCode('run_invalid'));
  assert.throws(() => validateRunRequest({ ...base, task_checks: ['fmt', 'fmt'] }, config, registry), errorCode('run_invalid'));
  const ok = validateRunRequest({ ...base, task_checks: ['fmt'] }, config, registry);
  assert.deepEqual(ok.task_checks, ['fmt']);
  assert.deepEqual(validateRunRequest({ ...base }, config, registry).task_checks, []);
  const criteria = criteriaFromBrief({
    acceptance_criteria: [],
    execution_checks: [{ id: 'fmt', cmd: 'true', timeout_min: 7 }],
  });
  assert.equal(criteria[0]!.timeout_min, 7);
  assert.equal(criteria[0]!.id, logicalTaskCheckId('fmt'));
  assert.equal(criteria[0]!.check_id, 'fmt');
  assert.equal(criteria[0]!.source, 'task_check');
});

test('AC-B5-4 empty/default task_checks does not forward integration_checks', t => {
  const f = runFixture(t);
  f.request.tasks = f.request.tasks!.slice(0, 1);
  f.request.lanes = 1;
  const registry = new PipelineRegistry(f.paths.config);
  const definition = registry.resolve('implement-review');
  delete (f.request as { task_checks?: string[] }).task_checks;
  assert.deepEqual(
    (valueForDefinition(f.request, f.request.tasks![0]!, definition) as { execution_checks: unknown[] }).execution_checks,
    [],
  );
  f.request.task_checks = [];
  f.request.integration_checks = ['test'];
  assert.deepEqual(
    (valueForDefinition(f.request, f.request.tasks![0]!, definition) as { execution_checks: unknown[] }).execution_checks,
    [],
  );
  f.request.task_checks = ['test'];
  const forwarded = valueForDefinition(f.request, f.request.tasks![0]!, definition) as {
    execution_checks: { id: string; timeout_min: number }[];
  };
  assert.deepEqual(forwarded.execution_checks.map(c => c.id), ['test']);
  assert.equal(forwarded.execution_checks[0]!.timeout_min, 1);
});

test('AC-B5-1/2 task check fails before reviewer; fixer re-runs checks; executor not re-attempted', async t => {
  const counter = join(temporary(t), 'fmt-count');
  const fmt = `echo 1 >> ${shPath(counter)}; if test -f src/check-fail.txt; then echo bad-fmt; exit 1; fi; echo fmt-ok`;
  const f = pipelineFixture(t, {
    'implement#1': 'check_fail_then_fix',
    'fix#1': 'fix_ok',
    'review#1': 'review_approve',
    'review#2': 'review_approve',
  });
  const start = await f.start({
    acceptance_criteria: [{ id: 'AC1', text: 'no criterion check', check_cmd: 'true' }],
    execution_checks: [{ id: 'fmt', cmd: fmt, timeout_min: 1 }],
  });
  const done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded');
  const implement = done.steps.find(s => s.instance === 'implement#1')!;
  const fix = done.steps.find(s => s.kind === 'fix')!;
  assert.ok(fix);
  assert.equal(implement.attempts.length, 1);
  const implementResult = JSON.parse(readFileSync(join(f.home, 'jobs', implement.attempts[0]!.job_id, 'result.json'), 'utf8')) as JobResult;
  assert.equal(implementResult.failure_reason, `check_failed:${logicalTaskCheckId('fmt')}`);
  const observed = implementResult.gbdev_observed.checks.find(c => c.source === 'task_check')!;
  assert.equal(observed.check_id, 'fmt');
  assert.notEqual(observed.exit_code, 0);
  const reviews = done.steps.filter(s => s.step_id === 'review');
  assert.ok(reviews.some(r => r.round === fix.round));
  for (const review of reviews) {
    const brief = JSON.parse(readFileSync(join(f.home, 'jobs', review.attempts[0]!.job_id, 'brief.json'), 'utf8'));
    assert.deepEqual(brief.execution_checks ?? [], []);
    const result = JSON.parse(readFileSync(join(f.home, 'jobs', review.attempts[0]!.job_id, 'result.json'), 'utf8')) as JobResult;
    assert.equal(result.gbdev_observed.checks.length, 0);
  }
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length, 2);
});

test('AC-B5-6 four criteria + task_checks share one physical runJobChecks execution', async t => {
  const f = tmpRepo(t, 'ok', { acceptance_criteria: [] });
  const counter = join(f.root, 'shared-count');
  const cmd = `echo 1 >> ${shPath(counter)} && echo ok`;
  const store = new JobStore(resolvePaths(f.env));
  const status = {
    ...job(undefined, new Date()), state: 'running' as const, repo: f.repo, worktree: f.repo,
    base_sha: f.git('rev-parse', 'HEAD').trim(), role: f.task.role, sandbox: 'workspace-write' as const,
    state_history: [{ state: 'running' as const, at: localIso(), by: 'gbdev' }],
  };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(paths.brief, f.task);
  atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE), captureWorkspaceSnapshotSync(f.repo, {
    job_id: status.job_id, phase: 'before_worker',
  }));
  mkdirSync(paths.checks, { recursive: true });
  let physical = 0;
  const results = await runJobChecks({
    criteria: criteriaFromBrief({
      acceptance_criteria: [1, 2, 3, 4].map(n => ({ id: `AC${n}`, text: `t${n}`, check_cmd: cmd })),
      execution_checks: [{ id: 'fmt', cmd, timeout_min: 1 }],
    }),
    cwd: f.repo,
    jobDir: paths.dir,
    cancelRequest: paths.cancelRequest,
    processInfo: paths.processInfo,
    env: f.env,
    onPhysicalStart: () => { physical++; },
  });
  assert.equal(physical, 1);
  assert.equal(results.length, 5);
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 1);
  const task = results.find(c => c.source === 'task_check')!;
  assert.equal(task.id, logicalTaskCheckId('fmt'));
  assert.equal(task.check_id, 'fmt');
  assert.ok(results.every(c => c.execution_id === results[0]!.execution_id));
});

test('AC-B5-7 read-only / inspect / final-review do not execute forwarded checks', t => {
  const root = temporary(t);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, allowed_repos: [root] }));
  const config = validateConfig({ version: 1, allowed_repos: [root] });
  const inspectBrief = validateBrief({
    schema: 'gbdev.task-brief.v1', brief_id: 'b_inspect', repo: root, base_ref: 'HEAD',
    role: 'inspector', sandbox: 'read-only', network: false, goal: 'q', context: '',
    constraints: [], allowed_paths: ['.'], acceptance_criteria: [], required_evidence: [],
    parent_job_id: null, answers: [],
  }, config);
  assert.deepEqual(inspectBrief.execution_checks ?? [], []);
  assert.deepEqual(criteriaFromBrief(inspectBrief), []);

  const f = runFixture(t);
  f.request.task_checks = ['test'];
  f.request.final_review = 'reviewer';
  const registry = new PipelineRegistry(f.paths.config);
  const finalReq = valueForDefinition(f.request, null, registry.resolve('review-only')) as {
    execution_checks: { id: string }[];
  };
  // Frozen on the pipeline request for change steps of final-fix, but review-only verdict briefs strip them.
  assert.deepEqual(finalReq.execution_checks.map(c => c.id), ['test']);
});

test('AC-B5-7b reviewer does not run task checks when implement already passed them', async t => {
  const marker = join(temporary(t), 'review-marker');
  const f = pipelineFixture(t, { 'implement#1': 'ok', 'review#1': 'review_approve' });
  const start = await f.start({
    execution_checks: [{ id: 'fmt', cmd: `echo 1 >> ${shPath(marker)}; true`, timeout_min: 1 }],
    acceptance_criteria: [{ id: 'AC1', text: 'ok', check_cmd: 'test -f src/ok.txt' }],
  });
  const done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded');
  assert.equal(readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length, 1);
  const review = done.steps.find(s => s.step_id === 'review')!;
  const brief = JSON.parse(readFileSync(join(f.home, 'jobs', review.attempts[0]!.job_id, 'brief.json'), 'utf8'));
  assert.deepEqual(brief.execution_checks ?? [], []);
  const result = JSON.parse(readFileSync(join(f.home, 'jobs', review.attempts[0]!.job_id, 'result.json'), 'utf8')) as JobResult;
  assert.deepEqual(result.gbdev_observed.checks, []);
});

test('AC-B5-8 cancel skips remaining task checks with null exit; rewrite clears reuse', async t => {
  const f = tmpRepo(t, 'ok', { acceptance_criteria: [] });
  const store = new JobStore(resolvePaths(f.env));
  const status = {
    ...job(undefined, new Date()), state: 'running' as const, repo: f.repo, worktree: f.repo,
    base_sha: f.git('rev-parse', 'HEAD').trim(), role: f.task.role, sandbox: 'workspace-write' as const,
    state_history: [{ state: 'running' as const, at: localIso(), by: 'gbdev' }],
  };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  mkdirSync(paths.checks, { recursive: true });
  writeFileSync(paths.cancelRequest, JSON.stringify({ at: localIso() }));
  const cancelled = await runJobChecks({
    criteria: criteriaFromBrief({
      acceptance_criteria: [],
      execution_checks: [{ id: 'fmt', cmd: 'sleep 30', timeout_min: 1 }],
    }),
    cwd: f.repo,
    jobDir: paths.dir,
    cancelRequest: paths.cancelRequest,
    processInfo: paths.processInfo,
    env: f.env,
  });
  assert.equal(cancelled[0]!.exit_code, null);
  assert.equal(cancelled[0]!.source, 'task_check');

  const counter = join(f.root, 'rewrite-count');
  const same = `echo 1 >> ${shPath(counter)}`;
  let physical = 0;
  await runJobChecks({
    criteria: criteriaFromBrief({
      acceptance_criteria: [
        { id: 'AC1', check_cmd: same },
        { id: 'REWRITE', check_cmd: 'printf changed > src/initial.txt' },
        { id: 'AC2', check_cmd: same },
      ],
      execution_checks: [{ id: 'fmt', cmd: same, timeout_min: 1 }],
    }),
    cwd: f.repo,
    jobDir: paths.dir,
    cancelRequest: join(paths.dir, 'no-cancel'),
    processInfo: paths.processInfo,
    env: f.env,
    onPhysicalStart: () => { physical++; },
  });
  assert.ok(physical >= 3);
});

test('AC-B5-8 round exhaustion keeps task_check failure evidence', async t => {
  const counter = join(temporary(t), 'round-count');
  const alwaysFail = `echo 1 >> ${shPath(counter)}; exit 1`;
  const f = pipelineFixture(t, {
    'implement#1': 'ok',
    'fix#1': 'fix_ok',
    'review#1': 'review_approve',
  });
  const start = await f.start({
    max_rounds: 1,
    acceptance_criteria: [{ id: 'AC1', text: 'ok', check_cmd: 'true' }],
    execution_checks: [{ id: 'fmt', cmd: alwaysFail, timeout_min: 1 }],
  });
  const done = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'needs_decision');
  assert.equal(done.state_reason, 'max_rounds_exceeded');
  const failed = done.steps.flatMap(s => s.attempts).map(a =>
    JSON.parse(readFileSync(join(f.home, 'jobs', a.job_id, 'result.json'), 'utf8')) as JobResult)
    .filter(r => r.gbdev_observed.checks.some(c => c.source === 'task_check' && c.exit_code !== 0));
  assert.ok(failed.length >= 1);
  assert.ok(failed[0]!.failure_reason?.startsWith('check_failed:task_check:'));
});

test('AC-B5-3/7 task and merge gate execute independently; run reviewers never run task checks', async t => {
  const f = runFixture(t);
  f.request.tasks = f.request.tasks!.slice(0, 1);
  f.request.lanes = 1;
  f.request.final_review = 'reviewer';
  const counter = join(f.root, 'gate-fmt-count');
  // Baseline/main has no src/a.txt yet — only fail when the task file contains BAD.
  const fmtCmd = `printf '%s|%s\\n' "$PWD" "$(git rev-parse HEAD)" >> ${shPath(counter)}; if test -f src/a.txt && grep -q BAD src/a.txt; then echo bad; exit 1; fi; echo ok`;
  f.request.checks = [
    { id: 'fmt', cmd: fmtCmd, timeout_min: 1 },
    { id: 'test', cmd: 'true', timeout_min: 1 },
  ];
  f.request.integration_checks = ['fmt', 'test'];
  f.request.task_checks = ['fmt'];
  f.fakePlan['a/implement#1'] = {
    sleep_ms: 30,
    actions: [{ type: 'write_file', path: 'src/a.txt', content: 'BAD\n' }],
  };
  f.fakePlan['fix#1'] = {
    actions: [{ type: 'write_file', path: 'src/a.txt', content: 'good\n' }],
  };
  f.fakePlan['review#1'] = 'review_approve';
  f.fakePlan['review#2'] = 'review_approve';
  f.savePlan();
  const { run, result } = await f.execute();
  assert.equal(run.state, 'succeeded');
  const lines = readFileSync(counter, 'utf8').trim().split('\n');
  const jobs = runJobs(f.store, run);
  const changes = jobs.filter(j => j.sandbox === 'workspace-write');
  assert.equal(changes.length, 2, 'implement + fixer');
  const changeMarkers = changes.map(j => {
    const report = JSON.parse(readFileSync(jobPaths(f.paths, j.job_id).result, 'utf8')) as JobResult;
    const check = report.gbdev_observed.checks.find(c => c.source === 'task_check')!;
    assert.ok(check);
    return `${realpathSync(j.worktree)}|${report.gbdev_observed.head_after}`;
  });
  assert.equal(result.merges.length, 1);
  const merge = mergeRecords(f.store, run)[0]!;
  assert.equal(merge.gate!.passed, true);
  assert.deepEqual(merge.gate!.checks.filter(c => c.id === 'fmt').map(c => c.exit_code), [0]);
  // Exact cwd/SHA markers distinguish baseline, both task jobs, and merged-HEAD gate.
  assert.deepEqual(lines.slice().sort(), [
    `${realpathSync(run.integration.worktree)}|${run.base_sha}`,
    ...changeMarkers,
    `${realpathSync(run.integration.worktree)}|${merge.merge_sha}`,
  ].sort());
  const gateDirs = readdirSync(join(f.paths.home, 'runs', run.run_id, 'merges')).filter(n => n.endsWith('.gate'));
  assert.equal(gateDirs.length, 1);
  assert.ok(existsSync(join(f.paths.home, 'runs', run.run_id, 'merges', gateDirs[0]!, 'fmt.log')));
  assert.ok(result.final_review);
  const reviews = jobs.filter(j => j.sandbox === 'read-only');
  assert.ok(reviews.some(j => j.pipeline_id), 'task pipeline reviewer was finalized');
  assert.equal(reviews.filter(j => j.job_id === result.final_review!.job_id).length, 1);
  for (const review of reviews) {
    const paths = jobPaths(f.paths, review.job_id);
    const brief = JSON.parse(readFileSync(paths.brief, 'utf8'));
    assert.deepEqual(brief.execution_checks ?? [], []);
    const report = JSON.parse(readFileSync(paths.result, 'utf8')) as JobResult;
    assert.deepEqual(report.gbdev_observed.checks, []);
    assert.deepEqual(readdirSync(paths.checks), []);
    assert.doesNotMatch(readFileSync(paths.events, 'utf8'), /task_check:/);
  }
});

test('B5 criterion and task check sharing catalog identity retain the same timeout', async t => {
  const f = runFixture(t);
  const task = f.request.tasks![0]!;
  f.request.checks = [{ id: 'shared', cmd: 'true', timeout_min: 17 }];
  f.request.integration_checks = ['shared'];
  f.request.task_checks = ['shared'];
  task.acceptance_criteria = [{ id: 'AC1', text: 'shared check', check: 'shared' }];
  const definition = new PipelineRegistry(f.paths.config).resolve('implement-review');
  const forwarded = valueForDefinition(f.request, task, definition) as {
    acceptance_criteria: { id: string; check_cmd: string; timeout_min: number }[];
    execution_checks: { id: string; cmd: string; timeout_min: number }[];
  };
  assert.equal(forwarded.acceptance_criteria[0]!.timeout_min, 17);
  assert.equal(forwarded.execution_checks[0]!.timeout_min, 17);
  const criteria = criteriaFromBrief(forwarded);
  let physical = 0;
  const results = await runJobChecks({
    criteria, cwd: f.repo, jobDir: join(f.root, 'shared-timeout-check'),
    cancelRequest: join(f.root, 'cancel.json'), processInfo: join(f.root, 'process.json'),
    env: process.env, onPhysicalStart: () => { physical++; },
  });
  assert.equal(physical, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.exit_code, 0);
  assert.equal(results[1]!.execution_id, results[0]!.execution_id);
  assert.deepEqual(criteria.map(c => c.timeout_min), [17, 17]);
});
