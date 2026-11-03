import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';
import { providerStub } from './helpers/providerStub.js';
import { fixture } from './helpers/m3.js';
import { testEnv } from './helpers/run.js';
import { worker } from './helpers.js';
import { startRun } from '../src/commands/run.js';
import { runPipeline } from '../src/commands/pipeline.js';
import { runJob } from '../src/run/jobs.js';
import { finalReview } from '../src/run/finalReview.js';
import { openIntegration } from '../src/run/integration.js';
import { LaneManager } from '../src/run/lanes.js';
import { jobPaths } from '../src/core/paths.js';
import { loadConfig } from '../src/core/config.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { resolveRequest } from '../src/contracts/pipelineRequest.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { PipelineSlotHooks } from '../src/pipeline/supervisor.js';

test('M3 safety argv: src and production dist have no approval bypass or disabled sandbox flags', () => {
  for (const root of ['src', 'dist']) for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name); if (path.includes('dist/test/')) continue;
    const source = readFileSync(path, 'utf8');
    assert.ok(!source.includes('--dangerously-bypass-approvals-and-sandbox'), path);
    assert.doesNotMatch(source, /--sandbox(?:\s+|['"`]\s*,\s*['"`])disabled/, path);
  }
});

const report = { ...worker(), files_changed: [], commits: [], tests: [], evidence: [], review: { verdict: 'approve', findings: [] }, resolution: { files: [], unresolved: [] } };
const hooks: PipelineSlotHooks = { async acquireSlot() {}, releaseSlot() {}, onRateLimit() {} };
function configure(root: string, config: string, repo: string) {
  const bin = providerStub(root), log = join(root, 'spawn-argv.jsonl');
  writeFileSync(config, JSON.stringify({ version: 1, allowed_repos: [repo], dashboard: { enabled: false }, providers: { codex: { bin }, cursor: { bin } } }));
  mkdirSync(join(root, 'roles'), { recursive: true });
  for (const name of ['executor', 'fixer', 'planner', 'resolver', 'verifier', 'reviewer']) {
    writeFileSync(join(root, 'roles', `${name}.json`), JSON.stringify({ schema: 'gbdev.role.v1', name, provider: 'codex', codex_model: 'gpt-6-astra' }));
  }
  return { bin, log };
}
function assertRecorded(dir: string, log: string, bin: string, sandbox: string) {
  const record = JSON.parse(readFileSync(join(dir, 'provider.json'), 'utf8'));
  const argv: string[] = record.argv, prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
  const received = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(entry => entry.args.includes(join(dir, 'final.md')));
  assert.equal(received.length, 1, 'one completed local stub invocation per job');
  assert.deepEqual(argv, received[0].args, 'persisted argv must equal actual child argv');
  assert.equal(record.cmd, bin); assert.equal(record.bin, bin); assert.equal(record.provider, 'codex');
  assert.equal(realpathSync(record.cwd), realpathSync(received[0].cwd));
  assert.deepEqual(argv.slice(-5), ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high', prompt]);
  assert.equal(argv.filter(arg => arg === '-m').length, 1);
  assert.equal(argv.filter(arg => arg === '-c').length, 1);
  assert.equal(argv[argv.indexOf('--sandbox') + 1], sandbox);
  assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!argv.includes('--sandbox=disabled')); assert.ok(!argv.includes('disabled'));
  assert.ok(!argv.includes('--add-dir'));
  assert.deepEqual(record.writable_roots, sandbox === 'workspace-write' ? [record.cwd] : []);
  return record;
}
const audit = (dir: string) => spawnSync(process.execPath, ['scripts/check-smoke-argv.mjs', '--ac30', dir], { encoding: 'utf8', timeout: 10_000 });

test('D-M4-1 standalone Codex spawn matches provider.json; real-format AC-30 high PASS and missing effort FAIL', async t => {
  const f = tmpRepo(t, 'ok', { provider: 'codex', model: 'gpt-6-astra', acceptance_criteria: [] });
  const { bin, log } = configure(f.root, f.config, f.repo);
  Object.assign(f.env, { GBDEV_STUB_LOG: log, GBDEV_STUB_REPORT: JSON.stringify(report) });
  const done = await f.wait((await f.launch()).job_id); assert.equal(done.state, 'succeeded');
  const dir = f.jobDir(done.job_id), record = assertRecorded(dir, log, bin, 'workspace-write');
  const passed = audit(dir); assert.equal(passed.status, 0, passed.stderr); assert.match(passed.stdout, /PASS .*gpt-6-astra/);
  const original = readFileSync(join(dir, 'provider.json'), 'utf8');
  writeFileSync(join(dir, 'provider.json'), JSON.stringify({ ...record, argv: record.argv.filter((arg: string) => arg !== '-c' && arg !== 'model_reasoning_effort=high') }));
  const failed = audit(dir); assert.equal(failed.status, 1); assert.match(failed.stdout, /FAIL .*missing model_reasoning_effort=high/);
  writeFileSync(join(dir, 'provider.json'), original);
});

test('D-M4-1 standalone pipeline Codex plan/implement/fix/review/verify argv preserve both sandboxes', async t => {
  const f = tmpRepo(t), { bin, log } = configure(f.root, f.config, f.repo);
  Object.assign(f.env, { GBDEV_STUB_LOG: log, GBDEV_STUB_REPORT: JSON.stringify(report) });
  const steps = [{ id: 'plan', role: 'planner' }, { id: 'implement', role: 'executor' }, { id: 'fix', role: 'fixer' }, { id: 'review', role: 'reviewer' }, { id: 'verify', role: 'verifier' }];
  const request = { schema: 'gbdev.pipeline-request.v1', request_id: 'argv', pipeline: { schema: 'gbdev.pipeline.v1', name: 'argv-paths', description: 'Codex argv paths', steps, timeout_min: 30 }, repo: f.repo, base_ref: 'main', goal: 'Check argv', context: '', constraints: [], allowed_paths: ['src/**'], acceptance_criteria: [], required_evidence: [], network: false };
  const run = unwrap((await f.command(['pipeline', 'start', '--request', '-'], JSON.stringify(request))).envelope) as PipelineRun;
  const done = unwrap((await f.command(['pipeline', 'wait', run.pipeline_id, '--timeout-ms', '60000'])).envelope) as PipelineRun;
  assert.equal(done.state, 'succeeded'); assert.equal(done.steps.length, steps.length);
  for (const step of done.steps) {
    assert.equal(step.attempts.length, 1);
    assertRecorded(f.jobDir(step.attempts[0]!.job_id), log, bin, ['implement', 'fix'].includes(step.step_id) ? 'workspace-write' : 'read-only');
  }
});

function runFixture(t: TestContext) {
  const f = fixture(t), { bin, log } = configure(f.root, f.paths.config, f.repo);
  testEnv(t, { GBDEV_STUB_LOG: log, GBDEV_STUB_REPORT: JSON.stringify({ ...report, task_graph: { schema: 'gbdev.task-graph.v1', summary: 'Plan', tasks: f.request.tasks } }) });
  return { ...f, bin, log };
}
for (const template of ['plan-implement-review', 'integration-fix', 'final-fix']) test(`D-M4-1 run-bound ${template} Codex argv recorded exactly`, async t => {
  const f = runFixture(t), manager = new LaneManager(f), lane = await manager.create(1, f.base), branch = manager.start(lane, 'a', f.base).branch;
  const done = await runPipeline(f.store, { schema: 'gbdev.pipeline-request.v1', request_id: 'argv', pipeline: template, repo: f.repo, base_ref: f.base, goal: 'Check argv', context: '', constraints: [], allowed_paths: ['src/**'], acceptance_criteria: [], required_evidence: [], network: false,
    run_binding: { run_id: f.run_id, task_id: 'a', lane: lane.lane, worktree: lane.worktree, branch } }, hooks);
  assert.equal(done.state, 'succeeded'); assert.ok(done.jobs_used >= 2);
  for (const step of done.steps) {
    assert.equal(step.attempts.length, 1);
    const id = step.attempts[0]!.job_id, job = f.store.read(id);
    assert.equal(job.provider, 'codex');
    assertRecorded(jobPaths(f.paths, id).dir, f.log, f.bin, job.sandbox);
  }
});
for (const role of ['planner', 'resolver', 'verifier', 'final_review']) test(`D-M4-1 run ${role} Codex argv recorded exactly`, async t => {
  const f = runFixture(t), run = await startRun(f.store, f.request, false);
  run.integration = await openIntegration({ paths: f.paths, repo: f.repo, run_id: run.run_id }, f.base);
  const roleName = role === 'final_review' ? 'reviewer' : role;
  const { snapshot } = resolveRequest({ schema: 'gbdev.pipeline-request.v1', request_id: 'argv', pipeline: { schema: 'gbdev.pipeline.v1', name: 'argv-role', description: 'Run role', steps: [{ id: 'step', role: roleName }], timeout_min: 30 }, repo: f.repo, base_ref: f.base, diff_base_ref: f.base, goal: 'Check argv', context: '', constraints: [], allowed_paths: ['src/**'], acceptance_criteria: [], required_evidence: [], network: false }, loadConfig(f.paths.config), new PipelineRegistry(f.paths.config));
  const signal = new AbortController().signal;
  const result = role === 'final_review'
    ? await finalReview(f.store, run, f.request, snapshot, hooks, signal)
    : await runJob(f.store, run, f.request, snapshot, hooks, signal, { instance: `run:${role}#1`, prompt: 'Local stub only', conflict_files: [], baseline: {} });
  assert.equal(f.store.read(result.job_id).state, 'succeeded');
  assertRecorded(jobPaths(f.paths, result.job_id).dir, f.log, f.bin, role === 'resolver' ? 'workspace-write' : 'read-only');
});
