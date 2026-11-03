import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GbdevPaths } from '../core/paths.js';

import { openNotifyLog, deliveryLog } from './log.js';

export type LaunchNotify = (failed: () => void) => void;
/** Leading edge only: no timer can keep a completed supervisor alive. */
export class NotifyTrigger {
  private last = -Infinity;
  constructor(private launch: LaunchNotify, private now = Date.now) {}
  fire(warning: () => void): void {
    try {
      const now = this.now(); if (now - this.last < 1000) return; this.last = now;
      let reported = false;
      const failed = () => { if (reported) return; reported = true; try { warning(); } catch { /* Additive only. */ } };
      try { this.launch(failed); } catch { failed(); }
    } catch { /* Even injected clocks cannot affect the caller. */ }
  }
}
export function deliveryEnv(paths: GbdevPaths, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TZ']) if (source[name] !== undefined) env[name] = source[name];
  env.GBDEV_HOME = paths.home; env.GBDEV_CONFIG = paths.config;
  if (source.NODE_TEST_CONTEXT !== undefined) for (const name of ['NODE_TEST_CONTEXT', 'GBDEV_NOTIFY_TEST', 'GBDEV_NOTIFY']) if (source[name] !== undefined) env[name] = source[name];
  return env;
}
/** Detached delivery belongs to its own process group, never the worker group. */
export function launchDeliver(paths: GbdevPaths, failed: () => void, env = process.env, spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess, command: '__notify-deliver' | '__notify-remind' = '__notify-deliver'): void {
  // Tests must inject launch. An opt-in to notification enqueue is NOT spawn permission.
  if (!spawnChild && (process.env.NODE_TEST_CONTEXT !== undefined || env.NODE_TEST_CONTEXT !== undefined)) { failed(); return; }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') { deliveryLog(paths.home, 'tls'); failed(); return; }
  let fd: number | undefined;
  try {
    // Reminder recovery may precede the first outbox record.
    const dir = join(paths.home, 'notify');
    if (command === '__notify-remind' && mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(dir, 0o700);
    fd = openNotifyLog(paths.home); if (fd === undefined) { failed(); return; }
    const child = (spawnChild ?? spawn)(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), command], {
      shell: false, detached: true, stdio: ['ignore', fd, fd], env: deliveryEnv(paths, env),
    });
    child.on('error', failed); child.unref();
  } catch { failed(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
