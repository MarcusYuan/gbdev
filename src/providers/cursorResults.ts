/**
 * M8 B6: strict Cursor structured-result candidate extraction.
 * Does not replace extractFinalMessage (prose path); used for verdict/structured recovery only.
 */
import { join } from 'node:path';
import { optionalText } from '../core/runtime.js';
import { extractWorkerResult, type Review } from '../contracts/workerResult.js';
import { GbdevError } from '../contracts/error.js';
import { jsonObjects, lastString } from './jsonOutput.js';
import { extractCursorResult } from './cursor.js';

export type ResultCandidateSource = 'terminal_result' | 'assistant_final';

export interface ResultCandidate {
  source: ResultCandidateSource;
  event_index: number;
  session_id: string | null;
  text: string;
  /** Terminal envelope signals provider failure (do not recover via assistant). */
  provider_failure: boolean;
}

export interface ResultCandidateContext {
  /** Expected job output; verdict requires review.verdict (+ non-empty findings for revise). */
  output: 'change' | 'verdict' | 'report';
}

export interface CandidateAssessment {
  source: ResultCandidateSource;
  event_index: number;
  accepted: boolean;
  reject_reason?: string;
}

export interface StructuredSelection {
  selected: ResultCandidate | null;
  valid: boolean;
  /** When set, finalize must not accept a last-wins parse of the written text. */
  force_invalid?: string;
  recovered_from_assistant: boolean;
  candidates: CandidateAssessment[];
  raw_file: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sessionOf(object: Record<string, unknown>): string | null {
  return typeof object.session_id === 'string' && object.session_id.trim()
    ? object.session_id
    : null;
}

/** True when the Cursor result envelope reports provider failure. */
export function isCursorProviderFailure(raw: Record<string, unknown>): boolean {
  if (typeof raw.subtype === 'string' && raw.subtype !== 'success') return true;
  return raw.is_error === true;
}

/** Same envelope recognition as cursor.ts lastCursorResult, exposed for indexing. */
export function cursorResultIndices(objects: Record<string, unknown>[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i]!;
    if (object.type === 'result') indices.push(i);
  }
  if (!indices.length && objects.length === 1 && !('type' in objects[0]!)) indices.push(0);
  return indices;
}

/** Concatenate text blocks within a single assistant event only (never across turns). */
export function assistantEventText(object: Record<string, unknown>): string | null {
  if (object.type !== 'assistant') return null;
  const message = record(object.message);
  if (!message || !Array.isArray(message.content)) return null;
  const texts: string[] = [];
  for (const block of message.content) {
    const item = record(block);
    if (item && item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
  }
  return texts.length ? texts.join('') : null;
}

function inCurrentSession(object: Record<string, unknown>, currentSession: string | null): boolean {
  if (currentSession === null) return true;
  const sid = sessionOf(object);
  return sid === null || sid === currentSession;
}

/**
 * Ordered structured-delivery candidates for the current execution/session only.
 * Never reads user/thinking/tool payloads as verdict text.
 */
export function extractResultCandidates(
  jobDir: string,
  _context: ResultCandidateContext,
  outputFile = 'raw.json',
): ResultCandidate[] {
  const raw = optionalText(join(jobDir, outputFile));
  if (raw === null) return [];
  const objects = jsonObjects(raw);
  if (!objects.length) return [];

  const resultIndices = cursorResultIndices(objects);
  const lastResultIdx = resultIndices.at(-1);
  const prevResultIdx = resultIndices.length >= 2 ? resultIndices.at(-2)! : -1;

  const currentSession = lastResultIdx !== undefined
    ? sessionOf(objects[lastResultIdx]!) ?? lastString(objects, 'session_id')
    : lastString(objects, 'session_id');

  const windowStart = prevResultIdx + 1;
  const out: ResultCandidate[] = [];

  if (lastResultIdx !== undefined) {
    const resultObj = objects[lastResultIdx]!;
    const extracted = extractCursorResult(resultObj);
    const text = extracted ?? (typeof resultObj.result === 'string' ? resultObj.result : '');
    out.push({
      source: 'terminal_result',
      event_index: lastResultIdx,
      session_id: sessionOf(resultObj) ?? currentSession,
      text: text ?? '',
      provider_failure: isCursorProviderFailure(resultObj),
    });

    for (let i = lastResultIdx - 1; i >= windowStart; i--) {
      const object = objects[i]!;
      if (!inCurrentSession(object, currentSession)) continue;
      const textBlock = assistantEventText(object);
      if (textBlock === null) continue;
      out.push({
        source: 'assistant_final',
        event_index: i,
        session_id: sessionOf(object) ?? currentSession,
        text: textBlock,
        provider_failure: false,
      });
      break;
    }
    return out;
  }

  // No terminal result: last complete assistant message in the current session.
  for (let i = objects.length - 1; i >= 0; i--) {
    const object = objects[i]!;
    if (!inCurrentSession(object, currentSession)) continue;
    const textBlock = assistantEventText(object);
    if (textBlock === null) continue;
    out.push({
      source: 'assistant_final',
      event_index: i,
      session_id: sessionOf(object) ?? currentSession,
      text: textBlock,
      provider_failure: false,
    });
    break;
  }
  return out;
}

function looksStructuredAttempt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
  return /```+\s*json\b/i.test(trimmed);
}

/** Collect explicit review.verdict values from complete JSON / fenced blocks in one delivery. */
export function collectExplicitVerdicts(text: string): Array<Review['verdict']> {
  const verdicts: Array<Review['verdict']> = [];
  const pushFrom = (value: unknown) => {
    try {
      const result = extractWorkerResult(
        typeof value === 'string' ? value : JSON.stringify(value),
        [],
      );
      if (result.review?.verdict) verdicts.push(result.review.verdict);
    } catch { /* ignore incomplete / non-result blocks */ }
  };

  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      pushFrom(value);
    } catch { /* may still have fences below */ }
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let fence: { length: number; json: boolean; lines: string[] } | null = null;
  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(`{3,})(.*)$/.exec(line);
      if (close && close[1]!.length >= fence.length) {
        if (fence.json) pushFrom(fence.lines.join('\n'));
        fence = null;
      } else fence.lines.push(line);
    } else {
      const open = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
      if (open) fence = { length: open[1]!.length, json: open[2]!.trim().toLowerCase() === 'json', lines: [] };
    }
  }
  return verdicts;
}

function hasConflictingVerdicts(text: string): boolean {
  return new Set(collectExplicitVerdicts(text)).size > 1;
}

type AssessKind = 'valid' | 'empty' | 'prose' | 'structured_invalid' | 'conflicting_verdicts' | 'missing_review';

function assessText(text: string, output: ResultCandidateContext['output']): { kind: AssessKind; detail?: string } {
  if (!text.trim()) return { kind: 'empty' };
  if (hasConflictingVerdicts(text)) return { kind: 'conflicting_verdicts' };

  try {
    const result = extractWorkerResult(text, []);
    // revise + empty findings remains a schema-valid extract; pipeline G9 still treats it as missing.
    if (output === 'verdict' && !result.review) return { kind: 'missing_review' };
    return { kind: 'valid' };
  } catch (error) {
    if (error instanceof GbdevError && error.contract.code === 'result_invalid') {
      return { kind: 'structured_invalid', detail: error.message };
    }
    if (looksStructuredAttempt(text)) {
      return { kind: 'structured_invalid', detail: error instanceof Error ? error.message : String(error) };
    }
    return { kind: 'prose' };
  }
}

/**
 * Strict selection: terminal wins when valid; assistant only for empty/prose terminal;
 * damaged / conflicting / provider-failure never resurrect an earlier approve.
 */
export function selectStructuredCursorResult(
  jobDir: string,
  context: ResultCandidateContext,
  outputFile = 'raw.json',
): StructuredSelection {
  const raw_file = outputFile;
  const candidates = extractResultCandidates(jobDir, context, outputFile);
  const assessments: CandidateAssessment[] = [];

  if (!candidates.length) {
    return { selected: null, valid: false, recovered_from_assistant: false, candidates: assessments, raw_file };
  }

  const terminal = candidates.find(c => c.source === 'terminal_result');
  if (terminal?.provider_failure) {
    assessments.push({
      source: 'terminal_result',
      event_index: terminal.event_index,
      accepted: false,
      reject_reason: 'provider_failure',
    });
    for (const c of candidates) {
      if (c.source === 'assistant_final') {
        assessments.push({
          source: c.source,
          event_index: c.event_index,
          accepted: false,
          reject_reason: 'blocked_by_provider_failure',
        });
      }
    }
    return {
      selected: null,
      valid: false,
      recovered_from_assistant: false,
      candidates: assessments,
      raw_file,
    };
  }

  for (const candidate of candidates) {
    const assessment = assessText(candidate.text, context.output);
    if (assessment.kind === 'valid') {
      assessments.push({ source: candidate.source, event_index: candidate.event_index, accepted: true });
      // Mark remaining as skipped.
      for (const rest of candidates) {
        if (rest === candidate) continue;
        if (assessments.some(a => a.event_index === rest.event_index && a.source === rest.source)) continue;
        assessments.push({
          source: rest.source,
          event_index: rest.event_index,
          accepted: false,
          reject_reason: 'superseded_by_earlier_valid',
        });
      }
      return {
        selected: candidate,
        valid: true,
        recovered_from_assistant: candidate.source === 'assistant_final',
        candidates: assessments,
        raw_file,
      };
    }

    if (assessment.kind === 'empty' || assessment.kind === 'prose') {
      assessments.push({
        source: candidate.source,
        event_index: candidate.event_index,
        accepted: false,
        reject_reason: assessment.kind,
      });
      continue;
    }

    // Damaged / conflicting / missing review: stick with this candidate; do not pick earlier approve.
    const reason = assessment.kind === 'conflicting_verdicts'
      ? 'conflicting_verdicts'
      : assessment.kind === 'missing_review'
        ? 'missing_review'
        : `structured_invalid:${assessment.detail ?? 'invalid'}`;
    assessments.push({
      source: candidate.source,
      event_index: candidate.event_index,
      accepted: false,
      reject_reason: reason,
    });
    for (const rest of candidates) {
      if (rest === candidate) continue;
      assessments.push({
        source: rest.source,
        event_index: rest.event_index,
        accepted: false,
        reject_reason: 'blocked_by_prior_structured_failure',
      });
    }
    return {
      selected: candidate,
      valid: false,
      force_invalid: reason,
      recovered_from_assistant: false,
      candidates: assessments,
      raw_file,
    };
  }

  return {
    selected: null,
    valid: false,
    recovered_from_assistant: false,
    candidates: assessments,
    raw_file,
  };
}
