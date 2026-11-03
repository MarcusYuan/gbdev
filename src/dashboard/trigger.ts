import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDashboard } from '../core/dashboardConfig.js';
import type { GbdevPaths } from '../core/paths.js';
import { disabled, tmuxEnv } from './tmux.js';
import { dashboardLog, openDashboardLog } from './log.js';
import { unitKind } from './names.js';

/** Observable handles for teardown; supervisors never wait on these children. */
export const activeEnsures = new Set<ChildProcess>();
export type LaunchEnsure = (failed: (reason: string) => void) => void;
/** Leading-edge debounce only. No trailing timer and no periodic repair. */
export class DashboardTrigger {
  private last = -Infinity;
  private warned = false;
  private warningPending = false;
  constructor(private launch: LaunchEnsure, private warning: (reason: string) => unknown, private now = Date.now) {}
  fire(): void {
    const now = this.now(); if (now - this.last < 5000) return; this.last = now;
    let failureReported = false;
    const failed = (reason: string) => {
      // message/error/exit can report the same ensure failure. A failed warning
      // write is retried by the next ensure, not by that child's later events.
      if (failureReported || reason.startsWith('disabled_')) return;
      failureReported = true;
      if (this.warned || this.warningPending) return;
      this.warningPending = true;
      try {
        const result = this.warning(reason);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          void Promise.resolve(result).then(
            () => { this.warned = true; this.warningPending = false; },
            () => { this.warningPending = false; },
          );
        } else { this.warned = true; this.warningPending = false; }
      } catch { this.warningPending = false; /* Retry on the next failure, never block work. */ }
    };
    try { this.launch(failed); } catch { failed('tmux_error'); }
  }
}
const context = new AsyncLocalStorage<{ home: string; trigger: DashboardTrigger }>();
export function dashboardEvent(home: string, type: string, data: Record<string, unknown>): void {
  const scope = context.getStore();
  if (scope?.home === home && (['lane_assigned', 'lane_released', 'plan_ready', 'run_state_change', 'decision_required', 'step_started'].includes(type) || type === 'state_change' && data.state === 'running')) scope.trigger.fire();
}
export function launchEnsure(paths: GbdevPaths, id: string, failed: (reason: string) => void): void {
  let fd: number | undefined;
  try {
    unitKind(id);
    const config = loadDashboard(paths.config); if (disabled(config)) return;
    fd = openDashboardLog(paths.home); if (fd === undefined) { failed('tmux_error'); return; }
    const env: NodeJS.ProcessEnv = { ...tmuxEnv(), GBDEV_HOME: paths.home, GBDEV_CONFIG: paths.config };
    for (const name of ['GBDEV_DASHBOARD', 'GBDEV_TMUX_BIN', 'NODE_TEST_CONTEXT', 'NO_COLOR']) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), '__dashboard-ensure', '--target', id], {
      shell: false, detached: true, stdio: ['ignore', fd, fd, 'ipc'],
      env,
    });
    activeEnsures.add(child); child.once('close', () => activeEnsures.delete(child));
    child.on('message', message => {
      if (message && typeof message === 'object' && 'dashboard_reason' in message && typeof message.dashboard_reason === 'string') failed(message.dashboard_reason);
    });
    child.on('error', () => { dashboardLog(paths.home, 'tmux_error'); failed('tmux_error'); });
    child.on('exit', (code, signal) => { if (code || signal) failed('tmux_error'); });
    child.unref(); child.channel?.unref();
  } catch { dashboardLog(paths.home, 'tmux_error'); failed('tmux_error'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Nested job/pipeline supervisors share the top-level unit's debounce and warning. */
export function withDashboard<T>(paths: GbdevPaths, id: string, warning: (reason: string) => unknown, work: () => Promise<T>, testing: { launch?: LaunchEnsure; now?: () => number } = {}): Promise<T> {
  const parent = context.getStore();
  if (parent?.home === paths.home) { parent.trigger.fire(); return work(); }
  const trigger = new DashboardTrigger(testing.launch ?? (failed => launchEnsure(paths, id, failed)), warning, testing.now);
  return context.run({ home: paths.home, trigger }, () => { trigger.fire(); return work(); });
}
