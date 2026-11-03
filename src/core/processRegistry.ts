import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './jobStore.js';
const registry = new AsyncLocalStorage<string>();
export function withRunProcesses<T>(dir: string, work: () => T): T { return registry.run(dir, work); }
/** Persist group ownership synchronously immediately after spawn, before yielding. */
export function registerRunProcess(pgid: number | undefined, kind: string, worktree?: string): () => void {
  const dir = registry.getStore(); if (!dir || !pgid) return () => {};
  const path = join(dir, 'processes', `${pgid}.json`); mkdirSync(join(dir, 'processes'), { recursive: true }); atomicWriteJson(path, { pgid, kind, ...(worktree ? { worktree } : {}) });
  return () => { try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } };
}
