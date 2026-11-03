import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, lstatSync, readFileSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { changedFiles, git } from './git.js';

export const WORKSPACE_BEFORE = 'workspace-before.json';
export const WORKSPACE_AFTER_WORKER = 'workspace-after-worker.json';
export const WORKSPACE_AFTER_CHECKS = 'workspace-after-checks.json';

/** Explicit watched paths that may be gitignored. */
export const WATCHED_EXTRA_PATHS = ['.omc/notepad.md'] as const;

export interface IndexState {
  xy: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  index_blob: string | null;
}

/**
 * Cheap stat identity for a regular file whose content gbdev observes itself (dirty, untracked,
 * watched extra). Unhashed (content_unknown) files are compared by this identity instead of
 * failing the whole job: equal size+mtime+ctime+ino+dev => unchanged (the same assumption
 * `git status` makes with core.trustctime/checkStat=default; ctime cannot be set from userspace),
 * any difference => changed and attributed conservatively.
 */
export interface ContentStat {
  size: string;
  mtime_ns: string;
  ctime_ns: string;
  ino: string;
  dev: string;
  /** Timestamps fell inside the racy window at capture time: never proves "unchanged". */
  racy?: boolean;
}

export interface WorkspaceEntry {
  path: string;
  kind: 'file' | 'symlink' | 'other';
  content_hash: string | null;
  content_unknown?: boolean;
  /**
   * 'git_index': a tracked regular file that `git status` (stat-checked, fsmonitor off) reports
   * clean against its stage-0 index entry. content_hash is then sha256 of the index blob id,
   * not of the bytes, so its identity costs no hashing budget and is never unknown.
   */
  content_source?: 'git_index';
  content_stat?: ContentStat;
  mode: number;
  index_state: IndexState;
}

export interface WorkspaceSnapshot {
  version: 1;
  job_id: string;
  head_sha: string;
  captured_at: string;
  phase: 'before_worker' | 'after_worker' | 'after_checks';
  entries: WorkspaceEntry[];
  inherited_dirty_paths: string[];
  previous_job_id: string | null;
}

export interface WorkspaceIssue {
  code: string;
  path: string;
  owner_job_id: string | null;
  source_phase: 'worker' | 'check' | 'unknown';
  repairable: boolean;
}

function assertRepoRelative(worktree: string, rel: string): void {
  if (!rel || rel.includes('\\') || rel.startsWith('/') || rel.split('/').includes('..')) {
    throw new GbdevError('workspace_snapshot_invalid', 'Path escapes worktree', { path: rel });
  }
  // Lexical containment only — realpath would follow symlinks that may point outside.
  const root = resolve(worktree);
  const abs = resolve(worktree, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new GbdevError('workspace_snapshot_invalid', 'Path escapes worktree', { path: rel });
  }
}

// Bounds apply to both live observation and synchronous crash recovery.
/** Cap on entries gbdev must observe itself (dirty, untracked, watched extras, non-verifiable tracked). */
export const SNAPSHOT_MAX_FILES = 4096;
/** Cap on all entries; clean tracked files are identified by their git index blob id and cost no hashing. */
export const SNAPSHOT_MAX_ENTRIES = 65536;
export const SNAPSHOT_MAX_HASH_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_TOTAL_HASH_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
/**
 * Stat timestamps this close to capture time may hide a later same-size edit within the same
 * timestamp tick (git's "racily clean" problem). Whole-second timestamps mean a coarse filesystem.
 */
export const SNAPSHOT_RACY_WINDOW_MS = 1_000;
export const SNAPSHOT_RACY_WINDOW_COARSE_MS = 3_000;
function racyWindowNs(mtimeNs: bigint, ctimeNs: bigint): bigint {
  const coarse = mtimeNs % 1_000_000_000n === 0n && ctimeNs % 1_000_000_000n === 0n;
  return BigInt(coarse ? SNAPSHOT_RACY_WINDOW_COARSE_MS : SNAPSHOT_RACY_WINDOW_MS) * 1_000_000n;
}
/**
 * Status must stat-check every tracked file itself: no fsmonitor/untracked cache shortcuts, and
 * ctime/inode participate, so a same-size edit with a restored mtime is still reported dirty.
 */
const STATUS_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.trustctime=true',
  '-c', 'core.checkStat=default', 'status', '--porcelain=v1', '--no-renames', '-z', '--untracked-files=all'];
export interface SnapshotOptions {
  signal?: AbortSignal | undefined;
  deadlineAt?: number | undefined;
  cancelled?: (() => boolean) | undefined;
  /** Optional tighter hash budgets; production defaults remain the hard upper bounds. */
  maxHashBytes?: number;
  maxTotalHashBytes?: number;
  /** Observation hook, called after each hashed chunk (also permits deterministic race tests). */
  onHashChunk?: ((path: string, bytes: number) => void) | undefined;
  /**
   * Identify git-clean tracked files by index blob id (default true). B1 activity probes pass false
   * to keep comparing byte hashes only, so commits/index bookkeeping never look like content progress.
   */
  gitIndexIdentity?: boolean;
  /**
   * Re-stat unhashed files whose stat identity is racy once the racy window has passed (default
   * true, bounded by the deadline). Activity/fingerprint probes pass false: they never trust unknown content.
   */
  settleRacy?: boolean;
}
function hashLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0) invalid('Invalid workspace hash budget');
  return Math.min(value, maximum);
}
type SnapshotMeta = { job_id: string; phase: WorkspaceSnapshot['phase']; previous_job_id?: string | null };
function budget(options: SnapshotOptions): number {
  const remaining = (options.deadlineAt ?? Date.now() + 30_000) - Date.now();
  if (options.signal?.aborted || options.cancelled?.() || remaining <= 0) {
    throw new GbdevError('workspace_snapshot_invalid', 'Workspace observation cancelled or deadline exceeded');
  }
  return Math.max(1, Math.min(30_000, remaining));
}
/** Still a B3 fail-closed error, but B1 can recognize evidence of concurrent activity. */
export class WorkspaceObservationRaceError extends GbdevError {
  constructor(message: string) {
    super('workspace_snapshot_invalid', message);
    this.name = 'WorkspaceObservationRaceError';
  }
}

function invalid(message: string): never { throw new GbdevError('workspace_snapshot_invalid', message); }

type CaptureState = { bytes: number };
function captureState(options: SnapshotOptions): CaptureState {
  return { bytes: hashLimit(options.maxTotalHashBytes, SNAPSHOT_TOTAL_HASH_BYTES) };
}
function indexFileMode(index: IndexState): 'file' | 'symlink' | 'other' {
  const mode = index.index_blob?.split(' ')[0];
  return mode === '100644' || mode === '100755' ? 'file' : mode === '120000' ? 'symlink' : 'other';
}
function gitIndexHash(index: IndexState): string {
  return createHash('sha256').update('gbdev-git-index\0').update(index.index_blob ?? '').digest('hex');
}
/** Racy relative to when this stat was taken: only a write in the same timestamp tick can hide. */
function statIdentity(st: BigIntStats, statTakenNs: bigint): ContentStat {
  const stat: ContentStat = { size: String(st.size), mtime_ns: String(st.mtimeNs), ctime_ns: String(st.ctimeNs),
    ino: String(st.ino), dev: String(st.dev) };
  const window = racyWindowNs(st.mtimeNs, st.ctimeNs);
  if (st.mtimeNs > statTakenNs - window || st.ctimeNs > statTakenNs - window) stat.racy = true;
  return stat;
}

function entryForPath(worktree: string, rel: string, index: IndexState, gitClean: boolean, options: SnapshotOptions,
  remaining: CaptureState): WorkspaceEntry {
  budget(options);
  assertRepoRelative(worktree, rel);
  const abs = join(worktree, rel);
  // Do not traverse an intermediate symlink, even for an explicitly watched extra.
  for (let dir = dirname(abs); dir !== worktree; dir = dirname(dir)) {
    try { if (lstatSync(dir).isSymbolicLink()) invalid('Symlink ancestor in watched path'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let st: BigIntStats;
  try { st = lstatSync(abs, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path: rel, kind: 'other', content_hash: null, mode: 0, index_state: index };
  }
  const entry: WorkspaceEntry = { path: rel, kind: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other',
    content_hash: null, mode: Number(st.mode), index_state: index };
  if (st.isSymbolicLink()) entry.content_hash = createHash('sha256').update(readlinkSync(abs)).digest('hex');
  else if (st.isFile() && gitClean && indexFileMode(index) === 'file') {
    // git status (stat-checked above) proved the bytes equal the stage-0 index blob.
    entry.content_hash = gitIndexHash(index);
    entry.content_source = 'git_index';
  } else if (st.isFile()) {
    entry.content_stat = statIdentity(st, BigInt(Date.now()) * 1_000_000n);
    const maxHashBytes = hashLimit(options.maxHashBytes, SNAPSHOT_MAX_HASH_BYTES);
    const size = Number(st.size);
    if (size > maxHashBytes || size > remaining.bytes) {
      // Unknown is never considered unchanged, even if metadata coincides.
      entry.content_unknown = true;
    } else {
      const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        let total = 0;
        for (;;) {
          budget(options);
          const n = readSync(fd, buffer, 0, Math.min(buffer.length, maxHashBytes + 1 - total), null);
          if (!n) break;
          total += n;
          if (total > maxHashBytes || total > remaining.bytes) { entry.content_unknown = true; break; }
          hash.update(buffer.subarray(0, n));
          options.onHashChunk?.(rel, total);
        }
        const end = fstatSync(fd, { bigint: true });
        if (end.size !== st.size || end.mtimeNs !== st.mtimeNs || end.ctimeNs !== st.ctimeNs || end.ino !== st.ino) throw new WorkspaceObservationRaceError(`File changed during observation: ${rel}`);
        if (!entry.content_unknown) entry.content_hash = hash.digest('hex');
        remaining.bytes -= total;
      } finally { closeSync(fd); }
    }
  }
  return entry;
}

type Operation = { args: string[] } | { path: string; index: IndexState; gitClean: boolean };
/** One collection algorithm shared by async live jobs and synchronous recovery. */
function* collect(worktree: string, meta: SnapshotMeta, useGitIndex: boolean): Generator<Operation, WorkspaceSnapshot, string | WorkspaceEntry> {
  const root = realpathSync(worktree);
  const top = (yield { args: ['rev-parse', '--show-toplevel'] }) as string;
  if (realpathSync(top.trim()) !== root) invalid('Worktree root mismatch');
  const head = ((yield { args: ['rev-parse', 'HEAD'] }) as string).trim();
  // ls-files after status: status may refresh the index, and the blob ids must match what status verified.
  const status = (yield { args: STATUS_ARGS }) as string;
  const ls = (yield { args: ['ls-files', '-s', '-v', '-z'] }) as string;
  const index = new Map<string, IndexState>();
  const paths = new Set<string>();
  const dirty = new Set<string>();
  // Only 'H' (cached, stat-checked) stage-0 entries can be vouched for by git status. Lowercase tags
  // (assume-unchanged) and 'S' (skip-worktree) are never reported dirty, so their bytes are observed directly.
  const verifiable = new Set<string>();
  for (const line of ls.split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t'), path = line.slice(tab + 1), [tag, ...fields] = line.slice(0, tab).split(' ');
    paths.add(path);
    index.set(path, { xy: '  ', staged: false, unstaged: false, untracked: false, index_blob: fields.slice(0, 3).join(' ') });
    if (tag === 'H' && fields[2] === '0') verifiable.add(path); else verifiable.delete(path);
  }
  for (const line of status.split('\0').filter(Boolean)) {
    const xy = line.slice(0, 2), path = line.slice(3);
    paths.add(path); dirty.add(path);
    index.set(path, { xy, staged: xy[0] !== ' ' && xy[0] !== '?', unstaged: xy[1] !== ' ' && xy[1] !== '?',
      untracked: xy === '??', index_blob: index.get(path)?.index_blob ?? null });
  }
  for (const path of WATCHED_EXTRA_PATHS) {
    const parent = join(root, dirname(path));
    try { if (lstatSync(parent).isSymbolicLink()) invalid('Symlink ancestor in watched path'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // lstat includes dangling symlinks, without following their targets.
    try { lstatSync(join(root, path)); paths.add(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const gitClean = (path: string) => useGitIndex && verifiable.has(path) && !dirty.has(path);
  if (paths.size > SNAPSHOT_MAX_ENTRIES) invalid(`Workspace file count exceeds snapshot limit: ${paths.size} paths > ${SNAPSHOT_MAX_ENTRIES}`);
  const observed = [...paths].filter(path => !gitClean(path)).length;
  if (observed > SNAPSHOT_MAX_FILES) {
    invalid(`Workspace file count exceeds snapshot limit: ${observed} dirty/untracked paths to hash > ${SNAPSHOT_MAX_FILES}`);
  }
  const entries: WorkspaceEntry[] = [];
  for (const path of [...paths].sort()) {
    const idx = index.get(path) ?? { xy: '??', staged: false, unstaged: false, untracked: true, index_blob: null };
    if (idx.untracked) dirty.add(path);
    entries.push((yield { path, index: idx, gitClean: gitClean(path) }) as WorkspaceEntry);
  }
  // A path git vouched for at the start must still be clean at the end, or its index identity
  // would hide an edit made during capture (later misattributed to the job).
  if (entries.some(e => e.content_source === 'git_index')) {
    const endStatus = (yield { args: STATUS_ARGS }) as string;
    for (const line of endStatus.split('\0').filter(Boolean)) {
      const path = line.slice(3);
      if (gitClean(path)) throw new WorkspaceObservationRaceError(`File changed during observation: ${path}`);
    }
  }
  const endHead = ((yield { args: ['rev-parse', 'HEAD'] }) as string).trim();
  if (endHead !== head) throw new WorkspaceObservationRaceError('HEAD changed during workspace observation');
  return { version: 1, job_id: meta.job_id, head_sha: head, captured_at: new Date().toISOString(), phase: meta.phase,
    entries, inherited_dirty_paths: [...dirty].sort(), previous_job_id: meta.previous_job_id ?? null };
}

/**
 * Make racy stat identities of unhashed files decidable. A file stat-ed within the racy window could
 * still be rewritten within the same timestamp tick without a visible stat change. Once the window
 * has passed, any later write must produce a newer timestamp, so a re-stat taken then is a sound
 * identity for "the file as of now" (no worker runs during capture). Bounded rounds; anything still
 * racy stays marked and fails closed (naming the path) if a later comparison depends on it.
 */
function racyPlan(snapshot: WorkspaceSnapshot, options: SnapshotOptions): number {
  if (options.settleRacy === false) return 0;
  const delay = racyUnknownDelayMs(snapshot);
  if (delay <= 0 || delay > SNAPSHOT_RACY_WINDOW_COARSE_MS + 200) return 0;
  const remaining = (options.deadlineAt ?? Infinity) - Date.now();
  return remaining > delay + 1_000 ? delay : 0;
}
function settleRacyEntries(worktree: string, snapshot: WorkspaceSnapshot): void {
  const startedNs = BigInt(Date.now()) * 1_000_000n;
  for (const e of snapshot.entries) {
    if (!e.content_unknown || !e.content_stat?.racy) continue;
    let st: BigIntStats;
    try { st = lstatSync(join(worktree, e.path), { bigint: true }); } catch { continue; }
    if (!st.isFile() || Number(st.mode) !== e.mode) continue; // Changed kind/mode: leave racy (fail closed).
    e.content_stat = statIdentity(st, startedNs);
  }
}
const SETTLE_ROUNDS = 3;

export function captureWorkspaceSnapshotSync(worktree: string, meta: SnapshotMeta, options: SnapshotOptions = {}): WorkspaceSnapshot {
  const snapshot = captureUnsettledSync(worktree, meta, options);
  const bounded = { ...options, deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + 30_000) };
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const delay = racyPlan(snapshot, bounded);
    if (!delay || bounded.signal?.aborted || bounded.cancelled?.()) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    if (bounded.signal?.aborted || bounded.cancelled?.()) break; // Keep the (racy, fail-closed) capture.
    settleRacyEntries(realpathSync(worktree), snapshot);
  }
  return snapshot;
}
function captureUnsettledSync(worktree: string, meta: SnapshotMeta, options: SnapshotOptions): WorkspaceSnapshot {
  const bounded = { ...options, deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + 30_000) };
  const iterator = collect(worktree, meta, options.gitIndexIdentity ?? true), remaining = captureState(options);
  let step = iterator.next();
  while (!step.done) {
    const op = step.value, timeout = budget(bounded);
    step = iterator.next('args' in op ? git(worktree, op.args, timeout) : entryForPath(realpathSync(worktree), op.path, op.index, op.gitClean, bounded, remaining));
  }
  return step.value;
}
export async function captureWorkspaceSnapshot(worktree: string, meta: SnapshotMeta, options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
  const snapshot = await captureUnsettled(worktree, meta, options);
  const bounded = { ...options, deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + 30_000) };
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const delay = racyPlan(snapshot, bounded);
    if (!delay || bounded.signal?.aborted || bounded.cancelled?.()) break;
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, delay);
      const poll = setInterval(() => { if (bounded.cancelled?.()) done(); }, 100);
      function done() { clearTimeout(timer); clearInterval(poll); bounded.signal?.removeEventListener('abort', done); resolve(); }
      bounded.signal?.addEventListener('abort', done, { once: true });
    });
    if (bounded.signal?.aborted || bounded.cancelled?.()) break; // Keep the (racy, fail-closed) capture.
    settleRacyEntries(realpathSync(worktree), snapshot);
  }
  return snapshot;
}
async function captureUnsettled(worktree: string, meta: SnapshotMeta, options: SnapshotOptions): Promise<WorkspaceSnapshot> {
  const bounded = { ...options, deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + 30_000) };
  const iterator = collect(worktree, meta, options.gitIndexIdentity ?? true), remaining = captureState(options);
  const signal = options.signal ?? new AbortController().signal;
  let step = iterator.next();
  while (!step.done) {
    const op = step.value, timeout = budget(bounded);
    if ('args' in op) step = iterator.next(await git(worktree, op.args, timeout, signal));
    else {
      await new Promise<void>(resolve => setImmediate(resolve));
      step = iterator.next(entryForPath(realpathSync(worktree), op.path, op.index, op.gitClean, bounded, remaining));
    }
  }
  return step.value;
}

export function readWorkspaceSnapshot(file: string, expected?: { job_id: string; phase: WorkspaceSnapshot['phase'] }): WorkspaceSnapshot {
  let raw: unknown;
  try {
    if (lstatSync(file).size > SNAPSHOT_MAX_EVIDENCE_BYTES) invalid('Workspace snapshot exceeds evidence size limit');
    raw = JSON.parse(readFileSync(file, 'utf8'));
  }
  catch { throw new GbdevError('workspace_snapshot_invalid', 'Unreadable workspace snapshot'); }
  const v = raw as WorkspaceSnapshot;
  if (!v || v.version !== 1 || !Array.isArray(v.entries) || v.entries.length > SNAPSHOT_MAX_ENTRIES ||
      typeof v.job_id !== 'string' || !/^[a-f0-9]{40,64}$/.test(v.head_sha ?? '') ||
      !Number.isFinite(Date.parse(v.captured_at)) || !['before_worker', 'after_worker', 'after_checks'].includes(v.phase) ||
      !(v.previous_job_id === null || typeof v.previous_job_id === 'string') ||
      !Array.isArray(v.inherited_dirty_paths) || !v.inherited_dirty_paths.every(p => typeof p === 'string') ||
      (expected && (v.job_id !== expected.job_id || v.phase !== expected.phase))) invalid('Invalid workspace snapshot shape or identity');
  const seen = new Set<string>();
  for (const e of v.entries) {
    if (!e || typeof e.path !== 'string' || seen.has(e.path) || !['file', 'symlink', 'other'].includes(e.kind) ||
        !(e.content_hash === null || /^[a-f0-9]{64}$/.test(e.content_hash)) || !Number.isInteger(e.mode) || e.mode < 0 ||
        (e.content_unknown !== undefined && typeof e.content_unknown !== 'boolean') ||
        !e.index_state || typeof e.index_state.xy !== 'string' || e.index_state.xy.length !== 2 ||
        !['staged', 'unstaged', 'untracked'].every(k => typeof e.index_state[k as keyof IndexState] === 'boolean') ||
        !(e.index_state.index_blob === null || typeof e.index_state.index_blob === 'string') ||
        ((e.kind === 'file' || e.kind === 'symlink') && !e.content_hash && !e.content_unknown) ||
        !(e.content_source === undefined || (e.content_source === 'git_index' && e.kind === 'file' && !!e.content_hash && !e.content_unknown && e.content_stat === undefined)) ||
        !(e.content_stat === undefined || validStat(e.content_stat))) invalid('Invalid workspace entry');
    assertRepoRelative('/workspace', e.path);
    seen.add(e.path);
  }
  if (v.entries.filter(e => e.content_source !== 'git_index').length > SNAPSHOT_MAX_FILES) invalid('Invalid workspace snapshot shape or identity');
  if (v.inherited_dirty_paths.some(p => !seen.has(p))) invalid('Invalid inherited paths');
  return v;
}

function validStat(s: ContentStat): boolean {
  return !!s && typeof s === 'object' && ['size', 'mtime_ns', 'ctime_ns', 'ino', 'dev'].every(k => /^\d{1,30}$/.test(String(s[k as keyof ContentStat])) &&
    typeof s[k as keyof ContentStat] === 'string') && (s.racy === undefined || typeof s.racy === 'boolean');
}

export function snapshotEntryMap(snapshot: WorkspaceSnapshot): Map<string, WorkspaceEntry> {
  return new Map(snapshot.entries.map(e => [e.path, e]));
}

/** Null means unchanged content cannot be proven, so check results must not be cached (B2). */
export function workspaceGenerationFingerprint(snapshot: WorkspaceSnapshot): string | null {
  if (snapshot.entries.some(entry => entry.content_unknown)) return null;
  const hash = createHash('sha256');
  for (const entry of [...snapshot.entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.content_hash ?? '');
    hash.update('\0');
    hash.update(entry.content_unknown ? '1' : '0');
    hash.update('\0');
    hash.update(String(entry.mode));
    hash.update('\0');
    hash.update(entry.index_state.xy);
    hash.update('\0');
    hash.update(entry.index_state.staged ? '1' : '0');
    hash.update(entry.index_state.unstaged ? '1' : '0');
    hash.update(entry.index_state.untracked ? '1' : '0');
    hash.update('\0');
    hash.update(entry.index_state.index_blob ?? '');
    hash.update('\0');
  }
  for (const path of [...snapshot.inherited_dirty_paths].sort()) {
    hash.update('inh:');
    hash.update(path);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sameMetadata(before: WorkspaceEntry, after: WorkspaceEntry): boolean {
  return before.kind === after.kind && before.mode === after.mode
    && before.index_state.xy === after.index_state.xy && before.index_state.index_blob === after.index_state.index_blob;
}
/** Equal stat identity proves unchanged content only when the earlier capture was not racy. */
function statUnchanged(before: ContentStat | undefined, after: ContentStat | undefined): boolean {
  return !!before && !!after && !before.racy
    && before.size === after.size && before.mtime_ns === after.mtime_ns && before.ctime_ns === after.ctime_ns
    && before.ino === after.ino && before.dev === after.dev;
}
function entryChanged(before: WorkspaceEntry | undefined, after: WorkspaceEntry | undefined): boolean {
  if (!before !== !after) return true;
  if (!before || !after) return false;
  if (!sameMetadata(before, after)) return true;
  // Unhashed content: changed unless the stat identity proves otherwise (attributed conservatively).
  if (before.content_unknown || after.content_unknown) return !statUnchanged(before.content_stat, after.content_stat);
  return before.content_hash !== after.content_hash;
}
/**
 * Why a path's change cannot be decided either way (null when decidable): unhashed content with
 * otherwise identical metadata and either no stat identity on one side (evidence written before
 * stat identities existed) or an identical-but-racy stat identity. Different stats are decidable
 * (changed) and attributed conservatively.
 */
function undecidableReason(before: WorkspaceEntry | undefined, after: WorkspaceEntry | undefined): string | null {
  if (!before || !after || (!before.content_unknown && !after.content_unknown) || !sameMetadata(before, after)) return null;
  if (!before.content_stat || !after.content_stat) return 'not hashed (size/hash budget) and no stat identity to compare';
  if (before.content_stat.racy && statUnchanged({ ...before.content_stat, racy: false }, after.content_stat)) {
    return 'not hashed (size/hash budget) and modified within the racy window of the earlier capture';
  }
  return null;
}

/** Live evidence must carry a comparable identity for every unhashed file (B3 fail-closed). */
export function assertSnapshotDecidable(snapshot: WorkspaceSnapshot): void {
  for (const e of snapshot.entries) {
    if (e.content_unknown && !e.content_stat) {
      throw new GbdevError('workspace_snapshot_invalid',
        `Workspace content is unknown for ${e.path}: not hashed (size/hash budget) and no stat identity to compare`, { path: e.path });
    }
    if (e.content_unknown && e.content_stat?.racy) {
      throw new GbdevError('workspace_snapshot_invalid',
        `Workspace content is unknown for ${e.path}: not hashed (size/hash budget) and modified within the racy window of capture`, { path: e.path });
    }
  }
}

/**
 * Milliseconds until no unhashed file in the snapshot is racy any more (0 when none). Callers that
 * capture a baseline may wait this long once and recapture, so a just-written large file does not
 * become undecidable later.
 */
export function racyUnknownDelayMs(snapshot: WorkspaceSnapshot, nowMs = Date.now()): number {
  let until = 0n;
  for (const e of snapshot.entries) {
    const s = e.content_stat;
    if (!e.content_unknown || !s?.racy) continue;
    const m = BigInt(s.mtime_ns), c = BigInt(s.ctime_ns), latest = m > c ? m : c;
    const end = latest + racyWindowNs(m, c);
    if (end > until) until = end;
  }
  const delay = Number((until - BigInt(nowMs) * 1_000_000n) / 1_000_000n);
  return delay > 0 ? delay + 50 : 0;
}

/** Paths whose watched state differs between two snapshots. */
export function diffSnapshotPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const a = snapshotEntryMap(before);
  const b = snapshotEntryMap(after);
  const paths = new Set([...a.keys(), ...b.keys()]);
  const changed: string[] = [];
  for (const path of paths) {
    if (entryChanged(a.get(path), b.get(path))) changed.push(path);
  }
  return changed.sort();
}

export function baselineHasInheritedStaged(baseline: WorkspaceSnapshot): boolean {
  return baseline.entries.some(e => e.index_state.staged);
}

/** Job-attributed file deltas exclude inherited paths whose watched state is unchanged. */
export function jobFilesChanged(baseline: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const a = snapshotEntryMap(baseline), b = snapshotEntryMap(after);
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const reason = undecidableReason(a.get(path), b.get(path));
    if (reason) throw new GbdevError('workspace_snapshot_invalid', `Workspace content is unknown for ${path}: ${reason}`, { path });
  }
  const delta = diffSnapshotPaths(baseline, after);
  const unchangedInherited = new Set(unchangedInheritedPaths(baseline, after));
  return delta.filter(p => !unchangedInherited.has(p));
}

export function workerAttributedPaths(baseline: WorkspaceSnapshot, after: WorkspaceSnapshot, worktree: string): string[] {
  const delta = jobFilesChanged(baseline, after);
  const headDelta = after.head_sha !== baseline.head_sha ? changedFiles(worktree, baseline.head_sha) : [];
  return [...new Set([...delta, ...headDelta])].sort();
}

export function unchangedInheritedPaths(baseline: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const delta = new Set(diffSnapshotPaths(baseline, after));
  return baseline.inherited_dirty_paths.filter(p => !delta.has(p)).sort();
}

export function buildCheckPhaseIssues(
  jobId: string,
  afterWorker: WorkspaceSnapshot,
  afterChecks: WorkspaceSnapshot,
): WorkspaceIssue[] {
  const changed = diffSnapshotPaths(afterWorker, afterChecks);
  const issues: WorkspaceIssue[] = [];
  for (const path of changed) {
    issues.push({
      code: 'check_workspace_delta',
      path,
      owner_job_id: jobId,
      source_phase: 'check',
      repairable: true,
    });
  }
  return issues;
}

/** Classify unchanged inherited paths using prior job evidence when available (B4 hook surface). */
export function buildInheritedWorkspaceIssues(
  baseline: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  previous?: { workspace_issues?: WorkspaceIssue[]; check_files_changed?: string[]; job_id?: string } | null,
): WorkspaceIssue[] {
  const unchanged = unchangedInheritedPaths(baseline, after);
  const known = new Map<string, WorkspaceIssue>();
  for (const issue of previous?.workspace_issues ?? []) {
    if (issue.repairable) known.set(issue.path, issue);
  }
  for (const path of previous?.check_files_changed ?? []) {
    if (!known.has(path)) {
      known.set(path, {
        code: 'check_workspace_delta', path, owner_job_id: previous?.job_id ?? baseline.previous_job_id,
        source_phase: 'check', repairable: true,
      });
    }
  }
  return unchanged.map(path => {
    const prior = known.get(path);
    if (prior) {
      return {
        code: 'inherited_repairable',
        path,
        owner_job_id: prior.owner_job_id ?? previous?.job_id ?? baseline.previous_job_id,
        source_phase: prior.source_phase,
        repairable: true,
      };
    }
    return {
      code: 'inherited_workspace_unknown',
      path,
      owner_job_id: null,
      source_phase: 'unknown' as const,
      repairable: false,
    };
  });
}

/** @deprecated Prefer buildInheritedWorkspaceIssues; kept as thin wrappers for call-site clarity. */
export function buildUnknownInheritedIssues(baseline: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceIssue[] {
  return buildInheritedWorkspaceIssues(baseline, after, null).filter(i => !i.repairable);
}

export function buildRepairableInheritedIssues(
  baseline: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  previous?: { workspace_issues?: WorkspaceIssue[]; check_files_changed?: string[]; job_id?: string } | null,
): WorkspaceIssue[] {
  return buildInheritedWorkspaceIssues(baseline, after, previous).filter(i => i.repairable);
}

