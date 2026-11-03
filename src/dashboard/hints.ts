import type { GbdevPaths } from '../core/paths.js';
import { dashboardStatus } from './reconcile.js';
export interface DashboardHint { enabled: boolean; reason: string | null; session: string | null; window: string; attach_hint: string | null; watch_hint: string }
/** Read-only, budgeted observation after launch; never repairs or waits for an ensure child. */
export async function dashboardHint(paths: GbdevPaths, id: string, kind: 'job' | 'pipeline' | 'run'): Promise<DashboardHint> {
  const status = await dashboardStatus(paths, 1000);
  return { enabled: status.enabled, reason: status.reason, session: status.session, window: id,
    attach_hint: status.enabled && !status.reason && status.session ? `tmux attach -t ${status.session}` : null,
    watch_hint: kind === 'job' ? `gbdev logs ${id} --follow` : `gbdev ${kind} watch ${id}` };
}
export async function addDashboard<T extends object>(paths: GbdevPaths, value: T, id: string, kind: 'job' | 'pipeline' | 'run'): Promise<T & { dashboard: DashboardHint }> {
  return { ...value, dashboard: await dashboardHint(paths, id, kind) };
}
export function dashboardHintText(value: unknown): string {
  const hint = (value as { dashboard?: DashboardHint })?.dashboard;
  return hint ? `${hint.attach_hint ? hint.attach_hint + '; ' : ''}${hint.watch_hint}\n` : '';
}
