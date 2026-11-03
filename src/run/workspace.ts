import { registerRunProcess } from '../core/processRegistry.js';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { RUN_ID_PATTERN } from '../core/ids.js';
import type { GbdevPaths } from '../core/paths.js';
import { signalGroup, spawnProcess, terminateGroup } from '../core/proc.js';

export interface RunWorkspaceOptions {
  paths: GbdevPaths; repo: string; run_id: string;
  worktree_setup_cmd?: string | null;
  /** Test override; production default is fifteen minutes. */
  setup_timeout_ms?: number;
  signal?: AbortSignal;
}
export function runWorkspacePath(options: RunWorkspaceOptions, name: string): string {
  if (!RUN_ID_PATTERN.test(options.run_id) || !/^(lane-[1-4]|integration)$/.test(name)) throw new GbdevError('run_invalid', 'Invalid run workspace identity');
  return join(options.paths.worktrees, basename(resolve(options.repo)), options.run_id, name);
}
export async function setupWorkspace(options: RunWorkspaceOptions, name: string, worktree: string): Promise<void> {
  if (!options.worktree_setup_cmd) return;
  const dir = join(options.paths.home, 'runs', options.run_id);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `setup-${name}.log`), 'a', 0o600);
  let timer: NodeJS.Timeout | undefined;
  try {
    const child = await spawnProcess('/bin/sh', ['-c', options.worktree_setup_cmd], { cwd: worktree, detached: true, stdio: ['ignore', fd, fd] });
    const unregister = registerRunProcess(child.pid, 'setup', worktree);
    let timedOut = false, stopping: Promise<void> | undefined;
    const stop = () => { stopping ??= terminateGroup(child.pid!); void stopping.catch(() => {}); };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    timer = setTimeout(() => { timedOut = true; try { signalGroup(child.pid!, 'SIGKILL'); } catch { /* Best effort; caller reports setup timeout. */ } }, options.setup_timeout_ms ?? 900_000);
    let code: number | null;
    try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { options.signal?.removeEventListener('abort', stop); await stopping; unregister(); }
    if (options.signal?.aborted || timedOut || code !== 0) throw new Error(timedOut ? 'setup timeout' : `setup exit ${code}`);
  } catch (error) {
    throw new GbdevError('worktree_failed', 'worktree_setup_failed', { reason: 'worktree_setup_failed', detail: String(error), worktree });
  } finally { if (timer) clearTimeout(timer); closeSync(fd); }
}
