import { GbdevError } from './error.js';

export type ObjectValue = Record<string, unknown>;

export function invalid(message: string): never {
  throw new GbdevError('config_invalid', message);
}

export function object(value: unknown, name: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as ObjectValue;
}

export function string(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(`${name} must be a nonempty string`);
}

export function strings(value: unknown, name: string, nonempty = false): asserts value is string[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) invalid(`${name} must be an array${nonempty ? ' with at least one item' : ''}`);
  value.forEach((item, i) => string(item, `${name}[${i}]`));
}

export function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${name} must be an array`);
  return value;
}

export function oneOf<T extends string>(value: unknown, choices: readonly T[], name: string): asserts value is T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(`${name} must be one of ${choices.join(', ')}`);
}

export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${name} must be an integer between ${min} and ${max}`);
}

export function boolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') invalid(`${name} must be a boolean`);
}

export function nullableString(value: unknown, name: string): asserts value is string | null {
  if (value !== null) string(value, name);
}

export function schema(value: ObjectValue, expected: string): void {
  if (value.schema !== expected) invalid(`schema must be ${expected}`);
}

export function timestamp(value: unknown, name: string): asserts value is string {
  string(value, name);
  // Require an explicit numeric offset rather than UTC's "Z" shorthand.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid(`${name} must be ISO 8601 with a numeric offset`);
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      Number(offsetHour) > 23 || Number(offsetMinute) > 59) invalid(`${name} has invalid date components`);
}
