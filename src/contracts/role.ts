import { GbdevError } from './error.js';
import type { Provider, Sandbox } from './brief.js';
import { assertNotReservedRoleId, isReservedRoleId } from '../roles/reserved.js';

export const ROLE_NAME = /^[a-z][a-z0-9-]{1,31}$/;
export type RoleSource = 'builtin' | 'builtin+user' | 'user';
export interface RoleDefinition {
  schema: 'gbdev.role.v1';
  name: string;
  description: string;
  output: 'change' | 'verdict' | 'report';
  sandbox: Sandbox;
  provider: Provider;
  allowed_providers: Provider[];
  codex_model: string | null;
  cursor_model: 'auto';
  default_timeout_min: number;
  default_stall_timeout_s: number;
  instructions: string[];
  instructions_file: string | null;
}
export interface ResolvedRole extends RoleDefinition {
  source: RoleSource;
  instructions_text: string;
}
export interface InvalidRole { file: string; name: string; code: 'role_invalid' | 'cursor_model_not_allowed' | 'role_fixed'; message: string }
export interface RoleList {
  schema: 'gbdev.role-list.v1';
  roles: Pick<ResolvedRole, 'name' | 'source' | 'output' | 'sandbox' | 'provider' | 'allowed_providers' | 'description'>[];
  invalid: InvalidRole[];
  aliases: Record<string, string>;
}
const fields = ['schema', 'name', 'description', 'output', 'sandbox', 'provider', 'allowed_providers', 'codex_model',
  'cursor_model', 'default_timeout_min', 'default_stall_timeout_s', 'instructions', 'instructions_file'];
export function roleInvalid(message: string): never { throw new GbdevError('role_invalid', message); }

function assertInspectorConstraints(role: RoleDefinition): void {
  if (role.name !== 'inspector') return;
  if (role.output !== 'report' || role.sandbox !== 'read-only') {
    roleInvalid('inspector must remain report / read-only');
  }
  if (!role.allowed_providers.every(p => p === 'cursor' || p === 'fake')
      || (role.provider !== 'cursor' && role.provider !== 'fake')) {
    roleInvalid('inspector provider must be cursor or fake');
  }
}

export function validateRole(value: unknown, filename?: string): RoleDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) roleInvalid('Role must be an object');
  const v = value as Record<string, unknown>;
  if (Object.hasOwn(v, 'cursor_model') && v.cursor_model !== 'auto') {
    throw new GbdevError('cursor_model_not_allowed', 'Role cursor_model must be auto');
  }
  for (const key of Object.keys(v)) if (!fields.includes(key)) roleInvalid(`Unknown role field: ${key}`);
  if (v.schema !== 'gbdev.role.v1') roleInvalid('schema must be gbdev.role.v1');
  if (typeof v.name === 'string' && isReservedRoleId(v.name)) assertNotReservedRoleId(v.name, 'role.name');
  if (typeof v.name !== 'string' || !ROLE_NAME.test(v.name)) roleInvalid('Invalid role name');
  if (v.name === 'code-reviewer') roleInvalid('code-reviewer is a reserved alias for reviewer');
  if (filename !== undefined && filename !== `${v.name}.json`) roleInvalid('Filename must equal <name>.json');
  if (typeof v.description !== 'string' || !v.description.trim() || v.description.length > 200) roleInvalid('description must be nonempty and at most 200 characters');
  if (typeof v.output !== 'string' || !['change', 'verdict', 'report'].includes(v.output)) roleInvalid('Invalid role output');
  const sandbox = v.output === 'change' ? 'workspace-write' : 'read-only';
  if (v.sandbox !== sandbox) roleInvalid(`output=${v.output} requires sandbox=${sandbox}`);
  if (!Array.isArray(v.allowed_providers) || !v.allowed_providers.length ||
      !v.allowed_providers.every(p => ['codex', 'cursor', 'fake'].includes(p)) ||
      new Set(v.allowed_providers).size !== v.allowed_providers.length) roleInvalid('allowed_providers must be a nonempty subset of codex, cursor, fake');
  if (v.name === 'resolver' && v.allowed_providers.includes('cursor')) roleInvalid('resolver does not allow cursor');
  if (!v.allowed_providers.includes(v.provider)) roleInvalid('provider must be in allowed_providers');
  if (v.codex_model !== null && (typeof v.codex_model !== 'string' || !v.codex_model.trim())) roleInvalid('codex_model must be a nonempty string or null');
  if (!Number.isInteger(v.default_timeout_min) || Number(v.default_timeout_min) < 1 || Number(v.default_timeout_min) > 240) roleInvalid('default_timeout_min must be an integer in 1–240');
  if (!Number.isSafeInteger(v.default_stall_timeout_s) || Number(v.default_stall_timeout_s) < 0) roleInvalid('default_stall_timeout_s must be a nonnegative safe integer');
  if (!Array.isArray(v.instructions) || v.instructions.length > 40 || !v.instructions.every(s => typeof s === 'string' && s.length <= 500)) roleInvalid('instructions must contain at most 40 strings, each at most 500 characters');
  if (v.instructions_file !== null && (typeof v.instructions_file !== 'string' || !/^[a-z0-9-]+\.md$/.test(v.instructions_file))) roleInvalid('instructions_file must be null or a same-directory .md filename');
  const role = structuredClone({ ...v, codex_model: typeof v.codex_model === 'string' ? v.codex_model.trim() : null, cursor_model: 'auto' }) as RoleDefinition;
  assertInspectorConstraints(role);
  return role;
}

export function validateResolvedRole(value: unknown): ResolvedRole {
  if (!value || typeof value !== 'object' || Array.isArray(value)) roleInvalid('Resolved role must be an object');
  const { source, instructions_text, ...role } = value as Record<string, unknown>;
  validateRole(role);
  if (typeof source !== 'string' || !['builtin', 'builtin+user', 'user'].includes(source) || typeof instructions_text !== 'string') roleInvalid('Invalid resolved role metadata');
  return value as ResolvedRole;
}
export function validateRoleList(value: unknown): RoleList {
  const v = value as RoleList;
  if (!v || v.schema !== 'gbdev.role-list.v1' || !Array.isArray(v.roles) || !Array.isArray(v.invalid) ||
      !v.aliases || Object.keys(v.aliases).length !== 1 || v.aliases['code-reviewer'] !== 'reviewer') roleInvalid('Invalid role list');
  for (const role of v.roles) validateResolvedRole({ codex_model: null, cursor_model: 'auto', default_timeout_min: 30,
    default_stall_timeout_s: 600, instructions: [], instructions_file: null, instructions_text: '', schema: 'gbdev.role.v1', ...role });
  for (const entry of v.invalid) if (!entry || typeof entry.file !== 'string' || typeof entry.name !== 'string' ||
    !['role_invalid', 'cursor_model_not_allowed', 'role_fixed'].includes(entry.code) || typeof entry.message !== 'string') roleInvalid('Invalid role error entry');
  return v;
}
