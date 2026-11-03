import { writeFileSync } from 'node:fs';
import { buildWorkerResultSchema } from '../contracts/workerResultSchema.js';
import { join } from 'node:path';
import { optionalText } from '../core/runtime.js';
import { type ProviderAdapter, type ProviderContext } from './types.js';
import { jsonObjects, lastString } from './jsonOutput.js';
import { providerOutputSchema } from './outputSchema.js';

/** Only structured error messages, never raw events, argv, prompt or worker prose. */
export function codexFailureReason(jobDir: string): string | null {
  const events = jsonObjects(optionalText(join(jobDir, 'raw.jsonl')) ?? '');
  const event = events.findLast(e => ['turn.failed', 'error', 'turn.completed'].includes(String(e.type)));
  if (!event || event.type === 'turn.completed') return null;
  const error = event.error;
  const rawMessage = error && typeof error === 'object' && 'message' in error ? error.message : event.message;
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) return null;
  let message = rawMessage;
  // Providers can echo request text in errors. Redact known prompt text before truncation.
  const prompt = optionalText(join(jobDir, 'prompt.md')) ?? '';
  for (const text of [prompt, ...prompt.split(/\r?\n/)].filter(text => text.trim().length >= 8)) message = message.replaceAll(text, '[redacted prompt]');
  message = message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(message);
  return `provider_error: ${chars.length > 300 ? chars.slice(0, 299).join('') + '…' : message}`;
}

export function codexSessionId(jobDir: string, outputFile = 'raw.jsonl'): string | null {
  const events = jsonObjects(optionalText(join(jobDir, outputFile)) ?? '');
  return lastString(events.filter(event => event.type === 'thread.started'), 'thread_id');
}

/** Pure argv construction: never grant writable access outside the worktree. */
export function buildCodexArgs(ctx: ProviderContext): string[] {
  const args = ['exec', '--cd', ctx.worktree, '--sandbox', ctx.sandbox,
    '--json', '--output-last-message', join(ctx.jobDir, 'final.md'), '--output-schema', join(ctx.jobDir, 'worker-result.schema.json')];
  if (ctx.model !== null && ctx.model.trim()) args.push('-m', ctx.model);
  if (ctx.network && ctx.sandbox === 'workspace-write') args.push('-c', 'sandbox_workspace_write.network_access=true');
  args.push('-c', 'model_reasoning_effort=high');
  args.push(ctx.prompt);
  return args;
}

/** Flags verified against the local `codex exec --help` (2026-10-25). */
export const codex: ProviderAdapter = {
  name: 'codex',
  prepareJob(jobDir, options) { writeFileSync(join(jobDir, 'worker-result.schema.json'), JSON.stringify(providerOutputSchema(buildWorkerResultSchema(options)), null, 2), { mode: 0o600 }); },
  buildInvocation(ctx) {
    const finalMessageFile = join(ctx.jobDir, 'final.md');
    return { cmd: ctx.bin, args: buildCodexArgs(ctx), cwd: ctx.worktree, finalMessageFile };
  },
  extractFinalMessage(jobDir) { return optionalText(join(jobDir, 'final.md')); },
};
