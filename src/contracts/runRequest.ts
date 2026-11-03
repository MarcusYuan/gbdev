import { assertRepoAllowed, type Config } from '../core/config.js';
import { DEFAULT_RUN, requireChangePipeline, MAX_LANES, type RunDefaults } from '../core/runConfig.js';
import { validateIdentifier } from '../core/ids.js';
import type { PipelineRegistry } from '../pipeline/definitions.js';
import type { StepOverride } from './pipelineRequest.js';
import { GbdevError } from './error.js';
import { assertCursorModels, assertSchema, closed, enumeration, list, nullable, nonempty, number, runInvalid, stringsSchema, taskIdSchema, textSchema, type JsonSchema } from './runValidation.js';
import { criterionSchema, graphTaskSchema, validateCriteria, validateTaskGraph, type GraphTask, type RunCriterion } from './taskGraph.js';
import { assertNotReservedRoleId, isPreservedRoleError } from '../roles/reserved.js';
export interface RunRequest { schema: 'gbdev.run-request.v1'; request_id: string; repo: string; base_ref: string; goal: string; context: string; constraints: string[]; allowed_paths: string[]; checks: { id: string; cmd: string; timeout_min: number }[]; integration_checks: string[]; /** Trusted change-step checks; omission derives cheap integration checks. */
  task_checks: string[]; acceptance_criteria: RunCriterion[]; decompose: 'planner' | 'provided'; tasks: GraphTask[] | null; lanes: number; overlap_policy: RunDefaults['overlap_policy']; default_task_pipeline: string; task_pipeline_overrides: Record<string, StepOverride>; final_review: RunDefaults['final_review']; worktree_setup_cmd: string | null; max_tasks: number; max_total_jobs: number; max_integration_fixes: number; timeout_min: number; network: boolean }
export const stepOverrideSchema = closed({ provider: enumeration('codex', 'cursor', 'fake'), codex_model: nullable(nonempty), cursor_model: { type: 'string', const: 'auto' }, timeout_min: number(1, 240), stall_timeout_s: number() }, ['provider', 'codex_model', 'cursor_model', 'timeout_min', 'stall_timeout_s']);
const defaultFields = ['lanes', 'overlap_policy', 'default_task_pipeline', 'task_pipeline_overrides', 'final_review', 'worktree_setup_cmd', 'max_tasks', 'max_total_jobs', 'max_integration_fixes', 'timeout_min', 'task_checks', 'network'];
export const runRequestSchema: JsonSchema = closed({ schema: { type: 'string', const: 'gbdev.run-request.v1' }, request_id: nonempty, repo: nonempty, base_ref: nonempty, goal: nonempty, context: textSchema, constraints: stringsSchema, allowed_paths: list(nonempty, 1), checks: list(closed({ id: taskIdSchema, cmd: { ...nonempty, maxLength: 500 }, timeout_min: number(1, 60) }, ['timeout_min']), 1, 10), integration_checks: list(taskIdSchema, 1), task_checks: { ...list(taskIdSchema, 0), uniqueItems: true }, acceptance_criteria: list(criterionSchema), decompose: enumeration('planner', 'provided'), tasks: nullable(list(graphTaskSchema, 1, 16)), lanes: number(1, MAX_LANES), overlap_policy: enumeration('serialize', 'allow'), default_task_pipeline: nonempty, task_pipeline_overrides: { type: 'object', additionalProperties: stepOverrideSchema }, final_review: enumeration('reviewer', 'verifier', 'none'), worktree_setup_cmd: nullable({ ...textSchema, maxLength: 500 }), max_tasks: number(1, 16), max_total_jobs: number(1, 120), max_integration_fixes: number(0, 3), timeout_min: number(60, 1440), network: { type: 'boolean', default: true } }, defaultFields);
export const CHEAP_TASK_CHECK_MAX_TIMEOUT_MIN = 5;
/** Only new, unnormalized requests may derive defaults. Persisted [] is an opt-out. */
export function shouldDefaultTaskChecks(value: unknown, defaults: RunDefaults): boolean {
  return !!value && typeof value === 'object' && !Object.hasOwn(value, 'task_checks') && defaults.task_checks === undefined;
}
export function validateRunRequest(value: unknown, config: Config, registry: PipelineRegistry, defaults: RunDefaults = DEFAULT_RUN): RunRequest {
  // Reserved override identifiers take precedence over closed-schema unknown fields.
  const overrides = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).task_pipeline_overrides : undefined;
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [id, override] of Object.entries(overrides)) {
      assertNotReservedRoleId(id, 'task_pipeline_overrides');
      if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
      const fields = override as Record<string, unknown>;
      for (const key of ['role', 'name']) {
        if (typeof fields[key] === 'string') assertNotReservedRoleId(fields[key], `override.${key}`);
      }
    }
  }
  assertCursorModels(value); assertSchema(value, runRequestSchema);
  const raw = structuredClone(value) as Partial<RunRequest>;
  const request = { ...Object.fromEntries(defaultFields.filter(k => k in defaults).map(k => [k, defaults[k as keyof RunDefaults]])), task_pipeline_overrides: {}, worktree_setup_cmd: null, network: true, ...raw } as RunRequest;
  request.checks = request.checks.map(c => ({ ...c, timeout_min: c.timeout_min ?? 10 }));
  request.task_checks = shouldDefaultTaskChecks(raw, defaults)
    ? request.integration_checks.filter(id => request.checks.some(c => c.id === id && c.timeout_min <= CHEAP_TASK_CHECK_MAX_TIMEOUT_MIN))
    : [...(request.task_checks ?? [])];
  const errors: string[] = [];
  try { request.repo = assertRepoAllowed(request.repo, config); validateIdentifier(request.base_ref, 'base_ref'); }
  catch (e) { if (isPreservedRoleError(e)) throw e; errors.push(String(e)); }
  if (new Set(request.checks.map(c => c.id)).size !== request.checks.length) errors.push('Duplicate check ids');
  for (const id of request.integration_checks) if (!request.checks.some(c => c.id === id)) errors.push(`Unknown integration check: ${id}`);
  if (new Set(request.task_checks).size !== request.task_checks.length) errors.push('Duplicate task_checks ids');
  for (const id of request.task_checks) if (!request.checks.some(c => c.id === id)) errors.push(`Unknown task check: ${id}`);
  validateCriteria(request.acceptance_criteria, request.checks, errors, 'acceptance_criteria');
  if (request.decompose === 'planner' && request.tasks !== null || request.decompose === 'provided' && request.tasks === null) errors.push('tasks must be null for planner and an array for provided');
  try { requireChangePipeline(request.default_task_pipeline, registry); }
  catch (e) { if (isPreservedRoleError(e)) throw e; errors.push(`Invalid default_task_pipeline: ${String(e)}`); }
  if (request.decompose === 'provided' && request.tasks) {
    try { request.tasks = validateTaskGraph({ schema: 'gbdev.task-graph.v1', summary: '', tasks: request.tasks }, { ...request, registry }).tasks; }
    catch (e) { if (isPreservedRoleError(e)) throw e; if (e instanceof GbdevError) errors.push(...(e.contract.details.errors as string[] ?? [e.message])); else throw e; }
  }
  const templates = new Set([request.default_task_pipeline, ...(request.tasks ?? []).map(t => t.pipeline ?? request.default_task_pipeline)]);
  for (const template of templates) {
    try {
      const d = registry.resolve(template), steps = [...d.steps, ...(d.fix_loop ? [{ id: 'fix', role: d.fix_loop.fix_role }] : [])];
      for (const [id, override] of Object.entries(request.task_pipeline_overrides)) {
        const step = steps.find(s => s.id === id); if (!step) { errors.push(`${template}: unknown override step ${id}`); continue; }
        const role = registry.roles.resolve(step.role);
        if (override.provider && !role.allowed_providers.includes(override.provider)) errors.push(`${id}: provider not allowed`);
      }
    } catch (e) { if (isPreservedRoleError(e)) throw e; errors.push(String(e)); }
  }
  if (errors.length) runInvalid(errors);
  return request;
}
