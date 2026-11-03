import { loadDashboard } from '../core/dashboardConfig.js';
import { resolvePaths } from '../core/paths.js';
import { identity } from '../dashboard/names.js';
import { GbdevError } from '../contracts/error.js';
import { serializeEnvelope, successEnvelope } from '../contracts/envelope.js';
import { JOB_ID_PATTERN, RUN_ID_PATTERN } from '../core/ids.js';
import { safeText } from '../render/format.js';
import { PIPELINE_ID, type ViewOptions } from '../render/views/common.js';
import { WatchView, watchView, type PaneKind, type Target } from '../render/views/watch.js';
export interface WatchOptions { json?: boolean; once?: boolean; pane?: string; verbose?: boolean; 'no-color'?: boolean }
const usage = (message: string): never => { throw new GbdevError('usage_error', message); };
export function watchTarget(type: 'run' | 'pipeline', id: string | undefined, options: WatchOptions): Target {
  if (!id || !(type === 'run' ? RUN_ID_PATTERN : PIPELINE_ID).test(id)) usage(`${type} watch requires a valid ${type}_id`);
  if (options.json && !options.once) usage('--json requires --once; following and JSON are mutually exclusive');
  if (type === 'pipeline') { if (options.pane !== undefined) usage('--pane is only supported by run watch'); return { kind: 'pipeline-all', id: id! }; }
  const pane = options.pane ?? 'all';
  if (!/^(?:all|status|integration|lane-[1-4])$/.test(pane)) usage('--pane must be status, lane-1..lane-4, integration or all');
  return pane.startsWith('lane-') ? { kind: 'run-lane', id: id!, lane: pane } : { kind: `run-${pane}` as Target['kind'], id: id! };
}
export function paneTarget(args: string[]): Target {
  const [kind, id, lane] = args;
  if (kind === 'index' && (args.length === 1 || args.length === 2 && id === 'index')) return { kind, id: 'index' };
  const kinds: PaneKind[] = ['run-status', 'run-lane', 'run-integration', 'pipeline-status', 'pipeline-step', 'job'];
  if (!kinds.includes(kind as PaneKind) || !id || args.length !== (kind === 'run-lane' ? 3 : 2)) usage('Invalid pane arguments');
  if (!(kind!.startsWith('run-') ? RUN_ID_PATTERN : kind!.startsWith('pipeline-') ? PIPELINE_ID : JOB_ID_PATTERN).test(id!)) usage('Invalid pane unit id');
  if (kind === 'run-lane' && (!lane || !/^lane-[1-4]$/.test(lane))) usage('Invalid pane lane');
  return { kind: kind as PaneKind, id: id!, ...(lane ? { lane } : {}) };
}
function runtime(options: WatchOptions): ViewOptions {
  return { once: options.once ?? false, verbose: options.verbose ?? false, columns: process.stdout.columns ?? 120, tty: Boolean(process.stdout.isTTY), color: !options['no-color'] && !process.env.NO_COLOR && Boolean(process.stdout.isTTY) };
}
/** JSON snapshots preserve v1 status schemas and never call status/reconcile (which can write). */
export async function watch(home: string, type: 'run' | 'pipeline', id: string | undefined, options: WatchOptions, write: (text: string) => void | Promise<void>): Promise<0 | 1> {
  const target = watchTarget(type, id, options), view = new WatchView(home, target, runtime(options));
  if (options.json) {
    const unit = type === 'run' ? view.files.run(target.id) : view.files.pipeline(target.id);
    if (!unit) throw new GbdevError(type === 'run' ? 'run_not_found' : 'pipeline_not_found', view.files.warnings(Date.now())[0]?.text ?? `Unit not found: ${target.id}`);
    let result: unknown = unit;
    if (type === 'pipeline') {
      // Project known status keys; never forward arbitrary additions such as env/prompt.
      const keys = ['schema', 'pipeline_id', 'pipeline', 'state', 'state_reason', 'outcome', 'failure_reason', 'repo', 'workspace', 'base_sha', 'diff_base_sha', 'head_sha', 'round', 'max_rounds', 'jobs_used', 'max_total_jobs', 'current', 'steps', 'decision', 'pending_questions', 'supervisor_pid', 'decisions', 'heartbeat_at', 'created_at', 'updated_at', 'deadline_at', 'paused_since', 'paused_ms', 'state_history', 'warnings', 'integration', 'dry_run', 'cleanup'];
      const frame = view.poll(Date.now());
      result = { ...Object.fromEntries(keys.filter(k => Object.hasOwn(unit, k)).map(k => [k, (unit as unknown as Record<string, unknown>)[k]])), current_job_lines: frame.lines.map(l => l.line) };
    }
    const safe = JSON.parse(JSON.stringify(result, (_key, value: unknown) => typeof value === 'string' ? safeText(value) : value));
    await write(serializeEnvelope(successEnvelope(`${type} watch`, type === 'run' ? 'gbdev.run.v1' : 'gbdev.pipeline-run.v1', safe))); return 0;
  }
  return withSignals(signal => watchView(new WatchView(home, target, { ...runtime(options), signal }), write));
}
export async function pane(home: string, args: string[], write: (text: string) => void | Promise<void>): Promise<0 | 1> {
  const target = paneTarget(args);
  const config = loadDashboard(resolvePaths().config);
  const session = identity(home, config.session).session;
  return withSignals(signal => watchView(new WatchView(home, target, { ...runtime({}), pane: true, signal, session,
    verbose: config.show_command_output, color: config.color && !process.env.NO_COLOR && Boolean(process.stdout.isTTY),
    backfillLines: config.backfill_lines, pollMs: config.poll_ms, retainFinishedMin: config.retain_finished_min, idleExitMin: config.idle_exit_min,
  }), write));
}
async function withSignals(work: (signal: AbortSignal) => Promise<0 | 1>): Promise<0 | 1> {
  const abort = new AbortController(), stop = () => abort.abort();
  process.on('SIGHUP', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try { return await work(abort.signal); }
  finally { process.off('SIGHUP', stop); process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}
