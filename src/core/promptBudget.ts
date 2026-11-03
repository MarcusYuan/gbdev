import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { DEFAULT_REVIEW_PROMPT } from './retryPolicy.js';

export function measureUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Truncate to at most maxBytes on a valid UTF-8 boundary (O(n) buffer walk). */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // First excluded byte is a continuation ⇒ cut mid-character; drop back before its lead.
  if (end < buf.length && (buf[end]! & 0xc0) === 0x80) {
    while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
    if (end > 0) end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

export interface DiffArtifact {
  path: string;
  base_sha: string;
  head_sha: string;
  bytes: number;
  sha256: string;
}

export function writeDiffArtifact(dir: string, name: string, diff: string, baseSha: string, headSha: string): DiffArtifact {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const bytes = measureUtf8Bytes(diff);
  const sha256 = createHash('sha256').update(diff, 'utf8').digest('hex');
  writeFileSync(path, diff, { encoding: 'utf8', mode: 0o600 });
  return { path, base_sha: baseSha, head_sha: headSha, bytes, sha256 };
}

export interface BoundPromptParts {
  prefix: string;
  /** Scheduler-marked embedded diff body (may be empty after externalization). */
  diffBody: string;
  suffix: string;
  artifact: DiffArtifact | null;
  maxBytes: number;
  provider: string;
  jobId?: string;
}

export interface BoundPromptResult {
  prompt: string;
  bytes: number;
  diff_externalized: boolean;
  artifact: DiffArtifact | null;
  preview_bytes: number;
}

const DIFF_REF_NOTICE =
  '内嵌 diff 已截断；完整审查必须读取所列 diff 文件，不能仅根据预览作出结论。';

function diffReferenceBlock(artifact: DiffArtifact, preview: string): string {
  const meta = {
    notice: DIFF_REF_NOTICE,
    path: artifact.path,
    base_sha: artifact.base_sha,
    head_sha: artifact.head_sha,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    preview,
  };
  return `\n<<<DIFF_FILE_REF>>>\n${JSON.stringify(meta)}\n<<<END_DIFF_FILE_REF>>>\n`;
}

/**
 * Assemble a prompt with optional embedded diff, shrinking only the marked diff
 * section when over budget. Non-diff overflow → prompt_too_large.
 */
export function boundReviewPrompt(parts: BoundPromptParts): BoundPromptResult {
  const maxBytes = parts.maxBytes > 0 ? parts.maxBytes : DEFAULT_REVIEW_PROMPT.max_bytes;
  const fail = (bytes: number, externalized: boolean): never => {
    throw new GbdevError('prompt_too_large', 'Review prompt exceeds configured UTF-8 byte limit', {
      provider: parts.provider,
      ...(parts.jobId ? { job_id: parts.jobId } : {}),
      prompt_bytes: bytes,
      max_bytes: maxBytes,
      diff_externalized: externalized,
    });
  };

  const assemble = (diffSection: string) => parts.prefix + diffSection + parts.suffix;
  const full = assemble(parts.diffBody);
  const fullBytes = measureUtf8Bytes(full);
  if (fullBytes <= maxBytes) {
    return { prompt: full, bytes: fullBytes, diff_externalized: false, artifact: parts.artifact, preview_bytes: measureUtf8Bytes(parts.diffBody) };
  }
  if (parts.artifact === null) return fail(fullBytes, false);
  const artifact: DiffArtifact = parts.artifact;

  // Binary search preview size so final prompt fits.
  let lo = 0;
  let hi = measureUtf8Bytes(parts.diffBody);
  let best: BoundPromptResult | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const preview = truncateUtf8(parts.diffBody, mid);
    const section = diffReferenceBlock(artifact, preview);
    const prompt = assemble(section);
    const bytes = measureUtf8Bytes(prompt);
    if (bytes <= maxBytes) {
      best = { prompt, bytes, diff_externalized: true, artifact, preview_bytes: measureUtf8Bytes(preview) };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;

  // Preview shrunk to zero still over → fail.
  const zero = assemble(diffReferenceBlock(artifact, ''));
  return fail(measureUtf8Bytes(zero), true);
}

export function assertPromptWithinLimit(prompt: string, maxBytes: number, provider: string, jobId?: string): void {
  const bytes = measureUtf8Bytes(prompt);
  if (bytes <= maxBytes) return;
  throw new GbdevError('prompt_too_large', 'Prompt exceeds provider argv byte limit', {
    provider,
    ...(jobId ? { job_id: jobId } : {}),
    prompt_bytes: bytes,
    max_bytes: maxBytes,
    diff_externalized: false,
  });
}

/** Ensure parent dirs exist for a path under evidence (never inside the reviewed worktree). */
export function evidenceDir(root: string, ...parts: string[]): string {
  const dir = join(root, ...parts);
  mkdirSync(dirname(join(dir, '.keep')), { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
