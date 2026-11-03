import { join } from 'node:path';
import { cursorMetadata, providerFailureReason } from '../providers/cursor.js';
import { jsonObjects } from '../providers/jsonOutput.js';
import { extractWorkerResult } from '../contracts/workerResult.js';
import { optionalText } from './runtime.js';

/** Both supervision and finalization use the same persisted extraction evidence. */
export function validProviderResult(jobDir: string): boolean {
  const read = (name: string) => {
    try { return JSON.parse(optionalText(join(jobDir, name)) ?? '{}') ?? {}; } catch { return {}; }
  };
  if (read('result-extraction.json').force_invalid) return false;
  try {
    extractWorkerResult(optionalText(join(jobDir, 'final.md')) ?? '', [], read('provider.json').schema_options);
    return true;
  } catch { return false; }
}

const limitText = /\b(?:429|rate[ _-]?limit(?:ed)?|usage limit|too many requests|quota exceeded|resource_exhausted)\b/i;

function providerStderrLine(line: string): boolean {
  const body = line.trim().replace(/^\[?\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})\]?\s+/, '');
  // Strong provider signals take precedence over source/diagnostic exclusions.
  if (/\bHTTP\/\d+(?:\.\d+)?\s+429\b|\bstatus(?:\s*:\s*|\s+)429\b|\b429\s+Too Many Requests\b/i.test(body)
    || /^ERROR\s+\w+::[\w:]+:/.test(body)) return true;
  const json = /^error(?::|\s)\s*(?:[\w.-]+:\s*)?(\{.*\})$/i.exec(body)?.[1];
  if (json) {
    try {
      const envelope = JSON.parse(json);
      const error = envelope.error;
      if (typeof error === 'string' && limitText.test(error)) return true;
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        if ([error.message, error.type, error.code, error.status].some(value => typeof value === 'string' && limitText.test(value))
          || error.code === 429 || error.status === 429) return true;
      }
    } catch { /* Invalid JSON can still be a source literal echo. */ }
  }
  // Exclude source echoes, not arbitrary mentions of tests or quoted JSON fields.
  if (/^assertion failed:|^not ok\s+\d+\s+-|^✖\s/i.test(body)) return false;
  if (/\bassert(?:\.\w+)*\s*\(|\bexpect\s*\(|^error\[E\d+\]|^error TS\d+\b|^test\s|\.test\.|\.[a-z]+:\d|["'`][^"'`]*(?:429|rate[ _-]?limit|usage limit|too many requests|quota exceeded|resource_exhausted)[^"'`]*["'`]/i.test(body)) return false;
  return /^error:\s*429\b|\brate[ _-]?limit(?:ed)?\b|\busage limit\b|\btoo many requests\b|\bquota exceeded\b|\bresource_exhausted\b/i.test(body);
}

/** Only provider error envelopes and stderr are eligible, never stdout tool/assistant text. */
export function providerRateLimit(provider: string, jobDir: string, exitCode: number | null): boolean {
  const failure = provider === 'cursor' ? cursorMetadata(jobDir).failure_reason : providerFailureReason(provider, jobDir);
  const eligible = exitCode !== 0 || !validProviderResult(jobDir) || !!failure;
  if (!eligible) return false;
  let errorText = failure ?? '';
  if (provider === 'cursor' && failure?.startsWith('provider_error:')) {
    const objects = jsonObjects(optionalText(join(jobDir, 'raw.json')) ?? '');
    const result = objects.findLast(e => e.type === 'result') ??
      (objects.length === 1 && !('type' in objects[0]!) ? objects[0] : undefined);
    if (result) {
      const structured = [result.message, result.error, result.errors].flatMap(value =>
        typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(v => typeof v === 'string') :
          value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? [value.message] : []);
      const fallback = typeof result.result === 'string' && result.result.length <= 500 ? result.result : '';
      errorText += '\n' + (structured.length ? structured.join('\n') : fallback);
    }
  }
  const stderr = (optionalText(join(jobDir, 'worker.log')) ?? '').split(/\r?\n/).slice(-80)
    .filter(providerStderrLine)
    .join('\n');
  return limitText.test(errorText + '\n' + stderr);
}
