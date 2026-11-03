import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

/** Resolve executables without invoking a shell or inspecting any user config. */
export function findExecutable(bin: string, searchPath = process.env.PATH ?? ''): string | null {
  const candidates = bin.includes('/') ? [resolve(bin)] : searchPath.split(delimiter).map(dir => resolve(dir, bin));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

export function spawnProcess(cmd: string, args: string[], options: SpawnOptions): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options);
    child.once('error', reject);
    child.once('spawn', () => resolve(child));
  });
}

export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code !== 'EPERM') return true;
    // macOS rejects signals to zombie-only groups. Check descendants as well as
    // the leader, which may have been reaped before its children exit.
    const probe = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000 });
    if (probe.status === 0) return probe.stdout.split('\n').some(line => {
      const [, group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !!state && !state.startsWith('Z');
    });
    // Failed inspection is not evidence that a writer has exited.
    return true;
  }
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid process group');
  try { process.kill(-pid, signal); }
  catch (error) { if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}

/** Keep watching the group even if its leader exits before its descendants. */
export async function terminateGroup(pid: number, graceMs = 10_000, killWaitMs = 5_000): Promise<void> {
  // Timer/abort callbacks must receive a promise even when the first signal fails.
  // Callers attach a rejection handler immediately and await the same promise later.
  try { signalGroup(pid, 'SIGTERM'); }
  catch (error) { return Promise.reject(error); }
  const until = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < until) await delay(50);
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
  const killedUntil = Date.now() + killWaitMs;
  while (groupAlive(pid) && Date.now() < killedUntil) await delay(25);
  if (groupAlive(pid)) throw new Error(`process_group_still_alive:${pid}`);
}

export function caffeinatePath(): string | null {
  const probe = spawnSync('which', ['caffeinate'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return probe.status === 0 ? probe.stdout.trim() || null : null;
}

/** Per-pid cumulative CPU snapshot used to detect deltas without reading argv/environ. */
export type CpuSampleState = Map<number, number>;

export interface WorkerCpuSample {
  unavailable: boolean;
  identityChanged: boolean;
  cpuDeltaMs: number;
  cpuTotalMs: number;
  state: CpuSampleState;
}

/** Parse `ps` time fields like `MM:SS.ss`, `HH:MM:SS`, or `DD-HH:MM:SS`. */
export function parsePsCpuTimeToMs(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const daySplit = text.split('-');
  let days = 0;
  let rest = text;
  if (daySplit.length === 2) {
    days = Number(daySplit[0]);
    rest = daySplit[1] ?? '';
    if (!Number.isFinite(days) || days < 0) return null;
  } else if (daySplit.length !== 1) return null;
  const parts = rest.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isFinite(n) || n < 0)) return null;
  let seconds = 0;
  if (nums.length === 3) seconds = (nums[0]! * 3600) + (nums[1]! * 60) + nums[2]!;
  else seconds = (nums[0]! * 60) + nums[1]!;
  return Math.round((days * 86400 + seconds) * 1000);
}

/**
 * Sample cumulative CPU for a process group. Does not read environ/cmdline or files outside /proc|ps.
 * Injectable for tests via ActivityTrackerOptions.processProbe.
 */
export function sampleWorkerGroupCpu(pgid: number, previous: CpuSampleState | null, timeoutMs = 200): WorkerCpuSample {
  const empty: WorkerCpuSample = {
    unavailable: true, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: previous ?? new Map(),
  };
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return empty;
  let probe: ReturnType<typeof spawnSync>;
  try {
    probe = spawnSync('ps', ['-axo', 'pid=,pgid=,time='], {
      encoding: 'utf8', timeout: Math.max(1, Math.min(200, timeoutMs)),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return empty;
  }
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return empty;

  const current: CpuSampleState = new Map();
  for (const line of probe.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const group = Number(match[2]);
    if (group !== pgid || !Number.isSafeInteger(pid) || pid <= 0) continue;
    const cpuMs = parsePsCpuTimeToMs(match[3]!);
    if (cpuMs === null) continue;
    current.set(pid, cpuMs);
  }

  if (current.size === 0) {
    // Empty group: may be a transient race after exit; treat as unavailable signal, not death proof.
    return { unavailable: true, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: previous ?? new Map() };
  }

  let identityChanged = false;
  let cpuDeltaMs = 0;
  let cpuTotalMs = 0;
  for (const [pid, cpuMs] of current) {
    cpuTotalMs += cpuMs;
    const prev = previous?.get(pid);
    if (prev === undefined) {
      // New member: count its current CPU as progress only after a baseline exists.
      if (previous) cpuDeltaMs += cpuMs;
      continue;
    }
    if (cpuMs < prev) {
      // PID reuse or clock reset — do not invent negative progress or extend grace.
      identityChanged = true;
      continue;
    }
    cpuDeltaMs += cpuMs - prev;
  }
  if (previous) {
    for (const pid of previous.keys()) {
      if (!current.has(pid)) identityChanged = true;
    }
  }
  return { unavailable: false, identityChanged, cpuDeltaMs, cpuTotalMs, state: current };
}
