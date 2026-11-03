import { GbdevError } from '../contracts/error.js';
import { validateInspectResult, type InspectExcerpt, type InspectResult, type InspectWarning } from '../contracts/inspect.js';
import { object } from '../contracts/validation.js';
import { ANSWER_MAX, CANDIDATE_JSON_MAX, EXCERPT_BYTES, EXCERPT_LINES, EXCERPT_MAX, EXCERPTS_TOTAL, RESULT_JSON_MAX, utf8Bytes, utf8Clip } from './limits.js';
import { assertInspectPath, canonicalLines, lookupSource, pathAllowed, readSnapshotFile, type EvidencePack } from './evidence.js';
import type { ResolvedInspectTarget } from './target.js';

function fail(message: string): never {
  throw new GbdevError('inspect_result_invalid', message);
}

function warn(warnings: InspectWarning[], code: InspectWarning): void {
  if (!warnings.includes(code)) warnings.push(code);
}

interface RawExcerpt { path: string; start_line: number; end_line: number; text: string }

function candidateOf(value: unknown): { answer: string; excerpts: RawExcerpt[] } {
  if (utf8Bytes(JSON.stringify(value ?? null)) > CANDIDATE_JSON_MAX) {
    throw new GbdevError('inspect_output_too_large', 'Inspection candidate exceeds 64 KiB');
  }
  let raw: Record<string, unknown>;
  try { raw = object(value, 'inspection'); }
  catch { fail('inspection candidate must be an object'); }
  for (const key of Object.keys(raw)) if (key !== 'answer' && key !== 'excerpts') fail(`unknown inspection field ${key}`);
  if (typeof raw.answer !== 'string' || !raw.answer.trim()) fail('inspection answer is required');
  if (!Array.isArray(raw.excerpts)) fail('inspection excerpts must be an array');
  const excerpts: RawExcerpt[] = [];
  raw.excerpts.forEach((item, i) => {
    let excerpt: Record<string, unknown>;
    try { excerpt = object(item, `excerpts[${i}]`); }
    catch { fail(`excerpts[${i}] must be an object`); }
    for (const key of Object.keys(excerpt)) if (!['path', 'start_line', 'end_line', 'text'].includes(key)) fail(`unknown excerpt field ${key}`);
    if (typeof excerpt.path !== 'string' || typeof excerpt.text !== 'string') fail(`excerpts[${i}] path and text must be strings`);
    if (!Number.isSafeInteger(excerpt.start_line) || !Number.isSafeInteger(excerpt.end_line) ||
        Number(excerpt.start_line) < 1 || Number(excerpt.end_line) < Number(excerpt.start_line)) fail(`excerpts[${i}] has invalid lines`);
    excerpts.push({ path: excerpt.path, start_line: excerpt.start_line as number, end_line: excerpt.end_line as number, text: excerpt.text });
  });
  return { answer: raw.answer, excerpts };
}

function sourceLines(pack: EvidencePack, worktree: string, path: string, paths: readonly string[]): string[] {
  if (path.startsWith('diff:') || path.startsWith('test:')) {
    const lines = lookupSource(pack, path);
    if (!lines) fail(`unknown virtual source ${path}`);
    return lines;
  }
  try { assertInspectPath(path); }
  catch { fail(`excerpt path is not allowed: ${path}`); }
  if (!pathAllowed(path, paths) || !pack.files.includes(path)) fail(`excerpt path is outside the inspection manifest: ${path}`);
  const read = readSnapshotFile(worktree, path);
  if ('omit' in read) fail(`excerpt source is not a readable text file: ${path}`);
  return read.lines;
}

function rebuild(excerpt: RawExcerpt, lines: string[], warnings: InspectWarning[]): InspectExcerpt | null {
  if (excerpt.start_line > lines.length) fail(`excerpt ${excerpt.path} starts past the source`);
  if (excerpt.end_line > lines.length) fail(`excerpt ${excerpt.path} ends past the source`);
  const requestedEnd = excerpt.end_line;
  const requested = lines.slice(excerpt.start_line - 1, requestedEnd);
  const reported = canonicalLines(excerpt.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')).join('\n');
  if (reported !== requested.join('\n')) fail(`excerpt ${excerpt.path} does not match the recorded source`);
  let end = requestedEnd;
  if (end - excerpt.start_line + 1 > EXCERPT_LINES) {
    end = excerpt.start_line + EXCERPT_LINES - 1;
    warn(warnings, 'output_truncated');
  }
  const slice = lines.slice(excerpt.start_line - 1, end);
  if (slice.some(line => utf8Bytes(line) > EXCERPT_BYTES) || utf8Bytes(slice.join('\n')) > EXCERPT_BYTES) {
    warn(warnings, 'output_truncated');
    return null;
  }
  return { path: excerpt.path, start_line: excerpt.start_line, end_line: end, text: slice.join('\n') };
}

function dropWholeFiles(excerpts: InspectExcerpt[], lengths: Map<string, number>, warnings: InspectWarning[]): InspectExcerpt[] {
  const kept = [...excerpts];
  let changed = true;
  while (changed) {
    changed = false;
    const byPath = new Map<string, InspectExcerpt[]>();
    for (const excerpt of kept) {
      const list = byPath.get(excerpt.path) ?? [];
      list.push(excerpt);
      byPath.set(excerpt.path, list);
    }
    for (const [path, group] of byPath) {
      const total = lengths.get(path) ?? 0;
      if (total < 1) continue;
      const covered = new Set<number>();
      for (const excerpt of group) for (let line = excerpt.start_line; line <= excerpt.end_line; line++) covered.add(line);
      if (covered.size >= total) {
        const last = group.at(-1)!;
        const index = kept.lastIndexOf(last);
        if (index >= 0) kept.splice(index, 1);
        warn(warnings, 'whole_file_omitted');
        changed = true;
        break;
      }
    }
  }
  return kept;
}

function fit(result: InspectResult): InspectResult {
  for (let i = 0; i < 1000; i++) {
    result.truncated = result.warnings.includes('input_truncated') || result.warnings.includes('output_truncated');
    if (utf8Bytes(JSON.stringify(result)) <= RESULT_JSON_MAX) return result;
    if (utf8Bytes(result.answer) > 80) {
      result.answer = utf8Clip(result.answer, Math.max(32, Math.floor(utf8Bytes(result.answer) * 0.75))).text || 'truncated';
      warn(result.warnings, 'output_truncated');
      continue;
    }
    if (result.excerpts.length) {
      result.excerpts.pop();
      warn(result.warnings, 'output_truncated');
      continue;
    }
    if (result.coverage.files.omitted.length > 8) {
      const extra = result.coverage.files.omitted.length - 8;
      result.coverage.files.omitted = result.coverage.files.omitted.slice(0, 8);
      const note = ` omitted_paths:${extra}`;
      const next = utf8Clip(result.answer + note, ANSWER_MAX).text;
      result.answer = next;
      continue;
    }
    if (result.warnings.length > 1) {
      result.warnings.pop();
      continue;
    }
    result.answer = utf8Clip(result.answer, 64).text || 'truncated';
    result.truncated = result.warnings.includes('input_truncated') || result.warnings.includes('output_truncated');
    if (utf8Bytes(JSON.stringify(result)) <= RESULT_JSON_MAX) return result;
    fail('normalized inspection does not fit 16384 bytes');
  }
  fail('normalized inspection does not fit 16384 bytes');
}

export function validateAndNormalizeInspection(candidate: unknown, evidence: EvidencePack, resolved: ResolvedInspectTarget, meta: { job_id: string; worktree: string; paths: readonly string[]; captured_at: string }): InspectResult {
  const parsed = candidateOf(candidate);
  const warnings = [...evidence.warnings];
  let answer = parsed.answer;
  if (utf8Bytes(answer) > ANSWER_MAX) {
    answer = utf8Clip(answer, ANSWER_MAX).text;
    warn(warnings, 'output_truncated');
  }
  const lengths = new Map<string, number>();
  const rebuilt: InspectExcerpt[] = [];
  let total = 0;
  for (const excerpt of parsed.excerpts) {
    if (rebuilt.length >= EXCERPT_MAX) { warn(warnings, 'output_truncated'); break; }
    const lines = sourceLines(evidence, meta.worktree, excerpt.path, meta.paths.length ? meta.paths : evidence.files);
    lengths.set(excerpt.path, lines.length);
    const next = rebuild(excerpt, lines, warnings);
    if (!next) continue;
    if (total + utf8Bytes(next.text) > EXCERPTS_TOTAL) { warn(warnings, 'output_truncated'); break; }
    total += utf8Bytes(next.text);
    rebuilt.push(next);
  }
  const excerpts = dropWholeFiles(rebuilt, lengths, warnings);
  const result: InspectResult = {
    schema: 'gbdev.inspect-result.v1', job_id: meta.job_id, target: resolved.target,
    snapshot: { mode: 'committed', target_sha: resolved.target_sha, diff_base_sha: resolved.diff_base_sha, captured_at: meta.captured_at, uncommitted_included: false },
    answer: answer.trim() ? answer : 'No answer.',
    excerpts,
    coverage: {
      files: { requested: [...meta.paths], omitted: evidence.omitted },
      diff: { requested: evidence.diffRequested, available: evidence.diffAvailable, truncated: evidence.diffTruncated },
      tests: {
        requested: evidence.testsRequested, available: evidence.testsAvailable, truncated: evidence.testsTruncated,
        checks: evidence.tests.map(test => ({ source_id: test.source_id, check_id: test.check_id, exit_code: test.exit_code, checked_sha: test.checked_sha, log_available: test.log_available })),
      },
    },
    truncated: warnings.includes('input_truncated') || warnings.includes('output_truncated'),
    warnings,
  };
  return validateInspectResult(fit(result));
}
