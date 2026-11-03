import { RoleRegistry } from '../roles/registry.js';
import type { GbdevPaths } from '../core/paths.js';

export function listRoles(paths: GbdevPaths) { return new RoleRegistry(paths.config).list(); }
export function showRole(paths: GbdevPaths, name: string) { return new RoleRegistry(paths.config).resolve(name); }
