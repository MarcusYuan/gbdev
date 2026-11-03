import { closeSync, constants, fstatSync, lstatSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { NOTICE_ID } from '../contracts/notify.js';
import { localIso } from '../core/time.js';
const classes = new Set(['enqueue_failed', 'launch_failed', 'config_invalid', 'key_name_missing', 'oversize', 'paused_auth_rejected', 'paused_endpoint_gone', 'paused_redirect_refused', 'network', 'timeout', 'tls', 'http_retryable', 'rejected', 'secret', 'secret_missing', 'secret_unsafe', 'secret_unsupported', 'url_invalid', 'sent', 'sent_coalesced', 'expired', 'clock_jump', 'storage_failed', 'corrupt_record', 'state_reset']);
/** Same policy as M4: current file + one .1 backup, rotate above 1 MiB. */
export function openNotifyLog(home: string): number | undefined {
  const path = join(home, 'notify', 'notify.log'); let fd: number | undefined;
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) return;
    if (stat && stat.size > 1024 * 1024) renameSync(path, path + '.1');
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const opened = fstatSync(fd); if (opened.isFile() && opened.nlink === 1) return fd;
  } catch { /* Never expose filesystem exceptions. */ }
  if (fd !== undefined) closeSync(fd);
  return;
}
/** Closed fields: callers cannot accidentally log a URL, response, or exception. */
export function deliveryLog(home: string, reason: string, notice_id?: string, seq?: number, status?: number | null): void {
  if (!classes.has(reason) || notice_id !== undefined && !NOTICE_ID.test(notice_id) || seq !== undefined && (!Number.isSafeInteger(seq) || seq < 1) || status !== undefined && status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) return;
  let fd: number | undefined;
  try { fd = openNotifyLog(home); if (fd !== undefined) writeSync(fd, `${localIso()} ${reason}${notice_id ? ` ${notice_id} ${seq}` : ''}${status ? ` ${status}` : ''}\n`); }
  catch { /* Additive only. */ } finally { if (fd !== undefined) closeSync(fd); }
}
