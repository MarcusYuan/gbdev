/**
 * M8 B6: Cursor exit 0 without usable worker-result — strict candidate recovery + existing retry.
 */
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { cursor } from '../src/providers/cursor.js';
import { fake } from '../src/providers/fake.js';
import {
  collectExplicitVerdicts,
  extractResultCandidates,
  selectStructuredCursorResult,
} from '../src/providers/cursorResults.js';
import { extractWorkerResult } from '../src/contracts/workerResult.js';
import { temporary, worker } from './helpers.js';
import { truncateUtf8Tail, appendMissingResultRetryPrompt, PREVIOUS_FINAL_SNIPPET_MAX_BYTES } from '../src/core/missingResultRetry.js';
import { VERDICT_RETRY_NOTICE } from '../src/core/prompt.js';
import { gate } from '../src/pipeline/gate.js';
import { result as sampleResult } from './helpers.js';
import { eventually, tmpRepo } from './helpers/tmpRepo.js';
import { testEnv } from './helpers/run.js';
import { fixture } from './helpers/m3.js';
import { superviseJob } from '../src/core/supervise.js';
import { finalReview } from '../src/run/finalReview.js';
import { runJobs } from '../src/run/invariants.js';
import type { RoleSnapshot } from '../src/contracts/pipelineRequest.js';
import { buildWorkerResultSchema } from '../src/contracts/workerResultSchema.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { localIso } from '../src/core/time.js';
import { finalize } from '../src/core/finalize.js';
import { job as sampleJob } from './helpers.js';
import {
  captureWorkspaceSnapshot, WORKSPACE_BEFORE,
} from '../src/core/workspaceSnapshot.js';
import { pipelineFixture } from './helpers/pipeline.js';
import { assertPipelineVerdictAccept } from '../src/core/verdictAcceptance.js';
import { GbdevError } from '../src/contracts/error.js';

const jsonl = (objects: unknown[]) => objects.map(o => JSON.stringify(o)).join('\n') + '\n';

const approveBody = () => ({
  ...worker(),
  files_changed: [],
  commits: [],
  tests: [],
  evidence: [],
  review: { verdict: 'approve' as const, findings: [] },
  handoff: { decided: [], rejected: [], risks: [], remaining: [] },
});

function writeRaw(dir: string, objects: unknown[] | string) {
  mkdirSync(dir, { recursive: true });
  const text = typeof objects === 'string' ? objects : jsonl(objects);
  writeFileSync(join(dir, 'raw.json'), text);
}

function fixtureStream(name: string): string {
  return readFileSync(resolve('test/fixtures', name), 'utf8');
}

/** Exercise legacy provider records in-process, with an isolated HOME and no detached CLI. */
function legacyCursorJob(t: TestContext, role = 'reviewer') {
  const h = tmpRepo(t, 'no_json', { provider: 'cursor', role, sandbox: 'read-only', acceptance_criteria: [], stall_timeout_s: 0 });
  testEnv(t, Object.fromEntries(Object.entries({ ...h.env, GBDEV_CLI_HOME: join(h.root, 'cli') })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)));
  const store = new JobStore(resolvePaths(h.env));
  const status = { ...sampleJob(), state: 'starting' as const, repo: h.repo, worktree: h.repo,
    base_sha: h.git('rev-parse', 'HEAD').trim(), provider: 'cursor' as const, role, sandbox: 'read-only' as const,
    deadline_at: localIso(new Date(Date.now() + 60_000)),
    state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }] };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id), bin = join(h.root, 'cursor-worker.mjs');
  atomicWriteJson(paths.brief, h.task);
  atomicWriteJson(join(paths.dir, 'provider.json'), { bin, writable_roots: [] });
  writeFileSync(paths.prompt, 'Review the workspace');
  writeFileSync(paths.rawJson, '');
  writeFileSync(paths.workerLog, '');
  const script = (source: string) => writeFileSync(bin, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return { h, store, status, paths, script };
}

const assistantApprove = () => ({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: JSON.stringify(approveBody()) }] } });
const terminal = (result = '') => ({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result });

test('AC-B6-1: terminal success without .result recovers assistant verdict JSON', t => {
  const dir = temporary(t);
  writeRaw(dir, fixtureStream('m8-b6-terminal-empty-assistant-verdict.jsonl'));
  // Legacy prose path still sees null .result → null from extract on terminal, no assistant fallback when terminal exists.
  assert.equal(cursor.extractFinalMessage(dir), null);

  const candidates = extractResultCandidates(dir, { output: 'verdict' });
  assert.equal(candidates[0]?.source, 'terminal_result');
  assert.equal(candidates[0]?.text, '');
  assert.equal(candidates[1]?.source, 'assistant_final');
  assert.ok(candidates[1]?.text.includes('approve'));

  const selected = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(selected.valid, true);
  assert.equal(selected.recovered_from_assistant, true);
  assert.equal(selected.selected?.source, 'assistant_final');
  assert.equal(extractWorkerResult(selected.selected!.text).review?.verdict, 'approve');
});

test('AC-B6-2: terminal prose recovers assistant; valid terminal wins over assistant', t => {
  const dir = temporary(t);
  writeRaw(dir, fixtureStream('m8-b6-terminal-prose-assistant-verdict.jsonl'));
  const recovered = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(recovered.valid, true);
  assert.equal(recovered.selected?.source, 'assistant_final');
  assert.equal(extractWorkerResult(recovered.selected!.text).summary, 'Assistant JSON');

  const terminalJson = JSON.stringify(approveBody());
  writeRaw(dir, [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: JSON.stringify({ ...approveBody(), summary: 'old assistant', review: { verdict: 'revise', findings: [{ id: 'F1', severity: 'major', file: null, line: null, message: 'x', suggestion: null }] } }) }] } },
    { type: 'result', subtype: 'success', is_error: false, result: terminalJson, session_id: 's' },
  ]);
  const preferTerminal = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(preferTerminal.valid, true);
  assert.equal(preferTerminal.selected?.source, 'terminal_result');
  assert.equal(extractWorkerResult(preferTerminal.selected!.text).summary, approveBody().summary);
  assert.equal(preferTerminal.recovered_from_assistant, false);
});

test('AC-B6-3: provider error / non-success terminal does not resurrect assistant approve', t => {
  const dir = temporary(t);
  const assistant = JSON.stringify(approveBody());
  writeRaw(dir, [
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: assistant }] } },
    { type: 'result', subtype: 'error', is_error: true, result: 'provider blew up', session_id: 's' },
  ]);
  const selected = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(selected.selected, null);
  assert.equal(selected.valid, false);
  assert.ok(selected.candidates.some(c => c.reject_reason === 'provider_failure'));
  // extractFinalMessage still returns terminal prose (compat); structured path blocks recovery.
  assert.equal(cursor.extractFinalMessage(dir), 'provider blew up');
});

test('AC-B6-4: user/tool/old-session/earlier-assistant approve are not selected', t => {
  const dir = temporary(t);
  const approve = JSON.stringify(approveBody());
  const revise = JSON.stringify({
    ...approveBody(),
    summary: 'final',
    review: { verdict: 'revise', findings: [{ id: 'F1', severity: 'major', file: null, line: null, message: 'need fix', suggestion: null }] },
  });
  writeRaw(dir, [
    { type: 'user', session_id: 'old', message: { content: [{ type: 'text', text: approve }] } },
    { type: 'tool_call', subtype: 'completed', session_id: 'old', tool_call: { createPlanToolCall: { result: approve } } },
    { type: 'assistant', session_id: 'old', message: { content: [{ type: 'text', text: approve }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'old' },
    // New session: earlier assistant approve, then final assistant revise, then prose terminal.
    { type: 'assistant', session_id: 'new', message: { content: [{ type: 'text', text: approve }] } },
    { type: 'assistant', session_id: 'new', message: { content: [{ type: 'text', text: revise }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Thanks.', session_id: 'new' },
  ]);
  const selected = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(selected.valid, true);
  assert.equal(selected.selected?.source, 'assistant_final');
  assert.equal(extractWorkerResult(selected.selected!.text).review?.verdict, 'revise');
  assert.equal(selected.selected?.session_id, 'new');
});

test('AC-B6-5: createPlan-only / prose / missing review / damaged / conflicting → invalid or missing', t => {
  const dir = temporary(t);

  writeRaw(dir, [
    { type: 'tool_call', subtype: 'started', session_id: 's', tool_call: { createPlanToolCall: {} } },
    { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's' },
  ]);
  assert.equal(selectStructuredCursorResult(dir, { output: 'verdict' }).selected, null);

  writeRaw(dir, [
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'Just some thoughts.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'All good.', session_id: 's' },
  ]);
  assert.equal(selectStructuredCursorResult(dir, { output: 'verdict' }).selected, null);

  const noReview = JSON.stringify({ ...worker(), files_changed: [], commits: [], tests: [], evidence: [] });
  writeRaw(dir, [
    { type: 'result', subtype: 'success', is_error: false, result: noReview, session_id: 's' },
  ]);
  const missingReview = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(missingReview.valid, false);
  assert.equal(missingReview.force_invalid, 'missing_review');

  writeRaw(dir, [
    { type: 'result', subtype: 'success', is_error: false, result: '{"schema":"gbdev.worker-result.v1",', session_id: 's' },
  ]);
  const damaged = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(damaged.valid, false);
  assert.ok(damaged.force_invalid?.startsWith('structured_invalid'));

  const approveFence = '```json\n' + JSON.stringify(approveBody()) + '\n```';
  const reviseFence = '```json\n' + JSON.stringify({
    ...approveBody(),
    review: { verdict: 'revise', findings: [{ id: 'F1', severity: 'major', file: null, line: null, message: 'x', suggestion: null }] },
  }) + '\n```';
  writeRaw(dir, [
    { type: 'result', subtype: 'success', is_error: false, result: `${approveFence}\n${reviseFence}`, session_id: 's' },
  ]);
  assert.deepEqual(new Set(collectExplicitVerdicts(`${approveFence}\n${reviseFence}`)), new Set(['approve', 'revise']));
  const conflict = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(conflict.valid, false);
  assert.equal(conflict.force_invalid, 'conflicting_verdicts');
});

test('AC-B6-9: CRLF, partial tail, and provenance indices are deterministic', t => {
  const dir = temporary(t);
  const assistant = JSON.stringify(approveBody());
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: assistant }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's' }),
  ];
  writeFileSync(join(dir, 'raw.json'), lines.join('\r\n') + '\r\n{"type":"thinking","text":"partial');
  const selected = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(selected.valid, true);
  assert.equal(selected.selected?.event_index, 1);
  assert.equal(selected.raw_file, 'raw.json');
});

test('AC-B6 snippet: previous final evidence prefers UTF-8 tail and stays bounded', () => {
  const big = '前'.repeat(20_000) + 'TAIL_MARKER_OK';
  const { excerpt, truncated } = truncateUtf8Tail(big, PREVIOUS_FINAL_SNIPPET_MAX_BYTES);
  assert.equal(truncated, true);
  assert.ok(excerpt.endsWith('TAIL_MARKER_OK'));
  assert.ok(Buffer.byteLength(excerpt, 'utf8') <= PREVIOUS_FINAL_SNIPPET_MAX_BYTES);
  const prompt = appendMissingResultRetryPrompt('BASE', {
    previousJobId: 'j_20261031_0000_abcd',
    previousFinalText: big,
    headSha: 'deadbeef',
  });
  assert.ok(prompt.startsWith('BASE' + VERDICT_RETRY_NOTICE));
  assert.ok(prompt.includes('previous_final_message_excerpt'));
  assert.ok(prompt.includes('TAIL_MARKER_OK'));
  assert.ok(prompt.includes('j_20261031_0000_abcd'));
  assert.ok(!prompt.includes('/jobs/'));
});

test('AC-B6-1 integration: supervise recovers assistant into final.md with provenance', async t => {
  const h = tmpRepo(t, 'no_json', {
    provider: 'cursor', role: 'reviewer', sandbox: 'read-only', acceptance_criteria: [],
  });
  const body = approveBody();
  const bin = join(h.root, 'cursor-b6-recover.mjs');
  writeFileSync(bin, `#!${process.execPath}
const approve = ${JSON.stringify(JSON.stringify(body))};
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'live-b6' }));
console.log(JSON.stringify({ type: 'assistant', session_id: 'live-b6', message: { content: [{ type: 'text', text: approve }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'live-b6' }));
`, { mode: 0o700 });
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { cursor: { bin } } }));

  // Standalone start pins the role output without enabling pipeline-only schema fields.
  const done = await h.wait((await h.launch()).job_id);
  const result = h.result(done.job_id);
  assert.equal(done.state, 'succeeded', JSON.stringify(result));
  assert.equal(result.worker_reported?.review?.verdict, 'approve');
  assert.equal(result.worker_result_source?.kind, 'assistant_final');
  assert.ok(result.worker_result_warnings.includes('worker_result_recovered_from_assistant'));
  const extraction = JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'result-extraction.json'), 'utf8'));
  assert.equal(extraction.recovered_from_assistant, true);
  assert.equal(extraction.selected.kind, 'assistant_final');
  assert.ok(existsSync(join(h.jobDir(done.job_id), 'raw.json')));
  assert.equal(readFileSync(join(h.jobDir(done.job_id), 'final.md'), 'utf8'), JSON.stringify(body));
  const options = JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'provider.json'), 'utf8')).schema_options;
  assert.equal(options.output, 'verdict');
  assert.deepEqual(buildWorkerResultSchema(options), buildWorkerResultSchema({ ...options, output: undefined }));
});

test('P1: standalone Cursor planner terminal report without review succeeds', async t => {
  const h = tmpRepo(t, 'no_json', { provider: 'cursor', role: 'planner', sandbox: 'read-only', acceptance_criteria: [] });
  const report = JSON.stringify({ ...worker(), files_changed: [], commits: [], tests: [], evidence: [] });
  const bin = join(h.root, 'cursor-report.mjs');
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(jsonl([terminal(report)]))});\n`, { mode: 0o700 });
  atomicWriteJson(h.config, { version: 1, allowed_repos: [h.repo], providers: { cursor: { bin } } });
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded', JSON.stringify(h.result(done.job_id)));
  assert.equal(h.result(done.job_id).worker_reported?.review, undefined);
  assert.equal(readFileSync(join(h.jobDir(done.job_id), 'final.md'), 'utf8'), report);
  const extraction = JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'result-extraction.json'), 'utf8'));
  assert.equal(extraction.valid, true);
  assert.equal(extraction.force_invalid, undefined);
  assert.equal(JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'provider.json'), 'utf8')).schema_options.output, 'report');
});

for (const role of ['planner', 'reviewer', 'unknown-legacy-role']) {
  test(`P1: legacy record without output resolves ${role} or retains prose extraction`, async t => {
    const f = legacyCursorJob(t, role);
    const report = JSON.stringify({ ...worker(), files_changed: [], commits: [], tests: [], evidence: [] });
    const events = role === 'reviewer' ? [assistantApprove(), terminal()] : [terminal(report)];
    f.script(`process.stdout.write(${JSON.stringify(jsonl(events))});`);
    await superviseJob(f.status.job_id, f.store);
    const result = f.h.result(f.status.job_id);
    assert.equal(result.state, 'succeeded', JSON.stringify(result));
    assert.equal(readFileSync(f.paths.finalMessage, 'utf8'), role === 'reviewer' ? JSON.stringify(approveBody()) : report);
    assert.equal(existsSync(join(f.paths.dir, 'result-extraction.json')), role !== 'unknown-legacy-role');
    if (role === 'reviewer') assert.equal(result.worker_result_source?.kind, 'assistant_final');
  });
}

test('P1: explicit report output takes precedence over reviewer role defaults', async t => {
  const f = legacyCursorJob(t);
  const providerFile = join(f.paths.dir, 'provider.json');
  atomicWriteJson(providerFile, { ...JSON.parse(readFileSync(providerFile, 'utf8')), schema_options: { output: 'report' } });
  const report = JSON.stringify({ ...worker(), files_changed: [], commits: [], tests: [], evidence: [] });
  f.script(`process.stdout.write(${JSON.stringify(jsonl([terminal(report)]))});`);
  await superviseJob(f.status.job_id, f.store);
  assert.equal(f.h.result(f.status.job_id).state, 'succeeded');
  assert.equal(readFileSync(f.paths.finalMessage, 'utf8'), report);
  assert.equal(JSON.parse(readFileSync(join(f.paths.dir, 'result-extraction.json'), 'utf8')).force_invalid, undefined);
});

for (const reason of ['cancelled', 'timeout'] as const) {
  test(`AC-B6-3 integration: ${reason} cannot become success through assistant approve`, async t => {
    const f = legacyCursorJob(t);
    if (reason === 'timeout') {
      f.status.deadline_at = localIso(new Date(Date.now() + 2000));
      f.store.write(f.status);
    }
    f.script(`process.stdout.write(${JSON.stringify(jsonl([assistantApprove()]))});\nsetInterval(() => {}, 1000);`);
    const running = superviseJob(f.status.job_id, f.store);
    await eventually(() => readFileSync(f.paths.rawJson, 'utf8').includes('approve') || undefined);
    if (reason === 'cancelled') atomicWriteJson(f.paths.cancelRequest, { by: 'test' });
    await running;
    const result = f.h.result(f.status.job_id);
    assert.equal(result.state, reason, JSON.stringify(result));
    assert.equal(f.store.read(f.status.job_id).state, reason);
    assert.ok(readFileSync(f.paths.rawJson, 'utf8').includes('approve'));
  });
}

test('P3: provider failure preserves terminal error prose, never assistant approve', async t => {
  const f = legacyCursorJob(t);
  f.script(`process.stdout.write(${JSON.stringify(jsonl([assistantApprove(), { ...terminal('provider blew up'), subtype: 'error', is_error: true }]))});`);
  await superviseJob(f.status.job_id, f.store);
  const result = f.h.result(f.status.job_id);
  assert.equal(result.state, 'failed');
  assert.ok(result.failure_reasons?.some(reason => reason.startsWith('provider_error')));
  assert.equal(result.worker_reported, null);
  assert.equal(readFileSync(f.paths.finalMessage, 'utf8'), 'provider blew up');
});

test('AC-B6-9: one JSONL event across deterministic byte chunks preserves raw and provenance', t => {
  const dir = temporary(t), raw = join(dir, 'raw.json');
  const text = jsonl([assistantApprove(), terminal()]).replaceAll('\n', '\r\n');
  const bytes = Buffer.from(text);
  writeFileSync(raw, '');
  // The final assistant is not a candidate until its JSON object is complete.
  appendFileSync(raw, bytes.subarray(0, 13));
  assert.deepEqual(extractResultCandidates(dir, { output: 'verdict' }), []);
  for (let offset = 13; offset < bytes.length; offset += 7) appendFileSync(raw, bytes.subarray(offset, offset + 7));
  appendFileSync(raw, '{"type":"result"');
  assert.deepEqual(readFileSync(raw), Buffer.concat([bytes, Buffer.from('{"type":"result"')]));
  const selected = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(selected.valid, true);
  assert.equal(selected.selected?.source, 'assistant_final');
  assert.equal(selected.selected?.event_index, 0);
  assert.equal(selected.raw_file, 'raw.json');
});

test('AC-B6-3 integration: exit nonzero with assistant approve still fails', async t => {
  const h = tmpRepo(t, 'no_json', {
    provider: 'cursor', role: 'reviewer', sandbox: 'read-only', acceptance_criteria: [],
  });
  const body = approveBody();
  const bin = join(h.root, 'cursor-b6-exit1.mjs');
  writeFileSync(bin, `#!${process.execPath}
const approve = ${JSON.stringify(JSON.stringify(body))};
console.log(JSON.stringify({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: approve }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's' }));
process.exit(1);
`, { mode: 0o700 });
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { cursor: { bin } } }));
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'failed');
  assert.ok((done.failure_reason ?? '').includes('worker_exit_nonzero') || (h.result(done.job_id).failure_reasons ?? []).some(r => r.startsWith('worker_exit_nonzero')));
});

test('AC-B6 finalize force_invalid does not last-wins approve on conflicting text', async t => {
  const h = tmpRepo(t, 'ok', { role: 'reviewer', sandbox: 'read-only', provider: 'fake', acceptance_criteria: [] });
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('GBDEV_')) delete process.env[key];
  Object.assign(process.env, h.env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const store = new JobStore(resolvePaths(h.env));
  const status = {
    ...sampleJob(), state: 'starting' as const, repo: h.repo, worktree: h.repo,
    base_sha: h.git('rev-parse', 'HEAD').trim(), role: 'reviewer', sandbox: 'read-only' as const,
    provider: 'fake' as const,
    state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }],
  };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(paths.brief, h.task);
  atomicWriteJson(join(paths.dir, 'provider.json'), {
    bin: process.execPath, writable_roots: [], schema_options: { pipelineStep: true, output: 'verdict' },
  });
  writeFileSync(paths.prompt, 'x');
  writeFileSync(paths.workerLog, '');
  writeFileSync(paths.rawJsonl, '');
  const approveFence = '```json\n' + JSON.stringify(approveBody()) + '\n```';
  const reviseFence = '```json\n' + JSON.stringify({
    ...approveBody(),
    review: { verdict: 'revise', findings: [{ id: 'F1', severity: 'major', file: null, line: null, message: 'x', suggestion: null }] },
  }) + '\n```';
  writeFileSync(paths.finalMessage, `${approveFence}\n${reviseFence}`);
  atomicWriteJson(join(paths.dir, 'result-extraction.json'), {
    selected: { kind: 'terminal_result', event_index: 0, raw_file: 'raw.json' },
    valid: false,
    recovered_from_assistant: false,
    force_invalid: 'conflicting_verdicts',
    candidates: [],
  });
  atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE), await captureWorkspaceSnapshot(h.repo, { job_id: status.job_id, phase: 'before_worker' }));
  const result = await finalize(store, status, h.task, 0);
  assert.equal(result.worker_reported, null);
  assert.ok(result.failure_reason?.includes('conflicting_verdicts'));
});

test('AC-B6-6/7: G9 missing-result retry once then pause; accept still guarded (M7 S2)', async t => {
  const f = pipelineFixture(t, { 'implement#1': 'dirty_exit', 'review#1': 'no_json' });
  const start = await f.start({ acceptance_criteria: [] });
  const paused = await f.wait(start.pipeline_id) as import('../src/contracts/pipelineRun.js').PipelineRun;
  assert.equal(paused.state_reason, 'verdict_missing');
  assert.equal(paused.jobs_used, 3);
  assert.equal(paused.steps[1]!.attempts.length, 2);
  assert.match(readFileSync(join(f.jobDir(paused.current!.job_id), 'prompt.md'), 'utf8'), /MUST end with valid worker-result JSON/);
  assert.match(readFileSync(join(f.jobDir(paused.current!.job_id), 'prompt.md'), 'utf8'), /previous_final_message_excerpt|Do not infer approve|exit 0/);
  const store = new JobStore(resolvePaths(f.env));
  assert.throws(
    () => assertPipelineVerdictAccept(store, paused, {
      action: 'accept', note: null, decision_id: 'd_b6_test',
    }),
    (e: unknown) => e instanceof GbdevError && (e.contract.code === 'verdict_evidence_required' || e.contract.code === 'verdict_retry_required' || e.contract.code === 'pipeline_state_conflict'),
  );
});

test('AC-B6-6: pipeline missing then approve adds one attempt and leaves first final/raw unchanged', async t => {
  const f = fixture(t);
  testEnv(t, { HOME: f.root, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config, GBDEV_CLI_HOME: join(f.root, 'cli') });
  f.request.tasks = [f.request.tasks![0]!];
  f.fakePlan['review#1'] = { by_execution: { '1': 'no_json', '2': 'review_approve' } };
  const saved = new Map<string, Buffer>();
  const build = fake.buildInvocation.bind(fake);
  t.mock.method(fake, 'buildInvocation', (ctx: Parameters<typeof build>[0]) => {
    if (ctx.stepInstance === 'review#1' && ctx.jobDir && existsSync(join(ctx.jobDir, 'job.json'))) {
      const job = JSON.parse(readFileSync(join(ctx.jobDir, 'job.json'), 'utf8'));
      if (job.attempt === 2) {
        const paths = jobPaths(f.paths, job.parent_job_id);
        for (const file of [paths.finalMessage, paths.rawJsonl]) saved.set(file, readFileSync(file));
      }
    }
    return build(ctx);
  });
  const { run } = await f.execute();
  assert.equal(run.state, 'succeeded', JSON.stringify(run.attention));
  const reviews = runJobs(f.store, run).filter(j => j.step_instance === 'review#1').sort((a, b) => a.attempt! - b.attempt!);
  assert.deepEqual(reviews.map(j => j.attempt), [1, 2]);
  assert.equal(run.budget.jobs_used, 3);
  assert.equal(saved.size, 2);
  for (const [file, bytes] of saved) assert.deepEqual(readFileSync(file), bytes, file);
  f.invariants(run.run_id);
});

test('AC-B6: r7 provider-error still does not resurrect earlier result via extractFinalMessage', t => {
  const dir = temporary(t);
  const sample = readFileSync(resolve('test/fixtures/cursor-stream-success.jsonl'), 'utf8');
  writeFileSync(join(dir, 'raw.json'), sample + jsonl([{ type: 'result', subtype: 'error' }]));
  assert.equal(cursor.extractFinalMessage(dir), null);
  const structured = selectStructuredCursorResult(dir, { output: 'verdict' });
  assert.equal(structured.selected, null);
});

test('AC-B6: gate still maps worker_result_missing to G9 retry then pause', () => {
  const missing = { ...sampleResult(), state: 'failed' as const, worker_reported: null, failure_reason: 'worker_result_missing', failure_reasons: ['worker_result_missing'] };
  assert.deepEqual(gate(missing, 'verdict', false, { attempts: 1 }), { rule: 'G9', action: 'retry' });
  assert.equal(gate(missing, 'verdict', false, { attempts: 1, verdictRetried: true }).action, 'settle');
  assert.equal(gate(missing, 'verdict', false, { attempts: 1, verdictRetried: true }).reason, 'verdict_missing');
});

for (const mode of ['fallback', 'retry', 'exhausted'] as const) {
  test(`AC-B6-6/8: Cursor final review ${mode} uses bounded jobs/calls/slots and preserves prior evidence`, async t => {
    const f = fixture(t);
    testEnv(t, { HOME: f.root, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config, GBDEV_CLI_HOME: join(f.root, 'cli') });
    f.request.tasks = [f.request.tasks![0]!];
    const { run } = await f.execute();
    const budgetBefore = run.budget.jobs_used;
    const calls = join(f.root, 'cursor-calls'), bin = join(f.root, 'cursor-final-review.mjs');
    const recovered = jsonl([assistantApprove(), terminal()]);
    const missing = jsonl([terminal('Review completed, but structured report is missing.')]);
    writeFileSync(bin, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const calls = ${JSON.stringify(calls)};
const attempt = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\\n').length + 1 : 1;
appendFileSync(calls, 'call\\n');
process.stdout.write(${JSON.stringify(mode)} === 'fallback' || (${JSON.stringify(mode)} === 'retry' && attempt === 2)
  ? ${JSON.stringify(recovered)} : ${JSON.stringify(missing)});
`, { mode: 0o700 });
    const snapshot: RoleSnapshot = {
      schema: 'gbdev.role-snapshot.v1', pipeline_id: '', resolved_at: localIso(),
      steps: { review: { role: 'reviewer', source: 'builtin', output: 'verdict', sandbox: 'read-only',
        provider: 'cursor', model: 'auto', timeout_min: 1, stall_timeout_s: 0, bin } },
      instructions_text: { reviewer: 'Review the changes and return worker-result JSON.' }, instructions_sha256: {},
    };
    let acquired = 0, released = 0, active = 0, created = 0;
    const saved = new Map<string, Buffer>();
    const reviews = () => runJobs(f.store, run).filter(j => j.step_instance?.startsWith('run:final_review#'))
      .sort((a, b) => a.attempt! - b.attempt!);
    const result = await finalReview(f.store, run, f.request, snapshot, {
      acquireSlot: async () => { assert.equal(active, 0); active++; acquired++; },
      releaseSlot: () => {
        assert.equal(active, 1); active--; released++;
        // Snapshot first-attempt bytes before the retry is created or launched.
        if (released === 1) {
          const paths = jobPaths(f.paths, reviews()[0]!.job_id);
          for (const file of [paths.finalMessage, paths.rawJson]) saved.set(file, readFileSync(file));
        }
      },
      onJobCreated: () => { assert.equal(active, 1); created++; run.budget.jobs_used++; },
      onRateLimit: () => assert.fail('No rate limit expected'),
    }, new AbortController().signal);
    const expected = mode === 'fallback' ? 1 : 2;
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, expected);
    assert.deepEqual({ acquired, released, active, created }, { acquired: expected, released: expected, active: 0, created: expected });
    assert.equal(run.budget.jobs_used - budgetBefore, expected);
    assert.equal(reviews().length, expected);
    assert.deepEqual(reviews().map(j => j.attempt), expected === 1 ? [1] : [1, 2]);
    assert.equal(result.verdict, mode === 'exhausted' ? null : 'approve');
    for (const [file, bytes] of saved) assert.deepEqual(readFileSync(file), bytes, file);
    if (expected === 2) {
      assert.equal(reviews()[1]!.parent_job_id, reviews()[0]!.job_id);
      const prompt = readFileSync(jobPaths(f.paths, reviews()[1]!.job_id).prompt, 'utf8');
      assert.ok(prompt.includes('previous_final_message_excerpt'));
      assert.ok(prompt.includes('Review completed, but structured report is missing.'));
    }
    if (mode !== 'exhausted') {
      const last = JSON.parse(readFileSync(jobPaths(f.paths, result.job_id).result, 'utf8'));
      assert.equal(last.worker_result_source.kind, 'assistant_final');
    }
  });
}
