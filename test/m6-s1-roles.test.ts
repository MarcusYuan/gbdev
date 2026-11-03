import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { validateRole, validateRoleList, validateResolvedRole } from '../src/contracts/role.js';
import { RoleRegistry, ROLE_ALIASES } from '../src/roles/registry.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { ROLE_SOURCES } from '../src/roles/catalog.generated.js';
import { temporary } from './helpers.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';

// Tests run with cwd = repo root (`npm test` / `node --test dist/test/`); import.meta is under dist/test/.
const ROOT = resolve('.');
const ROLES = join(ROOT, 'roles');
const SNAPSHOT = join(ROOT, 'test/fixtures/m6-prompts.snapshot.json');
const SNAPSHOT_EXTRA = join(ROOT, 'test/fixtures/m6-prompts.snapshot-extra.json');
const GEN = join(ROOT, 'scripts/gen-roles.mjs');
const NODE = process.execPath;
const NODE_BIN = dirname(NODE);
/** Minimal PATH for spawned tools — no host provider PATH / CODEX_HOME inheritance. */
const MIN_PATH = `${NODE_BIN}:/usr/bin:/bin`;

function runGen(args: string[] = [], cwd = ROOT) {
  return spawnSync(NODE, [GEN, ...args], { cwd, encoding: 'utf8', env: { PATH: MIN_PATH, HOME: tmpdir() } });
}

function roleDirs(): string[] {
  return readdirSync(ROLES, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '_shared')
    .map(e => e.name)
    .sort();
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(path, out);
    else if (entry.name.endsWith('.ts') && entry.name !== 'catalog.generated.ts') out.push(path);
  }
  return out;
}

function walkRolesFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkRolesFiles(path, out);
    else out.push(path);
  }
  return out;
}

/** Exactly one trailing newline, no CR, no trailing whitespace, no blank line at EOF. */
function assertRolesFileHygiene(path: string, bytes: Buffer) {
  const text = bytes.toString('utf8');
  assert.ok(text.endsWith('\n'), `${path}: must end with a trailing newline`);
  assert.ok(!text.endsWith('\n\n'), `${path}: extra blank line at EOF`);
  assert.ok(!text.includes('\r'), `${path}: CR is not allowed`);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    assert.ok(!/[ \t]$/.test(lines[i]!), `${path}: trailing whitespace on line ${i + 1}`);
  }
}

const M6_ROLE_NAMES = ['planner', 'executor', 'fixer', 'reviewer', 'verifier', 'resolver'] as const;

test('AC-1 roles/ layout and closed role-source schema', () => {
  assert.deepEqual(roleDirs(), ['executor', 'fixer', 'inspector', 'planner', 'resolver', 'reviewer', 'verifier']);
  assert.ok(existsSync(join(ROLES, '_shared', 'fragments.json')));
  assert.ok(existsSync(join(ROLES, 'README.md')));
  for (const name of roleDirs()) {
    const meta = JSON.parse(readFileSync(join(ROLES, name, 'role.json'), 'utf8'));
    assert.equal(meta.schema, 'gbdev.role-source.v1');
    assert.equal(meta.name, name);
    assert.equal(meta.prompt, 'prompt.md');
    assert.ok(existsSync(join(ROLES, name, 'prompt.md')));
    const expectedMode = meta.output === 'change' ? 'workspace-write' : 'read-only';
    assert.equal(meta.mode, expectedMode);
    assert.equal(meta.cursor_model, 'auto');
  }
});

test('roles/ files end with exactly one newline and no trailing whitespace', () => {
  const files = walkRolesFiles(ROLES).sort();
  assert.ok(files.length > 0);
  for (const path of files) assertRolesFileHygiene(path, readFileSync(path));
});

test('AC-2 builtinRoles and roles list/show match snapshot', async t => {
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  // M7 adds inspector; project to the frozen M6 six for snapshot equality.
  const projectedBuiltins = M6_ROLE_NAMES.map(name => {
    const role = builtinRoles().find(r => r.name === name);
    assert.ok(role, `missing M6 role ${name}`);
    return role;
  });
  assert.deepEqual(projectedBuiltins, snap.builtinRoles);
  const h = tmpRepo(t);
  const listed = await h.command(['roles', 'list']);
  assert.equal(listed.exit, 0);
  const list = validateRoleList(unwrap(listed.envelope));
  assert.ok(list.roles.some(r => r.name === 'inspector'));
  const projectedList = {
    ...list,
    roles: list.roles.filter(r => (M6_ROLE_NAMES as readonly string[]).includes(r.name)),
  };
  assert.deepEqual(projectedList, snap.roles.list);
  for (const name of [...M6_ROLE_NAMES, 'code-reviewer']) {
    const shown = await h.command(['roles', 'show', name]);
    assert.equal(shown.exit, 0);
    const role = validateResolvedRole(unwrap(shown.envelope));
    assert.deepEqual(role, snap.roles.show[name]);
  }
  assert.equal(ROLE_ALIASES['code-reviewer'], 'reviewer');
});

test('AC-3 prompt render matrix matches snapshot', async () => {
  const { capturePrompts } = await import(pathToFileURL(join(ROOT, 'scripts/m6-prompt-snapshot.mjs')).href);
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const actual = await capturePrompts(join(ROOT, 'dist'));
  assert.deepEqual(actual, snap);
});

test('AC-4 gen-roles --check, drift, and determinism (staging only; workspace read-only check)', () => {
  const ok = runGen(['--check']);
  assert.equal(ok.status, 0, ok.stderr);

  const staging = mkdtempSync(join(tmpdir(), 'gbdev-m6-ac4-'));
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

    const prompt = join(staging, 'roles/planner/prompt.md');
    const original = readFileSync(prompt, 'utf8');
    writeFileSync(prompt, original.replace('Produce', 'Xroduce'));
    const drifted = spawnSync(NODE, [gen, '--check'], { cwd: staging, encoding: 'utf8' });
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /out of date|gen-roles/);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  assert.equal(runGen(['--check']).status, 0);
});

test('AC-5 generator rejects invalid role sources and fragments', () => {
  const staging = mkdtempSync(join(tmpdir(), 'gbdev-m6-gen-'));
  try {
    cpSync(ROLES, join(staging, 'roles'), { recursive: true });
    mkdirSync(join(staging, 'scripts'), { recursive: true });
    mkdirSync(join(staging, 'src/roles'), { recursive: true });
    writeFileSync(join(staging, 'scripts/gen-roles.mjs'), readFileSync(GEN));
    // Seed a catalog so --check has a baseline path; generator writes relative to staging via its own ROOT.
    // Use a patched generator that points ROOT at staging by running from staging with copied script that uses import.meta.
    // The script resolves ROOT as dirname(scripts)/.. so staging layout works.

    const cases: { label: string; patch: () => void; match: RegExp }[] = [
      {
        label: 'cursor_model not auto',
        patch: () => {
          const path = join(staging, 'roles/reviewer/role.json');
          const meta = JSON.parse(readFileSync(path, 'utf8'));
          meta.cursor_model = 'sonnet';
          writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
        },
        match: /cursor_model_not_allowed/,
      },
      {
        label: 'mode/output mismatch',
        patch: () => {
          const path = join(staging, 'roles/executor/role.json');
          const meta = JSON.parse(readFileSync(path, 'utf8'));
          meta.mode = 'read-only';
          writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
        },
        match: /inconsistent with output/,
      },
      {
        label: 'resolver allows cursor',
        patch: () => {
          const path = join(staging, 'roles/resolver/role.json');
          const meta = JSON.parse(readFileSync(path, 'utf8'));
          meta.allowed_providers = ['codex', 'cursor', 'fake'];
          writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
        },
        match: /must not allow cursor/,
      },
      {
        label: 'unknown field',
        patch: () => {
          const path = join(staging, 'roles/planner/role.json');
          const meta = JSON.parse(readFileSync(path, 'utf8'));
          meta.extra = true;
          writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
        },
        match: /unknown field/,
      },
      {
        label: 'empty line in prompt.md',
        patch: () => {
          writeFileSync(join(staging, 'roles/planner/prompt.md'), 'line one\n\nline three\n');
        },
        match: /empty lines/,
      },
      {
        label: 'CR in prompt.md',
        patch: () => {
          writeFileSync(join(staging, 'roles/planner/prompt.md'), 'line one\r\nline two\n');
        },
        match: /CR/,
      },
      {
        label: 'undeclared placeholder',
        patch: () => {
          const path = join(staging, 'roles/_shared/orchestrator-notes.md');
          writeFileSync(path, '\nNote from the orchestrator: {{note}} {{extra}}\n');
        },
        match: /placeholders mismatch/,
      },
      {
        label: 'unused declared placeholder',
        patch: () => {
          const path = join(staging, 'roles/_shared/fragments.json');
          const index = JSON.parse(readFileSync(path, 'utf8'));
          const entry = index.fragments.find((f: { id: string }) => f.id === 'orchestrator-notes');
          entry.placeholders = ['note', 'unused'];
          writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
        },
        match: /placeholders mismatch/,
      },
      {
        label: 'fragment extra blank line at EOF',
        patch: () => {
          const path = join(staging, 'roles/_shared/untrusted-data-notice.md');
          const body = readFileSync(path, 'utf8').replace(/\n+$/, '');
          writeFileSync(path, `${body}\n\n`);
        },
        match: /extra blank line at EOF/,
      },
      {
        label: 'allowed_providers invalid element',
        patch: () => {
          const path = join(staging, 'roles/executor/role.json');
          const meta = JSON.parse(readFileSync(path, 'utf8'));
          meta.allowed_providers = ['codex', 'claude'];
          writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
        },
        match: /allowed_providers must be a nonempty subset/,
      },
      {
        label: 'allowed_providers duplicate',
        patch: () => {
          const path = join(staging, 'roles/executor/role.json');
          const meta = JSON.parse(readFileSync(path, 'utf8'));
          meta.allowed_providers = ['codex', 'codex', 'fake'];
          writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
        },
        match: /allowed_providers must be unique/,
      },
      {
        label: 'provider not in allowed_providers',
        patch: () => {
          const path = join(staging, 'roles/executor/role.json');
          const meta = JSON.parse(readFileSync(path, 'utf8'));
          meta.provider = 'codex';
          meta.allowed_providers = ['fake'];
          writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
        },
        match: /provider must be in allowed_providers/,
      },
      {
        label: 'description too long',
        patch: () => {
          const path = join(staging, 'roles/planner/role.json');
          const meta = JSON.parse(readFileSync(path, 'utf8'));
          meta.description = 'x'.repeat(201);
          writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
        },
        match: /description must be at most 200/,
      },
      {
        label: 'instruction line too long',
        patch: () => {
          writeFileSync(join(staging, 'roles/planner/prompt.md'), `${'y'.repeat(501)}\n`);
        },
        match: /each instruction must be at most 500/,
      },
      {
        label: 'fragments.json unknown top-level field',
        patch: () => {
          const path = join(staging, 'roles/_shared/fragments.json');
          const index = JSON.parse(readFileSync(path, 'utf8'));
          index.extra = true;
          writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
        },
        match: /fragments\.json: unknown field/,
      },
    ];

    for (const { label, patch, match } of cases) {
      rmSync(join(staging, 'roles'), { recursive: true, force: true });
      cpSync(ROLES, join(staging, 'roles'), { recursive: true });
      patch();
      const result = spawnSync(NODE, [join(staging, 'scripts/gen-roles.mjs')], {
        cwd: staging, encoding: 'utf8', env: { PATH: MIN_PATH, HOME: staging },
      });
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, match, `${label}: ${result.stderr}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('AC-5 validateRole still rejects non-auto cursor_model; resolver forbids cursor', () => {
  assert.throws(
    () => validateRole({ ...builtinRoles().find(r => r.name === 'reviewer')!, cursor_model: 'sonnet' as 'auto' }),
    (e: unknown) => e instanceof Error && /cursor_model|auto/i.test(e.message),
  );
  const resolver = builtinRoles().find(r => r.name === 'resolver')!;
  assert.ok(!resolver.allowed_providers.includes('cursor'));
  assert.throws(() => validateRole({ ...resolver, allowed_providers: ['codex', 'cursor', 'fake'] }));
  for (const role of ROLE_SOURCES) assert.equal(role.cursor_model, 'auto');
});

/** Intentionally kept in src/ (not _shared fragments). See roles/README.md. */
const AC6_KEEP_LITERALS = [
  '# gbdev worker task',
  '## Role',
  '## Pipeline context',
  '## Prior steps',
  '## Task',
  'Describe an actual finding',
  'Describe the task decomposition',
  'Describe the change',
  'Describe acceptance',
  'Describe how both sides intent is preserved',
  'Previous attempt summary:',
  'Fix final review findings',
  'Resolve final review findings',
  'Task title',
];

/** Migrated static prompt sentences that must not reappear as string literals in src/. */
const AC6_MIGRATED_LITERALS = [
  'Rebuild this task on current integration.',
  'Retry this task.',
  'This task passed in its lane but failed after integration. Integrated tasks:',
];

test('AC-6 relocated static lines (≥40 chars) absent from src/**/*.ts except catalog', () => {
  const shared = join(ROLES, '_shared');
  const longLines: string[] = [];
  for (const name of readdirSync(shared).filter(n => n.endsWith('.md'))) {
    const text = readFileSync(join(shared, name), 'utf8');
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    for (const line of body.split('\n')) if (line.length >= 40) longLines.push(line);
  }
  assert.ok(longLines.length > 0);
  const files = walkTs(join(ROOT, 'src'));
  for (const line of longLines) {
    for (const file of files) {
      assert.equal(readFileSync(file, 'utf8').includes(line), false, `${file} still contains: ${line.slice(0, 60)}`);
    }
  }
  for (const lit of AC6_MIGRATED_LITERALS) {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.equal(text.includes(lit), false, `${file} still contains migrated literal: ${lit}`);
    }
  }
  // Keep-list items may remain; assert the list itself is non-empty documentation of intent.
  assert.ok(AC6_KEEP_LITERALS.length > 0);
});

test('AC-3 production assemblers match snapshot; legal fix seeds + finalReview first attempt', async () => {
  const { assembleFinalReviewPrompt, assembleRunJobPrompt, integrationFixContextLine, rebuildOrRetryLine } =
    await import('../src/run/promptAssembly.js');
  const { renderStepPrompt } = await import('../src/pipeline/prompt.js');
  const { VERDICT_RETRY_NOTICE } = await import('../src/core/prompt.js');
  const { validateSeedFindings } = await import('../src/contracts/seedFindings.js');
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const { capturePrompts } = await import(pathToFileURL(join(ROOT, 'scripts/m6-prompt-snapshot.mjs')).href);
  const actual = await capturePrompts(join(ROOT, 'dist'));
  assert.equal(actual.internalPrompts.planner, snap.internalPrompts.planner);
  assert.equal(actual.internalPrompts.resolver, snap.internalPrompts.resolver);
  assert.equal(actual.internalPrompts.conflictVerifier, snap.internalPrompts.conflictVerifier);
  assert.equal(actual.internalPrompts.finalReview, snap.internalPrompts.finalReview);
  assert.equal(rebuildOrRetryLine('rebuild'), 'Rebuild this task on current integration.');
  assert.equal(rebuildOrRetryLine('retry'), 'Retry this task.');
  assert.equal(
    integrationFixContextLine('task-a, task-b'),
    'This task passed in its lane but failed after integration. Integrated tasks: task-a, task-b',
  );

  // Production first-step seed path (NOT historical kind:'fix'/round:1 snapshot alias).
  // pipeline.ts:76-77 initializes steps with kind:'step', round:0;
  // supervisor.ts:125-129 passes that shape + seed_findings on first step.
  const extra = JSON.parse(readFileSync(SNAPSHOT_EXTRA, 'utf8')) as {
    prompts: { firstStepSeedIntegrationGate: string; firstStepSeedFinalReview: string };
  };
  const runFinding = { id: 'C1', severity: 'major' as const, file: null, line: null, text: 'Integration check failed: gate' };
  const integrationSeed = validateSeedFindings({
    source: 'integration_gate',
    findings: [runFinding],
    logs: [{ check_id: 'gate', tail: 'line1\nline2' }],
  });
  const finalSeed = validateSeedFindings({
    source: 'final_review',
    findings: [runFinding],
    logs: [{ check_id: 'review', tail: 'finding tail' }],
  });
  const briefBase = {
    schema: 'gbdev.task-brief.v1' as const,
    brief_id: 'b_legal_seed',
    repo: '/snapshot/repo',
    base_ref: 'abc0001',
    role: 'fixer',
    provider: 'fake' as const,
    model: null,
    sandbox: 'workspace-write' as const,
    timeout_min: 30,
    network: false as const,
    goal: 'Fix',
    context: 'ctx',
    constraints: [] as string[],
    allowed_paths: ['src/**'],
    acceptance_criteria: [] as { id: string; text: string; check_cmd?: string }[],
    required_evidence: [] as string[],
    parent_job_id: null,
    answers: [] as never[],
  };
  const role = { output: 'change' as const, instructions_text: 'Fix instructions.' };
  const firstStep = {
    instance: 'fix#1',
    index: 1,
    total: 2,
    round: 0,
    max_rounds: 1,
    kind: 'step' as const,
    diff_base_sha: 'abc123',
    role,
    prior_handoffs: [] as never[],
    decisions: [] as never[],
    fix_findings: [] as never[],
    check_logs: [] as never[],
  };
  // supervisor.ts:273 when source===integration_gate
  const integrationBrief = {
    ...briefBase,
    context: `ctx\n${integrationFixContextLine('task-a, task-b')}`,
  };
  const integrationFix = renderStepPrompt(integrationBrief, {
    ...firstStep,
    pipeline: 'integration-fix',
    seed_findings: integrationSeed,
  });
  const finalFix = renderStepPrompt(briefBase, {
    ...firstStep,
    pipeline: 'final-fix',
    seed_findings: finalSeed,
  });
  assert.equal(integrationFix, extra.prompts.firstStepSeedIntegrationGate);
  assert.equal(finalFix, extra.prompts.firstStepSeedFinalReview);
  assert.notEqual(integrationFix, finalFix);

  const frBrief = {
    schema: 'gbdev.task-brief.v1' as const,
    brief_id: 'b_m6_snapshot_001',
    repo: '/snapshot/repo',
    base_ref: 'abc0001',
    role: 'reviewer',
    provider: 'fake' as const,
    model: null,
    sandbox: 'read-only' as const,
    timeout_min: 30,
    network: false as const,
    goal: 'Snapshot goal',
    context: 'Snapshot context',
    constraints: ['No new dependencies'],
    allowed_paths: ['src/**', 'test/**'],
    acceptance_criteria: [{ id: 'AC1', text: 'Tests pass' }],
    required_evidence: ['tests'],
    parent_job_id: null,
    answers: [] as { question_id: string; answer: string }[],
  };
  const frUntrusted = 'diff text\n' + JSON.stringify({ tasks: [], pipelines: [] });
  const first = assembleFinalReviewPrompt({
    brief: frBrief,
    instructionsText: 'Reviewer instructions.',
    notes: ['accepted by decider'],
    untrusted: frUntrusted,
    includeRetryNotice: false,
  });
  const retry = assembleFinalReviewPrompt({
    brief: frBrief,
    instructionsText: 'Reviewer instructions.',
    notes: ['accepted by decider'],
    untrusted: frUntrusted,
    includeRetryNotice: true,
  });
  assert.equal(retry, snap.internalPrompts.finalReview);
  assert.equal(first.includes(VERDICT_RETRY_NOTICE), false);
  assert.equal(retry.startsWith(first), true);
  assert.equal(retry.slice(first.length), VERDICT_RETRY_NOTICE);
  assert.equal(typeof assembleRunJobPrompt, 'function');
});

test('AC-7 build packs catalog; dist runs roles list without roles/', t => {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: MIN_PATH, HOME: tmpdir() }, shell: false,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.ok(existsSync(join(ROOT, 'dist/roles/catalog.generated.js')));

  // realpath: macOS tmpdir is often /var → /private/var; cli main-gate compares import.meta.url to argv[1].
  const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'gbdev-m6-dist-')));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  cpSync(join(ROOT, 'dist'), join(isolated, 'dist'), { recursive: true });
  const home = join(isolated, 'home');
  const config = join(isolated, 'config.json');
  writeFileSync(config, JSON.stringify({
    version: 1,
    allowed_repos: [],
    providers: {
      codex: { bin: join(isolated, 'missing-codex') },
      cursor: { bin: join(isolated, 'missing-cursor-agent') },
    },
  }));
  const cli = realpathSync(join(isolated, 'dist/cli.js'));
  const result = spawnSync(NODE, [cli, 'roles', 'list', '--json'], {
    encoding: 'utf8',
    env: {
      PATH: MIN_PATH,
      HOME: isolated,
      GBDEV_HOME: home,
      GBDEV_CONFIG: config,
      GBDEV_CLI_HOME: join(isolated, 'cli-home'),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.trim(), `expected JSON stdout, got ${JSON.stringify(result)}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.result_schema, 'gbdev.role-list.v1');
  assert.deepEqual(envelope.result.roles.map((r: { name: string }) => r.name),
    ['executor', 'fixer', 'inspector', 'planner', 'resolver', 'reviewer', 'verifier']);
});

test('AC-8 user override directory dirname(config)/roles/*.json unchanged', t => {
  const root = temporary(t);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ version: 1 }));
  mkdirSync(join(root, 'roles'));
  const base = builtinRoles().find(r => r.name === 'executor')!;
  writeFileSync(join(root, 'roles', 'executor.json'), JSON.stringify({
    schema: 'gbdev.role.v1',
    name: 'executor',
    description: 'User override description for executor role',
    provider: 'fake',
  }));
  const registry = new RoleRegistry(config);
  const role = registry.resolve('executor');
  assert.equal(role.source, 'builtin+user');
  assert.equal(role.description, 'User override description for executor role');
  assert.equal(role.provider, 'fake');
  assert.equal(role.default_timeout_min, base.default_timeout_min);
  assert.equal(registry.resolve('reviewer').source, 'builtin');
});
