import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { policyFixture } from './helpers/m9.js';
import { providerRateLimit } from '../src/core/providerRateLimit.js';
import { isRetryableRateLimit } from '../src/run/scheduler.js';

const cases = [
  { id: 'aee8 Cursor tool text success', provider: 'cursor', exit: 0, valid: true, limited: false, events: [{ type: 'tool', result: '.contains("rate limit") login rate limit exceeded' }, { type: 'result', subtype: 'success', is_error: false, result: 'success' }], stderr: '' },
  { id: 'f898 Codex tool text success', provider: 'codex', exit: 0, valid: true, limited: false, events: [{ type: 'item.completed', item: { output: 'login rate limit exceeded' } }, { type: 'turn.completed' }], stderr: 'Reading additional input from stdin...\nERROR codex_models_manager::manager: failed to refresh available models: request timed out' },
  { id: 'Codex model refresh timeout with failed exit and no result', provider: 'codex', exit: 1, valid: false, limited: false, events: [], stderr: 'ERROR codex_models_manager::manager: failed to refresh available models: request timed out' },
  { id: 'success ignores stderr 429', provider: 'codex', exit: 0, valid: true, limited: false, events: [{ type: 'turn.completed' }], stderr: '429 Too Many Requests' },
  { id: 'Codex turn failed', provider: 'codex', exit: 1, valid: false, limited: true, events: [{ type: 'turn.failed', error: { message: '429 usage limit' } }], stderr: '' },
  { id: 'Codex error', provider: 'codex', exit: 1, valid: false, limited: true, events: [{ type: 'error', message: 'usage limit reached' }], stderr: '' },
  { id: 'Cursor error result', provider: 'cursor', exit: 0, valid: false, limited: true, events: [{ type: 'result', is_error: true, result: 'rate limit exceeded' }], stderr: '' },
  { id: 'nonzero stderr only', provider: 'codex', exit: 1, valid: false, limited: true, events: [], stderr: '429 Too Many Requests' },
  { id: 'failed tool text is not provider error', provider: 'codex', exit: 1, valid: false, limited: false, events: [{ type: 'item.completed', item: { output: 'rate limit' } }], stderr: '' },
] as const;
for (const c of cases) test(`M9 O10 ${c.id}`, async t => {
  const f = policyFixture(t);
  f.status.provider = c.provider;
  f.task.provider = c.provider;
  await f.baseline();
  if (c.valid) f.report();
  writeFileSync(c.provider === 'cursor' ? f.paths.rawJson : f.paths.rawJsonl, c.events.map(e => JSON.stringify(e)).join('\n'));
  writeFileSync(f.paths.workerLog, c.stderr);
  assert.equal(providerRateLimit(c.provider, f.paths.dir, c.exit), c.limited);
  const r = await f.finish(c.exit);
  assert.equal(r.failure_reason === 'rate_limit', c.limited);
  assert.equal(isRetryableRateLimit(r, c.stderr), c.limited);
  if (c.valid) assert.equal(r.state, 'succeeded');
});

test('M9 scheduler cannot reclassify policy prose or stale stderr as provider cooldown', () => {
  assert.equal(isRetryableRateLimit({ state: 'failed', failure_reason: 'policy_violations: edited rate_limit test' }, '429 Too Many Requests'), false);
});

for (const provider of ['codex', 'cursor'] as const) test(`M9 supervise ${provider} successful tool-output replay cannot set rate_limit override`, async t => {
  const f = policyFixture(t);
  f.status.provider = provider; f.task.provider = provider;
  f.store.write(f.status);
  writeFileSync(f.paths.brief, JSON.stringify(f.task));
  const { worker } = await import('./helpers.js');
  const report = { ...worker(), files_changed: [], commits: [], handoff: { decided: [], rejected: [], risks: [], remaining: [] } };
  const events = provider === 'codex' ? [{ type: 'item.completed', item: { output: 'login rate limit exceeded' } }, { type: 'turn.completed' }] : [{ type: 'tool', result: '.contains("rate limit")' }, { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report) }];
  const { providerAdapter } = await import('../src/providers/index.js');
  t.mock.method(providerAdapter(provider), 'buildInvocation', () => ({ cmd: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(f.paths.finalMessage)}, ${JSON.stringify(JSON.stringify(report))}); console.log(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))}); console.error('429 Too Many Requests');`], cwd: f.repo, finalMessageFile: f.paths.finalMessage }));
  const { superviseJob } = await import('../src/core/supervise.js');
  await superviseJob(f.status.job_id, f.store);
  const r = f.result(f.status.job_id);
  assert.equal(r.worker_exit_code, 0);
  assert.equal(r.state, 'succeeded', r.failure_reason ?? '');
  assert.equal(isRetryableRateLimit(r, '429 Too Many Requests'), false);
});

test('M9 failed stderr source snippets are not provider error lines', async t => {
  const f = policyFixture(t);
  writeFileSync(f.paths.workerLog, 'const message = "login rate limit exceeded";\nassert.contains("rate limit");');
  assert.equal(providerRateLimit('codex', f.paths.dir, 1), false);
});

for (const stderr of [
  'error: expect("rate limit")',
  'error[E0308]: mismatched types rate limit exceeded',
  'Error: assert.equal(x, "rate limit exceeded")',
  'src/foo.ts:12: error login rate limit exceeded',
  'src/foo.rs:12: rate limit exceeded',
  'src/foo.py:12: rate limit exceeded',
  'error TS2322: rate limit exceeded',
  'test login rate limit exceeded',
  'foo.test.js: rate limit exceeded',
  'Error: "rate limit exceeded"',
  "error: 'usage limit'",
  'assertion failed: expected rate limit exceeded',
  'not ok 3 - rate limit retry',
  '✖ rate limit retry',
  'error: {"error":{"message":"Authentication failed","duration_ms":429}}',
  'error: {"error":{"message":"Authentication failed"},"retry_after":429}',
]) test(`M9 stderr source echo excluded: ${stderr}`, async t => {
  const f = policyFixture(t);
  await f.baseline();
  writeFileSync(f.paths.workerLog, stderr);
  assert.equal(providerRateLimit('codex', f.paths.dir, 1), false);
  assert.notEqual((await f.finish(1)).failure_reason, 'rate_limit');
});

for (const stderr of [
  'HTTP/1.1 429', 'status 429', '429 Too Many Requests',
  'status:429', 'status: 429',
  'ERROR openai: {"error":{"message":"Rate limit exceeded"}}',
  'error: {"error":{"message":"Rate limit exceeded"}}',
  'Error: {"error":"rate limit"}',
  'error: {"error":{"type":"resource_exhausted"}}',
  'error: {"error":{"code":429}}',
  'error: {"error":{"status":429}}',
  'error: {"error":{"code":"429"}}',
  'error: {"error":{"status":"429"}}',
  '2026-11-01T12:00:00Z ERROR {"error":"rate limit"}',
  'received HTTP/1.1 429: {"error":"rate limit"}',
  'ERROR codex_api::client: rate limit during test setup',
  'Error: 429', 'error: 429 retry later',
  'received HTTP/2 429: expect("rate limit")',
  'status:429 during foo.test.ts:12: expect("rate limit")',
  '429 Too Many Requests during test setup: assert.equal(status, 429)',
  'ERROR codex_api::client: stream error: 429 rate limit exceeded',
  '2026-11-01T12:00:00Z ERROR codex_api::client: stream error: rate limited',
  "Error: You've hit your usage limit", 'Error: quota exceeded', 'Error: resource_exhausted',
]) test(`M9 stderr provider error retained: ${stderr}`, async t => {
  const f = policyFixture(t);
  await f.baseline();
  writeFileSync(f.paths.workerLog, stderr);
  assert.equal(providerRateLimit('codex', f.paths.dir, 1), true);
  assert.equal((await f.finish(1)).failure_reason, 'rate_limit');
  f.report();
  assert.equal(providerRateLimit('codex', f.paths.dir, 0), false);
});

for (const envelope of [
  { result: 'Tool output: ' + 'unrelated output '.repeat(50) + 'rate limit' },
  { message: 'Authentication failed', result: 'rate limit exceeded' },
  { error: { message: 'Authentication failed' }, result: 'rate limit exceeded' },
]) test('M9 Cursor error prefers structured fields and excludes long tool output', async t => {
  const f = policyFixture(t);
  f.status.provider = 'cursor'; f.task.provider = 'cursor';
  await f.baseline();
  writeFileSync(f.paths.rawJson, JSON.stringify({ type: 'result', is_error: true, ...envelope }));
  assert.equal(providerRateLimit('cursor', f.paths.dir, 0), false);
  assert.notEqual((await f.finish()).failure_reason, 'rate_limit');
});

for (const forceInvalid of [false, true]) test(`M9 supervision/finalization share extraction eligibility: force_invalid=${forceInvalid}`, async t => {
  const f = policyFixture(t, 'read-only');
  f.status.provider = 'cursor'; f.task.provider = 'cursor';
  f.store.write(f.status);
  writeFileSync(f.paths.brief, JSON.stringify(f.task));
  const { worker } = await import('./helpers.js');
  const report = { ...worker(), files_changed: [], commits: [], handoff: { decided: [], rejected: [], risks: [], remaining: [] },
    ...(!forceInvalid ? { review: { verdict: 'approve', findings: [] } } : {}) };
  const { providerAdapter } = await import('../src/providers/index.js');
  const envelope = { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report) };
  t.mock.method(providerAdapter('cursor'), 'buildInvocation', () => ({ cmd: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(envelope))}); console.error('429 Too Many Requests');`], cwd: f.repo, finalMessageFile: null }));
  const { superviseJob } = await import('../src/core/supervise.js');
  await superviseJob(f.status.job_id, f.store);
  const r = f.result(f.status.job_id);
  const { validProviderResult } = await import('../src/core/providerRateLimit.js');
  assert.equal(validProviderResult(f.paths.dir), !forceInvalid);
  assert.equal(providerRateLimit('cursor', f.paths.dir, 0), forceInvalid);
  assert.equal(r.failure_reason === 'rate_limit', forceInvalid);
  assert.equal(r.worker_reported === null, forceInvalid);
});
