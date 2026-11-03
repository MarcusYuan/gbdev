import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { validateBrief } from '../src/contracts/brief.js';
import { validateRole } from '../src/contracts/role.js';
import { validateConfig } from '../src/core/config.js';
import { buildCodexArgs } from '../src/providers/codex.js';
import { RoleRegistry } from '../src/roles/registry.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { brief, errorCode, temporary } from './helpers.js';
import { tmpRepo } from './helpers/tmpRepo.js';

const executor = () => builtinRoles().find(r => r.name === 'executor')!;
for (const codex_model of ['', ' ', '\t\n']) test(`C1 rejects blank codex_model ${JSON.stringify(codex_model)}`, () => {
  assert.throws(() => validateRole({ ...executor(), codex_model }), errorCode('role_invalid'));
});
for (const model of [null, '', ' ', '\t\n', 'model-name']) test(`C1 defensive Codex args for model ${JSON.stringify(model)}`, () => {
  const args = buildCodexArgs({ bin: 'codex', worktree: '/repo', jobDir: '/job', prompt: 'task', sandbox: 'workspace-write', network: false, model });
  assert.equal(args.includes('-m'), model === 'model-name');
  if (model === 'model-name') assert.equal(args[args.indexOf('-m') + 1], model);
});
test('C1 null means no model override; explicit empty brief model is still invalid', t => {
  const root = temporary(t), config = validateConfig({ version: 1, allowed_repos: [root] });
  const input: Record<string, unknown> = { ...brief(root), provider: 'codex' }; delete input.model;
  assert.equal(validateBrief(input, config).model, null);
  assert.throws(() => validateBrief({ ...input, model: '' }, config), errorCode('config_invalid'));
});
test('C1 blank user role is invalid in list/start and does not fall back to builtin', async t => {
  const h = tmpRepo(t);
  mkdirSync(join(h.root, 'roles'));
  writeFileSync(join(h.root, 'roles', 'executor.json'), JSON.stringify({ schema: 'gbdev.role.v1', name: 'executor', codex_model: ' ' }));
  const registry = new RoleRegistry(h.config);
  assert.equal(registry.list().invalid[0]!.code, 'role_invalid');
  assert.throws(() => registry.resolve('executor'), errorCode('role_invalid'));
  const out = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(out.exit, 2); assert.equal(!out.envelope.ok && out.envelope.error.code, 'role_invalid');
});
test('C2 reserved alias user role is invalid; alias resolves only builtin/overridden reviewer', async t => {
  const h = tmpRepo(t), roles = join(h.root, 'roles'); mkdirSync(roles);
  const alias = { ...executor(), name: 'code-reviewer' };
  assert.throws(() => validateRole(alias), errorCode('role_invalid'));
  writeFileSync(join(roles, 'code-reviewer.json'), JSON.stringify(alias));
  let registry = new RoleRegistry(h.config);
  assert.equal(registry.resolve('code-reviewer').name, 'reviewer');
  assert.equal(registry.resolve('code-reviewer').source, 'builtin');
  writeFileSync(join(roles, 'reviewer.json'), JSON.stringify({ schema: 'gbdev.role.v1', name: 'reviewer', description: 'Overridden reviewer' }));
  registry = new RoleRegistry(h.config);
  assert.equal(registry.resolve('code-reviewer').description, 'Overridden reviewer');
  assert.equal(registry.resolve('code-reviewer').source, 'builtin+user');
  const output = await h.command(['roles', 'list']);
  assert.equal(output.exit, 0); assert.equal(output.envelope.ok, true);
  if (!output.envelope.ok) throw new Error('Expected list');
  const list = output.envelope.result as ReturnType<RoleRegistry['list']>;
  assert.ok(!list.roles.some(r => r.name === 'code-reviewer'));
  assert.deepEqual(list.aliases, { 'code-reviewer': 'reviewer' });
  assert.equal(list.invalid[0]!.name, 'code-reviewer'); assert.equal(list.invalid[0]!.code, 'role_invalid');
  writeFileSync(join(roles, 'reviewer.json'), '{}');
  assert.throws(() => new RoleRegistry(h.config).resolve('code-reviewer'), errorCode('role_invalid'));
});
test('C3 role JSON swapped to symlink after directory scan fails closed (TOCTOU regression)', t => {
  const root = temporary(t), dir = join(root, 'roles'); mkdirSync(dir);
  const file = join(dir, 'executor.json'), target = join(root, 'target.json');
  writeFileSync(file, JSON.stringify(executor()));
  writeFileSync(target, JSON.stringify({ ...executor(), description: 'Must not be read through symlink' }));
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    const entries = Reflect.apply(original, fs, args);
    if (String(args[0]) === dir) { unlinkSync(file); symlinkSync(target, file); }
    return entries;
  });
  syncBuiltinESMExports();
  try {
    const registry = new RoleRegistry(join(root, 'config.json'));
    assert.throws(() => registry.resolve('executor'), errorCode('role_invalid'));
    assert.equal(registry.list().invalid.length, 1);
    assert.equal(registry.resolve('reviewer').source, 'builtin');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
test('C3 role JSON read uses the validated descriptor, not a reopened pathname', t => {
  const root = temporary(t), dir = join(root, 'roles'); mkdirSync(dir);
  const file = join(dir, 'executor.json'), target = join(root, 'target.json');
  writeFileSync(file, JSON.stringify({ ...executor(), description: 'Opened file' }));
  writeFileSync(target, JSON.stringify({ ...executor(), description: 'Wrong replacement' }));
  const original = fs.fstatSync;
  let replaced = false;
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = Reflect.apply(original, fs, args);
    if (!replaced) { replaced = true; renameSync(file, `${file}.old`); symlinkSync(target, file); }
    return stat;
  });
  syncBuiltinESMExports();
  try { assert.equal(new RoleRegistry(join(root, 'config.json')).resolve('executor').description, 'Opened file'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
test('C4 reviewer preserves all SPEC example sentences and forbids self-approval', () => {
  const spec = readFileSync('docs/specs/SPEC-M2.md', 'utf8');
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(spec.split('### 4.1 gbdev.role.v1')[1]!)![1]!);
  const instructions = new RoleRegistry().resolve('reviewer').instructions;
  assert.deepEqual(instructions.slice(0, example.instructions.length), example.instructions);
  assert.ok(instructions.includes('Never approve changes you authored.'));
  for (const command of ['git diff', 'git log', 'cat', 'rg']) assert.ok(instructions.join('\n').includes(command));
});
