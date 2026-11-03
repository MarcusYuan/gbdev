import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { validateJobId } from './ids.js';

export type ConfigSource = 'env' | 'home' | 'default';

export interface GbdevPaths {
  home: string;
  config: string;
  /** How `config` was chosen (SPEC-M6 §8.1). */
  configSource: ConfigSource;
  /**
   * When home config existed as a symlink and was ignored in favor of default.
   * Only set when configSource === 'default' for that reason; used by doctor detail.
   */
  homeConfigSymlinkIgnored?: boolean;
  jobs: string;
  worktrees: string;
  lock: string;
}

export function expandHome(path: string, userHome = homedir()): string {
  if (!path.trim()) throw new GbdevError('config_invalid', 'Path must not be empty');
  if (path === '~') return userHome;
  if (path.startsWith('~/')) return join(userHome, path.slice(2));
  if (path.startsWith('~')) throw new GbdevError('config_invalid', '~user paths are not supported');
  return path;
}

export function defaultHomePath(userHome = homedir()): string {
  return resolve(expandHome(join(userHome, '.gbdev'), userHome));
}

export function defaultConfigPath(userHome = homedir()): string {
  return resolve(expandHome(join(userHome, '.config', 'gbdev', 'config.json'), userHome));
}

export function homeConfigPath(home: string): string {
  return join(home, 'config', 'config.json');
}

/** True iff path exists, is a regular file, and is not a symlink (lstat). */
export function isRegularConfigFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve a path for containment checks: deepest existing ancestor's realpath
 * plus any still-missing suffix (SPEC-M6 N7 / S3 review P1-3).
 * Ancestor symlinks are followed so aliases into a tree are detected.
 */
export function resolveLogicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      lstatSync(cursor);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
  let anchor: string;
  try {
    anchor = realpathSync(cursor);
  } catch {
    anchor = cursor;
  }
  return missing.length === 0 ? anchor : join(anchor, ...missing);
}

/** True if `candidate` is the same as or strictly inside `root` (logical paths). */
export function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const c = resolveLogicalPath(candidate);
  const r = resolveLogicalPath(root);
  return c === r || c.startsWith(`${r}/`);
}

/** True if `candidate` is strictly inside `root` (not equal). */
export function isPathStrictlyInside(candidate: string, root: string): boolean {
  const c = resolveLogicalPath(candidate);
  const r = resolveLogicalPath(root);
  return c.startsWith(`${r}/`);
}

export function resolvePaths(env: Partial<Pick<NodeJS.ProcessEnv, 'GBDEV_HOME' | 'GBDEV_CONFIG'>> = process.env, userHome = homedir()): GbdevPaths {
  const home = resolve(expandHome(env.GBDEV_HOME ?? join(userHome, '.gbdev'), userHome));
  if (env.GBDEV_CONFIG !== undefined) {
    const config = resolve(expandHome(env.GBDEV_CONFIG, userHome));
    return { home, config, configSource: 'env', jobs: join(home, 'jobs'), worktrees: join(home, 'worktrees'), lock: join(home, 'lock') };
  }
  const homeCfg = homeConfigPath(home);
  let homeConfigSymlinkIgnored = false;
  try {
    const st = lstatSync(homeCfg);
    if (st.isSymbolicLink()) homeConfigSymlinkIgnored = true;
    else if (st.isFile()) {
      return {
        home, config: resolve(homeCfg), configSource: 'home',
        jobs: join(home, 'jobs'), worktrees: join(home, 'worktrees'), lock: join(home, 'lock'),
      };
    }
  } catch { /* missing → default */ }
  const config = defaultConfigPath(userHome);
  return {
    home, config, configSource: 'default',
    ...(homeConfigSymlinkIgnored ? { homeConfigSymlinkIgnored: true } : {}),
    jobs: join(home, 'jobs'), worktrees: join(home, 'worktrees'), lock: join(home, 'lock'),
  };
}

export function jobPaths(paths: GbdevPaths, jobId: string) {
  validateJobId(jobId);
  const dir = join(paths.jobs, jobId);
  return {
    dir, job: join(dir, 'job.json'), brief: join(dir, 'brief.json'), prompt: join(dir, 'prompt.md'),
    rawJsonl: join(dir, 'raw.jsonl'), rawJson: join(dir, 'raw.json'), events: join(dir, 'events.jsonl'),
    workerLog: join(dir, 'worker.log'), finalMessage: join(dir, 'final.md'), diff: join(dir, 'diff.patch'),
    checks: join(dir, 'checks'), result: join(dir, 'result.json'),
    supervisorLog: join(dir, 'supervisor.log'), processInfo: join(dir, 'process.json'),
    cancelRequest: join(dir, 'cancel.json'),
  };
}

/** One active inspect reservation per home. Absent when no inspect is admitted. */
export function inspectLeasePath(paths: GbdevPaths): string {
  return join(paths.home, 'inspect', 'lease.json');
}

export function worktreePath(paths: GbdevPaths, repo: string, jobId: string): string {
  validateJobId(jobId);
  if (!isAbsolute(repo)) throw new GbdevError('config_invalid', 'repo must be absolute');
  const name = basename(resolve(repo));
  if (!name || name === '.' || name === '..') throw new GbdevError('config_invalid', 'repo must have a directory name');
  return join(paths.worktrees, name, jobId);
}
