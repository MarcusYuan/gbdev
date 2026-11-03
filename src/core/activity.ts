import {
  captureWorkspaceSnapshot,
  snapshotEntryMap,
  WorkspaceObservationRaceError,
  type SnapshotOptions,
  type WorkspaceSnapshot,
} from './workspaceSnapshot.js';
import {
  interpretCursorToolEvent,
  JsonlEventBuffer,
} from '../providers/cursorEvents.js';
import {
  sampleWorkerGroupCpu,
  type CpuSampleState,
  type WorkerCpuSample,
} from './proc.js';
import type { Clock } from './time.js';

export type ProgressSource = 'output' | 'file';

export interface ActivityDiagnostics {
  idle_s: number;
  last_progress_source: ProgressSource | null;
  pending_tool_count: number;
  cpu_progress_observed: boolean;
  grace_used: boolean;
}

export interface ActivityTickResult {
  stalled: boolean;
  diagnostics: ActivityDiagnostics;
  events: ActivityEmit[];
}

export type ActivityEmit =
  | { type: 'heartbeat'; data: Record<string, unknown> }
  | { type: 'warning'; data: Record<string, unknown> };

export interface ProcessProbe {
  (pgid: number, previous: CpuSampleState | null, timeoutMs: number): WorkerCpuSample;
}

export interface FileProbeResult {
  content_progress: boolean;
  unavailable?: boolean;
}

export interface FileProbe {
  (): FileProbeResult | Promise<FileProbeResult>;
}

export interface ActivityTrackerOptions {
  stallTimeoutS: number;
  clock: Pick<Clock, 'now'>;
  /** Worker process group id (detached child pid). */
  pgid: () => number | null;
  processProbe?: ProcessProbe;
  fileProbe?: FileProbe;
}

/** Probe interval: min(1000ms, max(100ms, S × 250ms)). */
export function activityProbeIntervalMs(stallTimeoutS: number): number {
  if (!(stallTimeoutS > 0)) return 1000;
  return Math.min(1000, Math.max(100, stallTimeoutS * 250));
}

/** Activity requires observed worktree changes, not B3's conservative unknown=changed.
 * Index/HEAD bookkeeping and hash-budget availability alone are not worker progress.
 * WorkspaceEntry has no size metadata, so unknown content cannot prove progress.
 */
export function workspaceActivityChanged(before: WorkspaceSnapshot, after: WorkspaceSnapshot): boolean {
  const a = snapshotEntryMap(before);
  const b = snapshotEntryMap(after);
  // A tracked-but-deleted path is not an existing worktree entry. Removing that
  // path from the index later must not manufacture a second deletion signal.
  for (const entries of [a, b]) {
    for (const [path, entry] of entries) {
      if (entry.kind === 'other' && entry.mode === 0) entries.delete(path);
    }
  }
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(path), right = b.get(path);
    if (!left || !right) return true;
    if (left.kind !== right.kind || left.mode !== right.mode) return true;
    if (!left.content_unknown && !right.content_unknown
      && left.content_hash !== null && right.content_hash !== null
      && left.content_hash !== right.content_hash) return true;
  }
  return false;
}

export function createWorkspaceFileProbe(
  worktree: string,
  jobId: string,
  options: Pick<SnapshotOptions, 'signal' | 'cancelled' | 'deadlineAt' | 'onHashChunk'> = {},
): FileProbe {
  let previous: WorkspaceSnapshot | null = null;
  let scanning = false;
  return async () => {
    if (scanning) return { content_progress: false };
    scanning = true;
    try {
      const snap = await captureWorkspaceSnapshot(worktree, {
        job_id: jobId,
        phase: 'after_worker',
        previous_job_id: null,
      }, {
        signal: options.signal,
        onHashChunk: options.onHashChunk,
        cancelled: options.cancelled,
        deadlineAt: options.deadlineAt ?? Date.now() + 5_000,
        // Activity probes stay cheap; unknown hashes are not treated as progress.
        maxHashBytes: 256 * 1024,
        maxTotalHashBytes: 2 * 1024 * 1024,
        // Byte hashes only: a commit turning a dirty file clean must not read as content progress.
        gitIndexIdentity: false,
        settleRacy: false,
      });
      if (!previous) {
        previous = snap;
        return { content_progress: false };
      }
      const changed = workspaceActivityChanged(previous, snap);
      previous = snap;
      return { content_progress: changed };
    } catch (error) {
      if (error instanceof WorkspaceObservationRaceError) return { content_progress: true };
      return { content_progress: false, unavailable: true };
    } finally {
      scanning = false;
    }
  };
}

export class ActivityTracker {
  readonly stallTimeoutS: number;
  readonly intervalMs: number;
  #clock: Pick<Clock, 'now'>;
  #pgid: () => number | null;
  #processProbe: ProcessProbe;
  #fileProbe: FileProbe | null;
  #lastProgressAt: number;
  #lastProgressSource: ProgressSource | null = null;
  #pending = new Map<string, string>();
  #jsonl = new JsonlEventBuffer();
  #cpuState: CpuSampleState | null = null;
  #cpuProgressObserved = false;
  #recentCpuProgress = false;
  #graceActive = false;
  #emittedProbeUnavailable = false;
  #fileScan: Promise<void> | null = null;
  #pendingFileProgress = false;
  #pendingFileUnavailable = false;

  constructor(options: ActivityTrackerOptions) {
    this.stallTimeoutS = options.stallTimeoutS;
    this.intervalMs = activityProbeIntervalMs(options.stallTimeoutS);
    this.#clock = options.clock;
    this.#pgid = options.pgid;
    this.#processProbe = options.processProbe ?? sampleWorkerGroupCpu;
    this.#fileProbe = options.fileProbe ?? null;
    this.#lastProgressAt = options.clock.now();
  }

  get pendingToolCount(): number { return this.#pending.size; }

  diagnostics(now = this.#clock.now()): ActivityDiagnostics {
    const grace = this.#pending.size > 0 || this.#recentCpuProgress;
    return {
      idle_s: Math.max(0, (now - this.#lastProgressAt) / 1000),
      last_progress_source: this.#lastProgressSource,
      pending_tool_count: this.#pending.size,
      cpu_progress_observed: this.#cpuProgressObserved,
      grace_used: grace,
    };
  }

  /** stdout/stderr byte growth is hard progress. */
  noteOutput(at = this.#clock.now()): ActivityEmit[] {
    return this.#markProgress('output', at);
  }

  /** Feed raw stdout text; parses Cursor tool_call JSONL without throwing. */
  consumeStdout(chunk: string, at = this.#clock.now()): ActivityEmit[] {
    const events: ActivityEmit[] = [];
    for (const object of this.#jsonl.push(chunk)) {
      events.push(...this.noteCursorEvent(object, at));
    }
    return events;
  }

  /** Called once after stdout closes; a trailing JSON object need not end in LF. */
  flushStdout(at = this.#clock.now()): ActivityEmit[] {
    return this.#jsonl.flush().flatMap(object => this.noteCursorEvent(object, at));
  }

  noteCursorEvent(event: Record<string, unknown>, at = this.#clock.now()): ActivityEmit[] {
    const signal = interpretCursorToolEvent(event);
    if (signal.kind === 'started') {
      if (this.#pending.has(signal.id)) return []; // duplicate started: no grace re-lease
      this.#pending.set(signal.id, signal.name);
      return this.#graceTransitionEvents(at);
    }
    if (signal.kind === 'completed') {
      if (!this.#pending.delete(signal.id)) return [];
      return this.#graceTransitionEvents(at);
    }
    return [];
  }

  /**
   * Periodic sample. File probe runs async without overlap; CPU probe is sync/injectable.
   * S=0 disables stall. Absolute deadline / cancel remain the caller's responsibility.
   */
  async tick(drainOutput?: () => ActivityEmit[]): Promise<ActivityTickResult> {
    const events: ActivityEmit[] = [];
    if (this.stallTimeoutS <= 0) {
      return { stalled: false, diagnostics: this.diagnostics(), events };
    }

    this.#scheduleFileProbe();
    if (this.#pendingFileProgress) {
      this.#pendingFileProgress = false;
      events.push(...this.#markProgress('file'));
    }
    if (this.#pendingFileUnavailable) {
      this.#pendingFileUnavailable = false;
      events.push(...this.#probeUnavailable('file'));
    }

    const pgid = this.#pgid();
    if (pgid !== null && Number.isSafeInteger(pgid) && pgid > 1) {
      try {
        const sample = this.#processProbe(pgid, this.#cpuState, Math.min(200, this.intervalMs / 2));
        this.#cpuState = sample.state;
        if (sample.unavailable) events.push(...this.#probeUnavailable('cpu'));
        else {
          // Latch meaningful CPU deltas until the next output/file progress window.
          // Clearing on a zero sample would flicker grace heartbeats and rewrite job.json.
          if (sample.cpuDeltaMs >= 20 && !sample.identityChanged) {
            this.#recentCpuProgress = true;
            this.#cpuProgressObserved = true;
          }
          events.push(...this.#graceTransitionEvents());
        }
      } catch {
        events.push(...this.#probeUnavailable('cpu'));
        this.#recentCpuProgress = false;
      }
    } else {
      this.#recentCpuProgress = false;
    }

    // A synchronous CPU probe may outlast S while the worker writes output.
    // Observe those bytes and Cursor lifecycle events before choosing S vs 3S.
    if (drainOutput) events.push(...drainOutput());
    const now = this.#clock.now();
    const idleMs = now - this.#lastProgressAt;
    const sMs = this.stallTimeoutS * 1000;
    const grace = this.#pending.size > 0 || this.#recentCpuProgress;
    const limit = grace ? 3 * sMs : sMs;
    const stalled = idleMs >= limit;
    const diagnostics = this.diagnostics(now);
    if (stalled) {
      events.push({
        type: 'warning',
        data: {
          code: 'worker_stalled',
          retryable: true,
          stall_timeout_s: this.stallTimeoutS,
          idle_s: diagnostics.idle_s,
          last_progress_source: diagnostics.last_progress_source,
          pending_tool_count: diagnostics.pending_tool_count,
          cpu_progress_observed: diagnostics.cpu_progress_observed,
          grace_used: diagnostics.grace_used,
        },
      });
    }
    return { stalled, diagnostics, events };
  }

  #scheduleFileProbe(): void {
    if (!this.#fileProbe || this.#fileScan) return;
    const probe = this.#fileProbe;
    this.#fileScan = Promise.resolve()
      .then(() => probe())
      .then(result => {
        if (result.unavailable) this.#pendingFileUnavailable = true;
        if (result.content_progress) this.#pendingFileProgress = true;
      })
      .catch(() => { this.#pendingFileUnavailable = true; })
      .finally(() => { this.#fileScan = null; });
  }

  #markProgress(source: ProgressSource, at = this.#clock.now()): ActivityEmit[] {
    const prev = this.#lastProgressSource;
    this.#lastProgressAt = at;
    this.#lastProgressSource = source;
    // True progress opens a new window; CPU "recent" grace resets with the window.
    this.#recentCpuProgress = false;
    const events: ActivityEmit[] = [];
    // Skip null→first-source heartbeats: construction already starts the window, and a
    // post-`running` rewrite of job.json breaks M7 inspect frozen-byte assertions.
    if (prev !== null && prev !== source) {
      events.push({
        type: 'heartbeat',
        data: {
          kind: 'worker_activity',
          last_progress_source: source,
          pending_tool_count: this.#pending.size,
          grace_active: this.#pending.size > 0 || this.#recentCpuProgress,
        },
      });
    }
    events.push(...this.#graceTransitionEvents(at));
    return events;
  }

  #graceTransitionEvents(at = this.#clock.now()): ActivityEmit[] {
    void at;
    const next = this.#pending.size > 0 || this.#recentCpuProgress;
    if (next === this.#graceActive) return [];
    this.#graceActive = next;
    return [{
      type: 'heartbeat',
      data: {
        kind: 'worker_activity',
        grace_active: next,
        pending_tool_count: this.#pending.size,
        last_progress_source: this.#lastProgressSource,
        cpu_progress_observed: this.#cpuProgressObserved,
      },
    }];
  }

  #probeUnavailable(which: 'cpu' | 'file'): ActivityEmit[] {
    if (this.#emittedProbeUnavailable) return [];
    this.#emittedProbeUnavailable = true;
    return [{
      type: 'warning',
      data: { code: 'activity_probe_unavailable', probe: which },
    }];
  }
}
