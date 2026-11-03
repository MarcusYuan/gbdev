import { GbdevError } from './error.js';
import { ROLE_NAME } from './role.js';
import { RoleRegistry } from '../roles/registry.js';
import { assertNotReservedRoleId, isReservedRoleId } from '../roles/reserved.js';
export interface PipelineDefinition {
  schema: 'gbdev.pipeline.v1'; name: string; description: string;
  steps: { id: string; role: string }[];
  fix_loop?: { after: string; fix_role: string; max_rounds: number };
  timeout_min: number;
}
export function pipelineInvalid(message: string): never { throw new GbdevError('pipeline_invalid', message); }
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) pipelineInvalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function fields(v: Record<string, unknown>, allowed: string[]): void {
  // Cursor's explicit model restriction has priority over unknown-field diagnostics.
  if ('cursor_model' in v && v.cursor_model !== 'auto') throw new GbdevError('cursor_model_not_allowed', 'cursor_model must be auto');
  for (const key of Object.keys(v)) {
    if (isReservedRoleId(key)) assertNotReservedRoleId(key, 'pipeline_field');
    if (!allowed.includes(key)) pipelineInvalid(`Unknown field: ${key}`);
  }
}
export function range(v: unknown, label: string, min: number, max: number): asserts v is number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) pipelineInvalid(`${label} must be ${min}–${max}`);
}
export function validatePipeline(value: unknown, registry = new RoleRegistry(), filename?: string): PipelineDefinition {
  const v = record(value, 'pipeline');
  fields(v, ['schema', 'name', 'description', 'steps', 'fix_loop', 'timeout_min']);
  if (v.schema !== 'gbdev.pipeline.v1' || typeof v.name !== 'string' || !ROLE_NAME.test(v.name)) pipelineInvalid('Invalid pipeline schema/name');
  if (filename && filename !== `${v.name}.json`) pipelineInvalid('Filename must equal <name>.json');
  if (typeof v.description !== 'string' || !v.description.trim()) pipelineInvalid('description must be nonempty');
  range(v.timeout_min, 'timeout_min', 30, 480);
  if (!Array.isArray(v.steps) || v.steps.length < 1 || v.steps.length > 6) pipelineInvalid('steps must contain 1–6 entries');
  const ids = new Set<string>();
  const steps = v.steps.map(item => {
    const step = record(item, 'step'); fields(step, ['id', 'role']);
    if (typeof step.id !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(step.id) || ids.has(step.id)) pipelineInvalid('Invalid or duplicate step id');
    assertNotReservedRoleId(step.id, 'pipeline_step_id');
    ids.add(step.id);
    if (typeof step.role !== 'string') pipelineInvalid('Invalid step role');
    assertNotReservedRoleId(step.role, 'pipeline_step_role');
    return { id: step.id, role: registry.resolve(step.role).name };
  });
  const outputs = steps.map(s => registry.resolve(s.role).output);
  const change = outputs.indexOf('change');
  if (change >= 0 && outputs.slice(0, change).includes('verdict')) pipelineInvalid('verdict cannot precede the first change');
  let fix: PipelineDefinition['fix_loop'];
  if (v.fix_loop !== undefined) {
    const f = record(v.fix_loop, 'fix_loop'); fields(f, ['after', 'fix_role', 'max_rounds']);
    range(f.max_rounds, 'max_rounds', 0, 5);
    const after = steps.find(s => s.id === f.after);
    if (!after || registry.resolve(after.role).output !== 'verdict') pipelineInvalid('fix_loop.after must reference a verdict step');
    if (typeof f.fix_role !== 'string') pipelineInvalid('fix_role must be change');
    assertNotReservedRoleId(f.fix_role, 'fix_role');
    if (registry.resolve(f.fix_role).output !== 'change') pipelineInvalid('fix_role must be change');
    fix = { after: after.id, fix_role: registry.resolve(f.fix_role).name, max_rounds: f.max_rounds };
  }
  return { schema: 'gbdev.pipeline.v1', name: v.name, description: v.description, steps, ...(fix ? { fix_loop: fix } : {}), timeout_min: v.timeout_min };
}
