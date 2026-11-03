import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { validatePipeline, type PipelineDefinition } from '../contracts/pipeline.js';
import { RoleRegistry } from '../roles/registry.js';
export function builtinPipelines(): PipelineDefinition[] {
  return [
    ['implement-review', [['implement', 'executor'], ['review', 'reviewer']]],
    ['plan-implement-review', [['plan', 'planner'], ['implement', 'executor'], ['review', 'reviewer']]],
    ['review-only', [['review', 'reviewer']]],
    ['implement-verify', [['implement', 'executor'], ['verify', 'verifier']]],
    ['integration-fix', [['fix', 'fixer'], ['review', 'reviewer']]],
    ['final-fix', [['fix', 'fixer'], ['review', 'reviewer']]],
  ].map(([name, pairs]) => {
    const steps = (pairs as string[][]).map(([id, role]) => ({ id: id!, role: role! }));
    return { schema: 'gbdev.pipeline.v1', name: name as string, description: steps.map(s => s.id).join(' → '), steps,
      ...(name === 'review-only' ? {} : { fix_loop: { after: steps.at(-1)!.id, fix_role: 'fixer', max_rounds: name === 'integration-fix' || name === 'final-fix' ? 1 : 2 } }), timeout_min: 240 };
  });
}
export class PipelineRegistry {
  private definitions = new Map<string, { definition: PipelineDefinition; source: 'builtin' | 'user' }>();
  private errors = new Map<string, { name: string; file: string; code: string; message: string }>();
  constructor(config: string, readonly roles = new RoleRegistry(config)) {
    for (const definition of builtinPipelines()) {
      try { this.definitions.set(definition.name, { definition: validatePipeline(definition, roles), source: 'builtin' }); }
      catch (e) { this.error(definition.name, 'builtin', e); }
    }
    const directory = join(dirname(config), 'pipelines');
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new GbdevError('pipeline_invalid', 'Cannot read pipelines directory'); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.json') || entry.isDirectory()) continue;
      const name = basename(entry.name, '.json'), file = join(directory, entry.name);
      try {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let value;
        try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Template must be a regular file of at most 64 KiB'); value = JSON.parse(readFileSync(fd, 'utf8')); }
        finally { closeSync(fd); }
        this.definitions.set(name, { definition: validatePipeline(value, roles, entry.name), source: 'user' }); this.errors.delete(name);
      } catch (e) { this.error(name, file, e); }
    }
  }
  private error(name: string, file: string, e: unknown): void {
    this.definitions.delete(name); this.errors.set(name, { name, file, code: e instanceof GbdevError ? e.contract.code : 'pipeline_invalid', message: String(e) });
  }
  resolve(name: string): PipelineDefinition {
    const error = this.errors.get(name);
    if (error) {
      const code = error.code === 'cursor_model_not_allowed' || error.code === 'role_fixed' ? error.code : 'pipeline_invalid';
      throw new GbdevError(code as 'cursor_model_not_allowed' | 'role_fixed' | 'pipeline_invalid', error.message, { ...error });
    }
    const found = this.definitions.get(name);
    if (!found) throw new GbdevError('pipeline_not_found', `Pipeline template not found: ${name}`);
    return structuredClone(found.definition);
  }
  list() {
    return { schema: 'gbdev.pipeline-list.v1' as const, pipelines: [...this.definitions.values()].map(({ definition: d, source }) => ({ name: d.name, source, ...(['integration-fix', 'final-fix'].includes(d.name) ? { internal: true } : {}), steps: d.steps.map(s => s.id), fix_loop: d.fix_loop ?? null, description: d.description })), invalid: [...this.errors.values()] };
  }
}
