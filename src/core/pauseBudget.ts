import { localIso } from './time.js';

export const MAX_PAUSE_EXTENSION_MS = 24 * 60 * 60 * 1000;
export interface PauseBudget { deadline_at: string; paused_since?: string; paused_ms?: number }
/** paused_ms is total completed waiting time; only its first 24h extends the deadline.
 * Legacy records without paused_since resume unchanged. Each unit owns its own clock.
 */
export function transitionPauseBudget(unit: PauseBudget, waiting: boolean, terminal: boolean, now = Date.now()): void {
  if (terminal) { delete unit.paused_since; return; }
  if (waiting) { unit.paused_since ??= localIso(new Date(now)); return; }
  if (unit.paused_since === undefined) return;
  const elapsed = Math.max(0, now - Date.parse(unit.paused_since));
  const previous = unit.paused_ms ?? 0;
  const extension = Math.min(elapsed, Math.max(0, MAX_PAUSE_EXTENSION_MS - previous));
  unit.paused_ms = previous + elapsed;
  unit.deadline_at = localIso(new Date(Date.parse(unit.deadline_at) + extension));
  delete unit.paused_since;
}
