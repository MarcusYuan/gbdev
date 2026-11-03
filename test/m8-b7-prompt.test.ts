import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GbdevError } from '../src/contracts/error.js';
import {
  assertPromptWithinLimit, boundReviewPrompt, measureUtf8Bytes, truncateUtf8, writeDiffArtifact,
} from '../src/core/promptBudget.js';
import { createCursorAdapter } from '../src/providers/cursor.js';
import { buildBoundedFinalPrompt } from '../src/run/finalReview.js';
import { brief } from './helpers.js';

test('AC-B7-13: 650KB+ diff externalized under 200000 UTF-8 bytes with readable artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbdev-b7-prompt-'));
  try {
    const diff = 'diff --git a/x b/x\n' + '中文行\n'.repeat(80_000) + '"\\\t'.repeat(100_000);
    assert.ok(measureUtf8Bytes(diff) >= 650_000 || measureUtf8Bytes(diff) > 200_000);
    const artifact = writeDiffArtifact(dir, 'integration.diff', diff, 'base', 'head');
    assert.equal(artifact.bytes, measureUtf8Bytes(diff));
    assert.equal(artifact.sha256, createHash('sha256').update(diff, 'utf8').digest('hex'));
    assert.equal(readFileSync(artifact.path, 'utf8'), diff);

    const task = brief('/repo');
    const input = {
      brief: task, instructionsText: 'Review.', notes: ['Review this diff carefully.'],
      diff, tasksJson: JSON.stringify({ tasks: [] }),
      artifact, includeRetryNotice: true, maxBytes: 200000, provider: 'cursor', jobId: 'test',
    };
    const prompt = buildBoundedFinalPrompt(input);
    assert.ok(measureUtf8Bytes(prompt) <= 200000);
    assert.match(prompt, /DIFF_FILE_REF/);
    assert.ok(prompt.includes(artifact.path));
    assert.ok(prompt.includes(artifact.sha256));
    assert.throws(() => buildBoundedFinalPrompt({ ...input, tasksJson: 'T'.repeat(200001) }),
      (e: unknown) => e instanceof GbdevError && e.contract.code === 'prompt_too_large');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-B7-14: UTF-8 counting, truncate boundary, non-diff overflow → prompt_too_large with zero spawn semantics', () => {
  const zh = '你好世界';
  assert.equal(measureUtf8Bytes(zh), 12);
  assert.equal(truncateUtf8(zh, 6), '你好');
  assert.equal(truncateUtf8('你好abc', 6), '你好');
  assert.equal(truncateUtf8('你好abc', 9), '你好abc');
  assert.throws(
    () => assertPromptWithinLimit('x'.repeat(200_001), 200000, 'cursor'),
    (e: unknown) => e instanceof GbdevError && e.contract.code === 'prompt_too_large'
      && e.contract.details.diff_externalized === false
      && !JSON.stringify(e.contract.details).includes('xxxxx'),
  );
  // Non-diff content alone over limit (no artifact) → fail, no spawn implied by throw before adapter.
  assert.throws(() => boundReviewPrompt({
    prefix: 'P'.repeat(210_000),
    diffBody: '',
    suffix: '',
    artifact: null,
    maxBytes: 200000,
    provider: 'fake',
  }), (e: unknown) => e instanceof GbdevError && e.contract.code === 'prompt_too_large');
});

test('AC-B7-14 adapter: cursor argv precheck rejects oversized prompt', () => {
  const adapter = createCursorAdapter();
  assert.throws(() => adapter.buildInvocation({
    bin: 'cursor-agent', worktree: '/tmp', jobDir: '/tmp', prompt: 'y'.repeat(200_001),
    sandbox: 'read-only', network: true, model: 'auto', writableRoots: [],
  }), (e: unknown) => e instanceof GbdevError && e.contract.code === 'prompt_too_large');
});
