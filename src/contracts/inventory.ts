import { array, boolean, integer, nullableString, object, string, strings } from './validation.js';

export type ListKind = 'job' | 'run' | 'pipeline';
export interface ListEntry {
  id: string; state: string; state_reason: string | null; created_at: string; updated_at: string; deadline_at: string | null;
  attention_count: number; decision_count: number; stale: boolean;
  lanes?: number; tasks?: number;
  run_id?: string | null; task_id?: string | null; template?: string; current_step?: string | null;
  role?: string; provider?: string; pipeline_id?: string | null; superseded_by?: string | null;
}
export interface ListResult {
  items: ListEntry[]; total: number; matched: number; shown: number; skipped: number; hidden_superseded: number; limit: number; warnings: string[];
}

/** CLI projection only, never a persisted status schema. */
export function validateInventory(value: unknown): ListResult {
  const v = object(value, 'inventory');
  for (const key of ['total', 'matched', 'shown', 'skipped', 'hidden_superseded']) integer(v[key], key, 0);
  integer(v.limit, 'limit', 1, 500);
  strings(v.warnings, 'warnings');
  for (const raw of array(v.items, 'items')) {
    const item = object(raw, 'inventory item');
    for (const key of ['id', 'state', 'created_at', 'updated_at']) string(item[key], key);
    for (const key of ['state_reason', 'deadline_at']) nullableString(item[key], key);
    for (const key of ['attention_count', 'decision_count']) integer(item[key], key, 0);
    boolean(item.stale, 'stale');
    if (item.superseded_by !== undefined) nullableString(item.superseded_by, 'superseded_by');
  }
  return value as ListResult;
}
