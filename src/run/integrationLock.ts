import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { RUN_ID_PATTERN } from '../core/ids.js';
import { acquireLock, isProcessAlive, type LockHandle } from '../core/lock.js';
import type { GbdevPaths } from '../core/paths.js';
import { localIso } from '../core/time.js';
export interface IntegrationLockOwner { pid: number; purpose: 'merge' | 'land' | 'cleanup' | 'recover'; seq: number; at: string }
function lockPath(paths: GbdevPaths, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new GbdevError('run_invalid', 'Invalid run id');
  return join(paths.home, 'runs', runId, 'integration.lock');
}
export function inspectIntegrationLock(paths: GbdevPaths, runId: string): { owner: IntegrationLockOwner | null; stale: boolean; exists: boolean } {
  try {
    const raw = readFileSync(lockPath(paths, runId), 'utf8');
    let owner: IntegrationLockOwner;
    try {
      owner = JSON.parse(raw) as IntegrationLockOwner;
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid owner');
    } catch { return { owner: null, stale: true, exists: true }; }
    return { owner, stale: !isProcessAlive(owner.pid), exists: true };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { owner: null, stale: false, exists: false }; return { owner: null, stale: true, exists: true }; }
}
/** Acquires the M1 lock only during O_EXCL/reclaim, not for the lock's lifetime. */
export function acquireIntegrationLock(paths: GbdevPaths, runId: string, purpose: IntegrationLockOwner['purpose'], seq = 0, globalHeld = false): LockHandle & { owner: IntegrationLockOwner; warnings: string[] } {
  const path = lockPath(paths, runId), global = globalHeld ? undefined : acquireLock(paths.lock);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const warnings: string[] = [], info = inspectIntegrationLock(paths, runId);
    if (info.exists) {
      if (!info.stale) throw new GbdevError('integration_locked', 'Integration lock is held or unreadable', { owner: info.owner });
      unlinkSync(path); warnings.push('stale_integration_lock');
    }
    const fd = openSync(path, 'wx', 0o600), owned = fstatSync(fd);
    const owner: IntegrationLockOwner = { pid: process.pid, purpose, seq, at: localIso() };
    const content = JSON.stringify(owner) + '\n';
    try { writeFileSync(fd, content); } catch (error) { closeSync(fd); unlinkSync(path); throw error; }
    let released = false;
    return { owner, warnings, release() {
      if (released) return;
      released = true;
      try {
        const current = statSync(path, { throwIfNoEntry: false });
        if (current?.dev === owned.dev && current.ino === owned.ino && readFileSync(path, 'utf8') === content) unlinkSync(path);
      } finally { closeSync(fd); }
    } };
  } finally { global?.release(); }
}
export function staleIntegrationLocks(paths: GbdevPaths): { run_id: string; owner: IntegrationLockOwner | null }[] {
  let names: string[];
  try { names = readdirSync(join(paths.home, 'runs')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.filter(n => RUN_ID_PATTERN.test(n)).sort().flatMap(run_id => { const info = inspectIntegrationLock(paths, run_id); return info.stale ? [{ run_id, owner: info.owner }] : []; });
}
