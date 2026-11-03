import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { validateBrief } from '../src/contracts/brief.js';
import { errorExitCode, GbdevError } from '../src/contracts/error.js';
import { validatePipeline } from '../src/contracts/pipeline.js';
import { resolveRequest } from '../src/contracts/pipelineRequest.js';
import { validateRole, validateResolvedRole, validateRoleList } from '../src/contracts/role.js';
import { validateRunRequest } from '../src/contracts/runRequest.js';
import { validateConfig } from '../src/core/config.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { ROLE_SOURCES } from '../src/roles/catalog.generated.js';
import { RoleRegistry } from '../src/roles/registry.js';
import { assertNotReservedRoleId, isReservedRoleId, RESERVED_ROLE_IDS } from '../src/roles/reserved.js';
import { cursor } from '../src/providers/cursor.js';
import { codex } from '../src/providers/codex.js';
import { errorCode, temporary } from './helpers.js';
import { providerStub } from './helpers/providerStub.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';

const ROOT = resolve('.');
const ROLES = join(ROOT, 'roles');
const GEN = join(ROOT, 'scripts/gen-roles.mjs');
const NODE = process.execPath;
const NODE_BIN = dirname(NODE);
const MIN_PATH = `${NODE_BIN}:/usr/bin:/bin`;
const M6_ROLE_NAMES = ['planner', 'executor', 'fixer', 'reviewer', 'verifier', 'resolver'] as const;

function putRole(root: string, name: string, value: unknown) {
  mkdirSync(join(root, 'roles'), { recursive: true });
  writeFileSync(join(root, 'roles', `${name}.json`), JSON.stringify(value));
}

function inspectorBuiltin() {
  const role = builtinRoles().find(r => r.name === 'inspector');
  assert.ok(role);
  return role;
}

function runGen(args: string[] = [], cwd = ROOT) {
  return spawnSync(NODE, [GEN, ...args], { cwd, encoding: 'utf8', env: { PATH: MIN_PATH, HOME: tmpdir() } });
}

test('AC-1 seven roles; inspector defaults; list/show; old alias unchanged', async t => {
  const dirs = readdirSync(ROLES, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '_shared')
    .map(e => e.name)
    .sort();
  assert.deepEqual(dirs, ['executor', 'fixer', 'inspector', 'planner', 'resolver', 'reviewer', 'verifier']);

  const meta = JSON.parse(readFileSync(join(ROLES, 'inspector', 'role.json'), 'utf8'));
  assert.equal(meta.provider, 'cursor');
  assert.equal(meta.mode, 'read-only');
  assert.equal(meta.output, 'report');
  assert.deepEqual(meta.allowed_providers, ['cursor', 'fake']);
  assert.equal(meta.cursor_model, 'auto');
  assert.equal(meta.codex_model, null);
  assert.equal(meta.default_timeout_min, 10);
  assert.equal(meta.default_stall_timeout_s, 120);
  assert.deepEqual(meta.used_by, ['gbdev inspect']);
  assert.deepEqual(meta.aliases, []);

  const generated = ROLE_SOURCES.find(r => r.name === 'inspector');
  assert.ok(generated);
  assert.equal(generated.provider, 'cursor');
  assert.equal(generated.sandbox, 'read-only');
  assert.equal(generated.output, 'report');
  assert.deepEqual([...generated.allowed_providers], ['cursor', 'fake']);
  assert.equal(generated.default_timeout_min, 10);
  assert.equal(generated.default_stall_timeout_s, 120);

  const runtime = inspectorBuiltin();
  assert.equal(runtime.provider, 'cursor');
  assert.equal(runtime.sandbox, 'read-only');
  assert.equal(runtime.output, 'report');
  assert.deepEqual(runtime.allowed_providers, ['cursor', 'fake']);
  assert.equal(runtime.cursor_model, 'auto');
  assert.equal(runtime.default_timeout_min, 10);
  assert.equal(runtime.default_stall_timeout_s, 120);

  const h = tmpRepo(t);
  const listed = await h.command(['roles', 'list']);
  assert.equal(listed.exit, 0);
  const list = validateRoleList(unwrap(listed.envelope));
  assert.equal(list.roles.length, 7);
  assert.ok(list.roles.some(r => r.name === 'inspector'));
  assert.equal(list.aliases['code-reviewer'], 'reviewer');
  const shown = await h.command(['roles', 'show', 'inspector']);
  assert.equal(shown.exit, 0);
  const role = validateResolvedRole(unwrap(shown.envelope));
  assert.equal(role.name, 'inspector');
  assert.equal(role.source, 'builtin');
  assert.equal(role.provider, 'cursor');
  assert.equal(role.output, 'report');
  assert.equal(role.sandbox, 'read-only');
  const alias = await h.command(['roles', 'show', 'code-reviewer']);
  assert.equal(alias.exit, 0);
  assert.equal(validateResolvedRole(unwrap(alias.envelope)).name, 'reviewer');
});

test('AC-2 inspector overrides: instructions/timeouts ok; write/output/provider relax rejected; non-auto cursor_model; resolver still bans cursor', t => {
  const root = temporary(t);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ version: 1 }));
  mkdirSync(join(root, 'roles'));
  writeFileSync(join(root, 'roles', 'extra.md'), 'Extra inspector note.\n');
  putRole(root, 'inspector', {
    schema: 'gbdev.role.v1',
    name: 'inspector',
    description: 'Overridden inspector description',
    instructions: ['Answer the question only.'],
    instructions_file: 'extra.md',
    default_timeout_min: 12,
    default_stall_timeout_s: 90,
  });
  const registry = new RoleRegistry(config);
  const role = registry.resolve('inspector');
  assert.equal(role.source, 'builtin+user');
  assert.equal(role.description, 'Overridden inspector description');
  assert.equal(role.default_timeout_min, 12);
  assert.equal(role.default_stall_timeout_s, 90);
  assert.equal(role.instructions_text, 'Answer the question only.\nExtra inspector note.\n');
  assert.equal(role.provider, 'cursor');
  assert.equal(role.output, 'report');
  assert.equal(role.sandbox, 'read-only');
  assert.equal(Object.isFrozen(role), true);
  assert.equal(Object.isFrozen(role.instructions), true);
  assert.equal(Object.isFrozen(role.allowed_providers), true);
  assert.throws(() => { (role as { description: string }).description = 'mutated'; }, TypeError);

  for (const fields of [
    { output: 'change', sandbox: 'workspace-write' },
    { output: 'verdict', sandbox: 'read-only' },
    { provider: 'codex', allowed_providers: ['codex', 'cursor', 'fake'] },
    { allowed_providers: ['cursor', 'codex', 'fake'], provider: 'cursor' },
  ]) {
    assert.throws(
      () => validateRole({ ...inspectorBuiltin(), ...fields }),
      errorCode('role_invalid'),
    );
  }
  assert.throws(
    () => validateRole({ ...inspectorBuiltin(), cursor_model: 'sonnet' as 'auto' }),
    errorCode('cursor_model_not_allowed'),
  );
  assert.throws(
    () => validateRole({ ...builtinRoles().find(r => r.name === 'resolver')!, allowed_providers: ['codex', 'cursor', 'fake'] }),
    errorCode('role_invalid'),
  );
});

test('AC-3 reserved identifiers rejected on name/resolve/basename/alias surfaces', t => {
  for (const id of RESERVED_ROLE_IDS) {
    assert.equal(isReservedRoleId(id), true);
    assert.equal(isReservedRoleId(` ${id.toUpperCase()} `), true);
    assert.throws(() => assertNotReservedRoleId(` ${id.toUpperCase()} `, 'test'), (error: unknown) => {
      return error instanceof GbdevError
        && error.contract.code === 'role_fixed'
        && error.contract.retryable === false
        && error.contract.details.name === id
        && error.contract.details.surface === 'test'
        && errorExitCode(error.contract.code) === 2;
    });
  }
  assert.equal(isReservedRoleId('example-dev'), false);
  assert.equal(isReservedRoleId('decider-helper'), false);

  for (const name of ['grokbot', 'grok-bot', 'dispatcher', 'decider']) {
    assert.throws(
      () => validateRole({ ...inspectorBuiltin(), name }),
      errorCode('role_fixed'),
    );
  }

  const root = temporary(t);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1 }));
  // Basename reserved even if body pretends to be executor.
  putRole(root, 'dispatcher', { ...builtinRoles().find(r => r.name === 'executor')!, name: 'executor' });
  putRole(root, 'grok-bot', { ...builtinRoles().find(r => r.name === 'executor')!, name: 'executor' });
  const registry = new RoleRegistry(join(root, 'config.json'));
  const list = registry.list();
  assert.ok(list.invalid.some(e => e.name === 'dispatcher' && e.code === 'role_fixed'));
  assert.ok(list.invalid.some(e => e.name === 'grok-bot' && e.code === 'role_fixed'));
  assert.throws(() => registry.resolve('dispatcher'), errorCode('role_fixed'));
  assert.throws(() => registry.resolve('  Decider '), errorCode('role_fixed'));
  assert.throws(() => registry.resolve('GROK-BOT'), errorCode('role_fixed'));
  // Unrelated executor still resolves.
  assert.equal(registry.resolve('executor').source, 'builtin');
});

test('AC-4 config/brief/pipeline/overrides return role_fixed; CLI exit 2; zero job/worktree', async t => {
  for (const run_defaults of [undefined, null, 3, [], 'ignored', {}]) {
    assert.deepEqual(validateConfig({ version: 1, run_defaults }), validateConfig({ version: 1 }));
  }
  assert.throws(() => validateConfig({ version: 1, grokbot: null }), errorCode('role_fixed'));
  assert.throws(() => validateConfig({ version: 1, providers: { dispatcher: { bin: 'x' } } }), errorCode('role_fixed'));
  assert.throws(() => validateConfig({ version: 1, roles: { decider: null } }), errorCode('role_fixed'));
  assert.throws(() => validateConfig({ version: 1, run_defaults: { grokbot: true } }), errorCode('role_fixed'));
  assert.throws(() => validateConfig({ version: 1, parallel: { dispatcher: 1 } }), errorCode('role_fixed'));

  const h = tmpRepo(t);
  const registry = new PipelineRegistry(h.config);
  assert.throws(
    () => validateConfig({ version: 1, allowed_repos: [h.repo], run_defaults: { dispatcher: 1 } }, registry),
    errorCode('role_fixed'),
  );
  assert.throws(
    () => validateConfig({ version: 1, allowed_repos: [h.repo], pipeline_defaults: { grokbot: 1 } }, registry),
    errorCode('role_fixed'),
  );

  writeFileSync(h.briefFile, JSON.stringify({ ...h.task, role: 'dispatcher' }));
  const briefStart = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(briefStart.exit, 2);
  assert.equal(!briefStart.envelope.ok && briefStart.envelope.error.code, 'role_fixed');
  assert.equal(!briefStart.envelope.ok && briefStart.envelope.error.retryable, false);
  assert.deepEqual(!briefStart.envelope.ok && briefStart.envelope.error.details, { name: 'dispatcher', surface: 'resolve' });
  assert.equal(existsSync(h.home), false);

  assert.throws(
    () => validateBrief({ ...h.task, role: 'grokbot' }, validateConfig({ version: 1, allowed_repos: [h.repo] }), registry.roles),
    errorCode('role_fixed'),
  );

  assert.throws(
    () => validatePipeline({
      schema: 'gbdev.pipeline.v1',
      name: 'bad',
      description: 'x',
      steps: [{ id: 'dispatcher', role: 'executor' }],
      timeout_min: 60,
    }, registry.roles),
    errorCode('role_fixed'),
  );
  assert.throws(
    () => validatePipeline({
      schema: 'gbdev.pipeline.v1',
      name: 'bad2',
      description: 'x',
      steps: [{ id: 'implement', role: 'decider' }],
      timeout_min: 60,
    }, registry.roles),
    errorCode('role_fixed'),
  );
  assert.throws(
    () => validatePipeline({
      schema: 'gbdev.pipeline.v1',
      name: 'bad3',
      description: 'x',
      steps: [{ id: 'implement', role: 'executor' }, { id: 'review', role: 'reviewer' }],
      fix_loop: { after: 'review', fix_role: 'dispatcher', max_rounds: 1 },
      timeout_min: 60,
    }, registry.roles),
    errorCode('role_fixed'),
  );

  const baseRequest = {
    schema: 'gbdev.pipeline-request.v1',
    request_id: 'req_m7',
    pipeline: 'implement-review',
    repo: h.repo,
    base_ref: 'HEAD',
    diff_base_ref: null,
    goal: 'g',
    context: '',
    constraints: [],
    allowed_paths: ['src/**'],
    acceptance_criteria: [{ id: 'AC1', text: 'ok' }],
    required_evidence: [],
    step_overrides: { dispatcher: { provider: 'fake' } },
    max_rounds: 1,
    timeout_min: 60,
    max_total_jobs: 4,
    network: false,
  };
  assert.throws(
    () => resolveRequest(baseRequest, validateConfig({ version: 1, allowed_repos: [h.repo] }), registry),
    errorCode('role_fixed'),
  );

  const baseRunRequest = {
      schema: 'gbdev.run-request.v1',
      request_id: 'run_m7',
      repo: h.repo,
      base_ref: 'HEAD',
      goal: 'g',
      context: '',
      constraints: [],
      allowed_paths: ['src/**'],
      checks: [{ id: 'c1', cmd: 'true', timeout_min: 1 }],
      integration_checks: ['c1'],
      acceptance_criteria: [{ id: 'AC1', text: 'ok', check: null }],
      decompose: 'planner',
      tasks: null,
      network: false,
      task_pipeline_overrides: { dispatcher: { provider: 'fake' } },
  };
  const config = validateConfig({ version: 1, allowed_repos: [h.repo] });
  assert.throws(
    () => validateRunRequest(baseRunRequest, config, registry),
    errorCode('role_fixed'),
  );
  for (const key of ['role', 'name']) {
    for (const name of RESERVED_ROLE_IDS) {
      const override = { implement: { [key]: ` ${name.toUpperCase()} ` } };
      for (const validate of [
        () => resolveRequest({ ...baseRequest, step_overrides: override }, config, registry),
        () => validateRunRequest({ ...baseRunRequest, task_pipeline_overrides: override }, config, registry),
      ]) {
        assert.throws(validate, (error: unknown) => {
          assert.ok(error instanceof GbdevError);
          assert.equal(error.contract.code, 'role_fixed');
          assert.deepEqual(error.contract.details, { name, surface: `override.${key}` });
          return true;
        });
      }
    }
    const override = { implement: { [key]: 'executor' } };
    assert.throws(() => resolveRequest({ ...baseRequest, step_overrides: override }, config, registry), errorCode('pipeline_invalid'));
    assert.throws(() => validateRunRequest({ ...baseRunRequest, task_pipeline_overrides: override }, config, registry), errorCode('run_invalid'));
  }

  const show = await h.command(['roles', 'show', 'dispatcher']);
  assert.equal(show.exit, 2);
  assert.equal(!show.envelope.ok && show.envelope.error.code, 'role_fixed');
  assert.equal(existsSync(h.home), false);
});

test('AC-5 list.invalid role_fixed; doctor roles=false; unrelated executor ok; bot_label and prose not false positives', async t => {
  const h = tmpRepo(t);
  putRole(h.root, 'dispatcher', { schema: 'gbdev.role.v1', name: 'dispatcher', description: 'nope' });
  putRole(h.root, 'executor', {
    schema: 'gbdev.role.v1',
    name: 'executor',
    description: 'Still a normal executor mentioning decider in prose only',
    provider: 'fake',
  });
  const listed = await h.command(['roles', 'list']);
  assert.equal(listed.exit, 0);
  const list = validateRoleList(unwrap(listed.envelope));
  assert.ok(list.invalid.some(e => e.code === 'role_fixed' && e.name === 'dispatcher'));
  assert.equal(list.roles.find(r => r.name === 'executor')?.source, 'builtin+user');
  assert.equal(new RoleRegistry(h.config).resolve('executor').provider, 'fake');

  const doctor = await h.command(['doctor']);
  assert.equal(doctor.exit, 0);
  const rolesCheck = (unwrap(doctor.envelope) as { checks: { name: string; ok: boolean; detail: string }[] })
    .checks.find(c => c.name === 'roles');
  assert.ok(rolesCheck);
  assert.equal(rolesCheck.ok, false);
  assert.match(rolesCheck.detail, /role_fixed/);

  // Natural-language "decider" and bot_label-like identifiers must not trip reserved checks.
  assert.equal(isReservedRoleId('example-dev'), false);
  writeFileSync(h.briefFile, JSON.stringify({
    ...h.task,
    role: 'executor',
    provider: 'fake',
    goal: 'Ask the decider whether grokbot should continue',
    context: 'bot_label=example-dev',
  }));
  const start = await h.command(['start', '--brief', h.briefFile]);
  assert.equal(start.exit, 0, JSON.stringify(start.envelope));
});

test('AC-6 seventh role exact; M6 six unchanged field-by-field; no extra roles beyond seven', () => {
  const all = builtinRoles();
  assert.equal(all.length, 7);
  assert.deepEqual(all.map(r => r.name).sort(), [
    'executor', 'fixer', 'inspector', 'planner', 'resolver', 'reviewer', 'verifier',
  ]);
  const inspector = all.find(r => r.name === 'inspector')!;
  assert.equal(inspector.output, 'report');
  assert.equal(inspector.sandbox, 'read-only');
  assert.equal(inspector.provider, 'cursor');
  assert.deepEqual(inspector.allowed_providers, ['cursor', 'fake']);
  assert.equal(inspector.cursor_model, 'auto');
  assert.equal(inspector.codex_model, null);
  assert.equal(inspector.default_timeout_min, 10);
  assert.equal(inspector.default_stall_timeout_s, 120);
  assert.ok(inspector.instructions.length >= 1);
  assert.ok(inspector.instructions.every(line => line.length > 0 && !line.includes('\n')));

  const snap = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/m6-prompts.snapshot.json'), 'utf8'));
  for (const name of M6_ROLE_NAMES) {
    const current = all.find(r => r.name === name)!;
    const historical = snap.builtinRoles.find((r: { name: string }) => r.name === name);
    assert.deepEqual(current, historical);
  }
});

test('AC-7 generator and runtime reserved identifier sets are exactly equal', () => {
  const declaration = /^const RESERVED_ROLE_IDS = new Set\((\[[^\n]+\])\);$/m.exec(readFileSync(GEN, 'utf8'));
  assert.ok(declaration, 'Generator reserved set must remain inspectable by this drift guard');
  const ids: string[] = JSON.parse(declaration[1]!.replaceAll("'", '"'));
  assert.deepEqual([...new Set(ids)].sort(), [...RESERVED_ROLE_IDS].sort());
});

for (const missing of ['executor', 'fixer', 'inspector', 'planner', 'resolver', 'reviewer', 'verifier', null]) {
  test(`AC-7 generator rejects ${missing ? `missing ${missing}` : 'extra role directory'}`, t => {
    const staging = temporary(t);
    cpSync(ROLES, join(staging, 'roles'), { recursive: true });
    mkdirSync(join(staging, 'scripts'));
    cpSync(GEN, join(staging, 'scripts/gen-roles.mjs'));
    if (missing) rmSync(join(staging, 'roles', missing), { recursive: true });
    else cpSync(join(staging, 'roles/executor'), join(staging, 'roles/extra'), { recursive: true });
    const result = spawnSync(NODE, [join(staging, 'scripts/gen-roles.mjs')], {
      cwd: staging, encoding: 'utf8', env: { PATH: MIN_PATH, HOME: staging },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /role name set mismatch/);
    assert.equal(existsSync(join(staging, 'src/roles/catalog.generated.ts')), false);
  });
}

test('AC-7 generator rejects normalized reserved aliases', t => {
  const staging = temporary(t);
  cpSync(ROLES, join(staging, 'roles'), { recursive: true });
  mkdirSync(join(staging, 'scripts'));
  cpSync(GEN, join(staging, 'scripts/gen-roles.mjs'));
  const file = join(staging, 'roles/inspector/role.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  for (const alias of ['Dispatcher', ' grokbot ', 'GROK-BOT', 'Decider']) {
    writeFileSync(file, JSON.stringify({ ...meta, aliases: [alias] }));
    const result = spawnSync(NODE, [join(staging, 'scripts/gen-roles.mjs')], {
      cwd: staging, encoding: 'utf8', env: { PATH: MIN_PATH, HOME: staging },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inspector.alias: role_fixed/);
    assert.equal(existsSync(join(staging, 'src/roles/catalog.generated.ts')), false);
  }
});

test('AC-7 gen-roles --check; staging inspector drift fails; regenerate identical; isolated dist shows inspector', () => {
  assert.equal(runGen(['--check']).status, 0);

  const staging = mkdtempSync(join(tmpdir(), 'gbdev-m7-ac7-'));
  try {
    cpSync(ROLES, join(staging, 'roles'), { recursive: true });
    mkdirSync(join(staging, 'scripts'), { recursive: true });
    mkdirSync(join(staging, 'src/roles'), { recursive: true });
    writeFileSync(join(staging, 'scripts/gen-roles.mjs'), readFileSync(GEN));
    const catalog = join(staging, 'src/roles/catalog.generated.ts');
    writeFileSync(catalog, readFileSync(join(ROOT, 'src/roles/catalog.generated.ts')));
    const gen = join(staging, 'scripts/gen-roles.mjs');
    const once = spawnSync(NODE, [gen], { cwd: staging, encoding: 'utf8' });
    assert.equal(once.status, 0, once.stderr);
    const mid = readFileSync(catalog);
    const twice = spawnSync(NODE, [gen], { cwd: staging, encoding: 'utf8' });
    assert.equal(twice.status, 0, twice.stderr);
    assert.deepEqual(readFileSync(catalog), mid);

    const prompt = join(staging, 'roles/inspector/prompt.md');
    const original = readFileSync(prompt, 'utf8');
    writeFileSync(prompt, original.replace('Answer', 'Xnswer'));
    const drifted = spawnSync(NODE, [gen, '--check'], { cwd: staging, encoding: 'utf8' });
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /out of date|gen-roles/);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  // Isolated dist (no roles/ source tree) can still show inspector from catalog.
  const isolated = mkdtempSync(join(tmpdir(), 'gbdev-m7-iso-'));
  try {
    cpSync(join(ROOT, 'dist'), join(isolated, 'dist'), { recursive: true });
    const home = join(isolated, 'home');
    const config = join(isolated, 'config.json');
    writeFileSync(config, JSON.stringify({ version: 1, allowed_repos: [] }));
    const shown = spawnSync(NODE, [join(isolated, 'dist/cli.js'), 'roles', 'show', 'inspector', '--json'], {
      encoding: 'utf8',
      env: {
        PATH: MIN_PATH,
        HOME: isolated,
        GBDEV_HOME: home,
        GBDEV_CONFIG: config,
        GBDEV_CLI_HOME: join(isolated, 'cli-home'),
      },
    });
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    const envelope = JSON.parse(shown.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.name, 'inspector');
    assert.equal(envelope.result.provider, 'cursor');
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test('AC-8 inspector Cursor auto read-only argv; Codex high unchanged; no forbidden literals in new S1 files', async t => {
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [], role: 'inspector', provider: 'cursor', sandbox: 'read-only' });
  const bin = providerStub(h.root);
  const log = join(h.root, 'argv.jsonl');
  h.env.GBDEV_STUB_LOG = log;
  writeFileSync(h.config, JSON.stringify({
    version: 1,
    allowed_repos: [h.repo],
    providers: { codex: { bin }, cursor: { bin } },
  }));
  writeFileSync(h.briefFile, JSON.stringify({
    ...h.task,
    role: 'inspector',
    provider: 'cursor',
    sandbox: 'read-only',
    model: 'auto',
    acceptance_criteria: [],
  }));
  const done = await h.wait((await h.launch()).job_id);
  assert.equal(done.state, 'succeeded');
  assert.equal(done.role, 'inspector');
  assert.equal(done.sandbox, 'read-only');
  const { args } = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)!);
  assert.equal(args[args.indexOf('--model') + 1], 'auto');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'enabled');
  assert.ok(args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'plan');
  assert.equal(args.includes('--force'), false);

  // Adapter-level: inspector-shaped context stays plan/auto.
  const invocation = cursor.buildInvocation({
    bin: 'cursor-agent',
    worktree: h.repo,
    jobDir: h.root,
    prompt: 'q', network: true,
    sandbox: 'read-only',
    model: 'auto',
  });
  assert.deepEqual(invocation.args.slice(0, 8), [
    '-p', '--output-format', 'stream-json', '--sandbox', 'enabled', '--trust', '--mode', 'plan',
  ]);
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'auto');

  // Exercise the Codex adapter using each resolved builtin that selects Codex.
  const codexRoles = new RoleRegistry().list().roles.filter(role => role.provider === 'codex');
  assert.ok(codexRoles.length > 0);
  for (const { name } of codexRoles) {
    const role = new RoleRegistry().resolve(name);
    const { args } = codex.buildInvocation({
      bin: 'codex', worktree: h.repo, jobDir: h.root, prompt: 'q',
      sandbox: role.sandbox, network: true, model: role.codex_model,
    });
    assert.equal(args[0], 'exec');
    const effort = args.indexOf('model_reasoning_effort=high');
    assert.ok(effort > 0, name);
    assert.equal(args[effort - 1], '-c', name);
  }

  // Forbidden literal scan on M7 S1 production additions (construct needles; never embed full tokens).
  const bypass = ['--dangerously', 'bypass-approvals', 'and-sandbox'].join('-');
  const disabledFlag = ['--sandbox', 'disabled'].join('=');
  const shellTrue = ['shell', ': true'].join('');
  for (const rel of [
    'src/roles/reserved.ts',
    'roles/inspector/role.json',
    'roles/inspector/prompt.md',
    'src/roles/catalog.generated.ts',
  ]) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.equal(text.includes(bypass), false, rel);
    assert.equal(text.includes(disabledFlag), false, rel);
    assert.equal(text.includes(shellTrue), false, rel);
  }
});
