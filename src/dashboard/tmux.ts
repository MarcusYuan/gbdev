import { StringDecoder } from 'node:string_decoder';
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { findExecutable } from '../core/proc.js';
import type { DashboardConfig } from '../core/dashboardConfig.js';
import type { GbdevPaths } from '../core/paths.js';
import { DashboardFailure, type DashboardReason, dynamic, safeArgs } from './safeArgs.js';
export const TMUX_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMUX_TMPDIR', 'TERM'] as const;
export function tmuxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of TMUX_ENV_KEYS) if (env[name] !== undefined) result[name] = env[name];
  result.TERM ||= 'xterm-256color'; return result;
}
export function disabled(config: DashboardConfig, env: NodeJS.ProcessEnv = process.env): DashboardReason | null {
  if (env.GBDEV_DASHBOARD === '0') return 'disabled_by_env';
  if (!config.enabled) return 'disabled_by_config';
  if (env.NODE_TEST_CONTEXT !== undefined && env.GBDEV_TMUX_BIN === undefined && env.GBDEV_DASHBOARD === undefined) return 'disabled_in_tests';
  return null;
}
export function binary(config: DashboardConfig, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GBDEV_TMUX_BIN ?? config.tmux_path;
  if (explicit !== null && (!isAbsolute(explicit) || !explicit)) throw new DashboardFailure('unsafe_argv');
  if (explicit !== null) dynamic(explicit);
  const path = findExecutable(explicit ?? 'tmux', env.PATH ?? '');
  if (!path) throw new DashboardFailure('tmux_not_found');
  return dynamic(path);
}
export function paneArgs(paths: Pick<GbdevPaths, 'home' | 'config'>, config: DashboardConfig, kind: string, id: string, lane?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = ['/usr/bin/env', '-i', `HOME=${env.HOME || homedir()}`, `LANG=${env.LANG || 'en_US.UTF-8'}`, 'TERM=tmux-256color', `GBDEV_HOME=${paths.home}`, `GBDEV_CONFIG=${paths.config}`,
    ...(!config.color || env.NO_COLOR ? ['NO_COLOR=1'] : []), process.execPath, '--max-old-space-size=64', fileURLToPath(new URL('../cli.js', import.meta.url)), '__pane', kind, id, ...(lane ? [lane] : [])];
  args.forEach(dynamic); return args;
}
export interface TmuxResult { code: number; stdout: string; stderr: string }
export function reportedVersion(text: string): string | null { return /^tmux (\d+\.\d+[a-z]?)$/.exec(text.trim())?.[1] ?? null; }
export function supportedVersion(text: string): string {
  const m = /^tmux (\d+)\.(\d+)[a-z]?$/.exec(text.trim());
  if (!m || Number(m[1]) < 3 || Number(m[1]) === 3 && Number(m[2]) < 2) throw new DashboardFailure('tmux_too_old');
  return text.trim().slice(5);
}
export class Tmux {
  constructor(readonly bin: string, readonly env: NodeJS.ProcessEnv = process.env, readonly deadline = Date.now() + 10000) { dynamic(bin); }
  timeout(): number { const left = this.deadline - Date.now(); if (left <= 0) throw new DashboardFailure('tmux_timeout'); return Math.min(3000, left); }
  async call(args: string[], compound = false): Promise<TmuxResult> {
    safeArgs(args, compound); const timeout = this.timeout();
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { shell: false, env: tmuxEnv(this.env), timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0, overflow = false;
      const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
      // A stray descendant retaining a pipe must not extend the call budget.
      // Kill only the invoked client, never the server or a process group.
      const stop = (reason: DashboardReason) => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); reject(new DashboardFailure(reason)); };
      const guard = setTimeout(() => stop(overflow ? 'tmux_error' : 'tmux_timeout'), timeout);
      const collect = (data: Buffer, out: boolean) => {
        bytes += data.length;
        if (bytes > 4 * 1024 * 1024) { overflow = true; stop('tmux_error'); return; }
        if (out) stdout += outDecoder.write(data); else stderr += errDecoder.write(data);
      };
      child.stdout.on('data', b => collect(b, true)); child.stderr.on('data', b => collect(b, false));
      child.on('error', e => { clearTimeout(guard); reject(new DashboardFailure((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'tmux_not_found' : 'tmux_error')); });
      child.on('close', (code, signal) => {
        clearTimeout(guard);
        if (signal) reject(new DashboardFailure(overflow ? 'tmux_error' : 'tmux_timeout'));
        else resolve({ code: code ?? 1, stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end() });
      });
    });
  }
  async ok(args: string[], compound = false): Promise<string> { const r = await this.call(args, compound); if (r.code) throw new DashboardFailure('tmux_error'); return r.stdout; }
  /** Synchronous diagnostic only, retaining the adapter's argv/env/time bounds. */
  sync(args: string[]): TmuxResult {
    safeArgs(args); const r = spawnSync(this.bin, args, { shell: false, env: tmuxEnv(this.env), timeout: this.timeout(), killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (r.error) throw new DashboardFailure((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'tmux_timeout' : (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'tmux_not_found' : 'tmux_error');
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
}
