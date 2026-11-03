import type { PipelineRegistry } from '../pipeline/definitions.js';
import { requireChangePipeline } from '../core/runConfig.js';
import { matchesAllowed } from '../core/glob.js';
import { assertCursorModels, assertSchema, closed, enumeration, list, codexNullable as nullable, nonempty, runInvalid, stringsSchema, taskIdSchema, textSchema, type JsonSchema } from './runValidation.js';
import { isPreservedRoleError } from '../roles/reserved.js';
export interface RunCriterion { id: string; text: string; check: string | null }
export interface GraphTask { id: string; title: string; goal: string; context: string; depends_on: string[]; file_scope: string[]; acceptance_criteria: RunCriterion[]; pipeline: string | null; size: 'S' | 'M' | 'L'; notes: string | null }
export interface TaskGraph { schema: 'gbdev.task-graph.v1'; summary: string; tasks: GraphTask[] }
export interface TaskGraphContext { max_tasks: number; allowed_paths: string[]; checks: readonly { id: string }[]; default_task_pipeline: string; registry: PipelineRegistry }
export const criterionSchema = closed({ id: nonempty, text: nonempty, check: nullable(taskIdSchema) });
export const graphTaskSchema = closed({ id: taskIdSchema, title: { ...textSchema, maxLength: 120 }, goal: { ...nonempty, maxLength: 2000 }, context: { ...textSchema, maxLength: 4000 }, depends_on: { ...list(taskIdSchema), uniqueItems: true }, file_scope: list(nonempty, 1, 30), acceptance_criteria: list(criterionSchema, 1, 10), pipeline: nullable(nonempty), size: enumeration('S', 'M', 'L'), notes: nullable({ ...textSchema, maxLength: 1000 }) });
export const taskGraphSchema: JsonSchema = closed({ schema: { const: 'gbdev.task-graph.v1', type: 'string' }, summary: textSchema, tasks: list(graphTaskSchema, 1, 16) });
export function validateCriteria(criteria: RunCriterion[], checks: readonly { id: string }[], errors: string[], label: string): void {
  for (const c of criteria) if (c.check !== null && !checks.some(check => check.id === c.check)) errors.push(`${label}.${c.id}: unknown check ${c.check}`);
}
export function validateTaskGraph(value: unknown, context: TaskGraphContext): TaskGraph {
  assertCursorModels(value); assertSchema(value, taskGraphSchema);
  const graph = structuredClone(value) as TaskGraph, errors: string[] = [], ids = new Set(graph.tasks.map(t => t.id));
  if (graph.tasks.length > context.max_tasks) errors.push('tasks exceeds max_tasks');
  if (ids.size !== graph.tasks.length) errors.push('Duplicate task ids');
  for (const task of graph.tasks) {
    for (const dep of task.depends_on) if (dep === task.id || !ids.has(dep)) errors.push(`${task.id}: invalid dependency ${dep}`);
    for (const scope of task.file_scope) {
      const parts = scope.split('/'), wildcard = parts.findIndex(p => /[*?\[{]/.test(p));
      const prefix = (wildcard < 0 ? parts : parts.slice(0, wildcard)).join('/');
      if (scope.startsWith('/') || parts.includes('..') || !context.allowed_paths.includes(scope) && !matchesAllowed(prefix, context.allowed_paths)) errors.push(`${task.id}: file_scope not covered: ${scope}`);
    }
    validateCriteria(task.acceptance_criteria, context.checks, errors, task.id);
    try { requireChangePipeline(task.pipeline ?? context.default_task_pipeline, context.registry); }
    catch (e) { if (isPreservedRoleError(e)) throw e; errors.push(`${task.id}: invalid pipeline: ${String(e)}`); }
  }
  // Kahn detects cycles; report actual cycle members (not descendants blocked by them).
  const remaining = new Map(graph.tasks.map(t => [t.id, new Set(t.depends_on)]));
  for (;;) { const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id); if (!ready.length) break; for (const id of ready) { remaining.delete(id); for (const deps of remaining.values()) deps.delete(id); } }
  const cycles = [...remaining.keys()].filter(start => {
    const seen = new Set<string>(); const reaches = (id: string): boolean => { if (seen.has(id)) return false; seen.add(id); return [...(remaining.get(id) ?? [])].some(dep => dep === start || reaches(dep)); }; return reaches(start);
  });
  if (cycles.length) errors.push(`Dependency cycle: ${cycles.join(', ')}`);
  if (errors.length) runInvalid(errors);
  return graph;
}
// Reused by schemas containing non-command task references.
export { stringsSchema };
