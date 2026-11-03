import assert from 'node:assert/strict';
import { extractWorkerResult } from '../../src/contracts/workerResult.js';

export function assertReviewPrompt(prompt: string): void {
  const example = extractWorkerResult(prompt);
  assert.equal(example.review?.verdict, 'revise');
  assert.equal(example.review.findings.length, 1);
  assert.deepEqual(Object.keys(example.review.findings[0]!).sort(), ['file', 'id', 'line', 'message', 'severity', 'suggestion']);
  assert.match(prompt, /MUST include review\.verdict and review\.findings/);
  assert.match(prompt, /verdict approve, revise, or reject/);
  assert.match(prompt, /never approve with any critical\/major finding/);
  assert.match(prompt, /unable to reach a conclusion, use revise/);
  assert.match(prompt, /All finding fields are required/);
}
