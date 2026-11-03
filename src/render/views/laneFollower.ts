import type { Run } from '../../contracts/run.js';
import type { PipelineRun } from '../../contracts/pipelineRun.js';
import { JOB_ID_PATTERN } from '../../core/ids.js';
import { JobRenderer, Tail } from '../job.js';
import { GbdevError } from '../../contracts/error.js';
import { str, type RenderLine } from '../format.js';
import { ViewFiles, stamp, type ViewOptions } from './common.js';
export interface JobTarget { jobId: string; label: string }
/** One retained job renderer per pane. Switching drains the old job before bounded new backfill. */
export class JobFollower {
  private current: JobRenderer | undefined;
  private pending: Generator<RenderLine> | undefined;
  get draining(): boolean { return this.pending !== undefined || !!this.current?.awaitingMetadata; }
  get complete(): boolean { return !!this.current?.complete && !this.pending; }
  close(): void { this.pending?.return(undefined); this.pending = undefined; }
  private key = '';
  private message = '';
  constructor(readonly files: ViewFiles, readonly options: ViewOptions = {}) {}
  poll(target: JobTarget | undefined, idle: string, now: number): RenderLine[] {
    const out: RenderLine[] = []; let separator: string | undefined;
    const collect = (renderer: JobRenderer, backfill = false): RenderLine[] => {
      const capacity = this.options.backfillLines ?? 400;
      if (backfill) {
        const tail = new Tail<RenderLine>(capacity), skips: RenderLine[] = []; let count = 0;
        for (const line of renderer.pollLines()) { if (line.tag === 'SKIP') skips.push(line); else { tail.push(line); count++; } }
        if (count > capacity) skips.push(stamp(now, 'SKIP', `${count - capacity} earlier rendered lines not shown`));
        return [...skips, ...tail.all()];
      }
      // Live bursts are resumed across polls, not silently dropped or accumulated in RAM.
      this.pending ??= renderer.pollLines(); const batch: RenderLine[] = [];
      while (batch.length < capacity) {
        const next = this.pending.next();
        if (next.done) { this.pending = undefined; break; }
        batch.push(next.value);
      }
      return batch;
    };
    const key = target ? `${target.jobId}:${target.label}` : '';
    if (key !== this.key) {
      if (this.current) { out.push(...collect(this.current)); if (this.draining) return out; }
      this.current = undefined; this.key = key; this.message = '';
    }
    if (target && JOB_ID_PATTERN.test(target.jobId)) {
      if (!this.current && this.files.json(`jobs/${target.jobId}/job.json`)) {
        try {
          this.current = new JobRenderer(this.files.fs.home, target.jobId, { verbose: this.options.verbose ?? false, columns: this.options.columns ?? 120 });
          separator = `──── ${target.label} · ${target.jobId} ────`; this.message = '';
        } catch (error) {
          // Metadata may disappear between the availability probe and construction.
          if (!(error instanceof GbdevError && error.contract.code === 'job_not_found' && !error.message.includes('WARN'))) this.files.warn(`jobs/${target.jobId}`, error);
        }
      }
      if (this.current) {
        const batch = collect(this.current, separator !== undefined);
        if (separator) {
          const first = batch.reduce((at, line) => Math.min(at, Date.parse(line.at)), now);
          out.push(stamp(first, 'STEP', separator));
        }
        out.push(...batch);
      }
      else idle = `waiting for ${target.jobId}`;
    } else if (target) idle = 'invalid job reference';
    if (!this.current && !this.files.unstable && this.message !== idle) { out.push(stamp(now, 'WAIT', idle)); this.message = idle; }
    return out;
  }
}
export function pipelineTarget(pipeline: PipelineRun | undefined, task = ''): JobTarget | undefined {
  if (!pipeline) return;
  // Terminal pipelines commonly clear current; retain the last attempted job for a late viewer.
  const step = pipeline.steps.find(s => s.instance === pipeline.current?.instance) ?? [...pipeline.steps].reverse().find(s => s.attempts.length);
  const jobId = pipeline.current?.job_id ?? step?.attempts.at(-1)?.job_id;
  if (!jobId) return;
  return { jobId, label: [task, pipeline.current?.instance ?? step?.instance, step?.provider, pipeline.pipeline_id].filter(Boolean).join(' · ') };
}
export class LaneFollower {
  private readonly jobs: JobFollower;
  constructor(readonly files: ViewFiles, readonly lane: string, readonly options: ViewOptions = {}) { this.jobs = new JobFollower(files, options); }
  get draining(): boolean { return this.jobs.draining; }
  close(): void { this.jobs.close(); }
  poll(run: Run, now: number): RenderLine[] {
    const lane = run.lanes.find(l => l.lane === this.lane);
    const pipeline = lane?.pipeline_id ? this.files.pipeline(lane.pipeline_id) : undefined;
    // Absence is not a lane reassignment. Keep offsets and the current renderer
    // until a valid run/pipeline snapshot tells us which job to follow next.
    if (lane?.pipeline_id && !pipeline) return [];
    const idle = lane?.pipeline_id && !pipeline ? `waiting for ${lane.pipeline_id}` : lane?.state === 'busy' ? `waiting for ${this.lane} job` : `·· ${this.lane} ${str(lane?.state) || 'idle'}（等待可调度任务）`;
    return this.jobs.poll(pipelineTarget(pipeline, lane?.task_id ?? ''), idle, now);
  }
}
