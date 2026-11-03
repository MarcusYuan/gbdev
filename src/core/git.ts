import { registerRunProcess } from './processRegistry.js';
import { groupAlive, terminateGroup, signalGroup } from './proc.js';
import { resolvePaths, type GbdevPaths } from './paths.js';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, basename, resolve, sep } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { validateBranchName, validateIdentifier, RUN_ID_PATTERN } from './ids.js';

export function git(repo: string, args: string[], timeout?: number): string;
export function git(repo: string, args: string[], timeout: number, signal: AbortSignal): Promise<string>;
export function git(repo: string, args: string[], timeout = 120_000, signal?: AbortSignal): string | Promise<string> {
  if (signal) return asynchronousGit(repo, args, timeout, signal);
  // All gbdev Git calls share this override, including implicit index refreshes
  // as well as add/commit, worktree creation/removal, and ref deletion.
  try {
    return execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], {
      encoding: 'utf8', timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new GbdevError('internal_error', 'Git command timed out (SIGKILL); index.lock/HEAD.lock may remain; inspect them before retrying (gbdev does not remove locks)', { git_timeout: true, timeout_ms: timeout });
    }
    throw error;
  }
}

/** Cancellable long Git commands retain the same argv, hook and timeout policy. */
async function asynchronousGit(repo: string, args: string[], timeout: number, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('git_cancelled');
  const child = spawn('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const unregister = registerRunProcess(child.pid, 'git', repo);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0, timedOut = false, overflow = false, stopping: Promise<void> | undefined;
  const stop = () => { if (child.pid) { stopping ??= terminateGroup(child.pid); void stopping.catch(() => {}); } };
  const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) { overflow = true; try { if (child.pid) signalGroup(child.pid, 'SIGKILL'); } catch { /* Best effort; awaiting caller reports timeout/overflow. */ } }
    else chunks.push(chunk);
  };
  child.stdout!.on('data', collect(stdout)); child.stderr!.on('data', collect(stderr));
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(() => { timedOut = true; try { if (child.pid) signalGroup(child.pid, 'SIGKILL'); } catch { /* Best effort; awaiting caller reports timeout/overflow. */ } }, timeout);
  try {
    const code = await exited; await stopping;
    if (timedOut) throw new GbdevError('internal_error', 'Git command timed out (SIGKILL); inspect index.lock/HEAD.lock before retrying', { git_timeout: true, timeout_ms: timeout });
    if (signal.aborted) throw new Error('git_cancelled');
    if (overflow) throw new GbdevError('internal_error', 'Git output exceeds 32 MiB');
    if (code !== 0) throw Object.assign(new Error(Buffer.concat(stderr).toString('utf8') || `git exit ${code}`), { status: code, stdout: Buffer.concat(stdout).toString('utf8') });
    return Buffer.concat(stdout).toString('utf8');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); if (!child.pid || !groupAlive(child.pid)) unregister(); }
}

export function resolveBase(repo: string, ref: string): string {
  validateIdentifier(ref, 'base_ref');
  try { git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']); }
  catch (error) {
    if (error instanceof GbdevError) throw error;
    if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
    throw new GbdevError('repo_no_commits', 'Repository has no HEAD commit', { repo });
  }
  try { return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim(); }
  catch (error) {
    if (error instanceof GbdevError) throw error;
    if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
    throw new GbdevError('worktree_failed', 'Cannot resolve base_ref to a commit', { base_ref: ref });
  }
}

export function addWorktree(repo: string, branch: string, worktree: string, baseSha: string): void {
  validateBranchName(branch);
  mkdirSync(dirname(worktree), { recursive: true });
  try { git(repo, ['worktree', 'add', '-b', branch, worktree, baseSha], 300_000); }
  catch (error) {
    if (error instanceof GbdevError) throw error;
    throw new GbdevError('worktree_failed', 'git worktree add failed', {
      branch, worktree, detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function head(repo: string): string { return git(repo, ['rev-parse', 'HEAD']).trim(); }
export function isDirty(repo: string): boolean { return git(repo, ['status', '--porcelain=v1', '-z']).length > 0; }
export function changedFiles(repo: string, baseSha: string): string[] {
  return git(repo, ['diff', '--name-only', '--no-renames', '-z', baseSha, 'HEAD', '--']).split('\0').filter(Boolean);
}
/** Include paths touched by any intervening commit, even if later deleted again. */
export function committedPaths(repo: string, baseSha: string, headSha = 'HEAD'): string[] {
  return [...new Set(git(repo, ['log', '--format=', '--name-only', '--no-renames', '--diff-filter=ACMRT', '-m', '-z', `${baseSha}..${headSha}`, '--'])
    .split('\0').map(path => path.replace(/^\n+/, '')).filter(Boolean))];
}
export function dirtyFiles(repo: string): string[] {
  return [...new Set([
    ...git(repo, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']).split('\0'),
    ...git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
}

export interface MergeTreeResult { clean: boolean; conflict_files: string[]; tree: string | null }
interface GitFailure { status?: number; stdout?: string | Buffer }
export function mergeTreeCheck(repo: string, ours: string, theirs: string, timeout = 120_000): MergeTreeResult {
  validateIdentifier(ours, 'ours'); validateIdentifier(theirs, 'theirs');
  for (let attempt = 0; ; attempt++) {
    try {
      const output = git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs], timeout);
      return { clean: true, conflict_files: [], tree: output.split('\0')[0]!.trim() };
    } catch (e) {
      const error = e as GitFailure;
      if (error.status === 1) {
        const [tree, ...files] = String(error.stdout ?? '').split('\0');
        if (!tree || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw new GbdevError('internal_error', 'Invalid merge-tree conflict output');
        return { clean: false, conflict_files: [...new Set(files.filter(Boolean))], tree: null };
      }
      if (e instanceof GbdevError || attempt >= 1) throw e;
    }
  }
}
const MERGE_IDENTITY = ['-c', 'user.name=gbdev', '-c', 'user.email=gbdev@localhost', '-c', 'commit.gpgsign=false'];
export function mergeNoFf(context: GitGuardContext, sha: string, message: string, timeout = 120_000): string {
  validateIdentifier(sha, 'merge sha');
  gitGuarded(context, { operation: 'mergeNoFf', sha, message }, timeout);
  return head(context.worktree);
}
export function mergeNoCommit(context: GitGuardContext, sha: string, timeout = 120_000): { clean: boolean; conflict_files: string[] } {
  validateIdentifier(sha, 'merge sha');
  const worktree = context.worktree;
  try { gitGuarded(context, { operation: 'mergeNoCommit', sha }, timeout); return { clean: true, conflict_files: [] }; }
  catch (e) { if ((e as GitFailure).status !== 1) throw e; const files = git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'], timeout).split('\0').filter(Boolean); if (!files.length) throw e; return { clean: false, conflict_files: files }; }
}
export function isAncestor(repo: string, ancestor: string, descendant: string, timeout = 120_000): boolean {
  validateIdentifier(ancestor, 'ancestor'); validateIdentifier(descendant, 'descendant');
  try { git(repo, ['merge-base', '--is-ancestor', ancestor, descendant], timeout); return true; }
  catch (e) { if ((e as GitFailure).status === 1) return false; throw e; }
}
export interface WorktreeEntry { worktree: string; head: string; branch: string | null; detached: boolean; bare: boolean; locked?: string; prunable?: string }
export function worktreeListPorcelain(repo: string, timeout = 120_000): WorktreeEntry[] {
  const output = git(repo, ['worktree', 'list', '--porcelain', '-z'], timeout), entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of output.split('\0')) {
    const index = field.indexOf(' '), key = index < 0 ? field : field.slice(0, index), value = index < 0 ? '' : field.slice(index + 1);
    if (key === 'worktree') { current = { worktree: value, head: '', branch: null, detached: false, bare: false }; entries.push(current); }
    else if (current) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value;
      else if (key === 'detached' || key === 'bare') current[key] = true;
      else if (key === 'locked' || key === 'prunable') current[key] = value;
    }
  }
  return entries;
}

/** No raw argv escape hatch: destructive operations are a closed, typed set. */
export interface GitGuardContext {
  run_id: string; repo: string; branch: string; worktree: string; paths?: GbdevPaths;
  /** Only parked lanes may be detached, and their HEAD must match this recorded SHA. */
  detached_sha?: string;
  /** Cleanup-only CAS deletion after the worktree has been removed. */
  cleanup_ref_only?: true;
}
export type GuardedOperation = { operation: 'resetHard' | 'switchDetach' | 'mergeNoCommit'; sha: string }
  | { operation: 'mergeNoFf'; sha: string; message: string }
  | { operation: 'switchCreate'; branch: string; sha: string }
  | { operation: 'switchExisting'; branch: string }
  | { operation: 'clean' | 'mergeAbort' }
  | { operation: 'snapshot'; message: string }
  | { operation: 'updateRefCas'; expected: string; sha: string | null };
export const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function runBranch(runId: string, branch: string): boolean {
  return RUN_ID_PATTERN.test(runId) && new RegExp(`^gbdev/${runId}/(integration|t/[a-z][a-z0-9-]{0,23}(-r[2-9][0-9]*|-r1[0-9]+)?)$`).test(branch);
}
/** Ownership failures are guard violations; command execution is deliberately outside this catch. */
export function assertRunWorktree(context: GitGuardContext, checkBranch = true, timeout = 120_000): void {
  const { run_id, branch, worktree } = context, paths = context.paths ?? resolvePaths();
  const fail = (reason: string): never => { throw new GbdevError('guard_violation', reason, { run_id, branch, worktree }); };
  if (!runBranch(run_id, branch)) fail('Branch outside run namespace');
  try {
    const expectedRoot = realpathSync(resolve(paths.worktrees, basename(resolve(context.repo)), run_id));
    const canonicalWorktrees = realpathSync(paths.worktrees);
    if (expectedRoot !== resolve(canonicalWorktrees, basename(resolve(context.repo)), run_id)) fail('Run directory symlink escapes worktrees root');
    const target = realpathSync(worktree);
    if (!target.startsWith(expectedRoot + sep) || !/^(integration|lane-[1-4])$/.test(target.slice(expectedRoot.length + 1))) fail('Worktree outside run integration/lanes');
    if (realpathSync(context.repo) === target) fail('Main repository is not a run worktree');
    if (realpathSync(git(target, ['rev-parse', '--show-toplevel'], timeout).trim()) !== target) fail('Target must be the worktree root');
    const common = (cwd: string) => realpathSync(resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'], timeout).trim()));
    if (common(target) !== common(context.repo)) fail('Worktree belongs to another repository');
    if (checkBranch) {
      // --no-recurse prevents a symbolic branch alias from hiding an outside target.
      const current = git(target, ['rev-parse', '--symbolic-full-name', 'HEAD'], timeout).trim();
      if (context.detached_sha && current !== 'HEAD') fail('Parked lane must remain detached');
      if (current === 'HEAD') {
        if (!context.detached_sha || !FULL_SHA.test(context.detached_sha) || basename(target) === 'integration' || head(target) !== context.detached_sha) fail('Unexpected detached HEAD');
      } else if (git(target, ['symbolic-ref', '--no-recurse', 'HEAD'], timeout).trim() !== `refs/heads/${branch}` || current !== `refs/heads/${branch}`) fail('Checked out branch does not match guard');
    }
  } catch (e) {
    if (e instanceof GbdevError && (e.contract.code === 'guard_violation' || e.contract.details.git_timeout)) throw e;
    fail('Cannot verify worktree ownership');
  }
}
function assertCleanupRef(context: GitGuardContext, action: GuardedOperation, timeout: number): void {
  const paths = context.paths ?? resolvePaths();
  if (action.operation !== 'updateRefCas' || action.sha !== null || !FULL_SHA.test(action.expected) || !runBranch(context.run_id, context.branch)) throw new GbdevError('guard_violation', 'Cleanup permits only a run-owned CAS deletion');
  const root = resolve(paths.worktrees, basename(resolve(context.repo)), context.run_id);
  if (resolve(context.worktree) !== resolve(root, 'integration') || realpathSync(root) !== resolve(realpathSync(paths.worktrees), basename(resolve(context.repo)), context.run_id)) throw new GbdevError('guard_violation', 'Cleanup path outside run namespace');
  if (worktreeListPorcelain(context.repo, timeout).some(w => w.branch === `refs/heads/${context.branch}`)) throw new GbdevError('cleanup_refused', 'Branch is checked out', { reason: 'checked_out' });
}
export function gitGuarded(context: GitGuardContext, action: GuardedOperation, timeout?: number): string;
export function gitGuarded(context: GitGuardContext, action: GuardedOperation, timeout: number, signal: AbortSignal): Promise<string>;
export function gitGuarded(context: GitGuardContext, action: GuardedOperation, timeout = 120_000, signal?: AbortSignal): string | Promise<string> {
  if (signal) return gitGuardedAsync(context, action, timeout, signal);
  if (context.cleanup_ref_only) assertCleanupRef(context, action, timeout);
  else assertRunWorktree(context, action.operation !== 'updateRefCas', timeout);
  const fail = (reason: string): never => { throw new GbdevError('guard_violation', reason); };
  if ('sha' in action && action.sha !== null && !FULL_SHA.test(action.sha)) fail('Expected a full commit SHA');
  const target = context.cleanup_ref_only ? context.repo : context.worktree;
  const execute = (args: string[]) => signal ? git(target, args, timeout, signal) : git(target, args, timeout);
  switch (action.operation) {
    case 'snapshot': return execute([...MERGE_IDENTITY, 'commit', '--no-verify', '-m', action.message]);
    case 'resetHard': return execute(['reset', '--hard', action.sha]);
    case 'clean': return execute(['clean', '-fd']);
    case 'mergeAbort': return execute(['merge', '--abort']);
    case 'switchDetach': return execute(['switch', '--detach', action.sha]);
    case 'switchExisting':
      if (!runBranch(context.run_id, action.branch)) fail('Existing branch outside run namespace');
      return execute(['switch', action.branch]);
    case 'switchCreate':
      if (!runBranch(context.run_id, action.branch)) fail('New branch outside run namespace');
      validateBranchName(action.branch);
      return execute(['switch', '-c', action.branch, action.sha]);
    case 'mergeNoFf': case 'mergeNoCommit':
      if (git(target, ['rev-parse', '--symbolic-full-name', 'HEAD'], timeout).trim() === 'HEAD') fail('Cannot merge on a parked lane');
      return execute([...MERGE_IDENTITY, 'merge', '--no-ff', ...(action.operation === 'mergeNoFf' ? ['--no-edit', '-m', action.message] : ['--no-commit']), action.sha]);
    case 'updateRefCas':
      if (!FULL_SHA.test(action.expected)) fail('Expected a full old SHA for CAS');
      return execute(action.sha === null ? ['update-ref', '--no-deref', '-d', `refs/heads/${context.branch}`, action.expected] : ['update-ref', '--no-deref', `refs/heads/${context.branch}`, action.sha, action.expected]);
    default: return fail('Unknown guarded operation');
  }
}
export function resetHard(context: GitGuardContext, sha: string, timeout?: number): void { gitGuarded(context, { operation: 'resetHard', sha }, timeout); }
export function cleanUntracked(context: GitGuardContext, timeout?: number): void { gitGuarded(context, { operation: 'clean' }, timeout); }
export function mergeAbort(context: GitGuardContext, timeout?: number): void { gitGuarded(context, { operation: 'mergeAbort' }, timeout); }
export function updateRefCas(context: GitGuardContext, sha: string | null, expected: string, timeout?: number): void { gitGuarded(context, { operation: 'updateRefCas', sha, expected }, timeout); }
export function switchDetach(context: GitGuardContext, sha: string, timeout?: number): void { gitGuarded(context, { operation: 'switchDetach', sha }, timeout); }
export function switchCreate(context: GitGuardContext, branch: string, sha: string, timeout?: number): void { gitGuarded(context, { operation: 'switchCreate', branch, sha }, timeout); }
export function addDetachedWorktree(repo: string, worktree: string, sha: string): void {
  if (!FULL_SHA.test(sha)) throw new GbdevError('guard_violation', 'Expected a full commit SHA');
  mkdirSync(dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', worktree, sha], 300_000);
}

export function switchExisting(context: GitGuardContext, branch: string): void { gitGuarded(context, { operation: 'switchExisting', branch }); }

export async function mergeNoFfAsync(context: GitGuardContext, sha: string, message: string, signal: AbortSignal): Promise<string> {
  await gitGuarded(context, { operation: 'mergeNoFf', sha, message }, 120_000, signal);
  return headAsync(context.worktree, signal);
}

export async function assertRunWorktreeAsync(context: GitGuardContext, checkBranch = true, timeout = 120_000, signal = new AbortController().signal): Promise<void> {
  const { run_id, branch, worktree } = context, paths = context.paths ?? resolvePaths();
  const fail = (reason: string): never => { throw new GbdevError('guard_violation', reason, { run_id, branch, worktree }); };
  if (!runBranch(run_id, branch)) fail('Branch outside run namespace');
  try {
    const expectedRoot = realpathSync(resolve(paths.worktrees, basename(resolve(context.repo)), run_id));
    const canonicalWorktrees = realpathSync(paths.worktrees);
    if (expectedRoot !== resolve(canonicalWorktrees, basename(resolve(context.repo)), run_id)) fail('Run directory symlink escapes worktrees root');
    const target = realpathSync(worktree);
    if (!target.startsWith(expectedRoot + sep) || !/^(integration|lane-[1-4])$/.test(target.slice(expectedRoot.length + 1))) fail('Worktree outside run integration/lanes');
    if (realpathSync(context.repo) === target) fail('Main repository is not a run worktree');
    if (realpathSync((await git(target, ['rev-parse', '--show-toplevel'], timeout, signal)).trim()) !== target) fail('Target must be the worktree root');
    const common = async (cwd: string) => realpathSync(resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'], timeout, signal)).trim()));
    if ((await common(target)) !== (await common(context.repo))) fail('Worktree belongs to another repository');
    if (checkBranch) {
      // --no-recurse prevents a symbolic branch alias from hiding an outside target.
      const current = (await git(target, ['rev-parse', '--symbolic-full-name', 'HEAD'], timeout, signal)).trim();
      if (context.detached_sha && current !== 'HEAD') fail('Parked lane must remain detached');
      if (current === 'HEAD') {
        if (!context.detached_sha || !FULL_SHA.test(context.detached_sha) || basename(target) === 'integration' || (await headAsync(target, signal)) !== context.detached_sha) fail('Unexpected detached HEAD');
      } else if ((await git(target, ['symbolic-ref', '--no-recurse', 'HEAD'], timeout, signal)).trim() !== `refs/heads/${branch}` || current !== `refs/heads/${branch}`) fail('Checked out branch does not match guard');
    }
  } catch (e) {
    if (e instanceof GbdevError && (e.contract.code === 'guard_violation' || e.contract.details.git_timeout)) throw e;
    fail('Cannot verify worktree ownership');
  }
}
export async function gitGuardedAsync(context: GitGuardContext, action: GuardedOperation, timeout = 120_000, signal = new AbortController().signal): Promise<string> {
  if (context.cleanup_ref_only) assertCleanupRef(context, action, timeout);
  else await assertRunWorktreeAsync(context, action.operation !== 'updateRefCas', timeout, signal);
  const fail = (reason: string): never => { throw new GbdevError('guard_violation', reason); };
  if ('sha' in action && action.sha !== null && !FULL_SHA.test(action.sha)) fail('Expected a full commit SHA');
  const target = context.cleanup_ref_only ? context.repo : context.worktree;
  const execute = (args: string[]) => git(target, args, timeout, signal);
  switch (action.operation) {
    case 'snapshot': return execute([...MERGE_IDENTITY, 'commit', '--no-verify', '-m', action.message]);
    case 'resetHard': return execute(['reset', '--hard', action.sha]);
    case 'clean': return execute(['clean', '-fd']);
    case 'mergeAbort': return execute(['merge', '--abort']);
    case 'switchDetach': return execute(['switch', '--detach', action.sha]);
    case 'switchExisting':
      if (!runBranch(context.run_id, action.branch)) fail('Existing branch outside run namespace');
      return execute(['switch', action.branch]);
    case 'switchCreate':
      if (!runBranch(context.run_id, action.branch)) fail('New branch outside run namespace');
      validateBranchName(action.branch);
      return execute(['switch', '-c', action.branch, action.sha]);
    case 'mergeNoFf': case 'mergeNoCommit':
      if ((await git(target, ['rev-parse', '--symbolic-full-name', 'HEAD'], timeout, signal)).trim() === 'HEAD') fail('Cannot merge on a parked lane');
      return execute([...MERGE_IDENTITY, 'merge', '--no-ff', ...(action.operation === 'mergeNoFf' ? ['--no-edit', '-m', action.message] : ['--no-commit']), action.sha]);
    case 'updateRefCas':
      if (!FULL_SHA.test(action.expected)) fail('Expected a full old SHA for CAS');
      return execute(action.sha === null ? ['update-ref', '--no-deref', '-d', `refs/heads/${context.branch}`, action.expected] : ['update-ref', '--no-deref', `refs/heads/${context.branch}`, action.sha, action.expected]);
    default: return fail('Unknown guarded operation');
  }
}

export async function headAsync(repo: string, signal = new AbortController().signal): Promise<string> { return (await git(repo, ['rev-parse', 'HEAD'], 120_000, signal)).trim(); }
export async function dirtyAsync(repo: string, signal = new AbortController().signal): Promise<boolean> { return !!(await git(repo, ['status', '--porcelain=v1', '-z'], 120_000, signal)); }
export async function mergeTreeCheckAsync(repo: string, ours: string, theirs: string, signal: AbortSignal): Promise<MergeTreeResult> {
  validateIdentifier(ours, 'ours'); validateIdentifier(theirs, 'theirs');
  for (let n = 0; ; n++) {
    try { const output = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs], 120_000, signal); return { clean: true, conflict_files: [], tree: output.split('\0')[0]!.trim() }; }
    catch (e) { const error = e as GitFailure; if (error.status === 1) { const [tree, ...files] = String(error.stdout ?? '').split('\0'); if (!tree || !FULL_SHA.test(tree)) throw new Error('Invalid merge-tree output'); return { clean: false, conflict_files: [...new Set(files.filter(Boolean))], tree: null }; } if (signal.aborted || n >= 1) throw e; }
  }
}
export async function worktreeAsync(repo: string, worktree: string, sha: string, signal: AbortSignal, branch?: string): Promise<void> {
  if (!FULL_SHA.test(sha)) throw new GbdevError('guard_violation', 'Expected full SHA');
  if (branch) validateBranchName(branch);
  mkdirSync(dirname(worktree), { recursive: true });
  await git(repo, ['worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), worktree, sha], 300_000, signal);
}

/** Cleanup remains guarded after its worktrees have been removed: only direct run refs, CAS. */
export function deleteRunBranchCas(context: GitGuardContext, expected: string): boolean {
  try { gitGuarded({ ...context, cleanup_ref_only: true }, { operation: 'updateRefCas', sha: null, expected }); return true; }
  catch (e) { if (e instanceof GbdevError && e.contract.code === 'cleanup_refused' && e.contract.details.reason === 'checked_out') return false; throw e; }
}
export function removeRunWorktree(context: GitGuardContext): void {
  assertRunWorktree(context, false);
  git(context.repo, ['worktree', 'remove', context.worktree]);
}
export function pruneWorktrees(repo: string): void { git(repo, ['worktree', 'prune']); }
/** The sole target-writing exception: explicit approval, direct branch, FF ancestry and CAS. */
export async function landFastForward(repo: string, target: string, sha: string, expected: string, approved: boolean): Promise<void> {
  if (!approved) throw new GbdevError('user_approval_required', 'Explicit user approval is required');
  validateBranchName(target);
  if (target.startsWith('gbdev/') || !FULL_SHA.test(sha) || !FULL_SHA.test(expected)) throw new GbdevError('guard_violation', 'Invalid land target');
  const signal = new AbortController().signal, ref = `refs/heads/${target}`;
  if ((await git(repo, ['rev-parse', '--symbolic-full-name', ref], 120_000, signal)).trim() !== ref || (await git(repo, ['rev-parse', ref], 120_000, signal)).trim() !== expected) throw new GbdevError('land_refused', 'Target moved', { reason: 'target_moved' });
  if (!await ancestorForLand(repo, expected, sha, signal)) throw new GbdevError('land_refused', 'Target is not an ancestor', { reason: 'target_moved' });
  const worktrees = worktreeListPorcelain(repo).filter(w => w.branch === ref);
  for (const w of worktrees) if ((await git(w.worktree, ['status', '--porcelain', '--untracked-files=no'], 120_000, signal)).length) throw new GbdevError('land_refused', 'Target worktree is dirty', { reason: 'target_is_checked_out_dirty' });
  if (worktrees.length > 1) throw new GbdevError('land_refused', 'Target is checked out multiple times', { reason: 'ff_failed' });
  try {
    if (worktrees[0]) {
      if ((await git(worktrees[0].worktree, ['symbolic-ref', '--no-recurse', 'HEAD'], 120_000, signal)).trim() !== ref) throw new Error('Target checkout moved');
      await git(worktrees[0].worktree, [...MERGE_IDENTITY, 'merge', '--ff-only', sha], 120_000, signal);
    } else await git(repo, ['update-ref', '--no-deref', ref, sha, expected], 120_000, signal);
  } catch (e) { throw new GbdevError('land_refused', String(e), { reason: worktrees.length ? 'ff_failed' : 'target_moved' }); }
}
async function ancestorForLand(repo: string, from: string, to: string, signal: AbortSignal): Promise<boolean> {
  try { await git(repo, ['merge-base', '--is-ancestor', from, to], 120_000, signal); return true; }
  catch (e) { if ((e as GitFailure).status === 1) return false; throw e; }
}
/** Reattach a retained integration branch after cleanup, without resetting its tip. */
export async function attachRunIntegration(context: GitGuardContext, expected: string, signal: AbortSignal): Promise<void> {
  const paths = context.paths ?? resolvePaths();
  if (context.branch !== `gbdev/${context.run_id}/integration` || !runBranch(context.run_id, context.branch) || resolve(context.worktree) !== resolve(paths.worktrees, basename(context.repo), context.run_id, 'integration')) throw new GbdevError('guard_violation', 'Invalid integration worktree');
  if ((await git(context.repo, ['rev-parse', `refs/heads/${context.branch}`], 120_000, signal)).trim() !== expected) throw new GbdevError('land_refused', 'Integration branch moved', { reason: 'sync_conflict' });
  mkdirSync(dirname(context.worktree), { recursive: true });
  if (realpathSync(dirname(context.worktree)) !== resolve(realpathSync(paths.worktrees), basename(context.repo), context.run_id)) throw new GbdevError('guard_violation', 'Integration path escapes root');
  await git(context.repo, ['worktree', 'add', context.worktree, context.branch], 120_000, signal);
  await assertRunWorktreeAsync(context, true, 120_000, signal);
}
