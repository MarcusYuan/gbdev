import { displayPath, line, outputTail, record, safeText, str, type RenderContext, type RenderLine } from './format.js';
export function contentText(message: unknown): string {
  const content = record(message).content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(v => str(record(v).text)).join('') : '';
}
/** Bounded iterative lookup: tolerate wrapper variations without unbounded recursion. */
export function findField(value: unknown, keys: readonly string[]): unknown {
  const pending: unknown[] = [value]; let visited = 0;
  while (pending.length && visited++ < 2048) {
    const value = pending.pop();
    if (Array.isArray(value)) { pending.push(...value.slice(0, 2048 - pending.length)); continue; }
    const current = record(value);
    for (const key of keys) if (Object.hasOwn(current, key)) return current[key];
    for (const v of Object.values(current)) if (v && typeof v === 'object' && pending.length < 2048) pending.push(v);
  }
  return undefined;
}
function duration(ms: unknown): string {
  const seconds = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}
export function cursor(event: Record<string, unknown>, ctx: RenderContext): RenderLine[] {
  const type = str(event.type), subtype = str(event.subtype);
  switch (type) {
    case 'system':
      if (subtype === 'init') return [line(ctx, 'INIT', `cursor model=${str(event.model)} mode=${str(event.permissionMode)} cwd=${displayPath(str(event.cwd), ctx)}`)];
      if (subtype === 'task_notification') return [line(ctx, 'NOTE', `${str(event.title)}: ${str(event.status)}`)];
      break;
    case 'user': return [line(ctx, 'PROMPT', `(${contentText(event.message).length} chars)`)];
    case 'thinking': return []; // Stateful coalescing belongs to ThinkingBuffer, not this pure mapper.
    case 'assistant': return [line(ctx, 'MSG', contentText(event.message).replace(/\s+/g, ' ').trim())];
    case 'connection':
      if (subtype === 'reconnecting' || subtype === 'reconnected') return [line(ctx, 'NET', subtype === 'reconnected' ? subtype : `reconnecting (attempt ${str(event.attempt)})`)];
      break;
    case 'retry':
      if (subtype === 'starting' || subtype === 'resuming') return [line(ctx, 'RETRY', subtype === 'starting' ? `attempt ${str(event.attempt)}` : `resuming from turn ${str(event.checkpoint_turn_count)}`)];
      break;
    case 'result': return [line(ctx, subtype === 'success' && event.is_error === false ? 'DONE' : 'ERR', subtype === 'success' && event.is_error === false ? `ok ${duration(event.duration_ms)} (api ${duration(event.duration_api_ms)})` : `result ${subtype}`)];
    case 'tool_call': {
      const call = record(event.tool_call), key = Object.keys(call).find(k => k.endsWith('ToolCall'));
      if (!key) break;
      const tool = record(call[key]), args = record(tool.args), name = key.replace(/ToolCall$/, '');
      if (subtype === 'started') {
        const path = str(args.path ?? args.filePath ?? args.file_path ?? args.target_file);
        switch (key) {
          case 'readToolCall': return [line(ctx, 'READ', displayPath(path, ctx))];
          case 'grepToolCall': return [line(ctx, 'GREP', `/${str(args.pattern)}/ in ${displayPath(path, ctx)}`)];
          case 'globToolCall': return [line(ctx, 'GLOB', str(args.globPattern))];
          case 'shellToolCall': return [line(ctx, 'CMD', `$ ${str(args.command)}${record(args.requestedSandboxPolicy).networkAccess === true ? ' ⚠net' : ''}`)];
          case 'taskToolCall': return [line(ctx, 'TASK', `${str(args.description)} (${str(record(record(args.subagentType).custom).name)})`)];
          case 'awaitToolCall': return [line(ctx, 'WAIT', '')];
          case 'getMcpToolsToolCall': return [line(ctx, 'MCP', `list-tools ${str(args.server)}`)];
        }
        if (/^(?:edit|write|delete|applyPatch|create|replace)/i.test(name)) return [line(ctx, 'EDIT', path ? `${/^delete/i.test(name) ? 'D' : /^(?:write|create)/i.test(name) ? 'A' : 'M'} ${displayPath(path, ctx)}` : `(${key})`)];
        const first = ['path', 'pattern', 'command', 'query'].map(k => args[k]).find(v => typeof v === 'string');
        return [line(ctx, 'TOOL', `${name}${first ? ` ${safeText(str(first)).slice(0, 80)}` : ''}`)];
      }
      if (subtype === 'completed') {
        const result = tool.result ?? event.result;
        const error = findField(result, ['error', 'failure']);
        // Never echo result bodies from read/grep/MCP, even when wrapped in errors.
        if (error !== undefined && error !== null && error !== false) return [line(ctx, 'ERR', `${name}: ${/^(?:read|grep|glob|getMcpTools)$/.test(name) ? 'failed' : safeText(str(record(error).message ?? error)).slice(0, 200) || 'failed'}`)];
        const out: RenderLine[] = [];
        if (key === 'shellToolCall') {
          const code = findField(result, ['exitCode', 'exit_code']);
          out.push(line(ctx, 'EXIT', typeof code === 'number' ? `${code === 0 ? '✓' : '✗'} ${code}` : 'done'));
          if (ctx.verbose) out.push(...outputTail(str(findField(result, ['stdout', 'output', 'aggregated_output'])), 5).map(text => line(ctx, '', `│ ${text}`)));
        }
        if (key === 'grepToolCall' || key === 'globToolCall') {
          const total = findField(result, ['totalFiles']), files = findField(result, ['files']);
          if (typeof total === 'number' || Array.isArray(files)) out.push(line(ctx, '', `↳ ${typeof total === 'number' ? total : (files as unknown[]).length} files`));
        }
        const ms = tool.duration_ms ?? event.duration_ms ?? findField(result, ['durationMs', 'duration_ms']);
        if (typeof ms === 'number' && ms >= 10000) out.push(line(ctx, '', `↳ ${name} ${(ms / 1000).toFixed(1)}s`));
        return out;
      }
      break;
    }
  }
  return [line(ctx, '?', `${type || 'unknown'}${subtype ? `:${subtype}` : ''}`)];
}
