import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { validateBrief } from '../src/contracts/brief.js';
import { validateConfig } from '../src/core/config.js';
import { brief, errorCode, temporary } from './helpers.js';

test('brief: accepts all supported providers, read-only reviewers and follow-up answers', t => {
  const repo = temporary(t);
  const config = validateConfig({ version: 1, allowed_repos: [repo] });
  for (const provider of ['codex', 'cursor', 'fake'] as const) {
    const value = { ...brief(repo), provider };
    assert.deepEqual(validateBrief(value, config), { ...value, stall_timeout_s: 600 });
  }
  const review = { ...brief(repo), role: 'reviewer', sandbox: 'read-only', model: 'model-name',
    timeout_min: 240, parent_job_id: 'j_20261025_1131_a7f3', answers: [{ question_id: 'Q1', answer: 'Use A' }],
    acceptance_criteria: [{ id: 'AC1', text: 'Inspect only' }] };
  assert.deepEqual(validateBrief(review, config), { ...review, stall_timeout_s: 900 });
  assert.equal(validateBrief({ ...brief(repo), timeout_min: 1 }, config).timeout_min, 1);
});

const invalidBriefs: Record<string, unknown> = {
  schema: 'wrong', brief_id: '', repo: 'relative/repo', base_ref: '--bad', provider: 'unknown', role: 'admin',
  model: 3, sandbox: 'disabled', timeout_min: 0, network: 1, goal: ' ', context: null,
  constraints: [''], allowed_paths: [], acceptance_criteria: [{ id: 'AC1', text: 123 }],
  required_evidence: {}, parent_job_id: '../escape', answers: [{ question_id: 'Q1', answer: '' }],
};

for (const [key, value] of Object.entries(invalidBriefs)) {
  test(`brief: rejects invalid ${key}`, t => {
    const repo = temporary(t);
    const config = validateConfig({ version: 1, allowed_repos: [repo] });
    assert.throws(() => validateBrief({ ...brief(repo), [key]: value }, config), errorCode(key === 'role' ? 'role_not_found' : 'config_invalid'));
    const missing: Record<string, unknown> = { ...brief(repo) };
    delete missing[key];
    if (!['provider', 'sandbox', 'model', 'timeout_min', 'network'].includes(key)) {
      assert.throws(() => validateBrief(missing, config), errorCode('config_invalid'));
    } else assert.doesNotThrow(() => validateBrief(missing, config));
  });
}

test('brief: rejects malformed roots, reviewer write access and timeout boundary errors', t => {
  const repo = temporary(t);
  const config = validateConfig({ version: 1, allowed_repos: [repo] });
  for (const root of [null, [], 'brief', 1]) assert.throws(() => validateBrief(root, config), errorCode('config_invalid'));
  for (const timeout_min of [241, -1, 1.5, NaN, '30']) {
    assert.throws(() => validateBrief({ ...brief(repo), timeout_min }, config), errorCode('config_invalid'));
  }
  assert.throws(() => validateBrief({ ...brief(repo), role: 'reviewer' }, config), errorCode('config_invalid'));
  assert.throws(() => validateBrief({ ...brief(repo), acceptance_criteria: [
    { id: 'AC1', text: 'First' }, { id: 'AC1', text: 'Duplicate' },
  ] }, config), errorCode('config_invalid'));
});

test('brief: allowlist uses exact canonical repo paths, not prefixes', t => {
  const root = temporary(t);
  const repo = join(root, 'repo');
  const child = join(repo, 'child');
  mkdirSync(child, { recursive: true });
  const sibling = join(root, 'repo-other');
  mkdirSync(sibling);
  const config = validateConfig({ version: 1, allowed_repos: [repo] });
  for (const denied of [child, sibling, root]) {
    assert.throws(() => validateBrief(brief(denied), config), errorCode('repo_not_allowed'));
  }
  const alias = join(root, 'alias');
  symlinkSync(repo, alias);
  assert.equal(validateBrief(brief(alias), config).repo, alias);
  const escaped = join(repo, 'outside');
  symlinkSync(sibling, escaped);
  assert.throws(() => validateBrief(brief(escaped), config), errorCode('repo_not_allowed'));
});
