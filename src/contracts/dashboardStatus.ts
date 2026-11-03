import { array, boolean, nullableString, object, oneOf, string } from './validation.js';
export function validateDashboardStatus(value: unknown): void {
  const v = object(value, 'dashboard status'); boolean(v.enabled, 'enabled');
  for (const k of ['reason', 'tmux_path', 'tmux_version', 'session', 'attach_hint']) nullableString(v[k], k);
  oneOf(v.session_state, ['absent', 'owned', 'foreign'], 'session_state');
  for (const item of array(v.windows, 'windows')) {
    const w = object(item, 'window'); for (const k of ['key', 'window_id', 'unit_id', 'unit_state']) string(w[k], k);
    for (const item of array(w.panes, 'panes')) { const p = object(item, 'pane'); string(p.key, 'key'); string(p.pane_id, 'pane_id'); boolean(p.dead, 'dead'); }
  }
  if (v.missing_panes !== undefined) for (const item of array(v.missing_panes, 'missing_panes')) {
    const p = object(item, 'missing pane'); string(p.key, 'key'); string(p.reason, 'reason');
  }
  if (v.text !== undefined && typeof v.text !== 'string') throw new TypeError('Invalid capture text');
}
