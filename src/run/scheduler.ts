import type { Provider } from '../contracts/brief.js';
import type { Run, TaskState } from '../contracts/run.js';
import type { GraphTask } from '../contracts/taskGraph.js';
import type { ParallelConfig } from '../core/runConfig.js';
import type { JobStore } from '../core/jobStore.js';
import { activeInspectProvider } from '../core/workerReservations.js';

export interface SchedulingTask extends Pick<GraphTask, 'id' | 'depends_on' | 'file_scope'> {
  state: TaskState; provider: Provider; lane: string | null;
  resume_ready?: boolean; integration_fix?: boolean;
}
export type Slots = Run['slots'];
export type SchedulingLane = Pick<Run['lanes'][number], 'lane' | 'state' | 'tasks_done'>;
export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const prefix = (glob: string) => { const parts = glob.split('/'); const i = parts.findIndex(p => /[*?\[{]/.test(p)); return i < 0 ? parts : parts.slice(0, i); };
  return left.some(a => right.some(b => {
    const x = prefix(a), y = prefix(b);
    return x.slice(0, Math.min(x.length, y.length)).every((part, i) => part === y[i]);
  }));
}
export function readyQueue(tasks: readonly SchedulingTask[]): SchedulingTask[] {
  const byId = new Map(tasks.map(t => [t.id, t])), lengths = new Map<string, number>(), visiting = new Set<string>();
  const length = (id: string): number => {
    if (lengths.has(id)) return lengths.get(id)!;
    if (visiting.has(id)) throw new Error('Dependency cycle');
    visiting.add(id);
    const value = 1 + Math.max(0, ...tasks.filter(t => t.depends_on.includes(id)).map(t => length(t.id)));
    visiting.delete(id); lengths.set(id, value); return value;
  };
  tasks.forEach(t => length(t.id));
  const priority = (t: SchedulingTask) => t.resume_ready || t.integration_fix ? 0 : 1;
  return tasks.filter(t => (t.state === 'ready' || t.state === 'pending' || t.state === 'paused' && t.resume_ready) && t.depends_on.every(id => byId.get(id)?.state === 'integrated'))
    .map(t => ({ t, index: tasks.indexOf(t) }))
    .sort((a, b) => priority(a.t) - priority(b.t) || length(b.t.id) - length(a.t.id) || a.index - b.index).map(({ t }) => t);
}
export function chooseLane(task: SchedulingTask, tasks: readonly SchedulingTask[], lanes: readonly SchedulingLane[]): SchedulingLane | undefined {
  const affinity = new Set(task.depends_on.map(id => tasks.find(t => t.id === id)?.lane));
  return lanes.filter(l => l.state === 'idle').sort((a, b) => Number(affinity.has(b.lane)) - Number(affinity.has(a.lane)) || a.tasks_done - b.tasks_done || Number(a.lane.slice(5)) - Number(b.lane.slice(5)))[0];
}
export function canAcquireSlot(slots: Slots, config: ParallelConfig, provider: Provider, now: number): boolean {
  const cooldown = slots.cooldown_until[provider];
  return (!cooldown || Number.isFinite(Date.parse(cooldown)) && Date.parse(cooldown) <= now)
    && slots.in_use < Math.min(slots.max_workers, config.max_workers)
    && (slots.by_provider[provider] ?? 0) < (config.provider_limits[provider] ?? config.max_workers);
}
/** Runtime callers pass store while holding the global lock; projections remain pure. */
export function acquireSlot(slots: Slots, config: ParallelConfig, provider: Provider, now: number, store?: JobStore): Slots | null {
  const inspectProvider = store ? activeInspectProvider(store) : null;
  if (inspectProvider !== null && !canAcquireSlot({ ...slots, in_use: slots.in_use + 1,
    by_provider: { ...slots.by_provider, [inspectProvider]: (slots.by_provider[inspectProvider] ?? 0) + 1 } }, config, provider, now)) return null;
  if (!canAcquireSlot(slots, config, provider, now)) return null;
  return { ...slots, in_use: slots.in_use + 1, by_provider: { ...slots.by_provider, [provider]: (slots.by_provider[provider] ?? 0) + 1 }, cooldown_until: { ...slots.cooldown_until } };
}
export function releaseSlot(slots: Slots, provider: Provider): Slots {
  if (slots.in_use < 1 || !(slots.by_provider[provider]! > 0)) throw new Error('Slot underflow');
  return { ...slots, in_use: slots.in_use - 1, by_provider: { ...slots.by_provider, [provider]: slots.by_provider[provider]! - 1 }, cooldown_until: { ...slots.cooldown_until } };
}
export function isRateLimited(failed: boolean, reason: string | null, log: string): boolean {
  return failed && /\b(429|rate.?limit|quota|usage limit|too many requests)\b/i.test(`${reason ?? ''}\n${log.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').slice(-80).join('\n')}`);
}
/** B3 evidence failures and B7 launch failures cannot be retried even with stale rate-limit log text. */
export function isRetryableRateLimit(result: { state: string; failure_reason?: string | null; failure_reasons?: string[]; auto_retries_exhausted?: boolean }, _log: string): boolean {
  if (result.failure_reason === 'workspace_snapshot_invalid' || result.failure_reasons?.includes('workspace_snapshot_invalid')) return false;
  if (result.auto_retries_exhausted || result.failure_reason === 'launch_failed' || result.failure_reason === 'prompt_too_large') return false;
  // Finalization is the only classifier with exit/result/provider provenance.
  return result.state === 'failed' && result.failure_reason === 'rate_limit';
}
export function coolDown(slots: Slots, provider: Provider, now: number, seconds: number): Slots {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) throw new Error('Invalid cooldown seconds');
  const until = Math.max(now + seconds * 1000, Date.parse(slots.cooldown_until[provider] ?? '') || 0);
  // Contract timestamps require a numeric UTC offset, not Z.
  return { ...slots, by_provider: { ...slots.by_provider }, cooldown_until: { ...slots.cooldown_until, [provider]: new Date(until).toISOString().replace('Z', '+00:00') } };
}
/** A batch is a projection, not a runtime slot lease; each step must still acquire via its hook. */
export function schedule(tasks: readonly SchedulingTask[], lanes: readonly SchedulingLane[], slots: Slots, config: ParallelConfig, now: number, overlapPolicy: 'serialize' | 'allow' = 'serialize') {
  const assignments: { task_id: string; lane: string }[] = [], warnings: { task_id: string; warning: string }[] = [];
  const available = lanes.map(l => ({ ...l })), active = tasks.filter(t => t.state === 'running' || t.state === 'merging');
  let reserved = slots;
  for (const task of readyQueue(tasks)) {
    const blockers = overlapPolicy === 'allow' ? [] : active.filter(t => t.id !== task.id && scopesOverlap(t.file_scope, task.file_scope));
    if (blockers.length) { warnings.push(...blockers.map(t => ({ task_id: task.id, warning: `waiting_overlap:${t.id}` }))); continue; }
    const lane = chooseLane(task, tasks, available), next = acquireSlot(reserved, config, task.provider, now);
    if (!lane || !next) continue;
    available.find(l => l.lane === lane.lane)!.state = 'busy'; reserved = next; active.push(task);
    assignments.push({ task_id: task.id, lane: lane.lane });
  }
  return { assignments, warnings, slots: reserved };
}
