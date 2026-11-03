import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type Envelope } from '../src/contracts/envelope.js';
import { isTerminal } from '../src/contracts/jobStatus.js';
import { buildWorkerResultSchema, workerResultSchema } from '../src/contracts/workerResultSchema.js';
import { indexView } from '../src/render/views/index.js';
import { ViewFiles } from '../src/render/views/common.js';
import { localIso } from '../src/core/time.js';
import { eventually, tmpRepo } from './helpers/tmpRepo.js';

function inspector(root: string): void {
  mkdirSync(join(root, 'roles'), { recursive: true });
  writeFileSync(join(root, 'roles', 'inspector.json'), JSON.stringify({ schema: 'gbdev.role.v1', name: 'inspector', provider: 'fake' }));
}

function denied(output: { exit: number | null; envelope: Envelope }, code: string, exit = 2): void {
  assert.equal(output.envelope.ok, false);
  if (!output.envelope.ok) {
    assert.equal(output.envelope.error.code, code);
    assert.equal(output.exit, exit);
  }
}

function reason(output: { envelope: Envelope }): string | undefined {
  return output.envelope.ok ? undefined : String(output.envelope.error.details.reason ?? '');
}

async function finishedParent(t: Parameters<typeof tmpRepo>[0]) {
  const fx = tmpRepo(t, 'ok');
  inspector(fx.root);
  const started = await fx.launch();
  await fx.wait(started.job_id);
  return { fx, parentId: started.job_id };
}

async function stop(fx: ReturnType<typeof tmpRepo>, id: string): Promise<void> {
  try { if (!isTerminal(fx.getJob(id).state)) await fx.command(['cancel', id]); } catch { /* already gone */ }
}

test('inspect help, usage, and path rejection happen before a job exists', async t => {
  const fx = tmpRepo(t);
  inspector(fx.root);
  const help = await fx.command(['help']);
  assert.equal(help.envelope.ok, true);
  if (help.envelope.ok) assert.match(String((help.envelope.result as { text: string }).text), /inspect <run_id\|job_id> --question <text>/);
  denied(await fx.command(['inspect', '--question', 'missing id']), 'usage_error');
  denied(await fx.command(['inspect', 'j_20261031_1200_abcd']), 'usage_error');
  denied(await fx.command(['start', '--brief', fx.briefFile, '--question', 'no']), 'usage_error');
  denied(await fx.command(['inspect', 'j_20261031_1200_abcd', '--question', 'q', '--nope']), 'usage_error');
  denied(await fx.command(['inspect', 'j_20261031_1200_abcd', '--question', 'a', '--question', 'b']), 'usage_error');
  denied(await fx.command(['inspect', 'j_20261031_1200_abcd', '--question', '   ']), 'usage_error');
  denied(await fx.command(['inspect', 'j_20261031_1200_abcd', '--question', 'x'.repeat(4097)]), 'usage_error');
  denied(await fx.command(['inspect', 'j_20261031_1200_abcd', '--question', 'q', '--task', 'task']), 'usage_error');
  const many = ['inspect', 'j_20261031_1200_abcd', '--question', 'q'];
  for (let i = 0; i < 21; i++) many.push('--paths', `src/f${i}.txt`);
  denied(await fx.command(many), 'usage_error');
  const before = existsSync(join(fx.home, 'jobs')) ? readdirSync(join(fx.home, 'jobs')).length : 0;
  const badPath = await fx.command(['inspect', 'j_20261031_1200_abcd', '--question', 'q', '--paths', '../secret']);
  denied(badPath, 'inspect_path_invalid');
  denied(await fx.command(['inspect', 'j_20261031_1200_abcd', '--question', 'q', '--paths', '/etc/passwd']), 'inspect_path_invalid');
  denied(await fx.command(['inspect', 'j_20261031_1200_abcd', '--question', 'q', '--paths', 'src/*.txt']), 'inspect_path_invalid');
  const after = existsSync(join(fx.home, 'jobs')) ? readdirSync(join(fx.home, 'jobs')).length : 0;
  assert.equal(after, before);
});

test('inspect start result status and missing JSON or dirty writes', async t => {
  const { fx, parentId } = await finishedParent(t);
  const rawParent = JSON.parse(readFileSync(join(fx.jobDir(parentId), 'result.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(rawParent, 'inspection'), false);
  writeFileSync(join(fx.repo, 'src', 'UNCOMMITTED_SENTINEL.txt'), 'do-not-inspect\n');
  fx.env.GBDEV_FAKE_SCENARIO = 'inspect_ok';
  const started = await fx.command(['inspect', parentId, '--question', 'What is committed?', '--diff']);
  assert.equal(started.envelope.ok, true);
  assert.equal(started.exit, 0);
  if (!started.envelope.ok) return;
  assert.equal(started.envelope.result_schema, 'gbdev.inspect-start.v1');
  const start = started.envelope.result as { job_id: string; snapshot: { mode: string; uncommitted_included: boolean }; dashboard: { window: string }; notify: { enabled: boolean }; question: string };
  assert.equal(start.snapshot.mode, 'committed');
  assert.equal(start.snapshot.uncommitted_included, false);
  assert.equal(typeof start.dashboard.window, 'string');
  assert.equal(typeof start.notify.enabled, 'boolean');
  const id = start.job_id;
  t.after(() => stop(fx, id));
  const status = await fx.wait(id);
  assert.equal(status.state, 'succeeded');
  assert.equal(status.kind, 'inspect');
  assert.equal(status.run_id, undefined);
  assert.equal(status.pipeline_id, null);
  assert.equal(existsSync(join(status.worktree, 'src', 'UNCOMMITTED_SENTINEL.txt')), false);
  const result = fx.result(id);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.inspection?.answer.includes('Committed evidence'), true);
  assert.equal(result.worker_reported && 'inspection' in result.worker_reported, false);
  assert.equal(result.gbdev_observed.snapshot_commit, null);
  const listed = await fx.command(['result', id]);
  assert.equal(listed.envelope.ok, true);
  if (listed.envelope.ok) assert.equal((listed.envelope.result as { inspection: { schema: string } }).inspection.schema, 'gbdev.inspect-result.v1');
  const refs = fx.git('show-ref');
  assert.equal(refs.includes(`gbdev/${id}`), false);
  fx.git('branch', `gbdev/${id}`, status.base_sha);
  const cleaned = await fx.command(['cleanup', id, '--force-branch']);
  assert.equal(cleaned.envelope.ok, true);
  if (cleaned.envelope.ok) assert.equal((cleaned.envelope.result as { branch_deleted: boolean }).branch_deleted, false);
  assert.equal(fx.git('show-ref').includes(`gbdev/${id}`), true);
  const again = await fx.command(['cleanup', id, '--force-branch']);
  assert.equal(again.envelope.ok, true);
  fx.env.GBDEV_FAKE_SCENARIO = 'inspect_dirty';
  const dirtyStart = await fx.command(['inspect', parentId, '--question', 'Did the tree stay clean?']);
  assert.equal(dirtyStart.envelope.ok, true);
  if (!dirtyStart.envelope.ok) return;
  const dirtyId = (dirtyStart.envelope.result as { job_id: string }).job_id;
  t.after(() => stop(fx, dirtyId));
  await fx.wait(dirtyId);
  const dirty = fx.result(dirtyId);
  assert.equal(dirty.state, 'failed');
  assert.equal(dirty.inspection, null);
  assert.equal(dirty.gbdev_observed.snapshot_commit, null);
  fx.env.GBDEV_FAKE_SCENARIO = 'inspect_no_json';
  const prose = await fx.command(['inspect', parentId, '--question', 'Is prose enough?']);
  assert.equal(prose.envelope.ok, true);
  if (!prose.envelope.ok) return;
  const proseId = (prose.envelope.result as { job_id: string }).job_id;
  t.after(() => stop(fx, proseId));
  await fx.wait(proseId);
  const proseResult = fx.result(proseId);
  assert.equal(proseResult.state, 'failed');
  assert.equal(proseResult.failure_reason, 'inspect_result_invalid');
  assert.equal(proseResult.inspection, null);
});

test('active targets, recursive inspect, and output limit', async t => {
  const fx = tmpRepo(t, 'slow');
  inspector(fx.root);
  const parent = await fx.launch();
  await eventually(() => fx.getJob(parent.job_id).state === 'running' ? true : undefined);
  fx.env.GBDEV_FAKE_SCENARIO = 'inspect_ok';
  const active = await fx.command(['inspect', parent.job_id, '--question', 'What is the recorded base?']);
  assert.equal(active.envelope.ok, true);
  if (!active.envelope.ok) return;
  const activeId = (active.envelope.result as { job_id: string }).job_id;
  t.after(() => stop(fx, activeId));
  await fx.wait(activeId);
  const activeResult = fx.result(activeId);
  assert.equal(activeResult.state, 'succeeded');
  assert.equal(activeResult.inspection?.warnings.includes('active_target_base_only'), true);
  assert.equal(activeResult.inspection?.warnings.includes('uncommitted_excluded'), true);
  const nested = await fx.command(['inspect', activeId, '--question', 'Inspect the inspect?']);
  denied(nested, 'inspect_target_unavailable', 1);
  assert.equal(reason(nested), 'recursive_inspect');
  fx.env.GBDEV_FAKE_SCENARIO = 'inspect_flood';
  const flood = await fx.command(['inspect', parent.job_id, '--question', 'How large is the log?']);
  assert.equal(flood.envelope.ok, true);
  if (!flood.envelope.ok) return;
  const floodId = (flood.envelope.result as { job_id: string }).job_id;
  t.after(() => stop(fx, floodId));
  await fx.wait(floodId);
  assert.equal(fx.result(floodId).failure_reason, 'inspect_output_too_large');
  await stop(fx, parent.job_id);
});

test('dashboard index annotates inspect jobs and M1 schema bytes stay stable', t => {
  assert.equal(JSON.stringify(buildWorkerResultSchema()), JSON.stringify(workerResultSchema));
  assert.equal(JSON.stringify(buildWorkerResultSchema({ pipelineStep: false, output: 'change' })), JSON.stringify(workerResultSchema));
  const inspected = JSON.stringify(buildWorkerResultSchema({ pipelineStep: false, output: 'report', inspection: true }));
  assert.equal(inspected.includes('"inspection"'), true);
  assert.equal(JSON.stringify(workerResultSchema).includes('"inspection"'), false);
  const home = mkdtempSync(join(tmpdir(), 'gbdev-inspect-view-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sha = 'a'.repeat(40);
  const at = localIso();
  const write = (id: string, extra: Record<string, unknown>) => {
    mkdirSync(join(home, 'jobs', id), { recursive: true });
    writeFileSync(join(home, 'jobs', id, 'job.json'), JSON.stringify({
      job_id: id, state: 'running', updated_at: at, created_at: at, ...extra,
    }));
  };
  write('j_20261031_1201_aaaa', {});
  write('j_20261031_1201_bbbb', {
    kind: 'inspect', inspection: { target: { id: 'j_20261031_1200_cccc' }, snapshot: { target_sha: sha } },
  });
  const rows = indexView(new ViewFiles(home), Date.now(), { columns: 200 }).rows.join('\n');
  assert.match(rows, /j_20261031_1201_bbbb inspector j_20261031_1200_cccc aaaaaaa committed/);
  assert.equal(rows.includes('j_20261031_1201_aaaa inspector'), false);
});


test('stderr-only reaches the exact combined cap and is terminated; soft states never succeed', async t => {
  const { fx, parentId } = await finishedParent(t);
  const before = readFileSync(join(fx.jobDir(parentId), 'job.json'));
  for (const scenario of ['inspect_stderr_flood', 'inspect_needs_input', 'inspect_blocked']) {
    fx.env.GBDEV_FAKE_SCENARIO = scenario;
    const launched = await fx.command(['inspect', parentId, '--question', 'Inspect committed state']);
    assert.equal(launched.envelope.ok, true); if (!launched.envelope.ok) return;
    const id = (launched.envelope.result as { job_id: string }).job_id;
    t.after(() => stop(fx, id));
    await fx.wait(id);
    const result = fx.result(id);
    assert.equal(result.inspection, null);
    if (scenario === 'inspect_stderr_flood') {
      assert.equal(result.state, 'failed');
      assert.equal(result.failure_reason, 'inspect_output_too_large');
      assert.equal(statSync(join(fx.jobDir(id), 'raw.jsonl')).size, 0);
      assert.equal(statSync(join(fx.jobDir(id), 'worker.log')).size, 1024 * 1024);
    } else assert.equal(result.state, scenario.slice('inspect_'.length));
    assert.equal(existsSync(join(fx.home, 'inspect', 'lease.json')), false);
    assert.deepEqual(readFileSync(join(fx.jobDir(parentId), 'job.json')), before);
  }
});


test('AC-20 cleanup keeps inspectable objects; AC-23 tests reads logs without executing checks', async t => {
  const { fx, parentId } = await finishedParent(t);
  const recorded = fx.result(parentId).gbdev_observed.head_after;
  const resultPath = join(fx.jobDir(parentId), 'result.json');
  const report = JSON.parse(readFileSync(resultPath, 'utf8'));
  const sentinel = join(fx.root, 'tests-must-not-run');
  report.gbdev_observed.checks[0].cmd = `touch ${sentinel}`;
  writeFileSync(resultPath, JSON.stringify(report));
  const cleaned = await fx.command(['cleanup', parentId, '--force-branch']); assert.equal(cleaned.envelope.ok, true);
  assert.equal(existsSync(fx.getJob(parentId).worktree), false);
  assert.equal(fx.git('cat-file', '-t', recorded!).trim(), 'commit');
  fx.env.GBDEV_FAKE_SCENARIO = 'inspect_ok';
  for (const hasLog of [true, false]) {
    if (!hasLog) rmSync(join(fx.jobDir(parentId), report.gbdev_observed.checks[0].log));
    const launched = await fx.command(['inspect', parentId, '--question', 'Read recorded test evidence', '--tests']);
    assert.equal(launched.envelope.ok, true); if (!launched.envelope.ok) return;
    const id = (launched.envelope.result as { job_id: string }).job_id; await fx.wait(id);
    const result = fx.result(id); assert.equal(result.state, 'succeeded');
    assert.equal(result.inspection?.snapshot.target_sha, recorded);
    assert.equal(readFileSync(join(fx.getJob(id).worktree, 'src', 'ok.txt'), 'utf8'), 'fake ok\n');
    assert.equal(result.inspection?.coverage.tests.requested, true);
    assert.equal(result.inspection?.coverage.tests.checks[0]?.log_available, hasLog);
    const prompt = readFileSync(join(fx.jobDir(id), 'prompt.md'), 'utf8');
    assert.equal(prompt.includes('\"checked\"'), hasLog);
    if (!hasLog) assert.ok(result.inspection?.warnings.includes('log_unavailable'));
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(result.gbdev_observed.checks, []);
  }
});
