import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildCodexArgs, codex } from '../src/providers/codex.js';
import { createCursorAdapter, cursor } from '../src/providers/cursor.js';
import { type ProviderContext } from '../src/providers/types.js';
import { findExecutable } from '../src/core/proc.js';
import { temporary } from './helpers.js';
import { providerStub } from './helpers/providerStub.js';

function context(jobDir: string): ProviderContext {
  return { bin: '/stub/provider bin', worktree: '/tmp/worktree with spaces', jobDir,
    prompt: 'Prompt with $(literal); "quotes"\nsecond line', sandbox: 'workspace-write', network: false, model: null };
}

test('codex adapter: verified argv preserves prompt/model/path boundaries and both sandboxes', t => {
  const dir = temporary(t);
  for (const sandbox of ['workspace-write', 'read-only'] as const) {
    const ctx = { ...context(dir), sandbox, model: 'model with spaces' };
    const invocation = codex.buildInvocation(ctx);
    assert.deepEqual(invocation, { cmd: ctx.bin, cwd: ctx.worktree, finalMessageFile: join(dir, 'final.md'),
      args: ['exec', '--cd', ctx.worktree, '--sandbox', sandbox, '--json', '--output-last-message', join(dir, 'final.md'), '--output-schema', join(dir, 'worker-result.schema.json'), '-m', ctx.model, '-c', 'model_reasoning_effort=high', ctx.prompt] });
  }
  assert.equal(codex.buildInvocation(context(dir)).args.includes('-m'), false);
  assert.deepEqual(codex.buildInvocation(context(dir)).args.slice(-3), ['-c', 'model_reasoning_effort=high', context(dir).prompt]);
  assert.equal(codex.extractFinalMessage(dir), null);
  writeFileSync(join(dir, 'final.md'), 'exact final\n');
  assert.equal(codex.extractFinalMessage(dir), 'exact final\n');
});

test('G1: pure Codex args never grant add-dir access, even with legacy writable roots', () => {
  const ctx = context('/tmp/job with spaces');
  const commonDir = '/tmp/repo with spaces/.git';
  const writableRoots = [ctx.worktree, commonDir];
  for (const sandbox of ['workspace-write', 'read-only'] as const) {
    const input = { ...ctx, sandbox, writableRoots };
    const args = buildCodexArgs(input);
    assert.equal(args.includes('--add-dir'), false);
    assert.equal(args.includes(commonDir), false);
    assert.equal(args.at(-1), ctx.prompt);
    assert.deepEqual(buildCodexArgs(input), args);
    assert.deepEqual(writableRoots, [ctx.worktree, commonDir]);
  }
});

test('cursor adapter: stream-json and auto model; sandbox enabled always; force only for writes; plan mode for reviewer', t => {
  const dir = temporary(t);
  const ctx = { ...context(dir), model: 'auto' };
  assert.deepEqual(cursor.buildInvocation(ctx), { cmd: ctx.bin, cwd: ctx.worktree, finalMessageFile: null,
    args: ['-p', '--output-format', 'stream-json', '--sandbox', 'enabled', '--trust', '--force', '--model', ctx.model, ctx.prompt] });
  const readonly = cursor.buildInvocation({ ...context(dir), sandbox: 'read-only' });
  assert.deepEqual(readonly.args, ['-p', '--output-format', 'stream-json', '--sandbox', 'enabled', '--trust', '--mode', 'plan', '--model', 'auto', ctx.prompt]);
  assert.equal(readonly.args.includes('--force'), false);
});

test('cursor adapter: strict default result extraction and replaceable JSON extractor', t => {
  const dir = temporary(t);
  assert.equal(cursor.extractFinalMessage(dir), null);
  for (const raw of ['bad json', 'null', '[]', '{}', '{"result":{}}', '{"result":false}']) {
    writeFileSync(join(dir, 'raw.json'), raw);
    assert.equal(cursor.extractFinalMessage(dir), null);
  }
  writeFileSync(join(dir, 'raw.json'), JSON.stringify({ result: 'exact final\n' }));
  assert.equal(cursor.extractFinalMessage(dir), 'exact final\n');
  const custom = createCursorAdapter(raw => (raw as { message: string }).message);
  writeFileSync(join(dir, 'raw.json'), JSON.stringify({ message: 'alternate field' }));
  assert.equal(custom.extractFinalMessage(dir), 'alternate field');
});

test('executable resolution: absolute paths, PATH lookup, missing/non-executable/directory', t => {
  const dir = temporary(t);
  const file = providerStub(dir);
  assert.equal(findExecutable(file, ''), file);
  assert.equal(findExecutable('provider-stub.mjs', join(dir, 'stub-bin')), file);
  assert.equal(findExecutable('absent', join(dir, 'stub-bin')), null);
  assert.equal(findExecutable(dir), null);
  const plain = join(dir, 'plain');
  writeFileSync(plain, '', { mode: 0o600 });
  assert.equal(findExecutable(plain), null);
});
