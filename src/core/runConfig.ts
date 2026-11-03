import { readFileSync } from 'node:fs';
import { GbdevError } from '../contracts/error.js';
import { integer, object } from '../contracts/validation.js';
import type { PipelineRegistry } from '../pipeline/definitions.js';
import { isPreservedRoleError, rejectReservedObjectKeys } from '../roles/reserved.js';

export const MAX_WORKERS = 4;
export const MAX_LANES = 4;
export interface ParallelConfig { max_workers: number; provider_limits: { codex: number; cursor: number; fake?: number }; rate_limit_cooldown_s: number }
export interface RunDefaults { task_checks?: string[]; lanes: number; max_tasks: number; max_total_jobs: number; timeout_min: number; max_integration_fixes: number; max_resolver_attempts: number; max_conflict_files: number; gate_timeout_min: number; final_review: 'reviewer' | 'verifier' | 'none'; overlap_policy: 'serialize' | 'allow'; default_task_pipeline: string }
export const DEFAULT_PARALLEL: ParallelConfig = { max_workers: 3, provider_limits: { codex: 3, cursor: 2 }, rate_limit_cooldown_s: 600 };
export const DEFAULT_RUN: RunDefaults = { lanes: 2, max_tasks: 12, max_total_jobs: 60, timeout_min: 720, max_integration_fixes: 1, max_resolver_attempts: 2, max_conflict_files: 20, gate_timeout_min: 30, final_review: 'reviewer', overlap_policy: 'serialize', default_task_pipeline: 'implement-review' };
function keys(v: Record<string, unknown>, allowed: string[], label: string): void {
  rejectReservedObjectKeys(v, label);
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new GbdevError('config_invalid', `Unknown ${label} field: ${key}`);
}
export function validateParallel(value: unknown = {}): ParallelConfig {
  const v = object(value, 'parallel'); keys(v, Object.keys(DEFAULT_PARALLEL), 'parallel');
  const p = { ...DEFAULT_PARALLEL, ...v };
  integer(p.max_workers, 'max_workers', 1, MAX_WORKERS); integer(p.rate_limit_cooldown_s, 'rate_limit_cooldown_s', 0, 3600);
  const limits = v.provider_limits === undefined ? {} : object(v.provider_limits, 'provider_limits'); keys(limits, ['codex', 'cursor', 'fake'], 'provider_limits');
  const provider_limits = { ...DEFAULT_PARALLEL.provider_limits, ...limits };
  for (const [key, limit] of Object.entries(provider_limits)) integer(limit, `provider_limits.${key}`, 1, p.max_workers);
  return { max_workers: p.max_workers, rate_limit_cooldown_s: p.rate_limit_cooldown_s, provider_limits } as ParallelConfig;
}
export function requireChangePipeline(name: string, registry: PipelineRegistry): void {
  const definition = registry.resolve(name);
  if (!definition.steps.some(s => registry.roles.resolve(s.role).output === 'change')) throw new Error('Template must contain a change step');
}
export function validateRunDefaults(value: unknown = {}, registry: PipelineRegistry): RunDefaults {
  const v = object(value, 'run_defaults'); keys(v, [...Object.keys(DEFAULT_RUN), 'task_checks'], 'run_defaults');
  const d = { ...DEFAULT_RUN, ...v };
  if (d.task_checks !== undefined && (!Array.isArray(d.task_checks) || d.task_checks.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(id)) || new Set(d.task_checks).size !== d.task_checks.length)) throw new GbdevError('config_invalid', 'Invalid run_defaults.task_checks');
  for (const [key, min, max] of [['lanes', 1, MAX_LANES], ['max_tasks', 1, 16], ['max_total_jobs', 1, 120], ['timeout_min', 60, 1440], ['max_integration_fixes', 0, 3], ['max_resolver_attempts', 0, 2], ['max_conflict_files', 1, 50], ['gate_timeout_min', 5, 120]] as const) integer(d[key], key, min, max);
  if (!['reviewer', 'verifier', 'none'].includes(d.final_review as string) || !['serialize', 'allow'].includes(d.overlap_policy as string)) throw new GbdevError('config_invalid', 'Invalid final_review/overlap_policy');
  try { if (typeof d.default_task_pipeline !== 'string') throw new Error('Template name required'); requireChangePipeline(d.default_task_pipeline, registry); }
  catch (e) { if (isPreservedRoleError(e)) throw e; throw new GbdevError('config_invalid', `Invalid default_task_pipeline: ${String(e)}`); }
  return d as unknown as RunDefaults;
}
/** Opt-in M3 reader. Legacy job/pipeline commands deliberately do not read these fields. */
export function readRunConfigFields(path: string): Record<string, unknown> {
  let v: Record<string, unknown>;
  try { v = object(JSON.parse(readFileSync(path, 'utf8')), 'config'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') v = {}; else throw new GbdevError('config_invalid', `Invalid configuration: ${String(e)}`); }
  return v;
}
export function loadRunConfig(path: string, registry: PipelineRegistry): { parallel: ParallelConfig; run_defaults: RunDefaults } {
  const v = readRunConfigFields(path);
  return { parallel: validateParallel(v.parallel), run_defaults: validateRunDefaults(v.run_defaults, registry) };
}
