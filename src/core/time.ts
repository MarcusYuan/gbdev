import { setTimeout as delay } from 'node:timers/promises';
import { GbdevError } from '../contracts/error.js';

export function localIso(date = new Date()): string {
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 0 || date.getFullYear() > 9999) {
    throw new GbdevError('config_invalid', 'Invalid date');
  }
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function deadlineAt(createdAt: Date, timeoutMin: number): string {
  if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > 240) throw new GbdevError('config_invalid', 'timeout_min must be 1–240');
  return localIso(new Date(createdAt.getTime() + timeoutMin * 60_000));
}

/** Injectable wall + monotonic clock for launch backoff / duration (tests must not real-sleep). */
export interface Clock {
  now(): number;
  monotonic(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const monoOrigin = process.hrtime.bigint();

export const realClock: Clock = {
  now: () => Date.now(),
  monotonic: () => Number(process.hrtime.bigint() - monoOrigin) / 1e6,
  sleep: async (ms, signal) => {
    try {
      await delay(Math.max(0, ms), undefined, signal ? { signal } : {});
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
  },
};

let activeClock: Clock = realClock;

/** Test hook: swap the process-wide supervise/launch clock. */
export function setActiveClock(clock: Clock | null): void {
  activeClock = clock ?? realClock;
}

export function getActiveClock(): Clock {
  return activeClock;
}

/** Unparseable timestamps have no instant; callers must not invent a cutoff. */
export function instantMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Invalid timestamps sort last in either direction, then lexically for stability. */
export function compareInstant(a: string, b: string, descending = false): number {
  const am = instantMs(a), bm = instantMs(b);
  if (am === null || bm === null) {
    if (am !== null) return -1;
    if (bm !== null) return 1;
    return a.localeCompare(b);
  }
  return descending ? bm - am : am - bm;
}

export function compareInstantDesc(a: string, b: string): number {
  return compareInstant(a, b, true);
}
