import assert from 'node:assert/strict';
import test from 'node:test';
import { extractWorkerResult, validateWorkerResult } from '../src/contracts/workerResult.js';
import { renderPrompt } from '../src/core/prompt.js';
import { brief, worker } from './helpers.js';

for (const sandbox of ['workspace-write', 'read-only'] as const) {
  test(`G2: ${sandbox} prompt gives sandbox-specific commit boundaries`, () => {
    const prompt = renderPrompt({ ...brief('/repo'), sandbox });
    assert.doesNotMatch(prompt, /argv arrays|no constructed shell commands/i);
    assert.match(prompt, /Do not access the network or install packages/);
    assert.match(prompt, /Never change branches/);
    assert.match(prompt, /commits field may be empty/);
    assert.doesNotMatch(prompt, /Commit local changes|If sandbox permissions prevent committing/);
    if (sandbox === 'workspace-write') {
      assert.match(prompt, /Do not modify files outside allowed_paths/);
      assert.match(prompt, /Do not run git add or git commit/);
      assert.match(prompt, /Leave changes in the worktree; gbdev will commit them after the worker exits \(snapshot\)/);
      assert.match(prompt, /Do not report a blocker because you cannot commit/);
      assert.doesNotMatch(prompt, /gbdev will not commit on your behalf/);
    } else {
      assert.match(prompt, /Do not modify any files \(including files within allowed_paths\)/);
      assert.doesNotMatch(prompt, /outside allowed_paths/);
      assert.match(prompt, /gbdev will not commit on your behalf; modifications will fail the job \(readonly_modified\)/);
      assert.doesNotMatch(prompt, /gbdev will commit them|snapshot/);
    }
  });
}

for (const key of ['criterion_id', 'kind', 'ref', 'note'] as const) {
  test(`F3: invalid evidence[1].${key} reports the indexed field path`, () => {
    const valid = worker().evidence[0]!;
    const report = { ...worker(), evidence: [valid, { ...valid, [key]: 42 }] };
    const expected = new RegExp(`evidence\\[1\\]\\.${key}`);
    assert.throws(() => validateWorkerResult(report), expected);
    assert.throws(() => extractWorkerResult(JSON.stringify(report)), expected);
  });
}

for (const [key, value] of [
  ['id', 42], ['question', 42], ['options', 42], ['default', 42],
  ['default', 'not an option'], ['blocking', 42],
] as const) {
  test(`F3: invalid open_questions[1].${key}=${value} reports the indexed field path`, () => {
    const valid = { id: 'Q1', question: 'Which?', options: ['A', 'B'], default: 'A', blocking: true };
    const report = { ...worker(), open_questions: [valid, { ...valid, [key]: value }] };
    const expected = new RegExp(`open_questions\\[1\\]\\.${key}`);
    assert.throws(() => validateWorkerResult(report), expected);
    assert.throws(() => extractWorkerResult(JSON.stringify(report)), expected);
  });
}
