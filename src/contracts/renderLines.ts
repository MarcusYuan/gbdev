import { validateJobId } from '../core/ids.js';
import { TAGS, type RenderLine } from '../render/format.js';
import { PROVIDERS, type Provider } from './brief.js';
import { array, integer, invalid, object, oneOf, timestamp } from './validation.js';
export interface RenderLinesResult {
  job_id: string; provider: Provider; lines: RenderLine[];
  corrupt_lines: number; truncated_lines: number; skipped_bytes: number;
}
export function validateRenderLines(value: unknown): RenderLinesResult {
  const v = object(value, 'render-lines'); validateJobId(v.job_id); oneOf(v.provider, PROVIDERS, 'provider');
  for (const key of ['corrupt_lines', 'truncated_lines', 'skipped_bytes']) integer(v[key], key);
  for (const value of array(v.lines, 'lines')) {
    const l = object(value, 'line'); timestamp(l.at, 'at'); oneOf(l.tag, TAGS, 'tag');
    if (typeof l.text !== 'string') invalid('text must be a string');
  }
  return value as RenderLinesResult;
}
