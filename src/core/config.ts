import { rejectConfigSecrets, validateNotify, type NotifyConfig } from './notifyConfig.js';
import { validateDashboard, type DashboardConfig } from './dashboardConfig.js';
import { validateParallel, validateRunDefaults, type ParallelConfig, type RunDefaults } from './runConfig.js';
import type { PipelineRegistry } from '../pipeline/definitions.js';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { integer, object, string, strings } from '../contracts/validation.js';
import { expandHome, resolvePaths } from './paths.js';
import { rejectReservedObjectKeys } from '../roles/reserved.js';
import {
  DEFAULT_REVIEW_PROMPT,
  DEFAULT_WORKER_LAUNCH,
  type ReviewPromptConfig,
  type WorkerLaunchConfig,
} from './retryPolicy.js';

export interface Config {
  notify?: NotifyConfig;
  dashboard?: DashboardConfig;
  parallel?: ParallelConfig;
  run_defaults?: RunDefaults;
  version: 1;
  allowed_repos: string[];
  providers: { codex: { bin: string }; cursor: { bin: string; model?: 'auto' } };
  default_timeout_min: number;
  default_stall_timeout_s: number;
  concurrency: 1;
  pipeline_defaults?: { max_rounds: number; timeout_min: number; max_total_jobs: number };
  worker_launch?: WorkerLaunchConfig;
  review_prompt?: ReviewPromptConfig;
}

const WORKER_LAUNCH_KEYS = ['failure_threshold_ms', 'max_retries', 'backoff_initial_ms', 'backoff_multiplier', 'backoff_max_ms'] as const;
const REVIEW_PROMPT_KEYS = ['max_bytes'] as const;

export function validateWorkerLaunch(value: unknown): WorkerLaunchConfig {
  const p = object(value, 'worker_launch');
  rejectReservedObjectKeys(p, 'worker_launch');
  for (const key of Object.keys(p)) {
    if (!(WORKER_LAUNCH_KEYS as readonly string[]).includes(key)) {
      throw new GbdevError('config_invalid', `Unknown worker_launch field: ${key}`);
    }
  }
  const failure_threshold_ms = p.failure_threshold_ms ?? DEFAULT_WORKER_LAUNCH.failure_threshold_ms;
  const max_retries = p.max_retries ?? DEFAULT_WORKER_LAUNCH.max_retries;
  const backoff_initial_ms = p.backoff_initial_ms ?? DEFAULT_WORKER_LAUNCH.backoff_initial_ms;
  const backoff_multiplier = p.backoff_multiplier ?? DEFAULT_WORKER_LAUNCH.backoff_multiplier;
  const backoff_max_ms = p.backoff_max_ms ?? DEFAULT_WORKER_LAUNCH.backoff_max_ms;
  integer(failure_threshold_ms, 'worker_launch.failure_threshold_ms', 1, 60000);
  integer(max_retries, 'worker_launch.max_retries', 0, 5);
  integer(backoff_initial_ms, 'worker_launch.backoff_initial_ms', 1, 60000);
  integer(backoff_multiplier, 'worker_launch.backoff_multiplier', 2, 10);
  integer(backoff_max_ms, 'worker_launch.backoff_max_ms', 1, 300000);
  if (backoff_max_ms < backoff_initial_ms) {
    throw new GbdevError('config_invalid', 'worker_launch.backoff_max_ms must be >= backoff_initial_ms');
  }
  return { failure_threshold_ms, max_retries, backoff_initial_ms, backoff_multiplier, backoff_max_ms };
}

export function validateReviewPrompt(value: unknown): ReviewPromptConfig {
  const p = object(value, 'review_prompt');
  rejectReservedObjectKeys(p, 'review_prompt');
  for (const key of Object.keys(p)) {
    if (!(REVIEW_PROMPT_KEYS as readonly string[]).includes(key)) {
      throw new GbdevError('config_invalid', `Unknown review_prompt field: ${key}`);
    }
  }
  const max_bytes = p.max_bytes ?? DEFAULT_REVIEW_PROMPT.max_bytes;
  integer(max_bytes, 'review_prompt.max_bytes', 4096, 200000);
  return { max_bytes };
}

/** Effective launch policy: explicit config or defaults (always closed). */
export function effectiveWorkerLaunch(config: Config): WorkerLaunchConfig {
  return config.worker_launch ?? { ...DEFAULT_WORKER_LAUNCH };
}

export function effectiveReviewPrompt(config: Config): ReviewPromptConfig {
  return config.review_prompt ?? { ...DEFAULT_REVIEW_PROMPT };
}

export function validateConfig(value: unknown, runRegistry?: PipelineRegistry): Config {
  rejectConfigSecrets(value);
  const v = object(value, 'config');
  rejectReservedObjectKeys(v, 'config');
  if (v.version !== 1) throw new GbdevError('config_invalid', 'config.version must be 1');
  const repos = v.allowed_repos === undefined ? [] : v.allowed_repos;
  strings(repos, 'allowed_repos');
  const allowedRepos = repos.map(repo => {
    const expanded = expandHome(repo);
    if (!isAbsolute(expanded)) throw new GbdevError('config_invalid', 'allowed_repos must contain absolute paths');
    return resolve(expanded);
  });
  const providers = v.providers === undefined ? {} : object(v.providers, 'providers');
  rejectReservedObjectKeys(providers, 'providers');
  if (v.roles !== undefined) rejectReservedObjectKeys(object(v.roles, 'roles'), 'roles');
  // Legacy readers ignore run_defaults shape; M3 validates it only with a run registry.
  if (v.run_defaults && typeof v.run_defaults === 'object' && !Array.isArray(v.run_defaults)) {
    rejectReservedObjectKeys(v.run_defaults as Record<string, unknown>, 'run_defaults');
  }
  if (v.parallel !== undefined) {
    const parallel = object(v.parallel, 'parallel');
    rejectReservedObjectKeys(parallel, 'parallel');
    if (parallel.provider_limits !== undefined) {
      rejectReservedObjectKeys(object(parallel.provider_limits, 'provider_limits'), 'provider_limits');
    }
  }
  const bin = (name: 'codex' | 'cursor', fallback: string) => {
    if (providers[name] === undefined) return { bin: fallback };
    const provider = object(providers[name], `providers.${name}`);
    if (name === 'cursor' && provider.model !== undefined && provider.model !== 'auto') throw new GbdevError('cursor_model_not_allowed', 'providers.cursor.model must be auto');
    if (provider.bin === undefined) return { bin: fallback };
    string(provider.bin, `providers.${name}.bin`);
    return { bin: expandHome(provider.bin) };
  };
  const timeout = v.default_timeout_min === undefined ? 30 : v.default_timeout_min;
  integer(timeout, 'default_timeout_min', 1, 240);
  const stallTimeout = v.default_stall_timeout_s === undefined ? 600 : v.default_stall_timeout_s;
  integer(stallTimeout, 'default_stall_timeout_s');
  if (v.concurrency !== undefined && v.concurrency !== 1) throw new GbdevError('config_invalid', 'M1 concurrency must be 1');
  let pipelineDefaults: Config['pipeline_defaults'];
  if (v.pipeline_defaults !== undefined) {
    const p = object(v.pipeline_defaults, 'pipeline_defaults');
    rejectReservedObjectKeys(p, 'pipeline_defaults');
    for (const key of Object.keys(p)) if (!['max_rounds', 'timeout_min', 'max_total_jobs'].includes(key)) throw new GbdevError('config_invalid', `Unknown pipeline_defaults field: ${key}`);
    const max_rounds = p.max_rounds ?? 2, timeout_min = p.timeout_min ?? 240, max_total_jobs = p.max_total_jobs ?? 12;
    integer(max_rounds, 'max_rounds', 0, 5); integer(timeout_min, 'timeout_min', 30, 480); integer(max_total_jobs, 'max_total_jobs', 1, 20);
    pipelineDefaults = { max_rounds, timeout_min, max_total_jobs };
  }
  const runConfig = runRegistry ? { parallel: validateParallel(v.parallel), run_defaults: validateRunDefaults(v.run_defaults, runRegistry) } : {};
  const workerLaunch = v.worker_launch === undefined ? undefined : validateWorkerLaunch(v.worker_launch);
  const reviewPrompt = v.review_prompt === undefined ? undefined : validateReviewPrompt(v.review_prompt);
  return {
    ...(v.notify === undefined ? {} : { notify: validateNotify(v.notify) }),
    ...(v.dashboard === undefined ? {} : { dashboard: validateDashboard(v.dashboard) }),
    ...runConfig,
    ...(pipelineDefaults ? { pipeline_defaults: pipelineDefaults } : {}),
    ...(workerLaunch ? { worker_launch: workerLaunch } : {}),
    ...(reviewPrompt ? { review_prompt: reviewPrompt } : {}),
    version: 1, allowed_repos: allowedRepos,
    providers: { codex: bin('codex', 'codex'), cursor: bin('cursor', 'cursor-agent') },
    default_timeout_min: timeout, default_stall_timeout_s: stallTimeout, concurrency: 1,
  };
}

export function loadConfig(path = resolvePaths().config): Config {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateConfig({ version: 1 });
    throw new GbdevError('config_invalid', `Cannot read configuration: ${path}`);
  }
  try {
    return validateConfig(JSON.parse(content));
  } catch (error) {
    if (error instanceof GbdevError) throw error;
    throw new GbdevError('config_invalid', `Invalid JSON configuration: ${path}`);
  }
}

export function assertRepoAllowed(repo: string, config: Config): string {
  if (!isAbsolute(repo)) throw new GbdevError('config_invalid', 'repo must be an absolute path');
  let canonical: string;
  try {
    canonical = realpathSync(repo);
    if (!statSync(canonical).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new GbdevError('config_invalid', 'repo must be an existing directory');
  }
  const allowed = config.allowed_repos.some(entry => {
    try { return realpathSync(entry) === canonical; } catch { return false; }
  });
  if (!allowed) throw new GbdevError('repo_not_allowed', 'repo is not in allowed_repos', { repo });
  return canonical;
}
