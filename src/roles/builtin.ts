import { type RoleDefinition } from '../contracts/role.js';
import { ROLE_SOURCES } from './catalog.generated.js';

export function builtinRoles(): RoleDefinition[] {
  return ROLE_SOURCES.map(role => ({
    schema: 'gbdev.role.v1',
    name: role.name,
    description: role.description,
    output: role.output,
    sandbox: role.sandbox,
    provider: role.provider,
    allowed_providers: [...role.allowed_providers],
    codex_model: role.codex_model,
    cursor_model: 'auto',
    default_timeout_min: role.default_timeout_min,
    default_stall_timeout_s: role.default_stall_timeout_s,
    instructions: [...role.instructions],
    instructions_file: null,
  }));
}
