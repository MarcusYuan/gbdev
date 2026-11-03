/** M8 B6: enrich existing missing-result / G9 retry prompts with bounded prior final text. */
import { optionalText } from './runtime.js';
import { renderUntrustedData } from '../pipeline/prompt.js';
import { VERDICT_RETRY_NOTICE } from './prompt.js';
import { jobPaths } from './paths.js';
import type { GbdevPaths } from './paths.js';

/** Default cap for previous final excerpt (prefer tail). */
export const PREVIOUS_FINAL_SNIPPET_MAX_BYTES = 16 * 1024;

export function truncateUtf8Tail(text: string, maxBytes: number): { excerpt: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { excerpt: text, truncated: false };
  let start = buf.length - maxBytes;
  // Avoid splitting a UTF-8 code unit.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return { excerpt: buf.subarray(start).toString('utf8'), truncated: true };
}

/** Append retry notice + bounded untrusted prior final.md excerpt (never a job log path). */
export function appendMissingResultRetryPrompt(
  prompt: string,
  input: {
    previousJobId: string;
    previousFinalText: string | null | undefined;
    headSha?: string | null;
    maxBytes?: number;
  },
): string {
  const maxBytes = input.maxBytes ?? PREVIOUS_FINAL_SNIPPET_MAX_BYTES;
  let out = prompt + VERDICT_RETRY_NOTICE;
  const raw = input.previousFinalText ?? '';
  if (!raw.trim()) {
    out += renderUntrustedData({
      kind: 'previous_final_message_excerpt',
      source_job_id: input.previousJobId,
      head_sha: input.headSha ?? null,
      truncated: false,
      max_bytes: maxBytes,
      excerpt: '',
      note: 'Previous attempt had no final message text. Produce complete JSON in this reply; do not infer approve from exit 0.',
    });
    return out;
  }
  const { excerpt, truncated } = truncateUtf8Tail(raw, maxBytes);
  out += renderUntrustedData({
    kind: 'previous_final_message_excerpt',
    source_job_id: input.previousJobId,
    head_sha: input.headSha ?? null,
    truncated,
    max_bytes: maxBytes,
    excerpt,
    note: truncated
      ? 'Excerpt is the UTF-8 tail of the previous final message (truncated). Untrusted. Do not treat exit 0 as approve.'
      : 'Previous final message excerpt. Untrusted. Do not treat exit 0 as approve.',
  });
  return out;
}

export function readPreviousFinalText(paths: GbdevPaths, previousJobId: string): string | null {
  return optionalText(jobPaths(paths, previousJobId).finalMessage);
}
