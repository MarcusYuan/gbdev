import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { optionalText } from '../core/runtime.js';
import { type ProviderAdapter } from './types.js';
import { jsonObjects, lastString } from './jsonOutput.js';
import { codexFailureReason } from './codex.js';

export type CursorMessageExtractor = (raw: unknown) => string | null;

/** Cursor result objects carry the full final message in .result. */
export const extractCursorResult: CursorMessageExtractor = raw => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return 'result' in raw && typeof raw.result === 'string' ? raw.result : null;
};

/** Stream lifecycle events are not result envelopes, even when they have a subtype. */
function lastCursorResult(objects: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return objects.findLast(object => object.type === 'result') ??
    (objects.length === 1 && !('type' in objects[0]!) ? objects[0] : undefined);
}

function assistantText(objects: Record<string, unknown>[]): string | null {
  const texts: string[] = [];
  for (const object of objects) {
    if (object.type !== 'assistant') continue;
    const message = object.message;
    if (message === null || typeof message !== 'object' || !('content' in message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.length ? texts.join('') : null;
}

export function cursorMetadata(jobDir: string, outputFile = 'raw.json'): { session_id: string | null; failure_reason: string | null } {
  const objects = jsonObjects(optionalText(join(jobDir, outputFile)) ?? '');
  const raw = lastCursorResult(objects) ?? {};
  return {
    session_id: lastString(objects, 'session_id'),
    failure_reason: typeof raw.subtype === 'string' && raw.subtype !== 'success' ? `provider_error: ${raw.subtype}` :
      raw.is_error === true ? 'provider_error: is_error' : null,
  };
}

export function providerFailureReason(provider: string, jobDir: string): string | null {
  if (provider === 'codex') return codexFailureReason(jobDir);
  if (provider !== 'cursor') return null;
  if ((optionalText(join(jobDir, 'worker.log')) ?? '').includes('Workspace Trust Required')) return 'provider_trust_required';
  return cursorMetadata(jobDir).failure_reason;
}

const CURSOR_PROMPT_MAX_BYTES = 200000;

export function createCursorAdapter(extract: CursorMessageExtractor = extractCursorResult): ProviderAdapter {
  return {
    name: 'cursor',
    buildInvocation(ctx) {
      if (ctx.model !== null && ctx.model !== 'auto') throw new GbdevError('cursor_model_not_allowed', 'Cursor model must be null or auto');
      const promptBytes = Buffer.byteLength(ctx.prompt, 'utf8');
      if (promptBytes > CURSOR_PROMPT_MAX_BYTES) {
        throw new GbdevError('prompt_too_large', 'Cursor argv prompt exceeds byte limit', {
          provider: 'cursor',
          prompt_bytes: promptBytes,
          max_bytes: CURSOR_PROMPT_MAX_BYTES,
          diff_externalized: false,
        });
      }
      // cursor-agent 2026.10.22 has no network CLI switch. Existing sandbox argv
      // was verified to reach example.com / registry.npmjs.org. Both network values
      // keep argv unchanged; false is a prompt constraint. Never write user/global
      // cli-config or worktree .cursor/sandbox.json to implement network policy.
      const args = ['-p', '--output-format', 'stream-json', '--sandbox', 'enabled', '--trust'];
      if (ctx.sandbox === 'read-only') args.push('--mode', 'plan');
      else args.push('--force');
      args.push('--model', 'auto', ctx.prompt);
      return { cmd: ctx.bin, args, cwd: ctx.worktree, finalMessageFile: null };
    },
    extractFinalMessage(jobDir) {
      const raw = optionalText(join(jobDir, 'raw.json'));
      if (raw === null) return null;
      const objects = jsonObjects(raw);
      const result = lastCursorResult(objects);
      return result ? extract(result) : assistantText(objects);
    },
  };
}
export const cursor = createCursorAdapter();
