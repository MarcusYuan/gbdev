/** UTF-8 byte and line budgets for inspect. All clipping is code-point safe. */
export const QUESTION_MAX = 4096;
export const PATH_MAX = 256;
export const PATHS_MAX = 20;
export const ANSWER_MAX = 2048;
export const EXCERPT_MAX = 8;
export const EXCERPT_LINES = 40;
export const EXCERPT_BYTES = 2048;
export const EXCERPTS_TOTAL = 8192;
export const RESULT_JSON_MAX = 16384;
export const EVIDENCE_PROMPT_MAX = 64 * 1024;
export const CANDIDATE_JSON_MAX = 64 * 1024;
export const RAW_OUTPUT_MAX = 1 * 1024 * 1024;
export const TEST_LOG_LINES = 80;
export const TEST_LOG_BYTES = 8 * 1024;
export const TEST_LOGS_MAX = 10;
export const SOURCE_FILE_MAX = 1 * 1024 * 1024;

/** Clip UTF-8 on a code-point boundary. Never emits a partial sequence. */
export function utf8Clip(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
