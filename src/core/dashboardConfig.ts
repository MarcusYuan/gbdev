import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { GbdevError } from '../contracts/error.js';
export interface DashboardConfig {
  enabled: boolean; session: string | null; tmux_path: string | null;
  retain_finished_min: number; idle_exit_min: number; max_windows: number;
  backfill_lines: number; poll_ms: number; show_command_output: boolean; color: boolean;
}
export const DASHBOARD_DEFAULTS: DashboardConfig = { enabled: true, session: null, tmux_path: null, retain_finished_min: 30, idle_exit_min: 120, max_windows: 8, backfill_lines: 400, poll_ms: 500, show_command_output: false, color: true };
export const SAFE_DYNAMIC = /^[A-Za-z0-9_./:@+=,-]+$/;
export const SESSION_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export function validateDashboard(value: unknown): DashboardConfig {
  const fail = (): never => { throw new GbdevError('config_invalid', 'Invalid dashboard configuration'); };
  if (value === undefined) return { ...DASHBOARD_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !Object.hasOwn(DASHBOARD_DEFAULTS, k))) fail();
  const d = { ...DASHBOARD_DEFAULTS, ...v };
  for (const k of ['enabled', 'show_command_output', 'color'] as const) if (typeof d[k] !== 'boolean') fail();
  if (d.session !== null && (typeof d.session !== 'string' || !SESSION_NAME.test(d.session))) fail();
  if (d.tmux_path !== null && (typeof d.tmux_path !== 'string' || !isAbsolute(d.tmux_path) || !SAFE_DYNAMIC.test(d.tmux_path))) fail();
  for (const [k, min, max] of [['retain_finished_min', 0, 1440], ['idle_exit_min', 5, 1440], ['max_windows', 1, 32], ['backfill_lines', 50, 5000], ['poll_ms', 200, 5000]] as const) {
    if (!Number.isInteger(d[k]) || d[k] < min || d[k] > max) fail();
  }
  return d as DashboardConfig;
}
/** Pane readers project only this section; never return the rest of the config. */
export function loadDashboard(path: string): DashboardConfig {
  try { return validateDashboard((JSON.parse(readFileSync(path, 'utf8')) as { dashboard?: unknown }).dashboard); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return validateDashboard(undefined); if (e instanceof GbdevError) throw e; throw new GbdevError('config_invalid', 'Cannot read dashboard configuration'); }
}
