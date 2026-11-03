import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRepo, unwrap, eventually } from './helpers/tmpRepo.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { PipelineResult } from '../src/contracts/pipelineResult.js';
import { groupAlive } from '../src/core/proc.js';
import { validateEvent } from '../src/contracts/event.js';
function fixture(t: TestContext, plan: Record<string, string> = { 'implement#1': 'ok', 'review#1': 'review_approve' }) {
  const f = tmpRepo(t), planFile = join(f.root, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan)); f.env.GBDEV_FAKE_PLAN = planFile;
  const request = { schema: 'gbdev.pipeline-request.v1', request_id: 'pr_test', pipeline: 'implement-review', repo: f.repo, base_ref: 'HEAD', diff_base_ref: null,
    goal: 'Implement and review', context: '', constraints: [], allowed_paths: ['src/**'], acceptance_criteria: [{ id: 'AC1', text: 'ok exists', check_cmd: 'test -f src/ok.txt' }], required_evidence: [], network: false,
    step_overrides: { implement: { provider: 'fake' }, review: { provider: 'fake' }, fix: { provider: 'fake' } } };
  const launch = async (patch: Record<string, unknown> = {}, dryRun = false) => f.command(['pipeline', 'start', '--request', '-', ...(dryRun ? ['--dry-run'] : [])], JSON.stringify({ ...request, ...patch }));
  const start = async (patch: Record<string, unknown> = {}) => unwrap((await launch(patch)).envelope) as PipelineRun;
  const wait = async (id: string, withResult = false) => unwrap((await f.command(['pipeline', 'wait', id, '--timeout-ms', '60000', ...(withResult ? ['--with-result'] : [])])).envelope);
  const read = (id: string) => JSON.parse(readFileSync(join(f.home, 'pipelines', id, 'pipeline.json'), 'utf8')) as PipelineRun;
  return { ...f, request, launch, start, wait, read, pipelineDir: (id: string) => join(f.home, 'pipelines', id) };
}
test('AC-S3.1 implement-review approves in shared worktree; strict schemas and aggregate evidence', async t => {
  const f = fixture(t), initial = await f.start();
  const result = await f.wait(initial.pipeline_id, true) as PipelineResult;
  assert.equal(result.state, 'succeeded'); assert.equal(result.outcome, 'approved'); assert.equal(result.jobs_used, 2);
  const definition = JSON.parse(readFileSync(join(f.pipelineDir(initial.pipeline_id), 'definition.json'), 'utf8'));
  assert.ok(definition.steps.every((s: { provider: string }) => s.provider === 'fake'));
  const run = f.read(initial.pipeline_id), [implement, review] = run.steps.map(s => f.getJob(s.attempts[0]!.job_id));
  assert.equal(implement!.worktree, review!.worktree); assert.equal(review!.base_sha, f.result(implement!.job_id).gbdev_observed.head_after);
  assert.equal(implement!.pipeline_id, initial.pipeline_id); assert.equal(review!.step_instance, 'review#1');
  assert.equal(result.final_checks!.job_id, implement!.job_id); assert.equal(result.final_checks!.checks[0]!.exit_code, 0);
  assert.equal(result.final_verdict!.verdict, 'approve'); assert.ok(result.files_changed.includes('src/ok.txt'));
  for (const job of [implement!, review!]) {
    const schema = JSON.parse(readFileSync(join(f.jobDir(job.job_id), 'worker-result.schema.json'), 'utf8'));
    assert.ok(schema.properties.handoff); assert.equal(Boolean(schema.properties.review), job.role === 'reviewer');
    const brief = JSON.parse(readFileSync(join(f.jobDir(job.job_id), 'brief.json'), 'utf8'));
    assert.equal(brief.brief_id, `${initial.pipeline_id}:${job.step_instance}:1`);
    if (job.role === 'reviewer') assert.equal(brief.acceptance_criteria[0].check_cmd, undefined);
  }
  const prompt = readFileSync(join(f.jobDir(review!.job_id), 'prompt.md'), 'utf8');
  assert.ok(prompt.includes(`git diff ${initial.diff_base_sha}..HEAD`)); assert.match(prompt, /implement#1/);
  const events = readFileSync(join(f.pipelineDir(run.pipeline_id), 'events.jsonl'), 'utf8').trim().split('\n').map(s => validateEvent(JSON.parse(s)));
  assert.ok(events.some(e => e.type === 'gate' && e.data.rule === 'G13'));
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
  assert.equal((await f.command(['pipeline', 'result', run.pipeline_id])).exit, 0);
  const dry = unwrap((await f.command(['pipeline', 'cleanup', run.pipeline_id, '--dry-run'])).envelope) as { would_remove_worktree: boolean };
  assert.equal(dry.would_remove_worktree, true); assert.ok(existsSync(run.workspace.worktree));
  const cleaned = unwrap((await f.command(['pipeline', 'cleanup', run.pipeline_id])).envelope) as { job_id: null; pipeline_id: string; branch_retained_reason: string };
  assert.equal(cleaned.job_id, null); assert.equal(cleaned.pipeline_id, run.pipeline_id); assert.equal(cleaned.branch_retained_reason, 'unmerged_job_commits');
  assert.ok(!existsSync(run.workspace.worktree)); assert.ok(existsSync(f.jobDir(review!.job_id))); assert.ok(existsSync(f.pipelineDir(run.pipeline_id)));
});
for (const [scenario, state, reason] of [
  ['needs_input', 'needs_input', 'needs_input'], ['blocked', 'blocked', 'blocked'], ['outside_paths', 'failed', 'policy_violations:'], ['crash', 'needs_decision', 'step_failed'],
] as const) test(`AC-S3.2 ${scenario} propagation preserves job facts and stops progression`, async t => {
  const f = fixture(t, { 'implement#1': scenario }), start = await f.start(), run = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(run.state, state); assert.ok(run.state_reason!.startsWith(reason)); assert.equal(run.jobs_used, 1);
  const result = unwrap((await f.command(['pipeline', 'result', run.pipeline_id])).envelope) as PipelineResult;
  assert.equal(result.state, state); assert.ok(existsSync(run.workspace.worktree));
  if (scenario === 'needs_input') assert.deepEqual(result.pending_questions, f.result(run.current!.job_id).worker_reported!.open_questions);
  if (scenario === 'blocked') assert.equal(run.decision!.detail, f.result(run.current!.job_id).failure_reason);
  if (scenario === 'outside_paths') assert.equal(run.steps[1]!.state, 'skipped');
  else assert.equal(run.steps[1]!.state, 'pending');
  const cleanup = await f.command(['pipeline', 'cleanup', run.pipeline_id]);
  if (state !== 'failed') { assert.equal(cleanup.envelope.ok, false); if (!cleanup.envelope.ok) assert.equal(cleanup.envelope.error.code, 'pipeline_not_terminal'); }
});
test('AC-S3.3 running pipeline occupies slot for standalone and pipeline starts; wait timeout snapshot; cancellation', async t => {
  const f = fixture(t, { 'implement#1': 'slow' }), run = await f.start();
  const activeJob = await eventually(() => f.read(run.pipeline_id).current?.job_id);
  const owned = await f.command(['cleanup', activeJob, '--dry-run']);
  if (owned.envelope.ok) assert.fail('step job cleanup must be refused'); else assert.equal(owned.envelope.error.code, 'job_owned_by_pipeline');
  for (const output of [await f.command(['start', '--brief', f.briefFile]), await f.launch(), await f.launch({}, true)]) {
    assert.equal(output.envelope.ok, false); if (!output.envelope.ok) { assert.equal(output.envelope.error.code, 'busy'); assert.equal(output.envelope.error.details.running_pipeline_id, run.pipeline_id); }
  }
  const timed = await f.command(['pipeline', 'wait', run.pipeline_id, '--timeout-ms', '1000']);
  assert.equal(timed.exit, 1); if (!timed.envelope.ok) { assert.equal(timed.envelope.error.code, 'wait_timeout'); assert.equal((timed.envelope.error.details.pipeline as PipelineRun).pipeline_id, run.pipeline_id); }
  const activeResult = await f.command(['pipeline', 'result', run.pipeline_id]); assert.equal(activeResult.envelope.ok, false);
  const cancelled = unwrap((await f.command(['pipeline', 'cancel', run.pipeline_id])).envelope) as PipelineRun;
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.steps[1]!.state, 'skipped');
  assert.deepEqual(unwrap((await f.command(['pipeline', 'cancel', run.pipeline_id])).envelope), cancelled);
});
test('AC-S3.3 needs_input releases slot; multiple paused runs coexist; standalone blocks pipeline', async t => {
  const f = fixture(t, { 'implement#1': 'needs_input' }), a = await f.start(); await f.wait(a.pipeline_id);
  const b = await f.start(); await f.wait(b.pipeline_id); assert.notEqual(a.workspace.worktree, b.workspace.worktree);
  f.env.GBDEV_FAKE_SCENARIO = 'slow';
  const job = await tmpStandalone();
  async function tmpStandalone() { return unwrap((await f.command(['start', '--brief', f.briefFile])).envelope) as { job_id: string }; }
  const busy = await f.launch(); if (busy.envelope.ok) assert.fail('expected busy'); else assert.equal(busy.envelope.error.details.running_job_id, job.job_id);
  await f.command(['cancel', job.job_id]);
});
test('AC-S3.4 killed supervisor reconciles failed and terminates worker process group', async t => {
  const f = fixture(t, { 'implement#1': 'slow' }), initial = await f.start();
  const run = await eventually(() => { const r = f.read(initial.pipeline_id); if (r.current && existsSync(join(f.jobDir(r.current.job_id), 'fake-processes.json'))) return r; return undefined; });
  const processes = JSON.parse(readFileSync(join(f.jobDir(run.current!.job_id), 'fake-processes.json'), 'utf8')) as { worker: number; descendant: number };
  assert.ok(groupAlive(processes.worker)); process.kill(run.supervisor_pid!, 'SIGKILL');
  await eventually(async () => { const s = unwrap((await f.command(['pipeline', 'status', run.pipeline_id])).envelope) as PipelineRun; return s.state === 'failed' ? s : undefined; }, 20000);
  const failed = f.read(run.pipeline_id); assert.equal(failed.failure_reason, 'pipeline_supervisor_crashed');
  assert.equal(f.getJob(run.current!.job_id).state, 'failed'); assert.match(f.result(run.current!.job_id).failure_reason!, /worker_crashed/);
  await eventually(() => !groupAlive(processes.worker) ? true : undefined);
  assert.equal(failed.steps[1]!.state, 'skipped'); assert.equal((await f.command(['pipeline', 'result', run.pipeline_id])).exit, 0);
});
test('AC-S3.5 step cleanup is refused for active and terminal jobs including dry-run', async t => {
  const f = fixture(t), initial = await f.start(), run = await f.wait(initial.pipeline_id) as PipelineRun;
  for (const s of run.steps) for (const flags of [[], ['--dry-run'], ['--force-branch']]) {
    const output = await f.command(['cleanup', s.attempts[0]!.job_id, ...flags]);
    assert.equal(output.exit, 1); assert.equal(output.envelope.ok, false); if (!output.envelope.ok) assert.equal(output.envelope.error.code, 'job_owned_by_pipeline');
  }
  assert.ok(existsSync(run.workspace.worktree));
});
test('S3 templates, dry-run no writes, request/definition preflight and fail closed', async t => {
  const f = fixture(t), templates = unwrap((await f.command(['pipeline', 'templates'])).envelope) as { pipelines: unknown[] };
  assert.equal(templates.pipelines.length, 6);
  const dry = unwrap((await f.launch({}, true)).envelope) as PipelineRun;
  assert.equal(dry.pipeline_id, 'p_dry_run'); assert.equal(dry.state, 'queued'); assert.equal(dry.dry_run, true); assert.equal(existsSync(f.home), false);
  for (const [patch, code, exit] of [
    [{ step_overrides: { missing: { provider: 'fake' } } }, 'pipeline_invalid', 2],
    [{ step_overrides: { implement: { sandbox: 'read-only' } } }, 'pipeline_invalid', 2],
    [{ step_overrides: { implement: { cursor_model: 'other' } } }, 'cursor_model_not_allowed', 2],
    [{ pipeline: 'review-only', step_overrides: { review: { provider: 'fake' } } }, 'pipeline_invalid', 2],
    [{ pipeline: 'absent' }, 'pipeline_not_found', 1],
  ] as const) { const output = await f.launch(patch, true); assert.equal(output.exit, exit); if (output.envelope.ok) assert.fail('expected error'); else assert.equal(output.envelope.error.code, code); }
  assert.equal(existsSync(f.home), false);
  mkdirSync(join(f.root, 'pipelines')); writeFileSync(join(f.root, 'pipelines', 'broken.json'), '{}');
  const list = unwrap((await f.command(['pipeline', 'templates'])).envelope) as { invalid: unknown[] }; assert.equal(list.invalid.length, 1);
  assert.deepEqual(readdirSync(f.repo).sort(), ['.git', 'src']);
});
test('S3 review-only uses supplied diff base; read-only violations retain dirty worktree', async t => {
  const f = fixture(t, { 'review#1': 'readonly_violation' });
  const initial = await f.start({ pipeline: 'review-only', diff_base_ref: 'HEAD', step_overrides: { review: { provider: 'fake' } } });
  const run = await f.wait(initial.pipeline_id) as PipelineRun; assert.equal(run.state, 'failed'); assert.match(run.failure_reason!, /policy_violations:.*readonly_modified/);
  const cleanup = await f.command(['pipeline', 'cleanup', run.pipeline_id]); if (cleanup.envelope.ok) assert.fail('dirty worktree cannot be removed'); else assert.equal(cleanup.envelope.error.code, 'cleanup_refused');
});
test('S3 direct step cancel pauses pipeline under G2; snapshot commit includes run identity', async t => {
  const f = fixture(t, { 'implement#1': 'slow' }), initial = await f.start();
  const id = await eventually(() => f.read(initial.pipeline_id).current?.job_id);
  await f.command(['cancel', id]);
  const paused = await f.wait(initial.pipeline_id) as PipelineRun; assert.equal(paused.state_reason, 'step_cancelled');
  writeFileSync(f.env.GBDEV_FAKE_PLAN!, JSON.stringify({ 'implement#1': 'dirty_exit', 'review#1': 'review_approve' }));
  const second = await f.start({ acceptance_criteria: [] }), done = await f.wait(second.pipeline_id, true) as PipelineResult;
  assert.equal(done.state, 'succeeded'); assert.ok(done.commits.some(c => c.includes(`(${second.pipeline_id} implement#1)`)));
});

test('S3 simultaneous starts serialize under global lock', async t => {
  const f = fixture(t, { 'implement#1': 'slow' });
  const outputs = await Promise.all([f.launch(), f.launch()]);
  assert.equal(outputs.filter(o => o.envelope.ok).length, 1);
  const failure = outputs.find(o => !o.envelope.ok)!.envelope;
  if (failure.ok) assert.fail('expected busy'); else assert.equal(failure.error.code, 'busy');
});
test('S3 immutable role snapshots ignore post-start edits; main repo dirt is excluded; status list', async t => {
  const f = fixture(t, { 'implement#1': 'slow', 'review#1': 'review_approve' });
  writeFileSync(join(f.repo, 'untracked.txt'), 'not part of worktree');
  const run = await f.start(); assert.ok(run.warnings.includes('repo_dirty_changes_not_included'));
  assert.equal(existsSync(join(run.workspace.worktree, 'untracked.txt')), false);
  const snapshotFile = join(f.pipelineDir(run.pipeline_id), 'roles.snapshot.json'), before = readFileSync(snapshotFile, 'utf8');
  mkdirSync(join(f.root, 'roles')); writeFileSync(join(f.root, 'roles', 'reviewer.json'), '{invalid');
  const list = unwrap((await f.command(['pipeline', 'status'])).envelope) as PipelineRun[];
  assert.equal(list[0]!.pipeline_id, run.pipeline_id); assert.equal(readFileSync(snapshotFile, 'utf8'), before);
  const cancelled = unwrap((await f.command(['pipeline', 'cancel', run.pipeline_id])).envelope) as PipelineRun;
  assert.equal(cancelled.state, 'cancelled');
});
test('S3 report-only completes without change checks or final verdict', async t => {
  const f = fixture(t, { 'plan#1': 'plan_ok' });
  const run = await f.start({ pipeline: { schema: 'gbdev.pipeline.v1', name: 'report-only', description: 'Plan', steps: [{ id: 'plan', role: 'planner' }], timeout_min: 30 }, step_overrides: { plan: { provider: 'fake' } } });
  const result = await f.wait(run.pipeline_id, true) as PipelineResult;
  assert.equal(result.outcome, 'completed'); assert.equal(result.final_checks, null); assert.equal(result.final_verdict, null);
  assert.equal(f.result(f.read(run.pipeline_id).current!.job_id).gbdev_observed.checks.length, 0);
});
test('S3 legacy non-approving cases now use S4 rules (zero fix budget)', async t => {
  const f = fixture(t);
  for (const scenario of ['review_revise', 'review_reject', 'review_no_verdict', 'review_bad_verdict', 'review_approve_with_critical']) {
    writeFileSync(f.env.GBDEV_FAKE_PLAN!, JSON.stringify({ 'implement#1': 'ok', 'review#1': scenario }));
    const start = await f.start({ max_rounds: 0 }), run = await f.wait(start.pipeline_id) as PipelineRun;
    const missing = ['review_no_verdict', 'review_bad_verdict'].includes(scenario);
    assert.equal(run.state, 'needs_decision'); assert.equal(run.state_reason, missing ? 'verdict_missing' : scenario === 'review_reject' ? 'review_rejected' : 'max_rounds_exceeded'); assert.equal(run.jobs_used, missing ? 3 : 2); assert.equal(run.round, 0);
  }
  const start = await f.start({ max_rounds: 0, acceptance_criteria: [{ id: 'AC1', text: 'fail', check_cmd: 'exit 1' }] }), run = await f.wait(start.pipeline_id) as PipelineRun;
  assert.equal(run.state_reason, 'max_rounds_exceeded'); assert.equal(run.jobs_used, 1);
});
test('S3 request errors and missing provider create no run artifacts; template replacement does not merge', async t => {
  const f = fixture(t);
  writeFileSync(f.config, JSON.stringify({ version: 1, allowed_repos: [f.repo], providers: { codex: { bin: join(f.root, 'nonexistent') } } }));
  const missing = await f.launch({ step_overrides: { implement: { provider: 'codex' }, review: { provider: 'fake' }, fix: { provider: 'fake' } } });
  if (missing.envelope.ok) assert.fail('expected missing provider'); else assert.equal(missing.envelope.error.code, 'provider_not_found');
  assert.equal(existsSync(f.home), false);
  mkdirSync(join(f.root, 'pipelines')); writeFileSync(join(f.root, 'pipelines', 'implement-review.json'), JSON.stringify({ schema: 'gbdev.pipeline.v1', name: 'implement-review' }));
  const invalid = await f.launch(); if (invalid.envelope.ok) assert.fail('expected invalid replacement'); else assert.equal(invalid.envelope.error.code, 'pipeline_invalid');
  assert.equal(existsSync(f.home), false);
});
