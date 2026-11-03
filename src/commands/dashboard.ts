import { GbdevError } from '../contracts/error.js';
import type { GbdevPaths } from '../core/paths.js';
import { unitKind } from '../dashboard/names.js';
import { captureDashboard, closeDashboard, dashboardStatus, ensureDashboard, type DashboardStatus } from '../dashboard/reconcile.js';
const usage = (): never => { throw new GbdevError('usage_error', 'Use dashboard status | ensure [--target <id>] | capture <id>[:<pane>] [--lines 1..2000] | close <id>|--all'); };
export async function dashboardCommand(paths: GbdevPaths, args: string[], options: Record<string, string | boolean | undefined>, hidden = false): Promise<{ result: DashboardStatus & { text?: string }; text: string }> {
  const [sub, target] = args;
  const allowed: Record<string, string[]> = { status: [], ensure: ['target'], capture: ['lines'], close: ['all'] };
  if (!sub || !Object.hasOwn(allowed, sub) || args.length > 2 || Object.entries(options).some(([k, v]) => v !== undefined && !allowed[sub]!.includes(k))) usage();
  if ((sub === 'status' || sub === 'ensure') && target || sub === 'capture' && !target || sub === 'close' && (!target === !options.all)) usage();
  if (hidden && (sub !== 'ensure' || typeof options.target !== 'string')) usage();
  const validate = (id: string) => { try { unitKind(id); } catch { usage(); } };
  if (options.target !== undefined) { if (typeof options.target !== 'string') usage(); validate(options.target as string); }
  let status: DashboardStatus;
  if (sub === 'capture') {
    const [id, pane = 'status', extra] = target!.split(':'); validate(id!);
    if (extra !== undefined || !/^(status|lane-[1-4]|integration|step|job)$/.test(pane)) usage();
    if (options.lines !== undefined && (typeof options.lines !== 'string' || !/^\d+$/.test(options.lines) || Number(options.lines) < 1 || Number(options.lines) > 2000)) usage();
    const captured = await captureDashboard(paths, id!, pane, Number(options.lines ?? 200)); status = captured.status;
    if (!status.enabled || status.session_state !== 'owned') unavailable(status);
    return { result: { ...status, text: captured.text }, text: captured.text };
  }
  if (sub === 'close') { if (target) validate(target); status = await closeDashboard(paths, target); if (!status.enabled || status.reason) unavailable(status); }
  else status = sub === 'ensure' ? await ensureDashboard(paths, options.target as string | undefined) : await dashboardStatus(paths);
  return { result: status, text: `dashboard ${status.enabled ? status.session_state : status.reason} ${status.session ?? ''}\n${status.attach_hint ? status.attach_hint + '\n' : ''}${status.missing_panes?.map(p => `${p.key}: ${p.reason}\n`).join('') ?? ''}` };
}
function unavailable(status: DashboardStatus): never { throw new GbdevError('dashboard_unavailable', 'Dashboard target unavailable', { reason: status.reason ?? 'tmux_error' }); }
