import { DECISION_REASONS } from '../contracts/run.js';
import type { NotifyPayload } from '../contracts/notify.js';

export interface NotifyUnit {
  kind: 'run' | 'pipeline' | 'job'; id: string; state: string;
  pipeline_id?: string | null; run_id?: string | null; workspace_mode?: string;
}
export interface Notice {
  event: NotifyPayload['event']; kind: NotifyPayload['kind'];
  decision_id?: string | null; task_id?: string | null; reason_code?: unknown;
}
/** Complete allowlist, independent of supervisor/AsyncLocalStorage context. */
export function notifiable(unit: NotifyUnit | null, type: string, data: Record<string, unknown>): Notice | null {
  if (!unit) return type === 'test' ? { event: 'test', kind: 'test' } : null;
  if (unit.kind !== 'run' && (unit.run_id || unit.pipeline_id || unit.workspace_mode === 'per_lane')) return null;
  if (type === 'notify_secret_exposed') return { event: 'health', kind: 'notify_secret_exposed' };
  if (unit.kind === 'run') {
    if (type === 'decision_required' && (DECISION_REASONS as readonly unknown[]).includes(data.reason)) {
      return { event: 'attention', kind: data.reason as Notice['kind'], decision_id: typeof data.decision_id === 'string' ? data.decision_id : null, task_id: typeof data.task_id === 'string' ? data.task_id : null };
    }
    if (type === 'supervisor_heartbeat_stale' || type === 'notify_secret_exposed') return { event: 'health', kind: type };
  }
  if (unit.kind === 'pipeline' && type === 'decision_required' && ['needs_input', 'blocked', 'needs_decision'].includes(unit.state)) {
    return { event: 'attention', kind: unit.state as Notice['kind'], decision_id: typeof data.decision_id === 'string' ? data.decision_id : null };
  }
  const transition = { run: 'run_state_change', pipeline: 'pipeline_state_change', job: 'state_change' }[unit.kind];
  if (type !== transition) return null;
  if (['succeeded', 'failed', 'cancelled', ...(unit.kind === 'job' ? ['timeout'] : [])].includes(String(data.state))) {
    return { event: 'terminal', kind: data.state as Notice['kind'], reason_code: data.state === 'failed' || data.state === 'timeout' ? data.reason ?? data.failure_reason : null };
  }
  if (unit.kind === 'job' && (data.state === 'needs_input' || data.state === 'blocked')) return { event: 'attention', kind: data.state === 'needs_input' ? 'job_needs_input' : 'job_blocked' };
  return null;
}
