import { displayPath, line, outputTail, record, safeText, str, type RenderContext, type RenderLine } from './format.js';
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const tokens = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n) : '0';
export function codex(event: Record<string, unknown>, ctx: RenderContext): RenderLine[] {
  const item = record(event.item), type = str(event.type);
  switch (type) {
    case 'thread.started': {
      const session = safeText(str(event.thread_id));
      return [line(ctx, 'INIT', `codex session ${session.includes('‹redacted›') ? '‹redacted›' : session.slice(0, 8)}`)];
    }
    case 'turn.started': return [];
    case 'item.started':
      if (item.type === 'command_execution') {
        const command = str(item.command).replace(/^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/, '$2');
        return [line(ctx, 'CMD', `$ ${command}`)];
      }
      if (item.type === 'file_change' || item.type === 'reasoning' || item.type === 'agent_message') return [];
      break;
    case 'item.completed':
      switch (item.type) {
        case 'command_execution': return [line(ctx, 'EXIT', typeof item.exit_code === 'number' ? `${item.exit_code === 0 ? '✓' : '✗'} ${item.exit_code}` : 'done'),
          ...(ctx.verbose ? outputTail(str(item.aggregated_output), 5).map(text => line(ctx, '', `│ ${text}`)) : [])];
        case 'file_change': {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          return [line(ctx, 'EDIT', changes.slice(0, 6).map(value => {
            const change = record(value), kind = ({ update: 'M', add: 'A', delete: 'D' } as Record<string, string>)[str(change.kind)] ?? '?';
            return `${kind} ${displayPath(str(change.path), ctx)}`;
          }).join(', ') + (changes.length > 6 ? ` +${changes.length - 6}` : ''))];
        }
        case 'reasoning': return [line(ctx, 'THINK', compact(str(item.text)))];
        case 'agent_message': {
          const text = str(item.text);
          try {
            const report = record(JSON.parse(text));
            if (report.schema === 'gbdev.worker-result.v1' && typeof report.status === 'string' && typeof report.summary === 'string') return [line(ctx, 'MSG', `result status=${report.status} ${report.summary.split(/\r?\n/)[0]}`)];
          } catch { /* ordinary prose */ }
          return [line(ctx, 'MSG', compact(text))];
        }
      }
      break;
    case 'turn.completed': {
      const usage = record(event.usage);
      return [line(ctx, 'TURN', `tokens in ${tokens(usage.input_tokens)} (cached ${tokens(usage.cached_input_tokens)}) out ${tokens(usage.output_tokens)} (reasoning ${tokens(usage.reasoning_output_tokens ?? usage.reasoning_tokens)})`)];
    }
    case 'turn.failed': case 'error': return [line(ctx, 'ERR', safeText(str(record(event.error).message ?? event.message ?? event.error)).slice(0, 300))];
  }
  return [line(ctx, '?', type ? `${type}${item.type ? `:${str(item.type)}` : ''}` : 'unknown')];
}
