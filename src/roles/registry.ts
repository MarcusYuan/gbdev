import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { roleInvalid, validateRole, type InvalidRole, type ResolvedRole, type RoleDefinition, type RoleList, type RoleSource } from '../contracts/role.js';
import { builtinRoles } from './builtin.js';
import { ROLE_ALIASES as GENERATED_ALIASES } from './catalog.generated.js';
import { assertNotReservedRoleId } from './reserved.js';

export const ROLE_ALIASES = Object.freeze({ ...GENERATED_ALIASES }) as Readonly<Record<string, string>>;

function roleFile(file: string): unknown {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') roleInvalid('Role JSON must be a regular file, not a symlink');
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) roleInvalid('Role JSON must be a regular file');
    if (stat.size > 64 * 1024) roleInvalid('Role JSON exceeds 64 KiB');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

function instructionsFile(file: string): string {
  // A same-directory filename must not escape through a symlink or block on a FIFO.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024) roleInvalid('instructions_file must be a regular UTF-8 file of at most 32 KiB');
    const bytes = Buffer.alloc(32 * 1024 + 1);
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > 32 * 1024) roleInvalid('instructions_file exceeds 32 KiB');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}
function snapshot(role: RoleDefinition, source: RoleSource, extra = ''): ResolvedRole {
  const resolved = { ...role, source, instructions_text: [...role.instructions, ...(extra ? [extra] : [])].join('\n') };
  Object.freeze(resolved.instructions);
  Object.freeze(resolved.allowed_providers);
  return Object.freeze(resolved);
}

/** Each load resolves instructions once; consumers retain an immutable, filesystem-independent snapshot. */
export class RoleRegistry {
  private readonly roles = new Map<string, ResolvedRole>();
  private directoryError: InvalidRole | undefined;
  private readonly errors = new Map<string, InvalidRole>();
  constructor(configPath?: string) {
    const builtins = new Map(builtinRoles().map(role => [role.name, role]));
    for (const role of builtins.values()) this.roles.set(role.name, snapshot(validateRole(role), 'builtin'));
    if (configPath === undefined) return; // Pure builtins for contract validation; never read ambient user configuration.
    const dir = join(dirname(configPath), 'roles');
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // If the registry cannot be enumerated, no builtin fallback can safely be assumed.
      this.roles.clear();
      this.directoryError = { file: dir, name: 'roles', code: 'role_invalid', message: `Cannot read roles directory: ${dir}` };
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!entry.name.endsWith('.json') || entry.isDirectory()) continue;
      const file = join(dir, entry.name), name = basename(entry.name, '.json');
      try {
        assertNotReservedRoleId(name, 'user_role_file');
        const user = roleFile(file);
        if (!user || typeof user !== 'object' || Array.isArray(user)) roleInvalid('Role must be an object');
        const fields = user as Record<string, unknown>;
        if (!Object.hasOwn(fields, 'schema') || !Object.hasOwn(fields, 'name')) roleInvalid('User role must specify schema and name');
        if (typeof fields.name === 'string') assertNotReservedRoleId(fields.name, 'role.name');
        const builtin = builtins.get(name);
        const role = validateRole({ ...builtin, ...fields }, entry.name);
        const extra = role.instructions_file === null ? '' : instructionsFile(join(dir, role.instructions_file));
        this.roles.set(name, snapshot(role, builtin ? 'builtin+user' : 'user', extra));
      } catch (error) {
        this.roles.delete(name); // Explicit invalid overrides never fall back to builtins.
        let code: InvalidRole['code'] = 'role_invalid';
        if (error instanceof GbdevError
            && (error.contract.code === 'role_fixed' || error.contract.code === 'cursor_model_not_allowed')) {
          code = error.contract.code;
        }
        this.errors.set(name, { file, name, code, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  resolve(name: string): ResolvedRole {
    assertNotReservedRoleId(name, 'resolve');
    if (this.directoryError) throw new GbdevError('role_invalid', this.directoryError.message, { ...this.directoryError });
    const canonical = Object.hasOwn(ROLE_ALIASES, name) ? ROLE_ALIASES[name]! : name;
    assertNotReservedRoleId(canonical, 'resolve');
    // Alias-named user files are diagnostics only; the canonical role controls resolution.
    const error = this.errors.get(canonical);
    if (error) throw new GbdevError(error.code, error.message, { ...error });
    const role = this.roles.get(canonical);
    if (!role) throw new GbdevError('role_not_found', `Role not found: ${name}`, { name });
    return role;
  }
  list(): RoleList {
    return { schema: 'gbdev.role-list.v1', roles: [...this.roles.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))
      .map(({ name, source, output, sandbox, provider, allowed_providers, description }) =>
        ({ name, source, output, sandbox, provider, allowed_providers: [...allowed_providers], description })),
    invalid: [...(this.directoryError ? [this.directoryError] : []), ...this.errors.values()].map(error => ({ ...error })), aliases: { ...ROLE_ALIASES } };
  }
}
