import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import type { ListKind, ListEntry, ListResult } from '../contracts/inventory.js';
import { isTerminal, JOB_STATES, type JobStatus } from '../contracts/jobStatus.js';
import { RUN_STATES as PIPELINE_STATES, terminalRun as terminalPipeline } from '../contracts/pipelineRun.js';
import { RUN_STATES } from '../contracts/run.js';
import { JOB_ID_PATTERN, RUN_ID_PATTERN } from '../core/ids.js';
import type { JobStore } from '../core/jobStore.js';
import { isProcessAlive } from '../core/lock.js';
import { jobPaths } from '../core/paths.js';
import { readSupersededBy } from '../core/superseded.js';
import { compareInstantDesc } from '../core/time.js';
import { readRun as readPipeline } from '../pipeline/store.js';
import { safeText } from '../render/format.js';
import { readRun, terminalRun } from '../run/store.js';

const cell = (value: string) => safeText(value).replace(/[\r\n\t\u2028\u2029]+/g, ' ');
const reason = (value: string | null | undefined) => value == null ? null : cell(value).slice(0, 160);
const gone = (pid: number | null | undefined) => pid != null && !isProcessAlive(pid);

function jobStale(store: JobStore, job: JobStatus): boolean {
  if (isTerminal(job.state)) return false;
  if (gone(job.pid)) return true;
  try {
    const info = JSON.parse(readFileSync(jobPaths(store.paths, job.job_id).processInfo, 'utf8')) as { supervisor_pid?: number; worker_pid?: number; worker_pgid?: number };
    return [info.supervisor_pid, info.worker_pid, info.worker_pgid].some(gone);
  } catch { return false; }
}

/** No locks, reconcile, config loading, directory creation, events or side effects. */
export function list(store: JobStore, kind: ListKind, options: Record<string, unknown> = {}): { schema: string; result: ListResult } {
  const allowed = ['active', 'state', 'limit', ...(kind === 'job' ? ['all'] : []), ...(kind === 'pipeline' ? ['standalone'] : [])];
  const usage = (): never => { throw new GbdevError('usage_error', `Use ${kind === 'job' ? 'list' : `${kind} list`} [--active] [--state <s>] [--limit <1..500>]${kind === 'job' ? ' [--all]' : kind === 'pipeline' ? ' [--standalone]' : ''} [--json]`); };
  if (Object.entries(options).some(([k, v]) => v !== undefined && !allowed.includes(k))) usage();
  for (const key of ['active', 'all', 'standalone']) if (options[key] !== undefined && typeof options[key] !== 'boolean') usage();
  const limit = options.limit === undefined ? 20 : Number(options.limit);
  if ((options.limit !== undefined && (typeof options.limit !== 'string' || !/^\d+$/.test(options.limit))) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) usage();
  const raw = options.state === undefined ? [] : Array.isArray(options.state) ? options.state : [options.state];
  if (raw.some(s => typeof s !== 'string')) usage();
  const states = (raw as string[]).flatMap(s => s.split(','));
  const legal: readonly string[] = kind === 'job' ? JOB_STATES : kind === 'run' ? RUN_STATES : PIPELINE_STATES;
  if (states.some(s => !legal.includes(s))) usage();
  const terminal = (state: string) => kind === 'job' ? isTerminal(state as JobStatus['state']) : ['succeeded', 'failed', 'cancelled'].includes(state);
  const dir = kind === 'job' ? store.paths.jobs : join(store.paths.home, kind === 'run' ? 'runs' : 'pipelines');
  const pattern = kind === 'job' ? JOB_ID_PATTERN : kind === 'run' ? RUN_ID_PATTERN : /^p_\d{8}_\d{4}_[a-f0-9]{4}$/;
  let names: string[] = [], skipped = 0;
  const warnings: string[] = [];
  try { names = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && pattern.test(e.name)).map(e => e.name); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('inventory directory unreadable'); }
  const entries: ListEntry[] = [];
  for (const id of names) {
    try {
      if (kind === 'job') {
        const j = store.read(id);
        entries.push({ id, state: j.state, state_reason: reason(j.failure_reason), created_at: j.created_at, updated_at: j.updated_at, deadline_at: j.deadline_at,
          role: j.role, provider: j.provider, pipeline_id: j.pipeline_id ?? null, run_id: j.run_id ?? null, task_id: j.task_id ?? null,
          attention_count: ['needs_input', 'blocked'].includes(j.state) ? 1 : 0, decision_count: 0,
          stale: jobStale(store, j), superseded_by: readSupersededBy(store, j) });
      } else if (kind === 'run') {
        const r = readRun(store, id);
        entries.push({ id, state: r.state, state_reason: reason(r.state_reason), created_at: r.created_at, updated_at: r.updated_at, deadline_at: r.deadline_at,
          lanes: r.lanes.length, tasks: r.tasks.length, attention_count: r.attention.length, decision_count: new Set(r.attention.map(a => a.decision_id)).size,
          stale: !terminalRun(r.state) && gone(r.supervisor_pid) });
      } else {
        const p = readPipeline(store, id);
        entries.push({ id, state: p.state, state_reason: reason(p.state_reason), created_at: p.created_at, updated_at: p.updated_at, deadline_at: p.deadline_at ?? null,
          run_id: p.workspace.mode === 'per_lane' ? p.workspace.run_id : null, task_id: p.workspace.mode === 'per_lane' ? p.workspace.task_id : null,
          template: p.pipeline, current_step: p.current?.instance ?? null, attention_count: p.pending_questions.length, decision_count: p.decision ? 1 : 0,
          stale: !terminalPipeline(p.state) && gone(p.supervisor_pid) });
      }
    } catch { skipped++; }
  }
  const filtered = entries.filter(e => (!options.active || !terminal(e.state)) && (!states.length || states.includes(e.state)) && (!options.standalone || !e.run_id));
  const hidden = options.all ? 0 : filtered.filter(e => e.superseded_by).length;
  const visible = filtered.filter(e => options.all || !e.superseded_by).sort((a, b) => compareInstantDesc(a.created_at, b.created_at) || b.id.localeCompare(a.id));
  const items = visible.slice(0, limit);
  if (skipped) warnings.push(`${skipped} unreadable or invalid records skipped`);
  return { schema: kind === 'pipeline' ? 'gbdev.pipeline-runs.v1' : `gbdev.${kind}-list.v1`,
    result: { items, total: entries.length, matched: visible.length, shown: items.length, skipped, hidden_superseded: hidden, limit, warnings } };
}

export function hiddenSupersededText(count: number): string {
  return count ? `${count} 个已被接管的 job 已隐藏，--all 显示\n` : '';
}

export function listText(result: ListResult, kind: ListKind): string {
  const rows = result.items.map(e => [e.id, e.state, e.created_at, `A:${e.attention_count}/D:${e.decision_count}`,
    [kind === 'run' ? `lanes=${e.lanes} tasks=${e.tasks}` : kind === 'pipeline' ? `${e.template} ${e.current_step ?? '-'} run=${e.run_id ?? '-'} task=${e.task_id ?? '-'}` : `${e.role}/${e.provider} pipeline=${e.pipeline_id ?? '-'} run=${e.run_id ?? '-'} task=${e.task_id ?? '-'}`,
      e.state_reason, e.stale ? `pid gone, ${kind === 'job' ? '' : `${kind} `}status ${e.id} to reconcile` : null,
      e.superseded_by ? `superseded by ${e.superseded_by}` : null].filter(Boolean).join(' | ')].map(cell));
  const widths = [0, 1, 2, 3].map(i => Math.max(0, ...rows.map(r => r[i]!.length)));
  return rows.map(row => row.map((s, i) => i < 4 ? s.padEnd(widths[i]!) : s).join('  ')).join('\n') + (rows.length ? '\n' : '') +
    `shown=${result.shown} total=${result.total} matched=${result.matched} skipped=${result.skipped}\n` +
    hiddenSupersededText(result.hidden_superseded) + result.warnings.map(w => `warning: ${cell(w)}\n`).join('') +
    `Tip: --active lists non-terminal records${kind === 'job' ? '; --all includes superseded jobs (still subject to --limit)' : ''}; --limit 1..500 (default 20).\n`;
}

/** Legacy status still reconciles every job; only its text presentation is filtered. */
export function statusListText(store: JobStore, jobs: JobStatus[], all = false): string {
  let hidden = 0;
  const lines = jobs.flatMap(j => {
    const by = readSupersededBy(store, j);
    if (by && !all) { hidden++; return []; }
    return [cell(`${j.job_id} ${j.state}${j.failure_reason ? `: ${j.failure_reason}` : ''}${by ? ` (superseded by ${by})` : ''}`)];
  });
  return lines.map(l => l + '\n').join('') + hiddenSupersededText(hidden) + 'Read-only inventory: gbdev list [--active] [--all]\n';
}
