import { closeSync, constants, fstatSync, lstatSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { safeText } from '../render/format.js';
/** Best effort, bounded and never follows a caller-supplied link. */
export function dashboardLog(home: string, message: string): void {
  const path = join(home, 'dashboard.log'); let fd: number | undefined;
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) return;
    if (stat && stat.size > 1024 * 1024) renameSync(path, path + '.1');
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const opened = fstatSync(fd); if (!opened.isFile() || opened.nlink !== 1) return;
    writeSync(fd, `${new Date().toISOString()} ${safeText(message).slice(0, 1000)}\n`);
  } catch { /* Observation must never affect work. */ } finally { if (fd !== undefined) closeSync(fd); }
}

/** Caller owns the returned descriptor; the child inherits only this log handle. */
export function openDashboardLog(home: string): number | undefined {
  const path = join(home, 'dashboard.log'); let fd: number | undefined;
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) return;
    if (stat && stat.size > 1024 * 1024) renameSync(path, path + '.1');
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const opened = fstatSync(fd);
    if (opened.isFile() && opened.nlink === 1) return fd;
  } catch { /* Best effort. */ }
  if (fd !== undefined) closeSync(fd);
  return;
}
