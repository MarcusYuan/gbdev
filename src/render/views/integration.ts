import { compareInstant } from '../../core/time.js';
import type { Run } from '../../contracts/run.js';
import { JOB_ID_PATTERN } from '../../core/ids.js';
import { LineReader, type ReadLine } from '../lineReader.js';
import { Tail } from '../job.js';
import { eventAt, record, safeText, str, type RenderLine, type Tag } from '../format.js';
import { JobFollower } from './laneFollower.js';
import { mergeRecords } from './runStatus.js';
import { records, stamp, ViewFiles, type ViewOptions } from './common.js';
/** Follow integration-owned jobs and selected run events; never display arbitrary event payloads. */
export class IntegrationFollower {
  private readonly events: LineReader;
  private readonly jobs = new Map<string, JobFollower>();
  private readonly completed = new Set<string>();
  private readonly gates = new Map<string, string>();
  private corrupt = 0;
  private scanAfter = '';
  private scanning = false;
  private initialScan = true;
  private refreshAt = Infinity;
  private readonly discovered = new Map<string, Record<string, unknown>>();
  private eventBackfill = true;
  private backfill = true;
  private pendingEvents: Generator<ReadLine> | undefined;
  get draining(): boolean { return (this.initialScan && this.scanning) || this.pendingEvents !== undefined || [...this.jobs.values()].some(j => j.draining); }
  close(): void { this.pendingEvents?.return(undefined); this.pendingEvents = undefined; for (const j of this.jobs.values()) j.close(); }
  recovery = '';
  constructor(readonly files: ViewFiles, readonly id: string, readonly options: ViewOptions = {}) { this.events = new LineReader(files.fs, `runs/${id}/events.jsonl`); }
  pollEvents(now: number): RenderLine[] {
    const tail = new Tail<RenderLine>(this.options.backfillLines ?? 400);
    try {
      this.pendingEvents ??= this.events.read();
      let count = 0;
      while (this.eventBackfill || count++ < (this.options.backfillLines ?? 400)) {
        const next = this.pendingEvents.next();
        if (next.done) { this.pendingEvents = undefined; break; }
        const entry = next.value;
        if (entry.kind !== 'line') { tail.push(stamp(now, entry.kind === 'skip' ? 'SKIP' : 'WARN', entry.kind === 'rotated' ? '[file rotated]' : `${entry.kind} run events`)); continue; }
        let e: Record<string, unknown>;
        try { e = record(JSON.parse(entry.text)); } catch { if (this.corrupt++ % 100 === 0) tail.push(stamp(now, 'WARN', 'corrupt run event skipped')); continue; }
        const d = record(e.data), type = str(e.type), seq = str(d.seq), task = str(e.task_id);
        let tag: Tag = 'NOTE', text = '';
        if (type.startsWith('merge_')) { tag = 'MERGE'; text = `#${seq} ${task} ${type.slice(6)}${type === 'merge_precheck' ? d.clean ? ' clean' : ' conflicts' : ''}${type === 'merge_rolled_back' ? ` → ${task} integration-fix` : ''}`; }
        else if (type === 'gate_started' || type === 'gate_finished') { tag = 'GATE'; text = `${d.baseline ? 'baseline' : `#${seq}`} ${type === 'gate_started' ? '…' : d.passed ? '✓' : '✗'} ${Array.isArray(d.failed_checks) ? d.failed_checks.map(str).join(', ') : ''}`; }
        else if (type === 'decision_required') { tag = 'DECIDE'; text = `${str(d.decision_id)} ${str(d.reason)}`; }
        else if (type === 'recovery_step') { this.recovery = safeText(str(d.message ?? d.step ?? d.phase)); text = `recovery ${this.recovery}`; }
        else if (type === 'warning') { tag = 'WARN'; text = `${str(d.code)} ${str(d.message)}`; }
        if (text) tail.push({ ...stamp(now, tag, text), at: eventAt(e, stamp(now, tag, '').at) });
      }
    } catch (error) { this.pendingEvents?.return(undefined); this.pendingEvents = undefined; this.files.warn(this.events.rel, error); }
    this.eventBackfill = false;
    return tail.all();
  }
  poll(run: Run, now: number): RenderLine[] {
    const tail = new Tail<RenderLine>(this.options.backfillLines ?? 400);
    const live: RenderLine[] = [];
    const push = (lines: RenderLine[]) => { for (const l of lines) { if (this.backfill) tail.push(l); else live.push(l); } };
    push(this.pollEvents(now));
    // Planner and final-review do not publish a live job reference in run.json/events.
    // Discover via safe job metadata, filtering ownership before following any stream.
    // Metadata discovery is paginated, not an arbitrary first-N cutoff. The run
    // contract caps owned jobs at 120; unrelated homes may contain far more jobs.
    // Keep the high-water mark between polls. Slow rescans catch late/rewritten
    // metadata (including same-minute IDs), but never hold terminal completion open.
    if (!this.initialScan && now >= this.refreshAt) { this.scanAfter = ''; this.refreshAt = Infinity; }
    const names = this.files.names('jobs', JOB_ID_PATTERN).filter(id => id > this.scanAfter);
    // A one-shot snapshot must finish discovery; live views amortize it across polls.
    const batch = this.options.once ? names : names.slice(0, 64);
    this.scanning = names.length > batch.length;
    this.scanAfter = batch.at(-1) ?? this.scanAfter;
    if (!this.scanning) { this.initialScan = false; if (this.refreshAt === Infinity) this.refreshAt = now + 30000; }
    for (const id of batch) {
      if (this.completed.has(id) || this.discovered.has(id)) continue;
      const job = this.files.json(`jobs/${id}/job.json`);
      if (job?.job_id === id && job.run_id === run.run_id && !job.pipeline_id) {
        if (this.discovered.size + this.completed.size < 120) this.discovered.set(id, { job_id: id, created_at: str(job.created_at), step_instance: safeText(str(job.step_instance)).slice(0, 160), role: safeText(str(job.role)).slice(0, 80), provider: safeText(str(job.provider)).slice(0, 16) });
        else this.files.warn('integration jobs exceed run contract limit', new Error());
      }
    }
    const candidates = [...this.discovered.values()].sort((a, b) => compareInstant(str(a.created_at), str(b.created_at)) || str(a.job_id).localeCompare(str(b.job_id)));
    for (const job of candidates) {
      const id = str(job.job_id);
      // Each follower keeps its offsets; no slot-based skip can starve a later job.
      const follower = this.jobs.get(id) ?? new JobFollower(this.files, this.options); this.jobs.set(id, follower);
      push(follower.poll({ jobId: id, label: `${str(job.step_instance ?? job.role)} · ${str(job.provider)}` }, '', now));
      const exists = this.files.exists(`jobs/${id}/job.json`);
      if (follower.complete || !exists) {
        follower.close(); this.jobs.delete(id); this.discovered.delete(id);
        if (exists && follower.complete) this.completed.add(id);
      }
    }
    const gates = mergeRecords(this.files, this.id).map(m => ({ key: `#${str(m.seq)}`, dir: `runs/${this.id}/merges/${str(m.seq)}.gate`, gate: record(m.gate) }));
    gates.push({ key: 'baseline', dir: `runs/${this.id}/baseline.gate`, gate: record(this.files.json(`runs/${this.id}/baseline-gate.json`)?.gate) });
    for (const { key, dir, gate } of gates) {
      const signature = JSON.stringify(gate.checks ?? []); if (this.gates.get(key) === signature) continue;
      if (this.gates.size < 256) this.gates.set(key, signature);
      for (const check of records(gate.checks)) {
        const checkId = str(check.id);
        push([stamp(now, 'GATE', `${key} ${checkId} ${check.exit_code === 0 ? '✓' : '✗'} exit ${str(check.exit_code)} ${str(check.duration_s)}s`)]);
        if (check.exit_code === 0 || !/^[a-z][a-z0-9-]{0,23}$/.test(checkId)) continue;
        const log = new Tail<string>(10); let privateKey = false;
        try {
          for (const e of new LineReader(this.files.fs, `${dir}/${checkId}.log`).read(true)) if (e.kind === 'line' || e.kind === 'truncated') {
            if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(e.text)) privateKey = true;
            log.push(privateKey ? '‹redacted›' : safeText(e.text));
            if (/-----END [A-Z ]*PRIVATE KEY-----/.test(e.text)) privateKey = false;
          }
        } catch (error) { this.files.warn(`${dir}/${checkId}.log`, error); }
        for (const text of log.all()) push([stamp(now, '', `│ ${text}`)]);
      }
    }
    const result = this.backfill ? tail.all() : live; this.backfill = false; return result;
  }
}
