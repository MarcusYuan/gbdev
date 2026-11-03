import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDashboard, type DashboardConfig } from '../core/dashboardConfig.js';
import { acquireLock, type LockHandle } from '../core/lock.js';
import type { GbdevPaths } from '../core/paths.js';
import { ViewFiles, retentionMs } from '../render/views/common.js';
import { safeText, str } from '../render/format.js';
import { sanitizeForTerminal } from '../render/sanitize.js';
import { redactSecrets } from '../render/redact.js';
import { desired, type DesiredWindow } from './desired.js';
import { dashboardLog } from './log.js';
import { identity, key, parseKey, unitKind } from './names.js';
import { BORDER_FORMAT, CREATED_FORMAT, DashboardFailure, type DashboardReason, PANE_FORMAT, SMALL_BORDER_FORMAT, paneId, windowId } from './safeArgs.js';
import { Tmux, binary, disabled, paneArgs, reportedVersion, supportedVersion } from './tmux.js';
export interface DashboardPane { key: string; pane_id: string; dead: boolean }
export interface DashboardWindow { key: string; window_id: string; unit_id: string; unit_state: string; panes: DashboardPane[] }
export interface DashboardStatus {
  enabled: boolean; reason: DashboardReason | null; tmux_path: string | null; tmux_version: string | null;
  session: string | null; session_state: 'absent' | 'owned' | 'foreign'; windows: DashboardWindow[]; attach_hint: string | null;
  missing_panes?: { key: string; reason: string }[];
}
interface Context { paths: GbdevPaths; config: DashboardConfig; owner: string; tmux: Tmux; status: DashboardStatus }
const empty = (): DashboardStatus => ({ enabled: false, reason: null, tmux_path: null, tmux_version: null, session: null, session_state: 'absent', windows: [], attach_hint: null });
const failure = (s: DashboardStatus, error: unknown): DashboardStatus => ({ ...s, session_state: s.session_state === 'foreign' ? 'foreign' : 'absent', attach_hint: null, reason: error instanceof DashboardFailure ? error.reason : 'tmux_error' });
function prepare(paths: GbdevPaths, s: DashboardStatus, deadline: number): Context | undefined {
  const config = loadDashboard(paths.config), reason = disabled(config);
  if (reason) { s.reason = reason; return; }
  s.enabled = true;
  const name = identity(paths.home, config.session); s.session = name.session;
  // Preflight every dynamic pane ingredient before even querying tmux.
  paths = { ...paths, home: name.root };
  paneArgs(paths, config, 'index', 'index');
  const bin = binary(config); s.tmux_path = bin;
  return { paths, config, owner: name.h12, tmux: new Tmux(bin, process.env, deadline), status: s };
}
const versions = new Map<string, string>();
async function version(ctx: Context): Promise<void> {
  const cached = versions.get(ctx.tmux.bin);
  const raw = cached ?? await ctx.tmux.ok(['-V']);
  ctx.status.tmux_version = reportedVersion(raw);
  supportedVersion(raw); if (versions.size < 32) versions.set(ctx.tmux.bin, raw); ctx.status.enabled = true;
}
function absent(stderr: string): boolean { return /no server running|no sessions|can't find session|cannot find session|error connecting.*(?:No such file|Connection refused)/i.test(stderr); }
async function ownership(ctx: Context): Promise<'absent' | 'owned' | 'foreign'> {
  const target = `=${ctx.status.session}`, has = await ctx.tmux.call(['has-session', '-t', target]);
  if (has.code) { if (absent(has.stderr)) return ctx.status.session_state = 'absent'; throw new DashboardFailure('tmux_error'); }
  // Options use target-pane syntax, not has-session's target-session syntax.
  const owner = await ctx.tmux.call(['show-options', '-v', '-t', `${target}:`, '@gbdev_owner']);
  if (owner.code || owner.stdout.trim() !== ctx.owner) { ctx.status.session_state = 'foreign'; throw new DashboardFailure('foreign_session'); }
  return ctx.status.session_state = 'owned';
}
async function inventory(ctx: Context): Promise<DashboardWindow[]> {
  // Always recheck owner before listing or acting on a snapshot.
  if (await ownership(ctx) !== 'owned') throw new DashboardFailure('tmux_error');
  const out = await ctx.tmux.ok(['list-panes', '-s', '-t', `=${ctx.status.session}`, '-F', PANE_FORMAT]);
  const windows = new Map<string, DashboardWindow>(), files = new ViewFiles(ctx.paths.home);
  for (const row of out.trimEnd().split('\n')) {
    if (!row) continue;
    const [wid, pid, value, dead, extra] = row.split('\t');
    if (!wid || !pid || value === undefined || !/^[01]$/.test(dead ?? '') || extra !== undefined) throw new DashboardFailure('tmux_error');
    windowId(wid); paneId(pid);
    const parsed = parseKey(value);
    if (!parsed) continue; // Unmarked/user panes are never actionable.
    const w = windows.get(wid) ?? { key: key(parsed.unit_id), window_id: wid, unit_id: parsed.unit_id, unit_state: '', panes: [] };
    if (w.unit_id !== parsed.unit_id) throw new DashboardFailure('tmux_error');
    w.panes.push({ key: value, pane_id: pid, dead: dead === '1' }); windows.set(wid, w);
  }
  for (const w of windows.values()) {
    const kind = unitKind(w.unit_id), dir = kind === 'run' ? 'runs' : kind === 'pipeline' ? 'pipelines' : 'jobs';
    w.unit_state = safeText(str(files.json(`${dir}/${w.unit_id}/${kind === 'pipeline' ? 'pipeline' : kind}.json`)?.state)).slice(0, 80) || 'unknown';
  }
  ctx.status.windows = [...windows.values()]; ctx.status.attach_hint = `tmux attach -t ${ctx.status.session}`;
  return ctx.status.windows;
}
async function lock(ctx: Context): Promise<LockHandle> {
  const path = join(ctx.paths.home, 'dashboard.lock'), until = Math.min(Date.now() + 2000, ctx.tmux.deadline);
  do {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new DashboardFailure('lock_busy');
    try { return acquireLock(path); } catch (e) { if (!(e instanceof Error && 'contract' in e)) throw e; }
    await delay(Math.min(50, Math.max(1, until - Date.now())));
  } while (Date.now() < until);
  throw new DashboardFailure('lock_busy');
}
async function options(ctx: Context, wid: string): Promise<void> {
  for (const [name, value] of [['remain-on-exit', 'off'], ['pane-border-status', 'top'], ['pane-border-format', BORDER_FORMAT], ['allow-rename', 'off'], ['automatic-rename', 'off'], ['allow-passthrough', 'off']]) {
    await ctx.tmux.ok(['set-option', '-w', '-t', windowId(wid), name!, value!]);
  }
}
async function mark(ctx: Context, pid: string, value: string): Promise<void> {
  await ctx.tmux.ok(['set-option', '-p', '-t', paneId(pid), '@gbdev_key', value]);
  await ctx.tmux.ok(['select-pane', '-t', pid, '-T', value]);
}
async function createSession(ctx: Context): Promise<void> {
  const target = `=${ctx.status.session}:`;
  const result = await ctx.tmux.call(['new-session', '-d', '-s', ctx.status.session!, '-x', '220', '-y', '60', '-n', 'index', '-P', '-F', CREATED_FORMAT, '--', ...paneArgs(ctx.paths, ctx.config, 'index', 'index'), ';', 'set-option', '-t', target, '@gbdev_owner', ctx.owner, ';', 'set-option', '-t', target, 'destroy-unattached', 'off'], true);
  if (result.code && /duplicate session/.test(result.stderr) && !result.stdout.trim()) {
    // No creation receipt: this session is not ours to initialize or roll back.
    if (await ownership(ctx) !== 'owned') throw new DashboardFailure('tmux_error');
    return;
  }
  const receipt = /^(@\d+)\t(%\d+)\n?$/.exec(result.stdout);
  try {
    if (result.code || result.stderr.trim() || !receipt) throw new DashboardFailure('tmux_error');
    // A command queue is not a transaction. Verify both session options before
    // exposing OWNED; a successful new-session alone is not bootstrap success.
    for (const [name, expected] of [['@gbdev_owner', ctx.owner], ['destroy-unattached', 'off']]) {
      const value = await ctx.tmux.ok(['show-options', '-v', '-t', target, name!]);
      if (value.trim() !== expected) throw new DashboardFailure('tmux_error');
    }
    if (await ownership(ctx) !== 'owned') throw new DashboardFailure('tmux_error');
    const wid = windowId(receipt[1]!), pid = paneId(receipt[2]!);
    // Index is the required session bootstrap, not S4's retention/eviction policy.
    await ctx.tmux.ok(['set-option', '-w', '-t', wid, '@gbdev_key', 'index']); await mark(ctx, pid, 'index'); await options(ctx, wid);
  } catch (error) {
    if (receipt) await rollbackBootstrap(ctx, receipt[1]!, receipt[2]!);
    throw error;
  }
}
/** Roll back only the window proven created by this invocation, never a name. */
async function rollbackBootstrap(ctx: Context, wid: string, pid: string): Promise<void> {
  try {
    const owner = await ctx.tmux.call(['show-options', '-v', '-t', `=${ctx.status.session}:`, '@gbdev_owner']);
    if (owner.code && !/invalid option/.test(owner.stderr)) return;
    if (!owner.code && owner.stdout.trim() && owner.stdout.trim() !== ctx.owner) return;
    const rows = await ctx.tmux.ok(['list-panes', '-s', '-t', `=${ctx.status.session}`, '-F', PANE_FORMAT]);
    if (!rows.split('\n').some(row => row.startsWith(`${wid}\t${pid}\t`))) return;
    // Last-window removal also removes the newly created session. If somebody
    // added another window meanwhile, it is deliberately left untouched.
    await ctx.tmux.ok(['kill-window', '-t', windowId(wid)]);
  } catch {
    // Keep the original failure and the same total budget (SPEC T13).
    dashboardLog(ctx.paths.home, 'tmux_error bootstrap rollback unavailable');
  }
}
async function ensureWindow(ctx: Context, want: DesiredWindow, now: number): Promise<void> {
  let windows = await inventory(ctx), existing = windows.filter(w => w.unit_id === want.id);
  if (existing.length > 1) throw new DashboardFailure('tmux_error');
  let wid = existing[0]?.window_id, changed = false;
  if (!wid) {
    const primary = want.panes[0]!;
    const out = await ctx.tmux.ok(['new-window', '-d', '-t', `=${ctx.status.session}:`, '-n', want.id, '-P', '-F', CREATED_FORMAT, '--', ...paneArgs(ctx.paths, ctx.config, primary.kind, want.id)]);
    const [window, pid] = out.trim().split('\t'); wid = windowId(window ?? ''); paneId(pid ?? '');
    // A historical reopen owns a fresh retention interval, persisted in tmux only.
    if (want.finishedAt !== undefined && now - want.finishedAt >= retentionMs(ctx.config.retain_finished_min)) {
      await ctx.tmux.ok(['set-option', '-w', '-t', wid, '@gbdev_reopened_at', String(now)]);
    }
    await ctx.tmux.ok(['set-option', '-w', '-t', wid, '@gbdev_key', want.key]); await mark(ctx, pid!, primary.key); await options(ctx, wid); changed = true;
  }
  for (const pane of want.panes) {
    windows = await inventory(ctx); const current = windows.find(w => w.window_id === wid);
    if (!current) throw new DashboardFailure('tmux_error');
    const present = current.panes.find(p => p.key === pane.key);
    if (present && !present.dead) continue;
    // A dead marked pane may be replaced in place; never restart a worker.
    if (present) {
      await ctx.tmux.ok(['respawn-pane', '-k', '-t', present.pane_id, '--', ...paneArgs(ctx.paths, ctx.config, pane.kind, want.id, pane.lane)]); changed = true; continue;
    }
    const anchor = current.panes.find(p => !p.dead)?.pane_id;
    if (!anchor) throw new DashboardFailure('tmux_error');
    const args = ['split-window', '-d', '-t', anchor, '-P', '-F', '#{pane_id}', '--', ...paneArgs(ctx.paths, ctx.config, pane.kind, want.id, pane.lane)];
    let split = await ctx.tmux.call(args);
    if (split.code && /no space for new pane/.test(split.stderr)) {
      await ctx.tmux.ok(['select-layout', '-t', wid, 'tiled']);
      // Refresh both ownership and anchor membership before the retry.
      const refreshed = await inventory(ctx);
      if (!refreshed.some(w => w.window_id === wid && w.panes.some(p => p.pane_id === anchor))) throw new DashboardFailure('tmux_error');
      split = await ctx.tmux.call(args);
    }
    if (split.code) {
      if (!/no space for new pane/.test(split.stderr)) throw new DashboardFailure('tmux_error');
      (ctx.status.missing_panes ??= []).push({ key: pane.key, reason: 'no pane: window too small' });
      const status = current.panes.find(p => p.key === key(want.id, 'status'));
      if (status) await ctx.tmux.ok(['set-option', '-w', '-t', wid, 'pane-border-format', SMALL_BORDER_FORMAT]);
      continue;
    }
    await mark(ctx, paneId(split.stdout.trim()), pane.key); changed = true;
  }
  if (changed) {
    if (want.panes.length - 1 <= 3) await ctx.tmux.ok(['set-option', '-w', '-t', wid, 'main-pane-height', '35%']);
    await ctx.tmux.ok(['select-layout', '-t', wid, want.panes.length - 1 <= 3 ? 'main-horizontal' : 'tiled']);
  }
  if (!ctx.status.missing_panes?.some(p => p.key.startsWith(want.key + ':'))) {
    const status = (await inventory(ctx)).find(w => w.window_id === wid)?.panes.find(p => p.key === key(want.id, 'status'));
    if (status && changed) await ctx.tmux.ok(['set-option', '-w', '-t', wid, 'pane-border-format', BORDER_FORMAT]);
  }
}
/** Active windows are never removed, even when they alone exceed the cap. */
export function selectWindows(windows: DesiredWindow[], max: number): DesiredWindow[] {
  const active = windows.filter(w => w.finishedAt === undefined);
  const retained = windows.filter(w => w.finishedAt !== undefined).sort((a, b) => b.finishedAt! - a.finishedAt! || b.id.localeCompare(a.id));
  return [...active, ...retained.slice(0, Math.max(0, max - active.length))];
}
async function ensureIndex(ctx: Context): Promise<void> {
  if (await ownership(ctx) !== 'owned') throw new DashboardFailure('tmux_error');
  const rows = (await ctx.tmux.ok(['list-panes', '-s', '-t', `=${ctx.status.session}`, '-F', PANE_FORMAT])).trimEnd().split('\n');
  const marked = rows.map(r => r.split('\t')).filter(r => r[2] === 'index');
  if (marked.length) {
    for (const row of marked) if (row[3] === '1') await ctx.tmux.ok(['respawn-pane', '-k', '-t', paneId(row[1]!), '--', ...paneArgs(ctx.paths, ctx.config, 'index', 'index')]);
    return;
  }
  const out = await ctx.tmux.ok(['new-window', '-d', '-t', `=${ctx.status.session}:`, '-n', 'index', '-P', '-F', CREATED_FORMAT, '--', ...paneArgs(ctx.paths, ctx.config, 'index', 'index')]);
  const [wid, pid] = out.trim().split('\t'); windowId(wid!); paneId(pid!);
  await ctx.tmux.ok(['set-option', '-w', '-t', wid!, '@gbdev_key', 'index']); await mark(ctx, pid!, 'index'); await options(ctx, wid!);
}
async function evict(ctx: Context, now: number, selected: Set<string>): Promise<void> {
  let windows = await inventory(ctx);
  const ended: { window: DashboardWindow; end: number }[] = [];
  for (const w of windows) {
    if (selected.has(w.unit_id)) continue;
    const unit = desired(ctx.paths.home, w.unit_id, ctx.config, now).windows[0];
    // Missing/corrupt metadata is not evidence that a unit has finished.
    if (unit?.finishedAt === undefined || !Number.isFinite(unit.finishedAt)) continue;
    const option = await ctx.tmux.call(['show-options', '-w', '-v', '-t', w.window_id, '@gbdev_reopened_at']);
    const reopened = /^\d+$/.test(option.stdout.trim()) ? Number(option.stdout.trim()) : NaN;
    const end = !option.code && Number.isSafeInteger(reopened) ? Math.max(unit.finishedAt, reopened) : unit.finishedAt;
    // §7.2 takes precedence over the cap for explicitly reopened history.
    if (end !== unit.finishedAt && now - end < retentionMs(ctx.config.retain_finished_min)) continue;
    ended.push({ window: w, end });
  }
  ended.sort((a, b) => a.end - b.end || a.window.unit_id.localeCompare(b.window.unit_id));
  // Retention belongs to pane lifecycles, including explicitly reopened old units.
  for (const { window } of ended) {
    if (windows.length <= ctx.config.max_windows) break;
    windows = await inventory(ctx);
    if (!windows.some(w => w.window_id === window.window_id && w.unit_id === window.unit_id)) continue;
    const fresh = desired(ctx.paths.home, window.unit_id, ctx.config, now).windows[0];
    if (fresh?.finishedAt === undefined || !Number.isFinite(fresh.finishedAt)) continue;
    await ctx.tmux.ok(['kill-window', '-t', window.window_id]);
    windows = windows.filter(w => w.window_id !== window.window_id);
  }
}
export async function dashboardStatus(paths: GbdevPaths, budgetMs = 10000): Promise<DashboardStatus> {
  const s = empty();
  try { const ctx = prepare(paths, s, Date.now() + budgetMs); if (!ctx) return s; await version(ctx); if (await ownership(ctx) === 'owned') await inventory(ctx); return s; }
  catch (e) { return failure(s, e); }
}
export async function ensureDashboard(paths: GbdevPaths, target?: string, now = Date.now()): Promise<DashboardStatus> {
  const s = empty(); let held: LockHandle | undefined, ctx: Context | undefined;
  try {
    if (target) unitKind(target);
    ctx = prepare(paths, s, Date.now() + 10000); if (!ctx) return s;
    const want = desired(ctx.paths.home, target, ctx.config, now);
    // Validate full desired argv before any tmux invocation.
    for (const w of want.windows) for (const p of w.panes) paneArgs(ctx.paths, ctx.config, p.kind, w.id, p.lane);
    await version(ctx); mkdirSync(ctx.paths.home, { recursive: true });
    for (const warning of want.warnings) dashboardLog(ctx.paths.home, warning);
    held = await lock(ctx);
    if (await ownership(ctx) === 'absent') await createSession(ctx);
    await ensureIndex(ctx);
    const selected = selectWindows(want.windows, ctx.config.max_windows);
    for (const w of selected) await ensureWindow(ctx, w, now);
    await evict(ctx, now, new Set(selected.map(w => w.id)));
    await inventory(ctx); return s;
  } catch (e) { const result = failure(s, e); dashboardLog(ctx?.paths.home ?? paths.home, result.reason!); return result; }
  finally { held?.release(); }
}
export async function captureDashboard(paths: GbdevPaths, id: string, pane: string, lines: number): Promise<{ status: DashboardStatus; text: string }> {
  const s = empty();
  try {
    const ctx = prepare(paths, s, Date.now() + 10000); if (!ctx) return { status: s, text: '' }; await version(ctx);
    const windows = await inventory(ctx), p = windows.find(w => w.unit_id === id)?.panes.find(p => p.key === key(id, pane) && !p.dead);
    if (!p) throw new DashboardFailure('tmux_error');
    const output = await ctx.tmux.ok(['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', p.pane_id]);
    // Preserve row breaks while stripping whole multiline control strings and keys.
    const clean = sanitizeForTerminal(output.replace(/\n/g, '\uffff')).replace(/\uffff/g, '\n');
    return { status: s, text: redactSecrets(clean) };
  } catch (e) { return { status: failure(s, e), text: '' }; }
}
export async function closeDashboard(paths: GbdevPaths, id?: string): Promise<DashboardStatus> {
  const s = empty(); let held: LockHandle | undefined;
  try {
    const ctx = prepare(paths, s, Date.now() + 10000); if (!ctx) return s; await version(ctx); held = await lock(ctx);
    const windows = await inventory(ctx);
    if (id) { const w = windows.find(w => w.unit_id === id); if (!w) throw new DashboardFailure('tmux_error'); await ctx.tmux.ok(['kill-window', '-t', w.window_id]); }
    else await ctx.tmux.ok(['kill-session', '-t', `=${s.session}`]);
    if (await ownership(ctx) === 'owned') await inventory(ctx); else { s.windows = []; s.attach_hint = null; }
    return s;
  } catch (e) { return failure(s, e); } finally { held?.release(); }
}
/** doctor remains synchronous for M1/M3 callers; all probes are read-only. */
export function dashboardDiagnostic(paths: GbdevPaths, probe?: { code: number; stdout: string; timedOut: boolean }): DashboardStatus {
  const s = empty();
  try {
    const ctx = prepare(paths, s, Date.now() + 10000); if (!ctx) return s;
    if (probe?.timedOut) throw new DashboardFailure('tmux_timeout');
    const v = probe ?? ctx.tmux.sync(['-V']); if (v.code) throw new DashboardFailure('tmux_error'); s.tmux_version = reportedVersion(v.stdout); supportedVersion(v.stdout); s.enabled = true;
    const has = ctx.tmux.sync(['has-session', '-t', `=${s.session}`]);
    if (has.code) { if (!absent(has.stderr)) throw new DashboardFailure('tmux_error'); return s; }
    const owner = ctx.tmux.sync(['show-options', '-v', '-t', `=${s.session}:`, '@gbdev_owner']);
    if (owner.code || owner.stdout.trim() !== ctx.owner) { s.session_state = 'foreign'; throw new DashboardFailure('foreign_session'); }
    s.session_state = 'owned'; s.attach_hint = `tmux attach -t ${s.session}`; return s;
  } catch (e) { return failure(s, e); }
}
