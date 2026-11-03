import { GbdevError } from '../../contracts/error.js';
import { formatLine, prepareLine, str, type RenderLine } from '../format.js';
import { Lifecycle, launchRetryRows, realClock, stamp, terminal, terminalJob, textRow, ViewFiles, type ViewOptions } from './common.js';
import { runStatus, runSummary } from './runStatus.js';
import { JobFollower, LaneFollower, pipelineTarget } from './laneFollower.js';
import { IntegrationFollower } from './integration.js';
import { pipelineStatus } from './pipeline.js';
import { indexView } from './index.js';
export type PaneKind = 'index' | 'run-status' | 'run-lane' | 'run-integration' | 'pipeline-status' | 'pipeline-step' | 'job';
export interface Target { kind: PaneKind | 'run-all' | 'pipeline-all'; id: string; lane?: string }
export interface ViewFrame { rows: string[]; lines: { pane: string; line: RenderLine }[]; found: boolean; done: boolean; summary: string; removed?: boolean; active?: boolean }
/** Same poll path for public watch and hidden panes. Only the outer lifecycle differs. */
export class WatchView {
  readonly files: ViewFiles;
  private readonly followers = new Map<string, LaneFollower>();
  private readonly jobs: JobFollower;
  private integration: IntegrationFollower | undefined;
  constructor(home: string, readonly target: Target, readonly options: ViewOptions = {}) {
    this.files = new ViewFiles(home); this.jobs = new JobFollower(this.files, options);
    if (target.kind.startsWith('run-')) this.integration = new IntegrationFollower(this.files, target.id, options);
  }
  close(): void { this.jobs.close(); this.integration?.close(); for (const f of this.followers.values()) f.close(); }
  poll(now: number): ViewFrame {
    this.files.unstable = false;
    const { kind, id } = this.target;
    const frame: ViewFrame = { rows: [], lines: [], found: false, done: false, summary: '' };
    const add = (pane: string, lines: RenderLine[]) => { frame.lines.push(...lines.map(line => ({ pane, line }))); };
    if (kind === 'index') {
      const snapshot = indexView(this.files, now, this.options); frame.rows = snapshot.rows; frame.active = snapshot.active; frame.found = true;
    } else if (kind.startsWith('run-')) {
      const run = this.files.run(id);
      if (run) {
        frame.found = true; frame.done = terminal(run.state); frame.summary = frame.done ? runSummary(this.files, run) : '';
        if (kind === 'run-status') this.integration!.pollEvents(now);
        if (kind === 'run-status' || kind === 'run-all') frame.rows = runStatus(this.files, run, now, this.options);
        if (kind === 'run-lane' || kind === 'run-all') {
          const lanes = kind === 'run-lane' ? [this.target.lane!] : run.lanes.map(l => l.lane);
          for (const lane of lanes) {
            const follower = this.followers.get(lane) ?? new LaneFollower(this.files, lane, this.options); this.followers.set(lane, follower);
            add(lane, follower.poll(run, now));
          }
        }
        if (kind === 'run-integration' || kind === 'run-all') add('integration', this.integration!.poll(run, now));
        if (frame.rows.length && this.integration!.recovery) frame.rows.push(textRow(`RECOVERY ${this.integration!.recovery}`, this.options.columns));
      }
    } else if (kind.startsWith('pipeline-')) {
      const p = this.files.pipeline(id);
      if (p) {
        frame.found = true; frame.done = terminal(p.state);
        frame.summary = `summary ${id} ${p.state} outcome=${p.outcome ?? '-'} steps=${p.steps.filter(s => s.state === 'succeeded').length}/${p.steps.length} \nbranch=${p.workspace.branch}\nsha=${p.head_sha}`;
        if (kind !== 'pipeline-step') frame.rows = pipelineStatus(p, now, this.options, this.files);
        if (kind !== 'pipeline-status') add('step', this.jobs.poll(pipelineTarget(p), `waiting for ${id} step`, now));
      }
    } else {
      const job = this.files.json(`jobs/${id}/job.json`);
      if (job) {
        frame.found = true; frame.done = terminalJob(job.state); frame.summary = `summary ${id} ${str(job.state)}`;
        frame.rows = launchRetryRows(this.files, id, now).map(row => textRow(row, this.options.columns));
        add('job', this.jobs.poll({ jobId: id, label: `${str(job.role)} · ${str(job.provider)}` }, '', now));
      }
    }
    if (!frame.found) {
      const path = kind.startsWith('run-') ? `runs/${id}/run.json` : kind.startsWith('pipeline-') ? `pipelines/${id}/pipeline.json` : `jobs/${id}/job.json`;
      frame.removed = this.files.exists(path) === false;
    }
    add('status', this.files.warnings(now));
    if (this.files.unstable) { frame.done = false; frame.active = true; }
    if (this.jobs.draining || this.integration?.draining || [...this.followers.values()].some(f => f.draining)) frame.done = false;
    frame.lines.sort((a, b) => Date.parse(a.line.at) - Date.parse(b.line.at));
    return frame;
  }
}
export async function watchView(view: WatchView, write: (text: string) => void | Promise<void>): Promise<0 | 1> {
  const options = view.options, clock = options.clock ?? realClock, life = new Lifecycle(options);
  let lastStatus = -Infinity, waiting = false, seen = false, missingPolls = 0;
  const emit = async (line: RenderLine, pane = '') => {
    const prefix = view.target.kind === 'run-all' && pane ? `[${pane}] ` : '';
    for (const part of prepareLine({ ...line, text: prefix + line.text }, options.columns)) await write(formatLine(part, options.color));
  };
  try {
    while (!options.signal?.aborted) {
      const now = clock.now();
      if (life.state === 'LINGER') { life.observe(true, true, now); if (life.state as string === 'EXIT') break; }
      else {
        const frame = view.poll(now);
        if (!frame.found && !options.pane && !seen) throw new GbdevError(view.target.kind.startsWith('run-') ? 'run_not_found' : view.target.kind.startsWith('pipeline-') ? 'pipeline_not_found' : 'job_not_found', frame.lines.find(l => l.line.tag === 'WARN')?.line.text ?? `Unit not found: ${view.target.id}`);
        // A single missing snapshot (including a rename gap) cannot end a pane.
        missingPolls = !frame.found && frame.removed ? missingPolls + 1 : 0;
        if (!frame.found && !waiting && !view.files.unstable && (!seen || missingPolls >= 3)) { await emit(stamp(now, 'WAIT', seen ? 'unit directory removed or metadata unavailable' : `waiting for ${view.target.id}`)); waiting = true; }
        if (frame.found) { waiting = false; seen = true; }
        // A removed unit cannot be controlled by a renderer: show summary and leave/linger.
        const removed = !frame.found && seen && missingPolls >= 3;
        life.observe(frame.found || removed, frame.done || removed, now);
        if (frame.rows.length && (now - lastStatus >= 2000 || options.once || frame.done)) {
          // Combined views append status snapshots: clearing would erase follow history.
          if (options.tty && ['index', 'run-status', 'pipeline-status'].includes(view.target.kind)) await write('\x1b[H\x1b[2J');
          await write(frame.rows.join('\n') + '\n'); lastStatus = now;
        }
        for (const { pane, line } of frame.lines) await emit(line, pane);
        if (life.state === 'SUMMARY') {
          for (const text of (frame.summary || 'summary unit unavailable').split('\n')) await emit(stamp(now, 'DONE', text));
          if (options.pane && !options.once) await write(textRow(`窗口将在 ${new Date(life.closeAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 关闭`, options.columns) + '\n');
          life.summarized(now);
        }
        if (options.once || life.state === 'EXIT' || view.target.kind === 'index' && life.idle(frame.active ?? false, now)) break;
      }
      await clock.sleep(Math.min(options.pollMs ?? 500, life.closeAt === undefined ? Infinity : Math.max(1, life.closeAt - clock.now())), options.signal);
    }
    return 0;
  } catch (error) {
    if (!options.pane) throw error;
    await emit(stamp(clock.now(), 'ERR', `renderer crashed: ${error instanceof Error ? error.message : 'unknown error'}`));
    const end = clock.now() + 60000;
    while (!options.signal?.aborted && clock.now() < end) await clock.sleep(Math.min(500, end - clock.now()), options.signal);
    return options.signal?.aborted ? 0 : 1;
  } finally { view.close(); }
}
