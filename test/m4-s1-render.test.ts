import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runCli } from '../src/cli.js';
import { validateEnvelope } from '../src/contracts/envelope.js';
import { JobRenderer, Tail } from '../src/render/job.js';
import { LineReader, MAX_LINE_BYTES } from '../src/render/lineReader.js';
import { HomeFs, RefusedPath } from '../src/render/homeFs.js';
import { sanitizeForTerminal } from '../src/render/sanitize.js';
import { redactSecrets } from '../src/render/redact.js';
import { cursor } from '../src/render/cursor.js';
import { ThinkingBuffer } from '../src/render/thinking.js';
import { displayPath, displayWidth, eventAt, formatLine, prepareLine, type RenderLine } from '../src/render/format.js';
import { job, temporary } from './helpers.js';
import { testEnv } from './helpers/run.js';

const id = 'j_20261025_1131_a7f3', at = '2026-10-25T11:31:02.000-07:00';
const fixture = (name: string) => readFileSync(join('test/fixtures', name), 'utf8');
function setup(t: TestContext, provider: 'codex' | 'cursor' | 'fake' = 'codex', state: 'running' | 'succeeded' = 'succeeded') {
  const root = temporary(t), home = join(root, 'home'), dir = join(home, 'jobs', id);
  mkdirSync(dir, { recursive: true });
  const status = { ...job(id), provider, state, worktree: provider === 'cursor' ? '/tmp/cursor-stream-fixture' : '/work/tree' };
  const save = () => writeFileSync(join(dir, 'job.json'), JSON.stringify(status)); save();
  testEnv(t, { GBDEV_HOME: home, GBDEV_CONFIG: join(root, 'do-not-read-config'), NO_COLOR: '1' });
  return { root, home, dir, status, save, raw: join(dir, provider === 'cursor' ? 'raw.json' : 'raw.jsonl') };
}
async function cli(args: string[]) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
function withoutTime(text: string): string[] { return text.trimEnd().split('\n').map(s => s.slice(9).trimEnd()); }
function plain(lines: RenderLine[]): string[] { return lines.map(l => `${l.tag.padEnd(6)} ${l.text}`.trimEnd()); }
async function render(home: string, options: ConstructorParameters<typeof JobRenderer>[2] = {}) {
  const renderer = new JobRenderer(home, id, options), lines: RenderLine[] = [];
  for await (const line of renderer.lines()) lines.push(line);
  return { lines, stats: renderer.stats };
}
for (const provider of ['codex', 'cursor', 'fake'] as const) test(`M4 AC-1 ${provider} logs golden and render-lines envelope`, async t => {
  const f = setup(t, provider);
  writeFileSync(f.raw, fixture(provider === 'cursor' ? 'cursor-stream-success.jsonl' : `${provider}-stream-render.jsonl`));
  const out = await cli(['logs', id, '--no-color']);
  assert.equal(out.code, 0); assert.equal(out.stderr, '');
  const expected = provider === 'codex' ? [
    'STEP   codex executor j_20261025_1131_a7f3 sandbox=workspace-write model=gpt-6-astra',
    'INIT   codex session abcdefgh', 'CMD    $ npm test', 'EXIT   ✓ 0', 'EDIT   M src/a.ts, A test/b.ts, D old.ts',
    'THINK  Inspect the tests.', 'MSG    result status=succeeded Implemented tests',
    'TURN   tokens in 12.3k (cached 10.1k) out 4.5k (reasoning 2.0k)', 'ERR    example failure', 'ERR    example error',
  ] : provider === 'cursor' ? [
    'STEP   cursor executor j_20261025_1131_a7f3 sandbox=workspace-write model=auto',
    'INIT   cursor model=Auto mode=default cwd=.', 'PROMPT (22 chars)', 'THINK  Preparing to reply with exactly "ok".',
    'MSG    ok', 'DONE   ok 14s (api 14s)',
  ] : [
    'STEP   fake executor j_20261025_1131_a7f3 sandbox=workspace-write model=fake', 'INIT   codex session fake1234', 'MSG    fake finished', '?      unknown',
  ];
  if (provider === 'codex') expected.push('NOTE   [backfill] untimestamped Codex raw uses read time, not event time');
  expected.push(`DONE   summary ${id} succeeded corrupt_lines=0 truncated_lines=0 skipped_bytes=0`);
  if (provider === 'fake') expected.push('NOTE   unknown_types unknown=2');
  assert.deepEqual(withoutTime(out.stdout), expected);
  const json = await cli(['logs', id, '--json']);
  assert.equal(json.stderr, ''); const envelope = validateEnvelope(JSON.parse(json.stdout)); assert.equal(envelope.ok, true);
  const result = JSON.parse(json.stdout).result;
  assert.deepEqual(plain(result.lines), expected); assert.equal(result.provider, provider);
  assert.equal(JSON.parse(json.stdout).contract_version, '1');
});

test('M4 AC-1 Cursor r4 result and all tool mappings omit bodies', async t => {
  const f = setup(t, 'cursor');
  writeFileSync(f.raw, JSON.stringify(JSON.parse(fixture('cursor-stdout-r4.json'))) + '\n');
  assert.ok((await cli(['logs', id])).stdout.includes('DONE   ok 4m19s (api 4m19s)'));
  const ctx = { at, worktree: '/work/tree', verbose: true };
  const tool = (name: string, args: unknown, result?: unknown, extra = {}) => cursor({ type: 'tool_call', subtype: result === undefined ? 'started' : 'completed', tool_call: { [name + 'ToolCall']: { args, result } }, ...extra }, ctx);
  assert.deepEqual(plain(tool('read', { path: '/work/tree/a' })), ['READ   a']);
  assert.deepEqual(plain(tool('grep', { pattern: 'foo', path: '/outside' })), ['GREP   /foo/ in ⚠outside /outside']);
  assert.deepEqual(plain(tool('glob', { globPattern: '*.ts' })), ['GLOB   *.ts']);
  assert.deepEqual(plain(tool('shell', { command: 'npm test', requestedSandboxPolicy: { networkAccess: true } })), ['CMD    $ npm test ⚠net']);
  assert.deepEqual(plain(tool('task', { description: 'review', subagentType: { custom: { name: 'reader' } }, prompt: 'HIDDEN' })), ['TASK   review (reader)']);
  assert.deepEqual(plain(tool('await', {})), ['WAIT']);
  assert.deepEqual(plain(tool('getMcpTools', { server: 'local' })), ['MCP    list-tools local']);
  for (const [name, flag] of [['edit', 'M'], ['write', 'A'], ['delete', 'D'], ['applyPatch', 'M']]) {
    assert.deepEqual(plain(tool(name!, { file_path: '/work/tree/a' })), [`EDIT   ${flag} a`]);
    assert.deepEqual(plain(tool(name!, {})), [`EDIT   (${name}ToolCall)`]);
  }
  assert.deepEqual(plain(tool('custom', { prompt: 'HIDDEN', query: 'query' })), ['TOOL   custom query']);
  assert.deepEqual(plain(tool('shell', {}, { wrapper: { exitCode: 1, stdout: 'output' } })), ['EXIT   ✗ 1', '       │ output']);
  assert.deepEqual(plain(tool('shell', {}, {})), ['EXIT   done']);
  assert.deepEqual(plain(tool('shell', {}, [{ nested: { exit_code: 2 } }])), ['EXIT   ✗ 2']);
  assert.deepEqual(plain(tool('glob', {}, { files: ['a', 'b'] })), ['       ↳ 2 files']);
  assert.deepEqual(plain(tool('grep', {}, { totalFiles: 3, body: 'HIDDEN' })), ['       ↳ 3 files']);
  assert.deepEqual(plain(tool('read', {}, { error: { message: 'HIDDEN' } })), ['ERR    read: failed']);
  assert.deepEqual(plain(tool('shell', {}, { failure: { message: 'bad command' } })), ['ERR    shell: bad command']);
  assert.deepEqual(plain(tool('read', {}, { body: 'HIDDEN' }, { duration_ms: 12300 })), ['       ↳ read 12.3s']);
  assert.deepEqual(plain(tool('read', {}, { body: 'HIDDEN' })), []);
  for (const [event, expected] of [
    [{ type: 'system', subtype: 'task_notification', title: 'task', status: 'done' }, 'NOTE   task: done'],
    [{ type: 'connection', subtype: 'reconnecting', attempt: 2, endpoint_url: 'HIDDEN' }, 'NET    reconnecting (attempt 2)'],
    [{ type: 'connection', subtype: 'reconnected' }, 'NET    reconnected'],
    [{ type: 'retry', subtype: 'starting', attempt: 3 }, 'RETRY  attempt 3'],
    [{ type: 'retry', subtype: 'resuming', checkpoint_turn_count: 4 }, 'RETRY  resuming from turn 4'],
    [{ type: 'result', subtype: 'success', is_error: true }, 'ERR    result success'],
  ] as const) assert.deepEqual(plain(cursor(event, ctx)), [expected]);
});

test('M4 AC-2 5000 thinking deltas coalesce to <=15 THINK lines, heap delta <32 MiB', async t => {
  const f = setup(t, 'cursor'); writeFileSync(f.raw, fixture('cursor-thinking-5k.jsonl'));
  const data = await measuredChild(t, f.root, `
    import { JobRenderer } from ${JSON.stringify('file://' + resolve('dist/src/render/job.js'))};
    import { LineReader } from ${JSON.stringify('file://' + resolve('dist/src/render/lineReader.js'))};
    globalThis.gc();
    const baseline = process.memoryUsage().heapUsed; let peak = baseline, count = 0;
    const original = LineReader.prototype.read;
    LineReader.prototype.read = function* (...args) {
      for (const entry of original.apply(this, args)) { peak = Math.max(peak, process.memoryUsage().heapUsed); yield entry; }
    };
    for await (const line of new JobRenderer(${JSON.stringify(f.home)}, ${JSON.stringify(id)}).lines()) {
      peak = Math.max(peak, process.memoryUsage().heapUsed); if (line.tag === 'THINK') count++;
    }
    console.log(JSON.stringify({ count, heapDelta: peak - baseline }));
  `);
  t.diagnostic(`THINK lines=${data.count}, isolated peak heap delta=${(data.heapDelta / 1048576).toFixed(2)} MiB`);
  assert.ok(data.count > 0 && data.count <= 15, String(data.count));
  assert.ok(data.heapDelta < 32 * 1048576, String(data.heapDelta));
});

test('M4 AC-2 live thinking threshold, idle flush, completion and bounded buffer', () => {
  const b = new ThinkingBuffer(); assert.deepEqual(b.add('a', at, 0, false), []);
  assert.deepEqual(b.idle(1999), []); assert.equal(b.idle(2000)[0]?.text, 'a'); assert.deepEqual(b.idle(3000), []);
  assert.equal(b.add('x'.repeat(400), at, 4000, false).length, 1);
  b.add('a'.repeat(100000), at, 5000, true); assert.ok(b.flush()[0]!.text.length <= 4096);
  b.add('中🙂'.repeat(5000), at, 6000, true); const unicode = b.flush()[0]!.text; assert.ok(Buffer.byteLength(unicode) <= 4096); assert.ok(!unicode.includes('�'));
});

test('M4 AC-4 corrupt, split UTF-8, partial and 2 MiB lines count exactly once', async t => {
  const f = setup(t, 'codex', 'running'); writeFileSync(f.raw, fixture('corrupt-and-partial.jsonl'));
  const reader = new LineReader(new HomeFs(f.home), `jobs/${id}/raw.jsonl`);
  assert.equal([...reader.read()].filter(v => v.kind === 'line').length, 2); assert.deepEqual([...reader.read()], []);
  appendFileSync(f.raw, 'tial"}}\n'); assert.equal([...reader.read()].filter(v => v.kind === 'line').length, 1);
  appendFileSync(f.raw, 'x'.repeat(2 * MAX_LINE_BYTES) + '\n');
  const out = [...reader.read()]; assert.equal(out.filter(v => v.kind === 'truncated').length, 1); assert.equal(reader.truncatedLines, 1);
  assert.deepEqual([...reader.read()], []);
  const data = await render(f.home); assert.equal(data.stats.corrupt_lines, 1); assert.equal(data.stats.truncated_lines, 1);
  assert.equal(data.lines.filter(l => l.text === 'partial').length, 1);
  const utf = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '中文' } }) + '\n');
  const split = utf.indexOf(Buffer.from('中')) + 1;
  writeFileSync(join(f.dir, 'utf'), utf.subarray(0, split)); const u = new LineReader(new HomeFs(f.home), `jobs/${id}/utf`);
  assert.deepEqual([...u.read()], []); appendFileSync(join(f.dir, 'utf'), utf.subarray(split));
  assert.ok([...u.read()].some(v => v.kind === 'line' && v.text.includes('中文')));
});

test('M4 AC-4 rotation by truncate and replacement resets partial and offsets', t => {
  const f = setup(t); writeFileSync(f.raw, 'old line\npending'); const r = new LineReader(new HomeFs(f.home), `jobs/${id}/raw.jsonl`);
  [...r.read()]; writeFileSync(f.raw, 'new\n'); assert.deepEqual([...r.read()], [{ kind: 'rotated', bytes: 0 }, { kind: 'line', text: 'new' }]);
  writeFileSync(join(f.dir, 'replacement'), 'replacement\n'); renameSync(join(f.dir, 'replacement'), f.raw);
  assert.deepEqual([...r.read()], [{ kind: 'rotated', bytes: 0 }, { kind: 'line', text: 'replacement' }]);
});

test('M4 AC-5 escape injection, unterminated strings and no-color outputs', async t => {
  const f = setup(t); writeFileSync(f.raw, fixture('escape-injection.jsonl'));
  for (const args of [[], ['--json']]) {
    const out = await cli(['logs', id, '--no-color', ...args]); assert.equal(out.code, 0); assert.match(out.stdout, /safe/); assert.match(out.stdout, /done/);
    if (args.includes('--json')) {
      const lines: RenderLine[] = JSON.parse(out.stdout).result.lines; assert.ok(lines.length > 0);
      for (const line of lines) assert.doesNotMatch(line.text, /[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    }
    assert.doesNotMatch(out.stdout, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    assert.doesNotMatch(out.stdout, /PAYLOAD|TITLE|SECRET/);
  }
  for (const control of ['\x1b]52;c;secret', '\x1bPsecret', '\x9d0;secret', '\x90secret']) assert.equal(sanitizeForTerminal('ok' + control), 'ok');
  assert.equal(sanitizeForTerminal('a\r\nb\t\u200b\u202e\u2066c'), 'ab\tc');
});

test('M4 AC-6 all secret patterns redact before width truncation, including verbose', async t => {
  const f = setup(t); writeFileSync(f.raw, fixture('fake-secrets.jsonl'));
  const rendered = await render(f.home); const msgs = rendered.lines.filter(l => l.tag === 'MSG');
  assert.equal(msgs.length, 25); for (const l of msgs) { assert.ok(l.text.includes('‹redacted›'), l.text); assert.doesNotMatch(l.text, /VALUE12345|PRIVATE BODY/); }
  const wrapped = prepareLine({ at, tag: 'MSG', text: 'sk-' + 'x'.repeat(500) }, 30); assert.ok(wrapped.every(l => !l.text.includes('xxx')));
  assert.equal(redactSecrets('authorization: Bearer abcdefghijklmnop'), 'authorization: ‹redacted›');
  writeFileSync(f.raw, JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, aggregated_output: 'password=VALUE12345\noutput' } }) + '\n');
  assert.doesNotMatch((await cli(['logs', id])).stdout, /output|VALUE12345/);
  const verbose = await cli(['logs', id, '--verbose']); assert.match(verbose.stdout, /‹redacted›/); assert.match(verbose.stdout, /│ output/);
});

test('M4 AC-6 hidden provider fields, prompt, MCP and read results never displayed', async t => {
  const f = setup(t, 'cursor'); const secret = 'HIDDEN_SENTINEL';
  writeFileSync(join(f.dir, 'provider.json'), JSON.stringify({ provider: 'cursor', role: 'reviewer', sandbox: 'readonly', model: 'auto', argv: [secret], env: { SECRET: secret } }));
  const events = [
    { type: 'system', subtype: 'init', apiKeySource: secret }, { type: 'user', message: { content: [{ text: secret }] } },
    { type: 'tool_call', subtype: 'started', tool_call: { taskToolCall: { args: { description: 'review', prompt: secret } } } },
    ...['getMcpTools', 'read', 'grep'].map(name => ({ type: 'tool_call', subtype: 'completed', tool_call: { [name + 'ToolCall']: { result: { output: secret, stdout: secret } } } })),
  ];
  writeFileSync(f.raw, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  for (const args of [[], ['--verbose'], ['--json', '--verbose']]) assert.doesNotMatch((await cli(['logs', id, ...args])).stdout, new RegExp(secret));
});

test('M4 AC-7 outside symlinks denied for raw, metadata, stderr and check logs', async t => {
  const f = setup(t); const outside = join(f.root, 'outside'); writeFileSync(outside, 'HIDDEN_OUTSIDE');
  symlinkSync(outside, f.raw); symlinkSync(outside, join(f.dir, 'provider.json')); symlinkSync(outside, join(f.dir, 'worker.log'));
  mkdirSync(join(f.dir, 'checks')); symlinkSync(outside, join(f.dir, 'checks', 'AC1.log'));
  writeFileSync(join(f.dir, 'events.jsonl'), JSON.stringify({ type: 'check', at, data: { id: 'AC1', exit_code: 1 } }) + '\n');
  const output = await cli(['logs', id, '--verbose', '--json']); assert.equal(output.code, 0);
  assert.match(output.stdout, /refused path outside GBDEV_HOME/); assert.doesNotMatch(output.stdout, /HIDDEN_OUTSIDE/);
  const fs = new HomeFs(f.home); assert.throws(() => fs.readUnderHome('../outside'), RefusedPath); assert.throws(() => fs.readUnderHome(outside), RefusedPath);
  symlinkSync(f.root, join(f.home, 'escape')); assert.throws(() => fs.readUnderHome('escape/outside'), RefusedPath);
});

test('M4 AC-8 follow backfills promptly, completes partial once, drains final bytes and exits', async t => {
  const f = setup(t, 'codex', 'running'); writeFileSync(f.raw, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }) + '\n');
  let stdout = '', stderr = '', settled = false;
  const promise = runCli(['logs', id, '--follow', '--no-color'], { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } }).then(code => { settled = true; return code; });
  try {
    await until(() => stdout.includes('first')); assert.match(stdout, /first/); assert.equal(settled, false);
    appendFileSync(f.raw, '{"type":"item.completed","item":{"type":"agent_message","text":"second');
    assert.doesNotMatch(stdout, /second/);
    appendFileSync(f.raw, '"}}\n'); f.status.state = 'succeeded'; f.save();
    assert.equal(await promise, 0); assert.equal(stderr, ''); assert.equal(stdout.match(/second/g)?.length, 1); assert.match(stdout, /DONE\s+summary .* succeeded/);
  } finally { f.status.state = 'succeeded'; f.save(); await promise; }
});

test('M4 AC-8 logs argument errors, unknown id and HELP', async t => {
  setup(t);
  for (const args of [[id, '--follow', '--json'], [id, '--tail', '-1', '--json'], [id, '--tail', '5001', '--json'], [id, '--from-start', '--tail', '2', '--json'], ['../bad', '--json'], ['--json'], [id, '--brief', 'x', '--json']]) {
    const out = await cli(['logs', ...args]); assert.equal(out.code, 2); assert.equal(JSON.parse(out.stdout).error.code, 'usage_error'); assert.equal(out.stderr, '');
  }
  assert.equal((await cli(['status', id, '--follow', '--json'])).code, 2);
  const absent = await cli(['logs', 'j_20261025_1131_ffff', '--json']); assert.equal(absent.code, 1); assert.equal(JSON.parse(absent.stdout).error.code, 'job_not_found');
  assert.match((await cli(['--help'])).stdout, /logs <job_id>.*--follow/);
});

test('M4 render width, paths, colors, tail ring, from-start and chronological sources', async t => {
  const f = setup(t); const ctx = { at, worktree: '/work/tree', userHome: '/users/test' };
  assert.equal(displayPath('/work/tree/a', ctx), 'a'); assert.equal(displayPath('/work/treeish/a', ctx), '⚠outside /work/treeish/a'); assert.equal(displayPath('/users/test/a', ctx), '⚠outside ~/a');
  for (const tag of ['THINK', 'MSG', 'CMD'] as const) {
    const lines = prepareLine({ at, tag, text: '中🙂a'.repeat(200) }, 40); assert.equal(lines.length, tag === 'CMD' ? 1 : 3);
    for (const l of lines) assert.ok(displayWidth(formatLine(l).trimEnd()) <= 40);
    assert.ok(lines.at(-1)!.text.endsWith('…'));
  }
  for (const timestamp_ms of [NaN, Infinity, 1e15, -1e15]) assert.equal(eventAt({ timestamp_ms }, at), at);
  assert.equal(eventAt({ at: 'bad' }, at), at);
  assert.equal(displayWidth('e\u0301中🙂'), 5); assert.match(formatLine({ at, tag: 'ERR', text: 'bad' }, true), /\x1b\[31m/);
  const ring = new Tail<number>(2); for (const n of [1, 2, 3, 4]) ring.push(n); assert.deepEqual(ring.all(), [3, 4]);
  writeFileSync(f.raw, [1, 3].map(n => JSON.stringify({ at: `2026-10-25T11:31:0${n}.000-07:00`, type: 'item.completed', item: { type: 'agent_message', text: `raw${n}` } })).join('\n') + '\n');
  writeFileSync(join(f.dir, 'events.jsonl'), JSON.stringify({ at: '2026-10-25T11:31:02.000-07:00', type: 'state_change', data: { state: 'running' } }) + '\n');
  const out = await cli(['logs', id, '--from-start', '--json']); const data = JSON.parse(out.stdout).result;
  assert.deepEqual(data.lines.filter((l: RenderLine) => ['MSG', 'STATE'].includes(l.tag)).map((l: RenderLine) => l.text), ['raw1', 'running', 'raw3']);
  assert.equal(JSON.parse((await cli(['logs', id, '--tail', '2', '--json'])).stdout).result.lines.length, 2);
  assert.deepEqual(JSON.parse((await cli(['logs', id, '--tail', '0', '--json'])).stdout).result.lines, []);
});

test('M4 checks and stderr tails redact, stdout is opt-in and logs are read-only', async t => {
  const f = setup(t); mkdirSync(join(f.dir, 'checks'));
  writeFileSync(join(f.dir, 'checks', 'AC1.log'), 'head\n' + Array.from({ length: 12 }, (_, i) => `line${i} password=VALUE12345`).join('\n'));
  writeFileSync(join(f.dir, 'worker.log'), '-----BEGIN RSA PRIVATE KEY-----\nBODY\n-----END RSA PRIVATE KEY-----\nstderr text\n');
  writeFileSync(join(f.dir, 'events.jsonl'), [{ type: 'check', at, data: { id: 'AC1', exit_code: 1, log: '/outside/ignored' } }, { type: 'check', at, data: { id: 'AC2', exit_code: 0, duration_s: 34 } }, { type: 'warning', at, data: { code: 'warn', message: 'message' } }, ...['heartbeat', 'worker_output', 'recovery_step'].map(type => ({ type, at, data: { message: 'HIDDEN' } }))].map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(f.dir, 'checks', 'criterion-2.log'), 'safe mapped check tail\n');
  appendFileSync(join(f.dir, 'events.jsonl'), JSON.stringify({ type: 'check', at, data: { id: 'free text id', exit_code: 1, log: 'checks/criterion-2.log' } }) + '\n');
  const before = readFileSync(join(f.dir, 'job.json'));
  const output = await cli(['logs', id, '--verbose']); assert.equal(output.code, 0);
  assert.match(output.stdout, /CHECK\s+✗ AC1 exit 1 \(checks\/AC1.log\)/); assert.match(output.stdout, /CHECK\s+✓ AC2 34s/);
  assert.doesNotMatch(output.stdout, /VALUE12345|BODY|HIDDEN|│ head|│ line1 /); assert.match(output.stdout, /│ line2 /);
  assert.match(output.stdout, /safe mapped check tail/); assert.match(output.stdout, /checks\/criterion-2.log/);
  assert.match(output.stdout, /stderr \+4 lines/); assert.match(output.stdout, /│ stderr text/);
  assert.deepEqual(readFileSync(join(f.dir, 'job.json')), before);
  assert.doesNotMatch((await cli(['logs', id])).stdout, /│ stderr text/);
});

test('M4 AC-26 render static safety and no network/process invocation', () => {
  const forbidden = ['send-keys', 'pipe-pane', 'run-shell', 'if-shell', 'source-file', 'set-environment', 'kill-server', 'shell: true', 'Object.keys(process.env)', 'JSON.stringify(process.env)', 'mcp.json', '.cursor/', '.codex/', 'node:child_process', 'node:http', 'node:net', 'fetch('];
  for (const name of readdirSync('src/render', { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name))) {
    const source = readFileSync(name, 'utf8'); for (const word of forbidden) assert.ok(!source.includes(word), `${name}: ${word}`);
    assert.equal(unsafeCode(source), false, name);
  }
});

// Isolated renderer process gives meaningful RSS/heap metrics independent of the full suite.
async function measuredChild(t: TestContext, root: string, source: string) {
  const file = join(root, 'measure.mjs'); writeFileSync(file, source);
  const child = spawn(process.execPath, ['--max-old-space-size=64', '--expose-gc', file], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  t.after(async () => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  const code = await done; clearTimeout(timeout); assert.equal(code, 0, stderr); return JSON.parse(stdout);
}
test('M4 AC-3 300 MiB logs --tail 400 completes <30s and RSS <150 MiB with SKIP', async t => {
  const f = setup(t); const fd = openSync(f.raw, 'w');
  try {
    const data = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'large fixture' } });
    const block = Buffer.from(data + ' '.repeat(65535 - data.length) + '\n');
    for (let i = 0; i < 4800; i++) writeSync(fd, block);
  } finally { closeSync(fd); }
  const data = await measuredChild(t, f.root, `
    import { logs } from ${JSON.stringify('file://' + resolve('dist/src/commands/logs.js'))};
    let output = ''; const start = Date.now();
    await logs(${JSON.stringify(f.home)}, ${JSON.stringify(id)}, { tail: '400', 'no-color': true }, text => { output += text; });
    console.log(JSON.stringify({ ms: Date.now() - start, rss: process.resourceUsage().maxRSS, output }));
  `);
  t.diagnostic(`300 MiB: ${data.ms} ms, peak RSS=${(data.rss / 1024).toFixed(2)} MiB`);
  const rendered = data.output.trimEnd().split('\n').filter((line: string) => !/^\S+ SKIP\s/.test(line));
  assert.equal(rendered.length, 400);
  assert.ok(data.ms < 30000, String(data.ms)); assert.ok(data.rss < 150 * 1024, String(data.rss)); assert.match(data.output, /SKIP\s+earlier 44.0 MiB/);
});

test('M4 AC-7 job metadata symlink and a symlink swapped between polls are refused', async t => {
  const f = setup(t); const fs = new HomeFs(f.home);
  writeFileSync(f.raw, 'inside\n'); const reader = new LineReader(fs, `jobs/${id}/raw.jsonl`);
  assert.equal([...reader.read()].length, 1);
  const outside = join(f.root, 'outside'); writeFileSync(outside, 'DO_NOT_READ');
  renameSync(f.raw, f.raw + '.old'); symlinkSync(outside, f.raw);
  assert.throws(() => [...reader.read()], RefusedPath);
  renameSync(join(f.dir, 'job.json'), join(f.dir, 'job.old')); symlinkSync(outside, join(f.dir, 'job.json'));
  const out = await cli(['logs', id, '--json']); assert.equal(out.code, 1);
  validateEnvelope(JSON.parse(out.stdout)); assert.match(out.stdout, /refused path outside GBDEV_HOME/); assert.doesNotMatch(out.stdout, /DO_NOT_READ/);
});

test('M4 follow supports cancellation, late raw file and bounded unknown type counts', async t => {
  const f = setup(t, 'codex', 'running');
  const controller = new AbortController(); const renderer = new JobRenderer(f.home, id, { follow: true, pollMs: 5, signal: controller.signal });
  const lines: RenderLine[] = [];
  const done = (async () => { for await (const line of renderer.lines()) { lines.push(line); if (line.tag === 'MSG') controller.abort(); } })();
  try {
    await delay(10); writeFileSync(f.raw, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'late file' } }) + '\n');
    await done; assert.equal(lines.filter(l => l.text === 'late file').length, 1);
  } finally { controller.abort(); await done; }
  f.status.state = 'succeeded'; f.save();
  writeFileSync(f.raw, Array.from({ length: 600 }, (_, i) => JSON.stringify({ type: `unknown-${i % 300}` })).join('\n') + '\n');
  const snapshot = await render(f.home); assert.equal(snapshot.lines.filter(l => l.tag === '?').length, 256);
  assert.ok(snapshot.lines.some(l => l.text === 'unknown_types unknown-0=2'));
  assert.ok(snapshot.lines.some(l => l.text.includes('unknown_types (other)=')));
});

test('M4 render-lines validates version 1 and rejects malformed contracts', async t => {
  setup(t); const out = JSON.parse((await cli(['logs', id, '--json'])).stdout);
  validateEnvelope(out);
  for (const [key, value] of Object.entries({ job_id: '../bad', provider: 'other', corrupt_lines: -1, truncated_lines: 1.5, skipped_bytes: '1', lines: [{ at, tag: 'INVALID', text: 'x' }] })) {
    assert.throws(() => validateEnvelope({ ...out, result: { ...out.result, [key]: value } }));
  }
  for (const line of [{ at: 'bad', tag: 'MSG', text: 'x' }, { at, tag: 'MSG', text: 4 }]) assert.throws(() => validateEnvelope({ ...out, result: { ...out.result, lines: [line] } }));
});

test('M4 AC-6 thinking truncation and live flush never expose credential continuations', () => {
  const buffer = new ThinkingBuffer();
  const first = buffer.add('sk-' + 'A'.repeat(450), at, 0, false);
  assert.equal(first[0]?.text, '‹redacted›');
  assert.deepEqual(buffer.add('A'.repeat(500), at, 10, false), []);
  buffer.add(' safe explanation', at, 20, false);
  assert.equal(buffer.flush()[0]?.text, 'safe explanation');
  buffer.clear(); buffer.add('sk-' + 'X'.repeat(20000), at, 30, true);
  assert.equal(buffer.flush()[0]?.text, '‹redacted›');
  buffer.clear(); buffer.add('-----BEGIN RSA PRIVATE KEY-----\n' + 'X'.repeat(10000), at, 40, true);
  buffer.add('Y'.repeat(10000) + '\n-----END RSA ', at, 50, true);
  buffer.add('PRIVATE KEY----- safe', at, 60, true);
  const output = buffer.flush()[0]?.text ?? ''; assert.doesNotMatch(output, /XXXX|YYYY/); assert.match(output, /safe/);
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'poll timed out'); await delay(10); }
}

test('M4 S-D3 punctuation and quoted key-value secrets are fully covered', () => {
  for (const value of ['password=abcdef,ghijkl', 'token=abcdef;ghijkl', '"api_key":"abcdef,ghijkl"}', 'secret=abcdef)ghijkl']) {
    const redacted = redactSecrets(value); assert.match(redacted, /‹redacted›/); assert.doesNotMatch(redacted, /abcdef|ghijkl/);
  }
});
test('M4 ThinkingBuffer explicit flush resets secret and private-key continuation', () => {
  const b = new ThinkingBuffer();
  for (const text of ['sk-' + 'A'.repeat(500), '-----BEGIN RSA PRIVATE KEY-----' + 'X'.repeat(5000)]) {
    b.add(text, at, 0, true); b.flush();
    b.add('ordinary explanation', at, 1, true); assert.equal(b.flush()[0]?.text, 'ordinary explanation');
  }
  b.add('sk-' + 'A'.repeat(500), at, 0, false); b.flush();
  b.add('after empty flush', at, 1, true); assert.equal(b.flush()[0]?.text, 'after empty flush');
});
test('M4 T21 retains bounded prefix and resumes after oversized line', t => {
  const f = setup(t); writeFileSync(f.raw, 'prefix' + 'x'.repeat(2 * MAX_LINE_BYTES) + '\nnext\n');
  const entries = [...new LineReader(new HomeFs(f.home), `jobs/${id}/raw.jsonl`).read()];
  assert.equal(entries[0]?.kind, 'truncated');
  if (entries[0]?.kind === 'truncated') { assert.ok(entries[0].text.startsWith('prefix')); assert.equal(Buffer.byteLength(entries[0].text), MAX_LINE_BYTES); }
  assert.deepEqual(entries[1], { kind: 'line', text: 'next' });
});
test('M4 corrupt WARN is limited to one per 100 corrupt lines', async t => {
  const f = setup(t); writeFileSync(f.raw, 'broken\n'.repeat(250));
  const data = await render(f.home); assert.equal(data.stats.corrupt_lines, 250);
  assert.equal(data.lines.filter(l => l.tag === 'WARN' && l.text.includes('corrupt JSON')).length, 3);
});

// Token spacing and computed member access must not bypass the recursive static guard.
function unsafeCode(source: string): boolean {
  const compact = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '')
    .replace(/\[['"]([a-zA-Z_][a-zA-Z_0-9]*)['"]\]/g, '.$1');
  return /(?:shell|['"]shell['"]):true|(?:Object\.(?:keys|values|entries)|JSON\.stringify)\(process\.env\)|fetch\(/.test(compact)
    || /['"](?:node:)?(?:child_process|https?|net|tls)['"]|core\/(?:proc|git|runtime|jobStore|supervise)|(?:run|pipeline)\/(?:supervisor|reconcile|store)/.test(compact);
}
test('M4 AC-26 static guard catches whitespace comments computed members and nested views', () => {
  for (const text of ['shell : /*comment*/ true', 'Object . keys (process . env)', 'JSON["stringify"](process["env"])', 'Object.entries(process.env)', 'fetch ("url")', 'import { spawn } from "child_process"']) assert.equal(unsafeCode(text), true, text);
  assert.equal(unsafeCode('const shell = false; const key = process.env.NO_COLOR;'), false);
});

test('M4 T21 oversized stderr retains safe prefix in verbose mode', async t => {
  const f = setup(t); writeFileSync(join(f.dir, 'worker.log'), 'safe-prefix password=abcdef,ghijkl ' + 'x'.repeat(2 * MAX_LINE_BYTES) + '\n');
  const out = await cli(['logs', id, '--verbose']); assert.equal(out.code, 0); assert.match(out.stdout, /worker.log prefix retained/); assert.match(out.stdout, /│ safe-prefix password=‹redacted›/); assert.doesNotMatch(out.stdout, /abcdef|ghijkl/);
});

test('M4 S2 P2 truncated valid JSON prefix is warned but never parsed', async t => {
  const f = setup(t); const prefix = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'MUST_NOT_RENDER' } });
  writeFileSync(f.raw, prefix + ' '.repeat(MAX_LINE_BYTES) + '\n');
  const out = await render(f.home); assert.equal(out.stats.truncated_lines, 1); assert.equal(out.stats.corrupt_lines, 0);
  assert.ok(out.lines.some(l => l.tag === 'WARN' && l.text.includes('truncated'))); assert.ok(out.lines.every(l => !l.text.includes('MUST_NOT_RENDER')));
});
