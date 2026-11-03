import { setTimeout as delay } from 'node:timers/promises';
import { GbdevError } from '../contracts/error.js';
import { JOB_STATES, isTerminal, type JobState } from '../contracts/jobStatus.js';
import type { Provider } from '../contracts/brief.js';
import { validateJobId } from '../core/ids.js';
import { sanitizeForTerminal } from './sanitize.js';
import { localIso } from '../core/time.js';
import { HomeFs, RefusedPath, TransientPath } from './homeFs.js';
import { LineReader } from './lineReader.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { checkLog, gbdevEvents, providerLine } from './gbdevEvents.js';
import { eventAt, line, prepareLine, record, safeText, str, type RenderContext, type RenderLine } from './format.js';
import { ThinkingBuffer } from './thinking.js';
export interface RenderOptions { follow?: boolean; fromStart?: boolean; verbose?: boolean; columns?: number; pollMs?: number; signal?: AbortSignal; userHome?: string; onBackfill?: () => void | Promise<void> }
export interface RenderStats { corrupt_lines: number; truncated_lines: number; skipped_bytes: number }
/** Bounded ring shared by snapshot views and the CLI. */
export class Tail<T> {
  private values: T[] = []; private next = 0;
  constructor(readonly capacity: number) {}
  push(value: T): void { if (!this.capacity) return; if (this.values.length < this.capacity) this.values.push(value); else { this.values[this.next] = value; this.next = (this.next + 1) % this.capacity; } }
  all(): T[] { return [...this.values.slice(this.next), ...this.values.slice(0, this.next)]; }
}
export class JobRenderer {
  readonly fs: HomeFs;
  readonly provider: Provider;
  readonly stats: RenderStats = { corrupt_lines: 0, truncated_lines: 0, skipped_bytes: 0 };
  private job: Record<string, unknown>;
  private readonly base: string;
  private readonly raw: LineReader;
  private readonly events: LineReader;
  private readonly stderr: LineReader;
  private readonly thinking = new ThinkingBuffer();
  private readonly unknown = new Map<string, number>();
  private readonly warnings = new Set<string>();
  private notices: RenderLine[] = [];
  private stderrCount = 0;
  private stderrAt = -Infinity;
  private stderrTail = new Tail<string>(5);
  private stderrKey = false;
  private missingPolls = 0;
  private unavailable = false;
  get awaitingMetadata(): boolean { return this.unavailable && !this.finished; }
  constructor(home: string, readonly jobId: string, readonly options: RenderOptions = {}) {
    validateJobId(jobId); this.fs = new HomeFs(home); this.base = `jobs/${jobId}`;
    const initial = this.metadata('job.json', true);
    if (!initial) throw new GbdevError('job_not_found', this.notices.length ? `WARN ${this.notices[0]!.text}` : `Job not found: ${jobId}`);
    this.job = initial;
    if (!['codex', 'cursor', 'fake'].includes(str(this.job.provider))) throw new GbdevError('config_invalid', 'Invalid job provider');
    this.provider = this.job.provider as Provider;
    this.raw = new LineReader(this.fs, `${this.base}/${this.provider === 'cursor' ? 'raw.json' : 'raw.jsonl'}`, options.fromStart);
    this.events = new LineReader(this.fs, `${this.base}/events.jsonl`, options.fromStart);
    this.stderr = new LineReader(this.fs, `${this.base}/worker.log`, options.fromStart);
  }
  private context(at = localIso()): RenderContext {
    return { at, worktree: str(this.job?.worktree), verbose: this.options.verbose ?? false, ...(this.options.userHome ? { userHome: this.options.userHome } : {}) };
  }
  private warn(key: string, message: string): void {
    if (this.warnings.has(key) || this.warnings.size >= 256) return;
    this.warnings.add(key); this.notices.push(line(this.context(), 'WARN', message));
  }
  private metadata(file: string, initial = false): Record<string, unknown> | undefined {
    try { const value = this.fs.json(`${this.base}/${file}`); return value === undefined ? undefined : record(value); }
    catch (error) {
      if (error instanceof TransientPath) { if (initial) throw error; }
      else this.warn(file, error instanceof RefusedPath ? error.message : `cannot read ${file}`);
      return undefined;
    }
  }
  private *read(reader: LineReader, final = false): ReturnType<LineReader['read']> {
    const skipped = reader.skippedBytes, truncated = reader.truncatedLines;
    try { yield* reader.read(final); }
    catch (error) { if (!(error instanceof TransientPath)) this.warn(reader.rel, error instanceof RefusedPath ? error.message : 'cannot read log file'); }
    finally { this.stats.skipped_bytes += reader.skippedBytes - skipped; this.stats.truncated_lines += reader.truncatedLines - truncated; }
  }
  private *source(reader: LineReader, raw: boolean, backfill: boolean, final: boolean): Generator<RenderLine> {
    let unstampedBackfill = false;
    for (const entry of this.read(reader, final)) {
      const ctx = this.context();
      if (entry.kind !== 'line' && entry.kind !== 'truncated') {
        if (entry.kind === 'rotated') { if (raw) this.thinking.clear(); yield line(ctx, 'WARN', '[file rotated]'); }
        if (entry.kind === 'skip') yield line(ctx, 'SKIP', `earlier ${(entry.bytes / 1048576).toFixed(1)} MiB not shown; use gbdev logs ${this.jobId} --from-start`);
        continue;
      }
      // Never echo an unparseable JSON prefix: it may end inside a credential.
      if (entry.kind === 'truncated') { yield line(ctx, 'WARN', '[line truncated: retained 1 MiB prefix; incomplete JSON not displayed]'); continue; }
      if (!entry.text.trim()) continue;
      let event: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(entry.text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        event = record(value);
      } catch {
        this.stats.corrupt_lines++;
        if (this.stats.corrupt_lines % 100 === 1) yield line(ctx, 'WARN', `corrupt JSON line skipped (count=${this.stats.corrupt_lines})`);
        continue;
      }
      ctx.at = eventAt(event, ctx.at);
      if (raw && this.provider === 'cursor') {
        if (event.type === 'thinking' && event.subtype === 'delta') { yield* this.thinking.add(str(event.text), ctx.at, Date.now(), backfill); continue; }
        yield* this.thinking.flush(); this.thinking.clear();
      }
      const rendered = raw ? this.provider === 'cursor' ? cursor(event, ctx) : codex(event, ctx) : gbdevEvents(event, ctx);
      // Codex JSONL commonly has no event timestamp. Keep `at` as observation
      // time, but explicitly label historical observations instead of inventing
      // an execution time. Timestamped events and live appends are unchanged.
      unstampedBackfill ||= raw && this.provider === 'codex' && backfill && !eventAt(event, '') && rendered.length > 0;
      yield* rendered;
      if (!raw && event.type === 'check' && record(event.data).exit_code !== 0) {
        const file = checkLog(record(event.data));
        if (file) for (const text of this.logTail(file, 10)) yield line(ctx, '', `│ ${text}`);
      }
    }
    // Footer survives the bounded tail, including a late/recreated pane. Keep
    // existing message text and unknown-type accounting unchanged.
    if (unstampedBackfill) yield line(this.context(), 'NOTE', '[backfill] untimestamped Codex raw uses read time, not event time');
    if (raw && backfill) yield* this.thinking.flush(false);
  }
  private logTail(file: string, count: number): string[] {
    const tail = new Tail<string>(count), reader = new LineReader(this.fs, `${this.base}/${file}`);
    let key = false;
    for (const entry of this.read(reader, true)) if (entry.kind === 'line' || entry.kind === 'truncated') {
      const text = sanitizeForTerminal(entry.text);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) key = true;
      tail.push(key ? '‹redacted›' : safeText(text));
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(text)) key = false;
    }
    return tail.all();
  }
  private *stderrLines(final: boolean): Generator<RenderLine> {
    for (const entry of this.read(this.stderr, final)) {
      if (entry.kind === 'line' || entry.kind === 'truncated') {
        if (entry.kind === 'truncated') yield line(this.context(), 'WARN', '[line truncated: worker.log prefix retained]');
        this.stderrCount++;
        const text = sanitizeForTerminal(entry.text);
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) this.stderrKey = true;
        if (this.options.verbose) this.stderrTail.push(this.stderrKey ? '‹redacted›' : safeText(text));
        if (/-----END [A-Z ]*PRIVATE KEY-----/.test(text)) this.stderrKey = false;
      }
      else if (entry.kind === 'rotated') { this.stderrTail = new Tail(5); this.stderrKey = false; yield line(this.context(), 'WARN', '[file rotated] worker.log'); }
      else if (entry.kind === 'skip') yield line(this.context(), 'SKIP', `earlier ${(entry.bytes / 1048576).toFixed(1)} MiB of worker.log not shown`);
    }
    if (this.stderrCount && (final || Date.now() - this.stderrAt >= 30000)) {
      yield line(this.context(), 'WARN', `stderr +${this.stderrCount} lines (worker.log)`);
      if (this.options.verbose) {
        for (const text of this.stderrTail.all()) yield line(this.context(), '', `│ ${text}`);
      }
      this.stderrCount = 0; this.stderrAt = Date.now(); this.stderrTail = new Tail(5);
    }
  }
  private *safe(lines: Iterable<RenderLine>): Generator<RenderLine> {
    for (const value of lines) {
      if (value.tag === '?') {
        const type = safeText(value.text).slice(0, 160), count = this.unknown.get(type) ?? 0;
        if (count) { this.unknown.set(type, count + 1); continue; }
        if (this.unknown.size >= 256) { this.unknown.set('(other)', (this.unknown.get('(other)') ?? 0) + 1); continue; }
        this.unknown.set(type, 1);
      }
      yield* prepareLine(value, this.options.columns);
    }
  }
  private *poll(backfill: boolean, final: boolean): Generator<RenderLine> {
    const streams = [this.source(this.raw, true, backfill, final), this.source(this.events, false, backfill, final)];
    // One lookahead per source, no full-file materialization. Source order is retained on ties.
    try {
      const heads = streams.map(s => s.next());
      while (heads.some(h => !h.done)) {
        let index = -1;
        for (let i = 0; i < heads.length; i++) if (!heads[i]!.done && (index < 0 || Date.parse(heads[i]!.value!.at) < Date.parse(heads[index]!.value!.at))) index = i;
        yield* this.safe([heads[index]!.value!]); heads[index] = streams[index]!.next();
      }
    } finally { for (const stream of streams) stream.return(undefined); }
    yield* this.safe(this.stderrLines(final));
    yield* this.safe(this.notices.splice(0));
  }
  private polled = false;
  private finished = false;
  get complete(): boolean { return this.finished; }
  private removed(): boolean {
    try {
      if (!this.fs.exists(`${this.base}/job.json`)) return ++this.missingPolls >= 3;
    } catch { /* Uncertain is not deleted. Retry on the next poll. */ }
    this.missingPolls = 0; return false;
  }
  /** Synchronous incremental interface for view coordinators: no timers or child processes. */
  *pollLines(): Generator<RenderLine> {
    if (this.finished) return;
    const next = this.metadata('job.json');
    if (!next) {
      this.unavailable = true;
      this.finished = this.removed();
      if (this.finished) this.warn('missing metadata', 'job directory removed or job metadata unavailable');
      yield* this.safe(this.notices.splice(0));
      return;
    }
    this.missingPolls = 0; this.unavailable = false;
    this.job = next;
    const terminal = (JOB_STATES as readonly string[]).includes(str(next.state)) && isTerminal(next.state as JobState);
    if (!this.polled) yield* this.safe([providerLine(this.metadata('provider.json') ?? {}, this.job, this.context(eventAt({ at: this.job.created_at }, localIso())))]);
    yield* this.poll(!this.polled, terminal);
    yield* this.safe(terminal ? this.thinking.flush() : this.thinking.idle(Date.now()));
    if (terminal) {
      yield* this.safe([line(this.context(), 'DONE', `summary ${this.jobId} ${str(next.state)} corrupt_lines=${this.stats.corrupt_lines} truncated_lines=${this.stats.truncated_lines} skipped_bytes=${this.stats.skipped_bytes}`)]);
      for (const [type, count] of this.unknown) yield* this.safe([line(this.context(), 'NOTE', `unknown_types ${type}=${count}`)]);
      this.finished = true;
    }
    this.polled = true;
  }
  async *lines(): AsyncGenerator<RenderLine> {
    const ctx = this.context(eventAt({ at: this.job.created_at }, localIso()));
    const provider = this.metadata('provider.json') ?? {};
    yield* this.safe([providerLine(provider, this.job, ctx)]);
    yield* this.safe(this.notices.splice(0));
    let backfill = true;
    while (!this.options.signal?.aborted) {
      const state = str(this.job.state), terminal = (JOB_STATES as readonly string[]).includes(state) && isTerminal(state as JobState);
      yield* this.poll(backfill, terminal);
      if (backfill && this.options.follow && !terminal) await this.options.onBackfill?.();
      if (!this.options.follow || terminal) {
        yield* this.safe(this.thinking.flush());
        if (terminal || this.options.follow) yield* this.safe([line(this.context(), 'DONE', `summary ${this.jobId} ${state} corrupt_lines=${this.stats.corrupt_lines} truncated_lines=${this.stats.truncated_lines} skipped_bytes=${this.stats.skipped_bytes}`)]);
        if (this.unknown.size) {
          // Separate bounded lines keep every counted type visible without extending the JSON contract.
          for (const [type, count] of this.unknown) yield* this.safe([line(this.context(), 'NOTE', `unknown_types ${type}=${count}`)]);
        }
        break;
      }
      backfill = false;
      yield* this.safe(this.thinking.idle(Date.now()));
      try { await delay(this.options.pollMs ?? 500, undefined, this.options.signal ? { signal: this.options.signal } : {}); }
      catch (error) { if (this.options.signal?.aborted) break; throw error; }
      const next = this.metadata('job.json');
      if (next) { this.job = next; this.missingPolls = 0; }
      else {
        yield* this.safe(this.notices.splice(0));
        if (!this.removed()) continue;
        yield* this.safe([line(this.context(), 'WARN', 'job directory removed or job metadata unavailable')]);
        yield* this.safe([line(this.context(), 'DONE', 'summary job unavailable')]); break;
      }
    }
  }
}
