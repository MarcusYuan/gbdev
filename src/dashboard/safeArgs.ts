import { SAFE_DYNAMIC } from '../core/dashboardConfig.js';
/** Dashboard failure reasons, SPEC-M4 §7.1; null denotes no failure. */
export const DASHBOARD_REASONS = [
  'disabled_by_config', 'disabled_by_env', 'disabled_in_tests', 'tmux_not_found', 'tmux_too_old',
  'tmux_error', 'tmux_timeout', 'unsafe_argv', 'foreign_session', 'lock_busy',
] as const;
export type DashboardReason = typeof DASHBOARD_REASONS[number];
export class DashboardFailure extends Error {
  constructor(readonly reason: DashboardReason) { super(reason); }
}
export const PANE_FORMAT = '#{window_id}\t#{pane_id}\t#{@gbdev_key}\t#{pane_dead}';
export const CREATED_FORMAT = '#{window_id}\t#{pane_id}';
export const BORDER_FORMAT = '#{pane_title}';
// Compact spelling preserves S-D1 even for the fixed small-window notice.
export const SMALL_BORDER_FORMAT = '#{pane_title}:no-pane:window-too-small';
const formats = new Set([PANE_FORMAT, CREATED_FORMAT, BORDER_FORMAT, SMALL_BORDER_FORMAT, '#{pane_id}']);
export function dynamic(value: string): string {
  if (!SAFE_DYNAMIC.test(value) || value.endsWith(';')) throw new DashboardFailure('unsafe_argv');
  return value;
}
export function paneId(value: string): string { if (!/^%\d+$/.test(value)) throw new DashboardFailure('tmux_error'); return value; }
export function windowId(value: string): string { if (!/^@\d+$/.test(value)) throw new DashboardFailure('tmux_error'); return value; }
export function safeArgs(args: readonly string[], compound = false): void {
  for (const arg of args) {
    if (arg === ';' && compound) continue;
    if (formats.has(arg) || arg === '35%' || /^%\d+$/.test(arg)) continue;
    dynamic(arg);
  }
}
