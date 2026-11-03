import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { JOB_ID_PATTERN, RUN_ID_PATTERN } from '../core/ids.js';
import { PIPELINE_ID } from '../render/views/common.js';
import { SESSION_NAME } from '../core/dashboardConfig.js';
import { DashboardFailure, dynamic } from './safeArgs.js';
export type UnitKind = 'run' | 'pipeline' | 'job';
export function unitKind(id: string): UnitKind {
  if (RUN_ID_PATTERN.test(id)) return 'run';
  if (PIPELINE_ID.test(id)) return 'pipeline';
  if (JOB_ID_PATTERN.test(id)) return 'job';
  throw new DashboardFailure('unsafe_argv');
}
export function identity(home: string, session: string | null = null) {
  let root: string; try { root = realpathSync(home); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; root = resolve(home); }
  dynamic(root);
  const hash = createHash('sha256').update(root).digest('hex'), h6 = hash.slice(0, 6), h12 = hash.slice(0, 12);
  const name = session ?? (root === join(homedir(), '.gbdev') ? 'gbdev' : `gbdev-${h6}`);
  if (!SESSION_NAME.test(name)) throw new DashboardFailure('unsafe_argv');
  return { root, session: name, h6, h12 };
}
export function key(id: string, pane?: string): string { return `${unitKind(id)}:${id}${pane ? ':' + dynamic(pane) : ''}`; }
export function parseKey(value: string): { unit_id: string; pane: string } | undefined {
  const [kind, id, pane, extra] = value.split(':');
  if (!id || !pane || extra || !/^(status|lane-[1-4]|integration|step|job)$/.test(pane)) return;
  try {
    if (unitKind(id) !== kind || kind === 'job' && pane !== 'job' || kind === 'pipeline' && !['status', 'step'].includes(pane) || kind === 'run' && ['step', 'job'].includes(pane)) return;
    return { unit_id: id, pane };
  } catch { return; }
}
