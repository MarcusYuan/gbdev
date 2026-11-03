import { isAbsolute, relative, resolve, sep } from 'node:path';
import { localIso } from '../core/time.js';
import { sanitizeForTerminal } from './sanitize.js';
import { redactSecrets } from './redact.js';
export const TAGS = ['INIT', 'PROMPT', 'THINK', 'MSG', 'CMD', 'EXIT', 'READ', 'EDIT', 'GREP', 'GLOB', 'TASK', 'WAIT', 'MCP', 'TOOL', 'NOTE', 'NET', 'RETRY', 'TURN', 'DONE', 'ERR', 'WARN', 'STATE', 'CHECK', 'STEP', 'MERGE', 'GATE', 'DECIDE', 'SKIP', '?', ''] as const;
export type Tag = typeof TAGS[number];
export interface RenderLine { at: string; tag: Tag; text: string }
export interface RenderContext { at: string; worktree: string; userHome?: string; verbose?: boolean }
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function str(value: unknown): string { return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''; }
export function eventAt(event: Record<string, unknown>, fallback: string): string {
  const time = typeof event.timestamp_ms === 'number' ? event.timestamp_ms : typeof event.at === 'string' ? Date.parse(event.at) : NaN;
  const date = new Date(time);
  return Number.isFinite(time) && Number.isFinite(date.getTime()) && date.getFullYear() >= 0 && date.getFullYear() <= 9999 ? localIso(date) : fallback;
}
export function line(ctx: RenderContext, tag: Tag, text: string): RenderLine { return { at: ctx.at, tag, text }; }
export function safeText(text: string): string { return redactSecrets(sanitizeForTerminal(text)); }
export function charWidth(char: string): number {
  if (/\p{Mark}/u.test(char)) return 0;
  const n = char.codePointAt(0)!;
  return n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7a3 || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0xffe0 && n <= 0xffe6 || n >= 0x1f300 && n <= 0x1faff || n >= 0x20000 && n <= 0x3fffd) ? 2 : 1;
}
export function displayWidth(text: string): number { let width = 0; for (const c of text) width += charWidth(c); return width; }
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '', used = 0;
  for (const c of text) { const w = charWidth(c); if (used + w > width - 1) break; out += c; used += w; }
  return out + '…';
}
/** Sanitize and redact the ENTIRE logical line before wrapping; JSON uses these same safe lines. */
export function prepareLine(input: RenderLine, columns = 120): RenderLine[] {
  const width = Math.max(1, Math.min(1000, columns) - 16);
  let text = safeText(input.text).replace(/\t/g, '    ');
  const max = input.tag === 'THINK' || input.tag === 'MSG' ? 3 : 1;
  const result: RenderLine[] = [];
  for (let i = 0; i < max; i++) {
    if (i === max - 1 || displayWidth(text) <= width) { result.push({ ...input, text: truncate(text, width) }); break; }
    let end = 0, used = 0;
    for (const c of text) { const w = charWidth(c); if (used + w > width) break; end += c.length; used += w; }
    if (!end) { result.push({ ...input, text: '…' }); break; }
    result.push({ ...input, text: text.slice(0, end) }); text = text.slice(end);
  }
  return result;
}
export function formatLine(input: RenderLine, color = false): string {
  const date = new Date(input.at);
  const time = Number.isFinite(date.getTime()) ? [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':') : '??:??:??';
  const text = `${time} ${input.tag.padEnd(6)} ${safeText(input.text)}`;
  const code = input.tag === 'ERR' || input.text.includes('✗') ? 31 : input.tag === 'WARN' ? 33 : input.tag === 'DONE' || input.text.includes('✓') ? 32 : input.tag === 'THINK' ? 90 : 0;
  return color && code ? `\x1b[${code}m${text}\x1b[0m\n` : text + '\n';
}
export function displayPath(path: string, ctx: RenderContext): string {
  if (!path) return '(unknown path)';
  const absolute = resolve(ctx.worktree || '/', path), rel = relative(ctx.worktree || '/', absolute);
  if (ctx.worktree && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel || '.';
  const home = ctx.userHome;
  return `⚠outside ${home && (absolute === home || absolute.startsWith(home + sep)) ? '~' + absolute.slice(home.length) : absolute}`;
}
export function outputTail(text: string, count: number): string[] {
  // Redact across newlines (notably private keys) before taking a tail.
  return redactSecrets(text).split(/\r?\n/).filter((s, i, a) => i < a.length - 1 || s !== '').slice(-count);
}
