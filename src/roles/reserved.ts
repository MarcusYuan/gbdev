import { GbdevError } from '../contracts/error.js';

/** Fixed control-plane identifiers, including legacy grokbot/grok-bot compatibility aliases.
 * Keep these reserved so old configs cannot accidentally dispatch a decider as a worker. */
export const RESERVED_ROLE_IDS = ['grokbot', 'grok-bot', 'dispatcher', 'decider'] as const;

export type ReservedRoleId = typeof RESERVED_ROLE_IDS[number];

export function normalizeRoleId(value: string): string {
  return value.trim().toLowerCase();
}

export function isReservedRoleId(value: string): boolean {
  return (RESERVED_ROLE_IDS as readonly string[]).includes(normalizeRoleId(value));
}

/** True for role_fixed / cursor_model_not_allowed — outer wrappers must not remap these. */
export function isPreservedRoleError(error: unknown): error is GbdevError {
  return error instanceof GbdevError
    && (error.contract.code === 'role_fixed' || error.contract.code === 'cursor_model_not_allowed');
}

export function assertNotReservedRoleId(name: string, surface: string): void {
  if (!isReservedRoleId(name)) return;
  throw new GbdevError(
    'role_fixed',
    'controller is a fixed control-plane role and cannot be configured or dispatched as a worker',
    { name: normalizeRoleId(name), surface },
  );
}

/** Reject reserved keys in a configuration object (values may be null; still rejected). */
export function rejectReservedObjectKeys(value: Record<string, unknown>, surface: string): void {
  for (const key of Object.keys(value)) assertNotReservedRoleId(key, surface);
}
