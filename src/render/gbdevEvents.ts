import { line, record, str, type RenderContext, type RenderLine } from './format.js';
/** Existing checks may use criterion-N instead of a free-text acceptance ID. */
export function checkLog(data: Record<string, unknown>): string | undefined {
  if (typeof data.log === 'string' && /^checks\/[A-Za-z0-9][A-Za-z0-9_-]*\.log$/.test(data.log)) return data.log;
  const id = str(data.id ?? data.check_id);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? `checks/${id}.log` : undefined;
}
export function gbdevEvents(event: Record<string, unknown>, ctx: RenderContext): RenderLine[] {
  const data = record(event.data);
  switch (event.type) {
    case 'state_change': return [line(ctx, 'STATE', `${str(data.state)}${data.failure_reason ? ` ${str(data.failure_reason)}` : ''}`)];
    case 'check': {
      const id = str(data.id ?? data.check_id), code = data.exit_code, seconds = data.duration_s;
      return [line(ctx, 'CHECK', code === 0 ? `✓ ${id}${typeof seconds === 'number' ? ` ${seconds}s` : ''}` : `✗ ${id} exit ${str(code)} (${checkLog(data) ?? 'log unavailable'})`)];
    }
    case 'warning': return [line(ctx, 'WARN', [str(data.code), str(data.message)].filter(Boolean).join(': '))];
    case 'heartbeat': case 'worker_output': case 'recovery_step': return [];
    default: return [line(ctx, '?', str(event.type) || 'unknown')];
  }
}
export function providerLine(provider: Record<string, unknown>, job: Record<string, unknown>, ctx: RenderContext): RenderLine {
  return line(ctx, 'STEP', `${str(provider.provider ?? job.provider)} ${str(provider.role ?? job.role)} ${str(job.job_id)} sandbox=${str(provider.sandbox ?? job.sandbox)} model=${str(provider.model) || (job.provider === 'cursor' ? 'auto' : job.provider === 'codex' ? 'gpt-6-astra' : 'fake')}`);
}
