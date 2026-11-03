import { linkSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { GbdevError } from '../contracts/error.js';

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const ownedLocks = new Set<string>();
export function ownsLock(path: string): boolean { return ownedLocks.has(path); }

export interface LockHandle { release(): void }

/** Atomically publish a fully-written PID using an exclusive hard link. Keep the descriptor open to identify ownership. */
export function acquireLock(path: string): LockHandle {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 10; attempt++) {
    let fd: number;
    try {
      const staged = `${path}.owner-${process.pid}-${randomUUID()}`;
      const candidate = openSync(staged, 'wx', 0o600);
      try {
        writeFileSync(candidate, `${process.pid}\n`, 'utf8');
        // link is exclusive like O_EXCL, but SIGKILL cannot expose an empty lock.
        linkSync(staged, path); fd = candidate;
      } catch (e) { closeSync(candidate); throw e; }
      finally { unlinkSync(staged); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const before = statSync(path);
        const content = readFileSync(path, 'utf8').trim();
        const pid = /^\d+$/.test(content) ? Number(content) : NaN;
        if (!Number.isSafeInteger(pid) || pid < 1 || isProcessAlive(pid)) {
          throw new GbdevError('busy', 'Global lock is held (or has an unreadable owner)', Number.isSafeInteger(pid) ? { pid } : {});
        }
        const after = statSync(path);
        if (before.dev === after.dev && before.ino === after.ino && readFileSync(path, 'utf8').trim() === content) unlinkSync(path);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== 'ENOENT') throw inspectionError;
      }
      continue;
    }
    const owned = fstatSync(fd);
    ownedLocks.add(path);
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        ownedLocks.delete(path);
        try {
          const current = statSync(path, { throwIfNoEntry: false });
          if (current?.dev === owned.dev && current.ino === owned.ino) unlinkSync(path);
        } finally {
          closeSync(fd);
        }
      },
    };
  }
  throw new GbdevError('busy', 'Global lock changed repeatedly; retry later');
}

export async function withLock<T>(path: string, operation: () => T | Promise<T>): Promise<T> {
  const lock = acquireLock(path);
  try { return await operation(); } finally { lock.release(); }
}
