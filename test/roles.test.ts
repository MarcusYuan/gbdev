import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { validateBrief } from '../src/contracts/brief.js';
import { validateRole, validateResolvedRole, validateRoleList } from '../src/contracts/role.js';
import { validateJobStatus } from '../src/contracts/jobStatus.js';
import { validateConfig } from '../src/core/config.js';
import { RoleRegistry } from '../src/roles/registry.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { brief, errorCode, job, temporary } from './helpers.js';
import { providerStub } from './helpers/providerStub.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';

const executor = () => builtinRoles().find(r => r.name === 'executor')!;
const reviewer = () => builtinRoles().find(r => r.name === 'reviewer')!;
function putRole(root: string, name: string, value: unknown) {
  mkdirSync(join(root, 'roles'), { recursive: true });
  writeFileSync(join(root, 'roles', `${name}.json`), JSON.stringify(value));
}
const patch = (fields: Record<string, unknown> = {}) => ({ schema: 'gbdev.role.v1', name: 'executor', ...fields });

const badRoles: [string, Record<string, unknown>][] = [
  ['schema', { schema: 'wrong' }], ['name uppercase', { name: 'Executor' }], ['name short', { name: 'x' }],
  ['name long', { name: 'x'.repeat(33) }], ['name traversal', { name: '../executor' }],
  ['description empty', { description: ' ' }], ['description long', { description: 'x'.repeat(201) }],
  ['output', { output: 'other' }], ['output type', { output: ['change'] }],
  ['change sandbox', { sandbox: 'read-only' }], ['verdict sandbox', { output: 'verdict' }], ['report sandbox', { output: 'report' }],
  ['provider membership', { provider: 'cursor', allowed_providers: ['codex'] }],
  ['provider unknown', { provider: 'other' }], ['allowed_providers empty', { allowed_providers: [] }],
  ['allowed_providers unknown', { allowed_providers: ['codex', 'other'] }],
  ['allowed_providers type', { allowed_providers: 'codex' }], ['allowed_providers duplicate', { allowed_providers: ['codex', 'codex'] }],
  ['codex_model type', { codex_model: 5 }], ['timeout low', { default_timeout_min: 0 }],
  ['timeout high', { default_timeout_min: 241 }], ['timeout fraction', { default_timeout_min: 1.5 }],
  ['timeout type', { default_timeout_min: '30' }], ['stall negative', { default_stall_timeout_s: -1 }],
  ['stall fraction', { default_stall_timeout_s: 0.1 }], ['stall unsafe', { default_stall_timeout_s: Number.MAX_SAFE_INTEGER + 1 }],
  ['instructions type', { instructions: 'text' }], ['instruction non-string', { instructions: [1] }],
  ['instruction too long', { instructions: ['x'.repeat(501)] }], ['instructions too many', { instructions: Array(41).fill('x') }],
  ['instructions_file traversal', { instructions_file: '../secret.md' }], ['instructions_file absolute', { instructions_file: '/tmp/secret.md' }],
  ['instructions_file uppercase', { instructions_file: 'Secret.md' }], ['instructions_file extension', { instructions_file: 'notes.txt' }],
  ['unknown field', { extra: true }],
];
for (const [name, changes] of badRoles) test(`AC-S1.2 §4.1 rejects ${name}`, () => {
  assert.throws(() => validateRole({ ...executor(), ...changes }), errorCode('role_invalid'));
});
for (const value of [null, [], 1, 'role']) test(`AC-S1.2 rejects root ${JSON.stringify(value)}`, () => {
  assert.throws(() => validateRole(value), errorCode('role_invalid'));
});
for (const key of Object.keys(executor()).filter(key => key !== 'cursor_model')) test(`AC-S1.2 requires ${key} for a new role`, () => {
  const value: Record<string, unknown> = { ...executor() };
  delete value[key];
  assert.throws(() => validateRole(value), errorCode('role_invalid'));
});
for (const cursor_model of [null, 'sonnet', '', 42, false]) test(`AC-S1.2 cursor_model ${JSON.stringify(cursor_model)} is forbidden even for Codex roles`, () => {
  assert.throws(() => validateRole({ ...executor(), cursor_model }), errorCode('cursor_model_not_allowed'));
});

test('AC-S1.2 role boundary values and omitted cursor_model are valid', () => {
  const value: Record<string, unknown> = { ...executor(), name: 'a'.repeat(32), description: 'x'.repeat(200), instructions: Array(40).fill('x'.repeat(500)),
    default_stall_timeout_s: Number.MAX_SAFE_INTEGER, default_timeout_min: 240, codex_model: null };
  delete value.cursor_model;
  assert.equal(validateRole(value).cursor_model, 'auto');
  assert.equal(validateRole({ ...executor(), default_stall_timeout_s: 0, default_timeout_min: 1, instructions: [] }).default_stall_timeout_s, 0);
  assert.throws(() => validateRole(executor(), 'wrong.json'), errorCode('role_invalid'));
});

for (const mode of ['missing', 'oversize', 'invalid-utf8', 'directory', 'symlink'] as const) {
  test(`AC-S1.2 instructions_file rejects ${mode}`, t => {
    const root = temporary(t);
    putRole(root, 'executor', patch({ instructions_file: 'extra.md' }));
    const file = join(root, 'roles', 'extra.md');
    if (mode === 'oversize') writeFileSync(file, Buffer.alloc(32769, 97));
    if (mode === 'invalid-utf8') writeFileSync(file, Buffer.from([0xc3, 0x28]));
    if (mode === 'directory') mkdirSync(file);
    if (mode === 'symlink') {
      writeFileSync(join(root, 'outside.md'), 'outside role directory');
      symlinkSync(join(root, 'outside.md'), file);
    }
    const registry = new RoleRegistry(join(root, 'config.json'));
    assert.throws(() => registry.resolve('executor'), errorCode('role_invalid'));
    assert.equal(registry.resolve('reviewer').name, 'reviewer');
    assert.equal(registry.list().invalid.length, 1);
  });
}

test('AC-S1.1 builtins list/show, JSON envelopes, text and help', async t => {
  const h = tmpRepo(t);
  const listed = await h.command(['roles', 'list']);
  assert.equal(listed.exit, 0);
  assert.equal(listed.envelope.ok && listed.envelope.result_schema, 'gbdev.role-list.v1');
  const list = validateRoleList(unwrap(listed.envelope));
  assert.deepEqual(list.roles.map(r => r.name), ['executor', 'fixer', 'inspector', 'planner', 'resolver', 'reviewer', 'verifier']);
  assert.deepEqual(list.invalid, []);
  assert.deepEqual(list.aliases, { 'code-reviewer': 'reviewer' });
  const expected = { executor: [45, 600], fixer: [30, 600], inspector: [10, 120], planner: [20, 600], resolver: [30, 600], reviewer: [40, 900], verifier: [30, 600] };
  for (const item of list.roles) {
    const shown = await h.command(['roles', 'show', item.name]);
    assert.equal(shown.exit, 0);
    assert.equal(shown.envelope.ok && shown.envelope.result_schema, 'gbdev.role.v1');
    const role = validateResolvedRole(unwrap(shown.envelope));
    assert.deepEqual([role.default_timeout_min, role.default_stall_timeout_s], expected[item.name as keyof typeof expected]);
    assert.equal(role.source, 'builtin');
    assert.equal(role.instructions_text, role.instructions.join('\n'));
  }
  for (const args of [['roles', 'list'], ['roles', 'show', 'reviewer'], ['--help']]) {
    const human = spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { env: h.env, encoding: 'utf8' });
    assert.equal(human.status, 0);
    assert.equal(human.stderr, '');
    assert.match(human.stdout, args[0] === '--help' ? /roles list\nroles show <name>/ : /reviewer/);
  }
  for (const args of [['roles'], ['roles', 'list', 'extra'], ['roles', 'show'], ['roles', 'remove', 'executor'], ['roles', 'show', 'executor', 'extra'], ['roles', 'list', '--brief', '-']]) {
    const bad = await h.command(args);
    assert.equal(bad.exit, 2);
    assert.equal(!bad.envelope.ok && bad.envelope.error.code, 'usage_error');
  }
  const absent = await h.command(['roles', 'show', 'unknown']);
  assert.equal(absent.exit, 1);
  assert.equal(!absent.envelope.ok && absent.envelope.error.code, 'role_not_found');
  assert.equal(existsSync(h.home), false, 'roles commands do not create job/home directories');
});

test('AC-S1.1/1.4 invalid files are isolated, sorted, fail closed, and ignored entries stay ignored', async t => {
  const h = tmpRepo(t);
  putRole(h.root, 'executor', patch({ extra: true }));
  putRole(h.root, 'bad', {});
  putRole(h.root, 'broken', {});
  writeFileSync(join(h.root, 'roles', 'broken.json'), '{bad');
  writeFileSync(join(h.root, 'roles', 'ignore.txt'), '{bad');
  mkdirSync(join(h.root, 'roles', 'subdir.json'));
  putRole(h.root, 'analyst', { ...reviewer(), name: 'analyst', output: 'report' });
  const listed = await h.command(['roles', 'list']);
  assert.equal(listed.exit, 0);
  const list = validateRoleList(unwrap(listed.envelope));
  assert.deepEqual(list.invalid.map(e => e.name), ['bad', 'broken', 'executor']);
  assert.equal(list.roles.some(r => r.name === 'executor'), false);
  assert.equal(validateResolvedRole(unwrap((await h.command(['roles', 'show', 'analyst'])).envelope)).source, 'user');
  const bad = await h.command(['roles', 'show', 'executor']);
  assert.equal(bad.exit, 2);
  assert.equal(!bad.envelope.ok && bad.envelope.error.code, 'role_invalid');
  assert.equal(!bad.envelope.ok && bad.envelope.error.details.file, join(h.root, 'roles', 'executor.json'));
  const failedStart = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(failedStart.exit, 2);
  assert.equal(!failedStart.envelope.ok && failedStart.envelope.error.code, 'role_invalid');
  assert.equal(existsSync(h.home), false);
  writeFileSync(h.briefFile, JSON.stringify({ ...h.task, role: 'fixer' }));
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded');
});

for (const fields of [{ name: 'reviewer' }, { schema: 'wrong' }, { name: undefined }, { schema: undefined }]) {
  test(`AC-S1.4 override requires matching filename and explicit schema/name: ${JSON.stringify(fields)}`, t => {
    const root = temporary(t);
    putRole(root, 'executor', patch(fields));
    const registry = new RoleRegistry(join(root, 'config.json'));
    assert.throws(() => registry.resolve('executor'), errorCode('role_invalid'));
    assert.equal(registry.resolve('reviewer').source, 'builtin');
  });
}

test('AC-S1.4 shallow merge, instruction append, immutable resolution and alias', t => {
  const root = temporary(t);
  putRole(root, 'executor', patch({ instructions: ['Replacement only.'], instructions_file: 'extra.md', allowed_providers: ['fake'], provider: 'fake' }));
  writeFileSync(join(root, 'roles', 'extra.md'), '追加 UTF-8\n');
  const registry = new RoleRegistry(join(root, 'config.json'));
  const role = registry.resolve('executor');
  assert.equal(role.source, 'builtin+user');
  assert.deepEqual(role.instructions, ['Replacement only.']);
  assert.deepEqual(role.allowed_providers, ['fake']);
  assert.equal(role.description, executor().description);
  assert.equal(role.instructions_text, 'Replacement only.\n追加 UTF-8\n');
  assert.throws(() => role.instructions.push('mutate'), TypeError);
  assert.throws(() => { role.provider = 'cursor'; }, TypeError);
  writeFileSync(join(root, 'roles', 'extra.md'), 'changed');
  assert.equal(registry.resolve('executor').instructions_text, role.instructions_text);
  assert.match(new RoleRegistry(join(root, 'config.json')).resolve('executor').instructions_text, /changed$/);
  assert.deepEqual(registry.resolve('code-reviewer'), registry.resolve('reviewer'));
  writeFileSync(join(root, 'roles', 'extra.md'), Buffer.alloc(32768, 97));
  assert.ok(new RoleRegistry(join(root, 'config.json')).resolve('executor').instructions_text.endsWith('a'.repeat(32768)));
});

for (const location of ['role', 'brief', 'config'] as const) test(`AC-S1.2 Cursor non-auto in ${location} returns exit 2 before any job/worktree`, async t => {
  const h = tmpRepo(t);
  if (location === 'role') putRole(h.root, 'executor', patch({ cursor_model: 'premium' }));
  if (location === 'brief') writeFileSync(h.briefFile, JSON.stringify({ ...h.task, provider: 'cursor', model: 'premium' }));
  if (location === 'config') writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { cursor: { model: 'premium' } } }));
  if (location === 'role') {
    const list = validateRoleList(unwrap((await h.command(['roles', 'list'])).envelope));
    assert.equal(list.invalid[0]!.code, 'cursor_model_not_allowed');
    const show = await h.command(['roles', 'show', 'executor']);
    assert.equal(show.exit, 2);
    assert.equal(!show.envelope.ok && show.envelope.error.code, 'cursor_model_not_allowed');
  }
  const output = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(output.exit, 2);
  assert.equal(!output.envelope.ok && output.envelope.error.code, 'cursor_model_not_allowed');
  assert.equal(existsSync(h.home), false);
  assert.doesNotMatch(h.git('branch', '--list'), /gbdev\//);
});

test('AC-S1.3 defaults, explicit overrides, model separation, no input mutation, and mismatch details', t => {
  const repo = temporary(t);
  putRole(repo, 'executor', patch({ codex_model: 'codex-choice', default_timeout_min: 23, default_stall_timeout_s: 19 }));
  const registry = new RoleRegistry(join(repo, 'config.json'));
  const config = validateConfig({ version: 1, allowed_repos: [repo], default_timeout_min: 5, default_stall_timeout_s: 2 });
  const minimal: Record<string, unknown> = { ...brief(repo) };
  for (const key of ['provider', 'sandbox', 'model', 'timeout_min', 'stall_timeout_s']) delete minimal[key];
  const before = structuredClone(minimal);
  const resolved = validateBrief(minimal, config, registry);
  assert.deepEqual(minimal, before);
  assert.equal(resolved.provider, 'codex');
  assert.equal(resolved.sandbox, 'workspace-write');
  assert.equal(resolved.model, 'codex-choice');
  assert.equal(resolved.timeout_min, 23);
  assert.equal(resolved.stall_timeout_s, 19);
  const cursor = validateBrief({ ...minimal, provider: 'cursor' }, config, registry);
  assert.equal(cursor.model, null, 'Codex model must never leak to Cursor');
  for (const model of [null, 'auto']) assert.equal(validateBrief({ ...minimal, provider: 'cursor', model }, config, registry).model, model);
  const explicit = { ...brief(repo), model: 'explicit', stall_timeout_s: 0 };
  assert.deepEqual(validateBrief(explicit, config, registry), explicit);
  const review = validateBrief({ ...minimal, role: 'code-reviewer' }, config, registry);
  assert.equal(review.role, 'reviewer');
  assert.equal(review.provider, 'cursor');
  assert.equal(review.sandbox, 'read-only');
  assert.equal(review.timeout_min, 40);
  assert.equal(review.stall_timeout_s, 900);
  assert.throws(() => validateBrief({ ...minimal, sandbox: 'read-only' }, config, registry), e => {
    assert.ok(errorCode('config_invalid')(e));
    assert.equal((e as any).contract.details.code, 'role_sandbox_mismatch'); return true;
  });
  putRole(repo, 'executor', patch({ allowed_providers: ['codex'] }));
  assert.throws(() => validateBrief({ ...minimal, provider: 'fake' }, config, new RoleRegistry(join(repo, 'config.json'))), e => {
    assert.ok(errorCode('config_invalid')(e));
    assert.equal((e as any).contract.details.code, 'role_provider_not_allowed'); return true;
  });
  for (const provider of [null, 1, 'other']) assert.throws(() => validateBrief({ ...minimal, provider }, config), errorCode('config_invalid'));
  assert.throws(() => validateBrief({ ...minimal, role: 'absent' }, config), errorCode('role_not_found'));
});

for (const name of ['executor', 'reviewer', 'code-reviewer', 'analyst']) test(`AC-S1.3/1.4 ${name} resolves once into brief, status and Role prompt without new worker-result fields`, async t => {
  const h = tmpRepo(t, name === 'executor' ? 'ok' : 'no_json', { acceptance_criteria: [] });
  const base = name === 'executor' ? executor() : reviewer();
  const canonical = name === 'code-reviewer' ? 'reviewer' : name;
  putRole(h.root, canonical, { ...base, name: canonical, provider: 'fake', instructions: ['Pinned role instruction.'] });
  const task: Record<string, unknown> = { ...h.task, role: name };
  for (const key of ['provider', 'sandbox', 'model', 'timeout_min']) delete task[key];
  writeFileSync(h.briefFile, JSON.stringify(task));
  const started = await h.launch();
  putRole(h.root, canonical, { ...base, name: canonical, provider: 'fake', instructions: ['Changed after launch.'] });
  const done = await h.wait(started.job_id);
  assert.equal(done.state, 'succeeded');
  assert.equal(done.role, canonical);
  assert.equal(done.provider, 'fake');
  assert.equal(done.sandbox, base.sandbox);
  const saved = JSON.parse(readFileSync(join(h.jobDir(done.job_id), 'brief.json'), 'utf8'));
  assert.equal(saved.timeout_min, base.default_timeout_min);
  assert.equal(saved.stall_timeout_s, base.default_stall_timeout_s);
  const prompt = readFileSync(join(h.jobDir(done.job_id), 'prompt.md'), 'utf8');
  assert.match(prompt, /## Role\nPinned role instruction\.\n\n## Worker boundaries/);
  assert.match(prompt, /Do not access the network or install packages/);
  assert.doesNotMatch(prompt, /"handoff"|"review"/);
  assert.deepEqual(h.result(done.job_id).gbdev_observed.checks, []);
  // Saved records are facts: reading them must not require a current registry entry.
  assert.equal(validateJobStatus({ ...job(), role: 'deleted-role' }).role, 'deleted-role');
});

test('AC-S1.1 doctor roles check reports invalid file summaries without affecting envelope success', async t => {
  const h = tmpRepo(t);
  h.env.PATH = h.root; // No real providers or user configs.
  const good = unwrap((await h.command(['doctor'])).envelope) as any;
  assert.deepEqual(good.checks.find((c: any) => c.name === 'roles'), { name: 'roles', ok: true, detail: '7 valid roles' });
  putRole(h.root, 'reviewer', { schema: 'gbdev.role.v1', name: 'reviewer', sandbox: 'workspace-write' });
  const output = await h.command(['doctor']);
  assert.equal(output.exit, 0);
  const check = (unwrap(output.envelope) as any).checks.find((c: any) => c.name === 'roles');
  assert.equal(check.ok, false);
  assert.ok(check.detail.includes(join(h.root, 'roles', 'reviewer.json')));
  assert.match(check.detail, /role_invalid.*requires sandbox=read-only/);
  const alias = await h.command(['roles', 'show', 'code-reviewer']);
  assert.equal(alias.exit, 2);
});


test('AC-S1.4 malformed builtin override does not fall back, including through alias', t => {
  const root = temporary(t);
  putRole(root, 'reviewer', {});
  writeFileSync(join(root, 'roles', 'reviewer.json'), '{broken');
  const registry = new RoleRegistry(join(root, 'config.json'));
  for (const name of ['reviewer', 'code-reviewer']) assert.throws(() => registry.resolve(name), errorCode('role_invalid'));
  assert.equal(registry.resolve('executor').source, 'builtin');
});

test('AC-S1.2 role JSON symlink is invalid and never read', t => {
  const root = temporary(t);
  mkdirSync(join(root, 'roles'));
  writeFileSync(join(root, 'other.json'), JSON.stringify(executor()));
  symlinkSync(join(root, 'other.json'), join(root, 'roles', 'executor.json'));
  const registry = new RoleRegistry(join(root, 'config.json'));
  assert.throws(() => registry.resolve('executor'), errorCode('role_invalid'));
  assert.match(registry.list().invalid[0]!.message, /symlink/);
});


for (const provider of ['codex', 'cursor'] as const) test(`AC-S1.3 role defaults reach ${provider} argv without model leakage`, async t => {
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [] });
  const bin = providerStub(h.root);
  const log = join(h.root, 'argv.jsonl');
  h.env.GBDEV_STUB_LOG = log;
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { codex: { bin }, cursor: { bin } } }));
  putRole(h.root, 'executor', patch({ provider, codex_model: 'role-codex-model' }));
  const task: Record<string, unknown> = { ...h.task };
  for (const key of ['provider', 'model', 'sandbox']) delete task[key];
  writeFileSync(h.briefFile, JSON.stringify(task));
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded');
  const { args } = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.equal(args[args.indexOf(provider === 'codex' ? '-m' : '--model') + 1], provider === 'codex' ? 'role-codex-model' : 'auto');
  if (provider === 'cursor') assert.equal(args.includes('role-codex-model'), false);
});

test('AC-S1.1 unreadable registry directory still lists diagnostics and fails closed on use', async t => {
  const h = tmpRepo(t);
  writeFileSync(join(h.root, 'roles'), 'not a directory');
  const output = await h.command(['roles', 'list']);
  assert.equal(output.exit, 0);
  const list = validateRoleList(unwrap(output.envelope));
  assert.deepEqual(list.roles, []);
  assert.equal(list.invalid[0]!.file, join(h.root, 'roles'));
  assert.equal((await h.command(['roles', 'show', 'executor'])).exit, 2);
});

test('AC-S1.3 missing role-selected provider never falls back or creates job files', async t => {
  const h = tmpRepo(t);
  writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { codex: { bin: join(h.root, 'absent') } } }));
  const task: Record<string, unknown> = { ...h.task };
  delete task.provider;
  writeFileSync(h.briefFile, JSON.stringify(task));
  const output = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(output.exit, 1);
  assert.equal(!output.envelope.ok && output.envelope.error.code, 'provider_not_found');
  assert.equal(existsSync(h.home), false);
});
