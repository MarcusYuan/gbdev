import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { cursor, cursorMetadata } from '../src/providers/cursor.js';
import { jsonObjects } from '../src/providers/jsonOutput.js';
import { temporary } from './helpers.js';
import { tmpRepo } from './helpers/tmpRepo.js';

// Reduced from the scheduler's real cursor-agent stream-json sample; cwd anonymized.
const sample = readFileSync(resolve('test/fixtures/cursor-stream-success.jsonl'), 'utf8');
const sessionId = '00000000-0000-4000-8000-000000000001';
const jsonl = (objects: unknown[]) => objects.map(object => JSON.stringify(object)).join('\n') + '\n';

test('J1/J3: real Cursor success stream extracts ok and session without lifecycle errors', t => {
  const dir = temporary(t);
  writeFileSync(join(dir, 'raw.json'), sample);
  assert.equal(cursor.extractFinalMessage(dir), 'ok');
  assert.deepEqual(cursorMetadata(dir), { session_id: sessionId, failure_reason: null });
});

test('J1/J3: truncated Cursor stream concatenates assistant text and ignores a partial tail', t => {
  const dir = temporary(t);
  const objects = jsonObjects(sample).filter(object => object.type !== 'result');
  objects.push(
    { type: 'assistant', message: { content: [null, { type: 'image', text: 'ignored' }, { type: 'text', text: '\nReview ' }, { type: 'text', text: 'complete.' }] } },
    { type: 'assistant', message: null },
    { type: 'assistant', message: { content: 'not text blocks' } },
    { type: 'thinking', subtype: 'completed', session_id: 'last-session' },
  );
  writeFileSync(join(dir, 'raw.json'), jsonl(objects) + '{"type":"result","subtype":"error","result":"half');
  assert.equal(cursor.extractFinalMessage(dir), 'ok\nReview complete.');
  assert.deepEqual(cursorMetadata(dir), { session_id: 'last-session', failure_reason: null });
});

test('J1/J3: Cursor stream without result or assistant text has no message or provider failure', t => {
  const dir = temporary(t);
  writeFileSync(join(dir, 'raw.json'), jsonl(jsonObjects(sample).filter(object => !['result', 'assistant'].includes(String(object.type)))));
  assert.equal(cursor.extractFinalMessage(dir), null);
  assert.deepEqual(cursorMetadata(dir), { session_id: sessionId, failure_reason: null });
});

test('J1/J3: only the last Cursor result determines message and failure, not later lifecycle events', t => {
  const dir = temporary(t);
  const tail = [
    { type: 'system', subtype: 'init', result: 'not a final', session_id: 'latest-session' },
    { type: 'thinking', subtype: 'delta', is_error: true, result: 'not a result' },
    { type: 'thinking', subtype: 'completed' },
  ];
  for (const [result, reason] of [
    [{ subtype: 'error', result: 'failed' }, 'provider_error: error'],
    [{ subtype: 'success', is_error: true, result: 'failed' }, 'provider_error: is_error'],
    [{ is_error: true, result: 'failed' }, 'provider_error: is_error'],
    [{ subtype: 'success', is_error: false, result: 'last success' }, null],
  ] as const) {
    writeFileSync(join(dir, 'raw.json'), sample + jsonl([{ type: 'result', subtype: 'error', result: 'earlier failure' }, { type: 'result', ...result }, ...tail]));
    assert.equal(cursor.extractFinalMessage(dir), result.result);
    assert.deepEqual(cursorMetadata(dir), { session_id: 'latest-session', failure_reason: reason });
  }
  // An incomplete result envelope must not resurrect an earlier result or assistant.
  writeFileSync(join(dir, 'raw.json'), sample + jsonl([{ type: 'result', subtype: 'error' }]));
  assert.equal(cursor.extractFinalMessage(dir), null);
  assert.equal(cursorMetadata(dir).failure_reason, 'provider_error: error');
});

test('J1/J3: legacy untyped pretty-printed Cursor JSON remains compatible', t => {
  const dir = temporary(t);
  for (const subtype of ['success', 'error']) {
    writeFileSync(join(dir, 'raw.json'), JSON.stringify({ subtype, is_error: false, result: 'legacy final', session_id: 'legacy-session' }, null, 2));
    assert.equal(cursor.extractFinalMessage(dir), 'legacy final');
    assert.deepEqual(cursorMetadata(dir), { session_id: 'legacy-session', failure_reason: subtype === 'success' ? null : 'provider_error: error' });
  }
});

test('J1/J3: jsonObjects preserves hundreds of Cursor thinking deltas and tolerates a partial tail', t => {
  const dir = temporary(t);
  const objects = jsonObjects(sample);
  const deltas = Array.from({ length: 800 }, (_, index) => ({ type: 'thinking', subtype: 'delta', text: `Thinking ${index}: "quoted"\n中文`, session_id: sessionId }));
  objects.splice(2, 0, ...deltas);
  const raw = jsonl(objects).replaceAll('\n', '\r\n') + '{"type":"thinking","text":"partial';
  assert.deepEqual(jsonObjects(raw), objects);
  writeFileSync(join(dir, 'raw.json'), raw);
  assert.equal(cursor.extractFinalMessage(dir), 'ok');
  assert.deepEqual(cursorMetadata(dir), { session_id: sessionId, failure_reason: null });
});

test('J2: fake Cursor thinking stream outlives stall timeout and succeeds without stderr', async t => {
  const h = tmpRepo(t, 'no_json', { provider: 'cursor', role: 'reviewer', sandbox: 'read-only', stall_timeout_s: 2, acceptance_criteria: [] });
  const bin = join(h.root, 'stream-provider.mjs');
  writeFileSync(bin, `#!${process.execPath}
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
assert.equal(args[args.indexOf('--model') + 1], 'auto');
assert.equal(args[args.indexOf('--mode') + 1], 'plan');
assert.equal(args.includes('--force'), false);
const emit = object => console.log(JSON.stringify({ ...object, session_id: 'live-stream-session' }));
emit({ type: 'system', subtype: 'init' });
const heartbeat = setInterval(() => emit({ type: 'thinking', subtype: 'delta', text: 'Still reviewing.' }), 50);
setTimeout(() => {
  clearInterval(heartbeat);
  emit({ type: 'thinking', subtype: 'completed' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Review complete.' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'Review complete.' });
}, 3500);
`, { mode: 0o700 });
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { cursor: { bin } } }));
  const done = await h.wait((await h.launch()).job_id);
  const result = h.result(done.job_id);
  assert.equal(done.state, 'succeeded', JSON.stringify(result));
  assert.equal(done.failure_reason, null);
  assert.equal(result.failure_reason, null);
  assert.equal(result.worker_exit_code, 0);
  assert.equal(result.session_id, 'live-stream-session');
  assert.equal(done.session_id, result.session_id);
  assert.ok(result.duration_s > h.task.stall_timeout_s!);
  assert.equal(readFileSync(result.paths.final_message, 'utf8'), 'Review complete.');
  assert.equal(readFileSync(result.paths.worker_log, 'utf8'), '');
  const raw = jsonObjects(readFileSync(join(h.jobDir(done.job_id), 'raw.json'), 'utf8'));
  assert.ok(raw.filter(object => object.type === 'thinking' && object.subtype === 'delta').length >= 20);
  const events = jsonObjects(readFileSync(result.paths.events, 'utf8'));
  assert.ok(events.some(event => event.type === 'worker_output' && (event.data as { raw_events: number; exit_code?: number }).raw_events >= 20 && !('exit_code' in (event.data as object))));
  assert.ok(!events.some(event => (event.data as { code?: string }).code === 'worker_stalled'));
});

test('J1/J3: interrupted fake Cursor stream preserves assistant delivery and exit-code failure', async t => {
  const h = tmpRepo(t, 'no_json', { provider: 'cursor', sandbox: 'read-only', acceptance_criteria: [] });
  const bin = join(h.root, 'interrupted-provider.mjs');
  const raw = jsonl(jsonObjects(sample).filter(object => object.type !== 'result')) + '{"type":"result","subtype":"err';
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(raw)});\nprocess.exitCode = 23;\n`, { mode: 0o700 });
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { cursor: { bin } } }));
  const done = await h.wait((await h.launch()).job_id);
  const result = h.result(done.job_id);
  assert.equal(done.state, 'failed');
  assert.equal(done.failure_reason, 'worker_exit_nonzero:23');
  assert.equal(result.failure_reason, done.failure_reason);
  assert.equal(result.session_id, sessionId);
  assert.equal(readFileSync(result.paths.final_message, 'utf8'), 'ok');
});
