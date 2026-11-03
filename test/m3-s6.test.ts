import assert from 'node:assert/strict';
import test from 'node:test';
import cp, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { temporary, job, brief, worker } from './helpers.js';
import { fixture } from './helpers/m3.js';
import { eventually } from './helpers/tmpRepo.js';
import { localIso } from '../src/core/time.js';
import { superviseJob } from '../src/core/supervise.js';
import { finalize } from '../src/core/finalize.js';
import { jobPaths } from '../src/core/paths.js';
import { groupAlive, signalGroup, terminateGroup } from '../src/core/proc.js';
import { setupWorkspace } from '../src/run/workspace.js';
import { git, head } from '../src/core/git.js';
import { landRun } from '../src/run/land.js';
import { cancelRun, startRun } from '../src/commands/run.js';
import { openIntegration } from '../src/run/integration.js';
import { writeRun } from '../src/run/store.js';
import { mergeRecords } from '../src/run/result.js';
import { runGate } from '../src/run/gate.js';
import { GbdevError } from '../src/contracts/error.js';
import { validateRunRequest, runRequestSchema } from '../src/contracts/runRequest.js';
import { assertSchema } from '../src/contracts/runValidation.js';
import { validateConfig } from '../src/core/config.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';

test('F29 initial SIGTERM EIO returns a rejected promise without synchronous or unhandled errors', async t => {
  const error = Object.assign(new Error('signal EIO'), { code: 'EIO' });
  t.mock.method(process, 'kill', (pid: number) => { assert.equal(pid, -123); throw error; });
  let stopping: Promise<void> | undefined;
  assert.doesNotThrow(() => { stopping = terminateGroup(123, 0, 0); void stopping.catch(() => {}); });
  // Leave rejection pending across a turn, as timer callers do until child close.
  // node:test fails this test on any uncaught exception or unhandled rejection.
  await delay(25);
  await assert.rejects(stopping!, e => e === error);
});

for (const caller of ['gate', 'finalize', 'supervise'] as const) test(`F29 ${caller} stop timer handles negative-pid EIO without uncaught errors`, async t => {
  const f = fixture(t), error = Object.assign(new Error('signal EIO'), { code: 'EIO' });
  const kill = process.kill.bind(process); let signals = 0;
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && signal !== 0) { signals++; throw error; }
    return kill(pid, signal);
  });
  if (caller === 'gate') {
    f.request.checks[0]!.cmd = 'sleep 0.3';
    await assert.rejects(runGate({ paths: f.paths, run_id: f.run_id, repo: f.repo, branch: `gbdev/${f.run_id}/integration`, worktree: f.repo }, f.request, ['test'], join(f.root, 'gate'), new AbortController().signal, 50), e => e === error);
  } else {
    const status = { ...job(), state: 'starting' as const, state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }], repo: f.repo, worktree: f.repo, base_sha: f.base, deadline_at: localIso(new Date(Date.now() + 1000)) };
    f.store.create(status); const paths = jobPaths(f.paths, status.job_id);
    const task = { ...brief(f.repo), acceptance_criteria: caller === 'finalize' ? [{ id: 'AC1', text: 'local check', check_cmd: 'sleep 0.3' }] : [] };
    if (caller === 'finalize') {
      // B2 skips pre-cancelled checks; exercise the stop timer only after physical startup.
      const stopped = assert.rejects(finalize(f.store, status, task, 0), e => e === error);
      await eventually(() => {
        if (!existsSync(paths.processInfo)) return undefined;
        const info = JSON.parse(readFileSync(paths.processInfo, 'utf8')) as { check_pgid?: number | null };
        return info.check_pgid ? true : undefined;
      });
      writeFileSync(paths.cancelRequest, '{}');
      await stopped;
    } else {
      status.step_instance = 'implement#1'; f.store.write(status);
      f.fakePlan['implement#1'] = { sleep_ms: 1500 }; f.savePlan();
      writeFileSync(paths.brief, JSON.stringify(task)); writeFileSync(paths.prompt, 'Fake provider EIO regression.');
      writeFileSync(join(paths.dir, 'provider.json'), JSON.stringify({ bin: process.execPath }));
      await assert.rejects(superviseJob(status.job_id, f.store), e => e === error);
    }
  }
  assert.ok(signals > 0, 'the timer must actually attempt a group signal');
  // Each local child self-exits and the caller waits for close before rejecting.
  await delay(25);
});

for (const state of ['Z', 'absent', 'S']) test(`F26 EPERM group ${state}: best effort signals and bounded termination`, async t => {
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  const mock = t.mock.method(cp, 'spawnSync', () => ({ status: 0, stdout: state === 'absent' ? '' : `123 123 ${state}\n`, stderr: '' }));
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  assert.doesNotThrow(() => signalGroup(123, 'SIGTERM'));
  assert.equal(groupAlive(123), state === 'S');
  if (state === 'S') await assert.rejects(terminateGroup(123, 0, 0), /process_group_still_alive/);
  else await terminateGroup(123, 10000, 5000);
});

test('F26 EPERM exited leader with live descendant remains alive', t => {
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  const mock = t.mock.method(cp, 'spawnSync', () => ({ status: 0, stdout: '124 123 S\n', stderr: '' }));
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(groupAlive(123), true);
});

for (const code of ['EPERM', 'EIO']) test(`F26 setup and Git timeout callbacks never throw ${code}`, async t => {
  const f = fixture(t);
  t.mock.method(process, 'kill', (pid: number) => { if (pid < 0) throw Object.assign(new Error(code), { code }); return true; });
  await assert.rejects(setupWorkspace({ paths: f.paths, repo: f.repo, run_id: f.run_id, worktree_setup_cmd: 'sleep 0.1', setup_timeout_ms: 1 }, 'lane-1', f.repo), /worktree_setup_failed/);
  await assert.rejects(git(f.repo, ['-c', 'alias.slow=!sleep 0.1', 'slow'], 1, new AbortController().signal), /timed out/);
});

test('F27 dirty integration is internal_error, not sync_conflict; target unchanged', async t => {
  const f = fixture(t), { run } = await f.execute();
  writeFileSync(join(f.repo, 'src/advance.txt'), 'target'); const target = f.commit(f.repo, 'advance');
  writeFileSync(join(run.integration.worktree, 'src/dirty.txt'), 'keep');
  await assert.rejects(landRun(f.store, run.run_id, 'main', true), e => e instanceof GbdevError && e.contract.code === 'internal_error' && e.contract.details.reason === 'integration_corrupt');
  assert.equal(head(f.repo), target); assert.equal(readFileSync(join(run.integration.worktree, 'src/dirty.txt'), 'utf8'), 'keep');
});

test('F27/F30 non-gate sync failure is internal_error with aborted_crash evidence and rollback', async t => {
  const f = fixture(t), { run } = await f.execute();
  writeFileSync(join(f.repo, 'src/advance.txt'), 'target'); const target = f.commit(f.repo, 'advance');
  // A malformed trusted snapshot fails after merge, not at the conflict precheck.
  writeFileSync(join(f.paths.home, 'runs', run.run_id, 'settings.snapshot.json'), '{}');
  await assert.rejects(landRun(f.store, run.run_id, 'main', true), e => e instanceof GbdevError && e.contract.code === 'internal_error');
  assert.equal(head(f.repo), target); assert.equal(head(run.integration.worktree), run.integration.verified_sha);
  const record = mergeRecords(f.store, run).at(-1)!;
  assert.equal(record.kind, 'sync'); assert.equal(record.result, 'aborted_crash'); assert.equal(record.gate, null);
  assert.equal(record.precheck.clean, true); assert.equal(record.rolled_back_to, run.integration.verified_sha);
});

test('F28/F33 CLI dead-supervisor cancel asynchronously restores integration HEAD and cleans worktree', async t => {
  const f = fixture(t), run = await startRun(f.store, f.request, false);
  await openIntegration({ paths: f.paths, repo: f.repo, run_id: run.run_id }, run.base_sha);
  writeFileSync(join(run.integration.worktree, 'src/extra.txt'), 'remove'); f.commit(run.integration.worktree, 'unverified');
  writeRun(f.store, run);
  const done = await cancelRun(f.store, run.run_id); assert.equal(done.state, 'cancelled'); assert.equal(head(run.integration.worktree), run.base_sha);
  assert.equal(done.integration.head_sha, run.base_sha);
  assert.equal(existsSync(join(run.integration.worktree, 'src/extra.txt')), false);
});

test('F31 SPEC and operator documentation consistently use the CLI --request option', () => {
  for (const path of ['docs/specs/SPEC-M3.md', 'docs/controller-recipe.md', 'docs/smoke-m3/README.md']) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /gbdev run start --request /, path);
    assert.ok(!source.includes('--request' + '-file'), path);
  }
});

for (let n = 1; n <= 8; n++) test(`S6 R${n} request schema and semantic validation without provider or external repository access`, t => {
  const root = temporary(t), value = JSON.parse(readFileSync(`docs/smoke-m3/r${n}-request.json`, 'utf8'));
  assertSchema(value, runRequestSchema); assert.equal(value.repo, '/path/to/gbdev-smoke'); assert.equal(value.base_ref, 'main');
  value.repo = root; // Only filesystem-dependent whitelist check is substituted.
  const result = validateRunRequest(value, validateConfig({ version: 1, allowed_repos: [root] }), new PipelineRegistry(join(root, 'config.json')));
  assert.equal(result.lanes, 2); assert.equal(result.task_pipeline_overrides.review?.cursor_model, 'auto');
  assert.doesNotMatch(JSON.stringify(value), /docs\/smoke-m3\/README\.md|见 README/);
  for (const layout of ['ESM .js', 'src/', 'test/', 'npm test', 'node:test', '离线', 'node:assert/strict']) assert.ok(result.context.includes(layout), layout);
});

const check = (...paths: string[]) => spawnSync(process.execPath, ['scripts/check-smoke-argv.mjs', ...paths], { encoding: 'utf8' });
function record(root: string, id: string, argv: unknown, provider = 'cursor') {
  const dir = join(root, 'jobs', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ job_id: id, provider, run_id: 'r1' }));
  writeFileSync(join(dir, 'provider.json'), JSON.stringify({ argv })); return dir;
}
test('AC-S6.2 checks job/run/jobs paths, deduplicates, skips other providers and never writes', t => {
  const root = temporary(t), dir = record(root, 'j1', ['--model', 'auto', '--sandbox', 'enabled']); record(root, 'j2', [], 'codex');
  const run = join(root, 'runs', 'r1'); mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'run.json'), JSON.stringify({ run_id: 'r1', tasks: [] }));
  const before = readFileSync(join(dir, 'provider.json'), 'utf8'); const result = check(dir, run, join(root, 'jobs'));
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /cursor=1 passed=1 failed=0 skipped=1/); assert.equal(readFileSync(join(dir, 'provider.json'), 'utf8'), before);
});
test('F32 bare home cannot turn a run with no Cursor evidence green using historical jobs', t => {
  const root = temporary(t); record(root, 'historical-cursor', ['--model', 'auto']);
  const run = join(root, 'runs', 'current'); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'run.json'), JSON.stringify({ run_id: 'current', tasks: [], integration: { branch: 'gbdev/current/integration' } }));
  for (const paths of [[root], [run], [run, root]]) {
    const result = check(...paths); assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /PASS historical-cursor/);
    if (paths.includes(root)) { assert.match(result.stderr, /home root is not allowed/); assert.match(result.stderr, /runs\/<id> or jobs\/<id>/); }
  }
});
test('F32 explicit --allow-home retains historical audit and deduplication', t => {
  const root = temporary(t), dir = record(root, 'j1', ['--model', 'auto']);
  const result = check('--allow-home', root, dir);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /cursor=1 passed=1 failed=0 skipped=0 errors=0/);
  record(root, 'bad', ['--model', 'other']);
  assert.equal(check(root, '--allow-home').status, 1, '--allow-home must not bypass argv validation');
});
for (const [label, argv] of Object.entries({ missing: undefined, model: ['--model', 'other'], bypass: ['--model', 'auto', '--dangerously-' + 'bypass-approvals-and-sandbox'], sandbox: ['--model', 'auto', '--sandbox', 'disabled'], equals: ['--model', 'auto', '--sandbox=disabled'], duplicate: ['--model', 'auto', '--model', 'other'], malformed: [3] })) test(`AC-S6.2 rejects ${label}`, t => {
  const root = temporary(t); const result = check(record(root, 'j1', argv)); assert.equal(result.status, 1); assert.match(result.stdout, /FAIL j1/);
});
test('AC-S6.2 missing paths, malformed records and no Cursor evidence fail closed', t => {
  const root = temporary(t); assert.equal(check(root).status, 1); assert.equal(check(join(root, 'missing')).status, 1);
  const dir = record(root, 'j1', []); writeFileSync(join(dir, 'job.json'), '{'); assert.equal(check('--allow-home', root).status, 1);
});


test('AC-S6.2 supervisor records exact Cursor argv sent to local stub (no real provider)', async t => {
  const f = fixture(t), captured = join(f.root, 'captured.json'), stub = join(f.root, 'cursor-stub.mjs');
  // This is a reviewer job: the argv fixture must also satisfy its verdict contract.
  const report = { ...worker(), review: { verdict: 'approve', findings: [] } };
  writeFileSync(stub, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({type:'result', result:${JSON.stringify(JSON.stringify(report))}}));\n`, { mode: 0o700 });
  const status = { ...job(), provider: 'cursor' as const, state: 'starting' as const, state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }], role: 'reviewer', sandbox: 'read-only' as const, repo: f.repo, worktree: f.repo, base_sha: f.base, deadline_at: localIso(new Date(Date.now() + 60000)) };
  f.store.create(status); const paths = jobPaths(f.paths, status.job_id);
  writeFileSync(paths.brief, JSON.stringify({ ...brief(f.repo), provider: 'cursor', role: 'reviewer', sandbox: 'read-only', model: 'auto', acceptance_criteria: [] }));
  writeFileSync(paths.prompt, 'Read only local stub test.'); writeFileSync(join(paths.dir, 'provider.json'), JSON.stringify({ bin: stub, writable_roots: [] }));
  await superviseJob(status.job_id, f.store);
  assert.equal(f.store.read(status.job_id).state, 'succeeded');
  const record = JSON.parse(readFileSync(join(paths.dir, 'provider.json'), 'utf8'));
  assert.deepEqual(record.argv, JSON.parse(readFileSync(captured, 'utf8'))); assert.equal(record.bin, stub); assert.equal(record.provider, 'cursor');
  assert.equal(check(paths.dir).status, 0);
});
