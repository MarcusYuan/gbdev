import { GbdevError } from './error.js';

/** Small, explicit JSON Schema subset used by the M3 contracts. No I/O or coercion. */
export interface JsonSchema {
  type?: string | string[]; const?: unknown; default?: unknown; enum?: readonly unknown[]; properties?: Record<string, JsonSchema>;
  required?: readonly string[]; additionalProperties?: boolean | JsonSchema; items?: JsonSchema;
  minItems?: number; maxItems?: number; uniqueItems?: boolean; minLength?: number; maxLength?: number;
  pattern?: string; minimum?: number; maximum?: number; anyOf?: JsonSchema[];
}
export const textSchema: JsonSchema = { type: 'string' };
export const nonempty: JsonSchema = { type: 'string', minLength: 1, pattern: '\\S' };
export const bool: JsonSchema = { type: 'boolean' };
export const number = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): JsonSchema => ({ type: 'integer', minimum, maximum });
export const enumeration = (...values: string[]): JsonSchema => ({ type: 'string', enum: values });
export const codexNullable = (s: JsonSchema): JsonSchema => ({ ...s, type: [...(Array.isArray(s.type) ? s.type : [s.type!]), 'null'], ...(s.enum ? { enum: [...s.enum, null] } : {}) });
export const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'null' }] });
export const list = (items: JsonSchema, minItems = 0, maxItems = Number.MAX_SAFE_INTEGER): JsonSchema => ({ type: 'array', items, minItems, maxItems });
export const closed = (properties: Record<string, JsonSchema>, optional: string[] = []): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
export const stringsSchema = list(nonempty);
export const taskIdSchema: JsonSchema = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,23}$' };
export const runIdSchema: JsonSchema = { type: 'string', pattern: '^r_[0-9]{8}_[0-9]{4}_[a-f0-9]{4}$' };
export const laneSchema: JsonSchema = { type: 'string', pattern: '^lane-[1-4]$' };
export const dateSchema: JsonSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?[+-]\\d{2}:\\d{2}$' };
export function schemaErrors(value: unknown, s: JsonSchema, path = '$'): string[] {
  if (s.anyOf) return s.anyOf.some(option => !schemaErrors(value, option, path).length) ? [] : [`${path}: no allowed shape matches`];
  const errors: string[] = [];
  if ('const' in s && value !== s.const) errors.push(`${path}: expected ${String(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: invalid enum value`);
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).some(t => t === type || t === 'integer' && Number.isSafeInteger(value))) return [...errors, `${path}: expected ${s.type}`];
  if (typeof value === 'number' && (!Number.isFinite(value) || value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity))) errors.push(`${path}: out of range`);
  if (typeof value === 'string') {
    if (value.length < (s.minLength ?? 0) || value.length > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(value)) errors.push(`${path}: invalid string`);
    if (s === dateSchema && !Number.isFinite(Date.parse(value))) errors.push(`${path}: invalid timestamp`);
  }
  if (Array.isArray(value)) {
    if (value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? Infinity)) errors.push(`${path}: invalid array length`);
    if (s.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) errors.push(`${path}: duplicate entries`);
    if (s.items) value.forEach((v, i) => errors.push(...schemaErrors(v, s.items!, `${path}[${i}]`)));
  } else if (value !== null && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const key of s.required ?? []) if (!Object.hasOwn(v, key)) errors.push(`${path}.${key}: required`);
    for (const [key, entry] of Object.entries(v)) {
      const child = s.properties && Object.hasOwn(s.properties, key) ? s.properties[key] : undefined;
      if (child) errors.push(...schemaErrors(entry, child, `${path}.${key}`));
      else if (s.additionalProperties === false) errors.push(`${path}.${key}: unknown field${key === 'check_cmd' || key === 'cmd' ? '; use check to reference checks[].id' : ''}`);
      else if (typeof s.additionalProperties === 'object') errors.push(...schemaErrors(entry, s.additionalProperties, `${path}.${key}`));
    }
  }
  return errors;
}
export function runInvalid(errors: string[]): never { throw new GbdevError('run_invalid', errors.join('; '), { errors }); }
export function assertSchema(value: unknown, schema: JsonSchema): void { const errors = schemaErrors(value, schema); if (errors.length) runInvalid(errors); }
/** Model restriction takes precedence even when the containing object has unknown fields. */
export function assertCursorModels(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(assertCursorModels); return; }
  const v = value as Record<string, unknown>;
  if ('cursor_model' in v && v.cursor_model !== 'auto' || v.provider === 'cursor' && v.model !== undefined && v.model !== null && v.model !== 'auto') throw new GbdevError('cursor_model_not_allowed', 'Cursor model must be auto');
  Object.values(v).forEach(assertCursorModels);
}
