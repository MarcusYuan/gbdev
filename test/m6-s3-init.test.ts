import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { validateEnvelope } from '../src/contracts/envelope.js';
import {
  validateHomeBinding, validateInitResult, validateInstallResult, validateDoctorResult,
} from '../src/contracts/commandResults.js';
import { normalizeBotLabel, initText } from '../src/commands/init.js';
import { PATH_HINT, sharedLauncherPaths } from '../src/core/launcher.js';
import { defaultConfigPath, defaultHomePath, homeConfigPath, resolvePaths } from '../src/core/paths.js';
import { computeSecretGen } from '../src/notify/secret.js';
import { identity } from '../src/dashboard/names.js';
import { unwrap } from './helpers/tmpRepo.js';
import { brief } from './helpers.js';

const ROOT = resolve('.');
const NODE = process.execPath;
const NODE_BIN = dirname(NODE);
const CLI = realpathSync(join(ROOT, 'dist/cli.js'));
const MIN_PATH = `${NODE_BIN}:/usr/bin:/bin`;

const SENTINEL_URL = 'https://sentinel.example.invalid/m6-s3-webhook-do-not-leak';
const SENTINEL_KEY = 'GBDEVTESTKEY-m6-s3-sentinel-do-not-leak';

type SnapEntry = {
  type: 'dir' | 'file' | 'link';
  mode: number;
  mtimeMs: number;
  size: number;
  hash: string | null;
  target: string | null;
};

/** Full-tree snapshot for AC-18/19/23 zero-write proofs (P2-8). */
function treeSnapshot(dir: string): Map<string, SnapEntry> {
  const out = new Map<string, SnapEntry>();
  const walk = (base: string, rel = '') => {
    let st;
    try { st = lstatSync(base); } catch { return; }
    const key = rel || '.';
    if (st.isSymbolicLink()) {
      out.set(key, {
        type: 'link', mode: st.mode, mtimeMs: st.mtimeMs, size: st.size,
        hash: null, target: readlinkSync(base),
      });
      return;
    }
    if (st.isDirectory()) {
      out.set(key, {
        type: 'dir', mode: st.mode, mtimeMs: st.mtimeMs, size: st.size,
        hash: null, target: null,
      });
      let entries: string[];
      try { entries = readdirSync(base); } catch { return; }
      for (const name of entries.sort()) {
        walk(join(base, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    const content = readFileSync(base);
    out.set(key, {
      type: 'file', mode: st.mode, mtimeMs: st.mtimeMs, size: st.size,
      hash: createHash('sha256').update(content).digest('hex'), target: null,
    });
  };
  walk(dir);
  return out;
}

function fixtureSnapshot(root: string): Map<string, SnapEntry> {
  return treeSnapshot(root);
}

function fixture(t: { after: (fn: () => void) => void }, opts: { withGlobalNotify?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbdev-m6-s3-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const cliHome = join(root, '.gbdev-cli');
  const defaultHome = join(root, '.gbdev');
  const globalConfigDir = join(root, '.config', 'gbdev');
  const globalConfig = join(globalConfigDir, 'config.json');
  const secretsDir = join(globalConfigDir, 'notify');
  mkdirSync(defaultHome, { recursive: true, mode: 0o700 });
  mkdirSync(globalConfigDir, { recursive: true, mode: 0o700 });
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const globalBody: Record<string, unknown> = {
    version: 1,
    allowed_repos: [join(root, 'repo')],
    providers: {
      codex: { bin: join(root, 'missing-codex') },
      cursor: { bin: join(root, 'missing-cursor-agent') },
    },
  };
  if (opts.withGlobalNotify) {
    globalBody.notify = { enabled: true, key_name: 'X-Key', secret_source: 'file' };
  }
  writeFileSync(globalConfig, JSON.stringify(globalBody, null, 2) + '\n', { mode: 0o600 });
  // M5-format sentinel secret keyed by default home h12 (AC-24).
  const h12 = identity(defaultHome).h12;
  writeFileSync(
    join(secretsDir, `${h12}.secret.json`),
    JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: SENTINEL_URL, key: SENTINEL_KEY }) + '\n',
    { mode: 0o600 },
  );
  for (const name of ['.zshrc', '.zprofile', '.bashrc', '.profile']) {
    writeFileSync(join(root, name), `# sentinel ${name}\n`);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: MIN_PATH,
    HOME: root,
    GBDEV_CLI_HOME: cliHome,
  };
  delete env.GBDEV_HOME;
  delete env.GBDEV_CONFIG;

  const run = (args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) =>
    spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const runJson = (args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) => {
    const result = run([...args, '--json'], extra);
    assert.equal(result.stderr, '', result.stderr);
    const envelope = validateEnvelope(JSON.parse(result.stdout));
    return { ...result, envelope };
  };
  const assertNoSentinel = (...texts: string[]) => {
    for (const text of texts) {
      assert.equal(text.includes(SENTINEL_URL), false, 'leaked sentinel URL');
      assert.equal(text.includes(SENTINEL_KEY), false, 'leaked sentinel key');
    }
  };
  return { root, cliHome, defaultHome, globalConfig, globalConfigDir, secretsDir, env, run, runJson, assertNoSentinel };
}

function secretGenForFile(path: string): string {
  const st = lstatSync(path);
  return computeSecretGen({ source: 'file', mtimeMs: st.mtimeMs, size: st.size, ino: st.ino })!;
}

test('AC-16 label normalization table with exact truncation', () => {
  assert.equal(normalizeBotLabel('Example Dev'), 'example-dev');
  assert.equal(normalizeBotLabel('my-bot'), 'my-bot');
  assert.equal(normalizeBotLabel('--x__y--'), 'x-y');
  assert.equal(normalizeBotLabel('9abc'), 'abc');
  // Exact truncation to 32 chars.
  const long = `a${'b'.repeat(40)}`;
  assert.equal(normalizeBotLabel(long), 'abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(normalizeBotLabel(long).length, 32);
  // Truncation that lands on a trailing dash → strip trailing dashes (AC-16).
  const dashy = `a${'b'.repeat(30)}-extra`;
  assert.equal(normalizeBotLabel(dashy), `a${'b'.repeat(30)}`);
  assert.match(normalizeBotLabel(dashy), /^[a-z][a-z0-9-]{0,31}$/);
  assert.equal(normalizeBotLabel(dashy).endsWith('-'), false);
  for (const bad of ['', '123', 'cli', 'bootstrap']) {
    assert.throws(() => normalizeBotLabel(bad), (e: unknown) => e instanceof Error && 'contract' in e
      && (e as { contract: { code: string } }).contract.code === 'usage_error');
  }
});

test('AC-16 CLI rejects reserved/empty labels with usage_error', t => {
  const f = fixture(t);
  for (const label of ['', '123', 'cli', 'bootstrap']) {
    const out = f.runJson(['init', '--bot', label]);
    assert.equal(out.status, 2, label);
    assert.equal(out.envelope.ok, false);
    if (!out.envelope.ok) assert.equal(out.envelope.error.code, 'usage_error');
  }
});

test('AC-17 new label creates home/home.json/config/launchers; second call unchanged', t => {
  const f = fixture(t, { withGlobalNotify: true });
  const first = f.runJson(['init', '--bot', 'Example Dev']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const r = validateInitResult(unwrap(first.envelope));
  assert.equal(r.bot_label, 'example-dev');
  assert.equal(r.bot_label_input, 'Example Dev');
  assert.equal(r.legacy_default, false);
  assert.equal(r.home_action, 'created');
  assert.equal(r.binding.action, 'created');
  assert.equal(r.config.action, 'created');
  assert.equal(r.home, join(f.root, '.gbdev-example-dev'));
  assert.equal(lstatSync(r.home).mode & 0o777, 0o700);
  const binding = validateHomeBinding(JSON.parse(readFileSync(r.binding.path, 'utf8')));
  assert.equal(binding.bot_label, 'example-dev');
  assert.equal(lstatSync(r.binding.path).mode & 0o777, 0o600);
  const createdAt = binding.created_at;
  const cfg = JSON.parse(readFileSync(r.config.path, 'utf8')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(cfg, 'notify'), false);
  assert.equal(cfg.version, 1);
  assert.deepEqual(cfg.allowed_repos, [join(f.root, 'repo')]);
  assert.equal(lstatSync(r.config.path).mode & 0o777, 0o600);
  // Seeded result equals global config minus notify (P2-8 / AC-17).
  const globalRaw = JSON.parse(readFileSync(f.globalConfig, 'utf8')) as Record<string, unknown>;
  const { notify: _n, ...withoutNotify } = globalRaw;
  assert.deepEqual(cfg, withoutNotify);
  assert.equal(existsSync(join(f.cliHome, 'bin', 'gbdev')), true);
  assert.equal(existsSync(r.bot_launcher.path), true);
  assert.match(readFileSync(r.bot_launcher.path, 'utf8'), /unset GBDEV_CONFIG/);
  assert.match(readFileSync(r.bot_launcher.path, 'utf8'), new RegExp(`GBDEV_HOME='${r.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  const sharedMtime = lstatSync(r.launcher.path).mtimeMs;
  const botMtime = lstatSync(r.bot_launcher.path).mtimeMs;

  const second = f.runJson(['init', '--bot', 'example-dev']);
  assert.equal(second.status, 0);
  const again = validateInitResult(unwrap(second.envelope));
  assert.equal(again.home_action, 'unchanged');
  assert.equal(again.binding.action, 'unchanged');
  assert.equal(again.config.action, 'unchanged');
  assert.equal(again.launcher.action, 'unchanged');
  assert.equal(again.bot_launcher.action, 'unchanged');
  assert.equal(validateHomeBinding(JSON.parse(readFileSync(again.binding.path, 'utf8'))).created_at, createdAt);
  assert.equal(lstatSync(again.launcher.path).mtimeMs, sharedMtime);
  assert.equal(lstatSync(again.bot_launcher.path).mtimeMs, botMtime);
  // Global config untouched (still has notify).
  assert.equal(JSON.parse(readFileSync(f.globalConfig, 'utf8')).notify.enabled, true);
});

test('AC-18 legacy_default zero-write on default home + global config', t => {
  const f = fixture(t);
  mkdirSync(join(f.defaultHome, 'notify'), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.defaultHome, 'notify', 'state.json'), JSON.stringify({
    verified_by_bot: 'my-bot',
    verified_at: '2026-10-30T12:00:00.000-07:00',
    verified_secret_gen: '1:1:1',
    verified_notice_id: 'n_0123456789abcdef',
  }) + '\n', { mode: 0o600 });
  writeFileSync(join(f.defaultHome, 'marker.txt'), 'keep\n');
  const beforeFixture = fixtureSnapshot(f.root);
  const beforeHome = treeSnapshot(f.defaultHome);
  const beforeGlobal = readFileSync(f.globalConfig);
  const beforeGlobalStat = statSync(f.globalConfig);

  const out = f.runJson(['init', '--bot', 'my-bot']);
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const r = validateInitResult(unwrap(out.envelope));
  assert.equal(r.legacy_default, true);
  assert.equal(r.home, f.defaultHome);
  assert.equal(r.home_action, 'none');
  assert.equal(r.binding.action, 'none');
  assert.equal(r.config.action, 'none');
  assert.equal(r.config.seeded_from, null);
  assert.equal(r.config.path, f.globalConfig);

  assert.deepEqual(treeSnapshot(f.defaultHome), beforeHome);
  assert.deepEqual(readFileSync(f.globalConfig), beforeGlobal);
  assert.equal(statSync(f.globalConfig).mtimeMs, beforeGlobalStat.mtimeMs);
  // Bot launcher may be written under cli home (outside default home); default home tree intact.
  assert.equal(existsSync(r.bot_launcher.path), true);
  assert.deepEqual(treeSnapshot(f.defaultHome), beforeHome);
  // P2-12: compare before/after Maps with the same exclusion rules (entry set deepEqual).
  // Root `.` only exempts mtime/size (creating `.gbdev-cli` updates both); keep type + mode.
  const after = fixtureSnapshot(f.root);
  const excludeCli = (key: string) => key === '.gbdev-cli' || key.startsWith('.gbdev-cli/');
  const filterMap = (snap: Map<string, SnapEntry>) => {
    const out = new Map<string, unknown>();
    for (const [key, val] of snap) {
      if (excludeCli(key)) continue;
      if (key === '.') {
        out.set(key, { type: val.type, mode: val.mode });
        continue;
      }
      out.set(key, val);
    }
    return out;
  };
  assert.deepEqual(filterMap(after), filterMap(beforeFixture));
  const beforeRoot = beforeFixture.get('.')!;
  const afterRoot = after.get('.')!;
  assert.equal(afterRoot.type, beforeRoot.type);
  assert.equal(afterRoot.mode, beforeRoot.mode);
});

test('AC-19 home_conflict three cases with zero writes on full fixture', t => {
  const f = fixture(t);

  // 1) home.json bound to other label
  {
    const home = join(f.root, '.gbdev-taken');
    mkdirSync(home, { mode: 0o700 });
    const binding = {
      schema: 'gbdev.home.v1',
      bot_label: 'other-bot',
      home: realpathSync(home),
      home_id: identity(home).h12,
      created_at: '2026-10-30T12:00:00.000-07:00',
      gbdev_version: '1.0.0',
    };
    writeFileSync(join(home, 'home.json'), JSON.stringify(binding, null, 2) + '\n', { mode: 0o600 });
    const before = fixtureSnapshot(f.root);
    const out = f.runJson(['init', '--bot', 'taken']);
    assert.equal(out.status, 1);
    assert.equal(out.envelope.ok, false);
    if (!out.envelope.ok) {
      assert.equal(out.envelope.error.code, 'home_conflict');
      assert.equal(out.envelope.error.details.bound_bot_label, 'other-bot');
    }
    assert.deepEqual(fixtureSnapshot(f.root), before);
  }

  // 2) non-empty directory without home.json
  {
    const home = join(f.root, '.gbdev-smokeish');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'leftover.txt'), 'nope\n');
    const before = fixtureSnapshot(f.root);
    const out = f.runJson(['init', '--bot', 'smokeish']);
    assert.equal(out.status, 1);
    assert.equal(out.envelope.ok, false);
    if (!out.envelope.ok) {
      assert.equal(out.envelope.error.code, 'home_conflict');
      assert.equal(out.envelope.error.details.bound_bot_label, null);
    }
    assert.deepEqual(fixtureSnapshot(f.root), before);
  }

  // 3) --home points at default home bound to another bot
  {
    mkdirSync(join(f.defaultHome, 'notify'), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.defaultHome, 'notify', 'state.json'), JSON.stringify({
      verified_by_bot: 'my-bot',
      verified_at: '2026-10-30T12:00:00.000-07:00',
      verified_secret_gen: '1:1:1',
    }) + '\n');
    const before = fixtureSnapshot(f.root);
    const out = f.runJson(['init', '--bot', 'someone-else', '--home', f.defaultHome]);
    assert.equal(out.status, 1);
    assert.equal(out.envelope.ok, false);
    if (!out.envelope.ok) {
      assert.equal(out.envelope.error.code, 'home_conflict');
      assert.equal(out.envelope.error.details.bound_bot_label, 'my-bot');
    }
    assert.deepEqual(fixtureSnapshot(f.root), before);
  }
});

test('P1-2 unsafe home config layouts rejected with zero external writes', t => {
  const f = fixture(t);
  const external = join(f.root, 'external-config');
  mkdirSync(external, { recursive: true, mode: 0o755 });
  const externalCfg = join(external, 'config.json');
  writeFileSync(externalCfg, JSON.stringify({ version: 1, marker: 'external' }) + '\n');
  const beforeExternal = {
    bytes: readFileSync(externalCfg),
    st: lstatSync(externalCfg),
    dirMode: lstatSync(external).mode,
  };

  for (const [label, setup] of [
    ['link-config-dir', (home: string) => {
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(join(home, 'home.json'), JSON.stringify({
        schema: 'gbdev.home.v1', bot_label: 'link-config-dir',
        home: realpathSync(home), home_id: identity(home).h12,
        created_at: '2026-10-30T12:00:00.000-07:00', gbdev_version: '1.0.0',
      }, null, 2) + '\n', { mode: 0o600 });
      symlinkSync(external, join(home, 'config'));
    }],
    ['link-config-json', (home: string) => {
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(join(home, 'home.json'), JSON.stringify({
        schema: 'gbdev.home.v1', bot_label: 'link-config-json',
        home: realpathSync(home), home_id: identity(home).h12,
        created_at: '2026-10-30T12:00:00.000-07:00', gbdev_version: '1.0.0',
      }, null, 2) + '\n', { mode: 0o600 });
      mkdirSync(join(home, 'config'), { mode: 0o700 });
      symlinkSync(externalCfg, join(home, 'config', 'config.json'));
    }],
    ['dangling-config', (home: string) => {
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(join(home, 'home.json'), JSON.stringify({
        schema: 'gbdev.home.v1', bot_label: 'dangling-config',
        home: realpathSync(home), home_id: identity(home).h12,
        created_at: '2026-10-30T12:00:00.000-07:00', gbdev_version: '1.0.0',
      }, null, 2) + '\n', { mode: 0o600 });
      mkdirSync(join(home, 'config'), { mode: 0o700 });
      symlinkSync(join(f.root, 'missing-target.json'), join(home, 'config', 'config.json'));
    }],
  ] as const) {
    const home = join(f.root, `.gbdev-${label}`);
    setup(home);
    const before = fixtureSnapshot(f.root);
    for (const dry of [false, true]) {
      const args = dry
        ? ['init', '--bot', label, '--dry-run']
        : ['init', '--bot', label];
      const out = f.runJson(args);
      assert.equal(out.status, 1, `${label} dry=${dry}`);
      assert.equal(out.envelope.ok, false);
      if (!out.envelope.ok) assert.equal(out.envelope.error.code, 'home_conflict');
      assert.deepEqual(fixtureSnapshot(f.root), before);
      assert.deepEqual(readFileSync(externalCfg), beforeExternal.bytes);
      assert.equal(lstatSync(externalCfg).mtimeMs, beforeExternal.st.mtimeMs);
      assert.equal(lstatSync(external).mode, beforeExternal.dirMode);
    }
  }
});

test('P1-3 reject homes and launchers inside default home tree', t => {
  const f = fixture(t);
  writeFileSync(join(f.defaultHome, 'marker.txt'), 'keep\n');

  // Direct child path
  {
    const before = treeSnapshot(f.defaultHome);
    const beforeFx = fixtureSnapshot(f.root);
    for (const dry of [false, true]) {
      const args = ['init', '--bot', 'child-bot', '--home', join(f.defaultHome, 'new-bot')];
      if (dry) args.push('--dry-run');
      const out = f.runJson(args);
      assert.equal(out.status, 1, `child dry=${dry}`);
      assert.equal(out.envelope.ok, false);
      if (!out.envelope.ok) assert.equal(out.envelope.error.code, 'home_conflict');
      assert.deepEqual(treeSnapshot(f.defaultHome), before);
      assert.deepEqual(fixtureSnapshot(f.root), beforeFx);
    }
  }

  // Multi-level child
  {
    const before = treeSnapshot(f.defaultHome);
    const target = join(f.defaultHome, 'a', 'b', 'c');
    for (const dry of [false, true]) {
      const args = ['init', '--bot', 'deep-bot', '--home', target];
      if (dry) args.push('--dry-run');
      const out = f.runJson(args);
      assert.equal(out.status, 1);
      if (!out.envelope.ok) assert.equal(out.envelope.error.code, 'home_conflict');
      assert.deepEqual(treeSnapshot(f.defaultHome), before);
    }
  }

  // Ancestor symlink alias into default home
  {
    const alias = join(f.root, 'alias-gbdev');
    symlinkSync(f.defaultHome, alias);
    const before = treeSnapshot(f.defaultHome);
    const beforeFx = fixtureSnapshot(f.root);
    for (const dry of [false, true]) {
      const args = ['init', '--bot', 'alias-bot', '--home', join(alias, 'nested')];
      if (dry) args.push('--dry-run');
      const out = f.runJson(args);
      assert.equal(out.status, 1, `alias dry=${dry}`);
      if (!out.envelope.ok) assert.equal(out.envelope.error.code, 'home_conflict');
      assert.deepEqual(treeSnapshot(f.defaultHome), before);
      assert.deepEqual(fixtureSnapshot(f.root), beforeFx);
    }
  }

  // GBDEV_CLI_HOME inside default home → launcher_conflict
  {
    const cliInside = join(f.defaultHome, 'cli-inside');
    const before = treeSnapshot(f.defaultHome);
    const beforeFx = fixtureSnapshot(f.root);
    for (const dry of [false, true]) {
      const args = ['init', '--bot', 'cli-in-home'];
      if (dry) args.push('--dry-run');
      const out = f.runJson(args, { GBDEV_CLI_HOME: cliInside });
      assert.equal(out.status, 1, `cli-home dry=${dry}`);
      assert.equal(out.envelope.ok, false);
      if (!out.envelope.ok) assert.equal(out.envelope.error.code, 'launcher_conflict');
      assert.deepEqual(treeSnapshot(f.defaultHome), before);
      assert.deepEqual(fixtureSnapshot(f.root), beforeFx);
    }
  }
});

test('P2-6 existing home/config dirs must be 0700', t => {
  const f = fixture(t);
  for (const mode of [0o755, 0o777] as const) {
    const label = `mode-${mode.toString(8)}`;
    const home = join(f.root, `.gbdev-${label}`);
    mkdirSync(home, { mode });
    chmodSync(home, mode);
    const before = fixtureSnapshot(f.root);
    const out = f.runJson(['init', '--bot', label]);
    assert.equal(out.status, 1, label);
    assert.equal(out.envelope.ok, false);
    if (!out.envelope.ok) {
      assert.equal(out.envelope.error.code, 'home_conflict');
      assert.equal(out.envelope.error.details.mode, `0${mode.toString(8)}`);
    }
    assert.deepEqual(fixtureSnapshot(f.root), before);
  }
  // Existing config/ with wrong mode
  {
    const home = join(f.root, '.gbdev-cfgmode');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'home.json'), JSON.stringify({
      schema: 'gbdev.home.v1', bot_label: 'cfgmode',
      home: realpathSync(home), home_id: identity(home).h12,
      created_at: '2026-10-30T12:00:00.000-07:00', gbdev_version: '1.0.0',
    }, null, 2) + '\n', { mode: 0o600 });
    mkdirSync(join(home, 'config'), { mode: 0o755 });
    chmodSync(join(home, 'config'), 0o755);
    const before = fixtureSnapshot(f.root);
    const out = f.runJson(['init', '--bot', 'cfgmode']);
    assert.equal(out.status, 1);
    if (!out.envelope.ok) {
      assert.equal(out.envelope.error.code, 'home_conflict');
      assert.equal(out.envelope.error.details.mode, '0755');
    }
    assert.deepEqual(fixtureSnapshot(f.root), before);
  }
});

test('AC-20 resolvePaths priority, symlink ignored, default unchanged', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbdev-m6-s3-paths-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, '.gbdev-bot');
  mkdirSync(join(home, 'config'), { recursive: true });
  const homeCfg = homeConfigPath(home);
  writeFileSync(homeCfg, JSON.stringify({ version: 1, allowed_repos: ['/tmp/home-only'] }) + '\n');
  const def = resolvePaths({ GBDEV_HOME: home }, root);
  assert.equal(def.configSource, 'home');
  assert.equal(def.config, resolve(homeCfg));

  const envCfg = join(root, 'env-config.json');
  writeFileSync(envCfg, JSON.stringify({ version: 1 }) + '\n');
  const withEnv = resolvePaths({ GBDEV_HOME: home, GBDEV_CONFIG: envCfg }, root);
  assert.equal(withEnv.configSource, 'env');
  assert.equal(withEnv.config, resolve(envCfg));

  // Symlink home config → ignore, fall back to default.
  rmSync(homeCfg);
  const target = join(root, 'elsewhere.json');
  writeFileSync(target, JSON.stringify({ version: 1 }) + '\n');
  symlinkSync(target, homeCfg);
  const ignored = resolvePaths({ GBDEV_HOME: home }, root);
  assert.equal(ignored.configSource, 'default');
  assert.equal(ignored.config, defaultConfigPath(root));
  assert.equal(ignored.homeConfigSymlinkIgnored, true);

  // Default home without config/ matches prior shape (AC-20 / master).
  const defaultHome = defaultHomePath(root);
  mkdirSync(defaultHome, { recursive: true });
  const masterLike = resolvePaths({}, root);
  assert.equal(masterLike.home, join(root, '.gbdev'));
  assert.equal(masterLike.config, join(root, '.config/gbdev/config.json'));
  assert.equal(masterLike.configSource, 'default');
  assert.equal(masterLike.homeConfigSymlinkIgnored, undefined);
});

test('AC-21/AC-22 bot launcher isolates notify enable + fake job into bot home', t => {
  const f = fixture(t, { withGlobalNotify: true });
  const repo = join(f.root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const gitEnv = { ...f.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(f.root, 'gitconfig') };
  writeFileSync(join(f.root, 'gitconfig'), '');
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv });
  assert.equal(git('init', '--initial-branch=main').status, 0);
  writeFileSync(join(repo, 'src', 'a.txt'), 'a\n');
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init').status, 0);

  const init = f.runJson(['init', '--bot', 'iso-bot']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const ir = validateInitResult(unwrap(init.envelope));
  const botHome = ir.home;
  const botLauncher = ir.command;
  const beforeGlobal = readFileSync(f.globalConfig);
  const beforeDefault = treeSnapshot(f.defaultHome);

  const alienHome = join(f.root, 'alien-home');
  const alienConfig = join(f.root, 'alien-config.json');
  mkdirSync(alienHome, { recursive: true });
  writeFileSync(alienConfig, JSON.stringify({ version: 1 }) + '\n');

  const enable = spawnSync(botLauncher, ['notify', 'enable', '--key-name', 'X-Iso', '--json'], {
    encoding: 'utf8',
    env: {
      ...f.env,
      PATH: `${join(f.cliHome, 'bin')}:${MIN_PATH}`,
      GBDEV_HOME: alienHome,
      GBDEV_CONFIG: alienConfig,
    },
  });
  assert.equal(enable.status, 0, enable.stderr || enable.stdout);
  const botCfg = JSON.parse(readFileSync(homeConfigPath(botHome), 'utf8')) as { notify?: { enabled?: boolean; key_name?: string } };
  assert.equal(botCfg.notify?.enabled, true);
  assert.equal(botCfg.notify?.key_name, 'X-Iso');
  assert.deepEqual(readFileSync(f.globalConfig), beforeGlobal);
  assert.deepEqual(treeSnapshot(f.defaultHome), beforeDefault);
  assert.equal(JSON.parse(readFileSync(alienConfig, 'utf8')).notify, undefined);

  const status = spawnSync(botLauncher, ['notify', 'status', '--json'], {
    encoding: 'utf8',
    env: {
      ...f.env,
      PATH: `${join(f.cliHome, 'bin')}:${MIN_PATH}`,
      GBDEV_HOME: alienHome,
      GBDEV_CONFIG: alienConfig,
      GBDEV_NOTIFY: '0',
    },
  });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const statusEnv = validateEnvelope(JSON.parse(status.stdout));
  assert.ok(statusEnv.ok);
  if (statusEnv.ok) {
    assert.equal((statusEnv.result as { home_id: string }).home_id, ir.home_id);
  }

  const briefFile = join(f.root, 'brief.json');
  writeFileSync(briefFile, JSON.stringify({
    ...brief(repo),
    acceptance_criteria: [{ id: 'AC1', text: 'ok', check_cmd: 'true' }],
  }));
  const start = spawnSync(botLauncher, ['start', '--brief', briefFile, '--json'], {
    encoding: 'utf8',
    env: {
      ...f.env,
      PATH: `${join(f.cliHome, 'bin')}:${MIN_PATH}`,
      GBDEV_HOME: alienHome,
      GBDEV_CONFIG: alienConfig,
      GBDEV_FAKE_SCENARIO: 'ok',
      GBDEV_TIMEOUT_SCALE: '1000',
      GBDEV_NOTIFY: '0',
      GBDEV_DASHBOARD: '0',
      NODE_TEST_CONTEXT: '1',
    },
  });
  assert.equal(start.status, 0, start.stderr || start.stdout);
  const startEnv = validateEnvelope(JSON.parse(start.stdout));
  assert.ok(startEnv.ok);
  const jobId = (unwrap(startEnv) as { job_id: string }).job_id;
  assert.equal(existsSync(join(botHome, 'jobs', jobId)), true);
  assert.equal(existsSync(join(alienHome, 'jobs', jobId)), false);
  assert.equal(existsSync(join(f.defaultHome, 'jobs', jobId)), false);
  spawnSync(botLauncher, ['cancel', jobId, '--json'], {
    encoding: 'utf8',
    env: { ...f.env, PATH: `${join(f.cliHome, 'bin')}:${MIN_PATH}`, GBDEV_NOTIFY: '0', GBDEV_DASHBOARD: '0', NODE_TEST_CONTEXT: '1' },
  });
});

test('AC-23 next_steps; --no-install bot/shared combos; --dry-run; secret_gen (P2-4/P2-5)', t => {
  const f = fixture(t);

  // dry-run zero writes on full fixture
  {
    const before = fixtureSnapshot(f.root);
    const out = f.runJson(['init', '--bot', 'dry-bot', '--dry-run']);
    assert.equal(out.status, 0);
    const r = validateInitResult(unwrap(out.envelope));
    assert.equal(r.dry_run, true);
    assert.equal(r.home_action, 'would_create');
    assert.equal(existsSync(join(f.root, '.gbdev-dry-bot')), false);
    assert.equal(existsSync(join(f.cliHome, 'bin', 'gbdev')), false);
    assert.deepEqual(fixtureSnapshot(f.root), before);
  }

  // --no-install: zero launcher writes + install_launcher in next_steps
  {
    const out = f.runJson(['init', '--bot', 'noinst-bot', '--no-install']);
    assert.equal(out.status, 0);
    const r = validateInitResult(unwrap(out.envelope));
    assert.ok(r.next_steps.includes('install_launcher'));
    assert.equal(existsSync(join(f.cliHome, 'bin', 'gbdev')), false);
    assert.equal(existsSync(r.bot_launcher.path), false);
    assert.equal(existsSync(r.home), true);
    const text = initText(r);
    assert.match(text, /re-run `gbdev init`/);
    assert.match(text, /does not create the bot launcher/);
  }

  // Shared current + bot missing → install_launcher (P2-5)
  {
    assert.equal(f.runJson(['install']).status, 0);
    const out = f.runJson(['init', '--bot', 'bot-miss', '--no-install']);
    const r = validateInitResult(unwrap(out.envelope));
    assert.equal(r.launcher.state_before, 'current');
    assert.ok(r.next_steps.includes('install_launcher'));
    assert.equal(existsSync(r.bot_launcher.path), false);
  }

  // Both current → no install_launcher
  {
    const bInit = f.runJson(['init', '--bot', 'ns-b']);
    const rb0 = validateInitResult(unwrap(bInit.envelope));
    const c = f.runJson(['init', '--bot', 'ns-b', '--no-install'], { PATH: `${dirname(rb0.command)}:/usr/bin:/bin` });
    const rc = validateInitResult(unwrap(c.envelope));
    assert.equal(rc.next_steps.includes('install_launcher'), false);
    assert.ok(rc.next_steps.includes('notify_init'));

    // Shared stale + bot current → install_launcher
    writeFileSync(rb0.launcher.path, readFileSync(rb0.launcher.path, 'utf8').replace(/version:.*/, 'version: 0.0.0-stale'));
    const stale = f.runJson(['init', '--bot', 'ns-b', '--no-install'], { PATH: `${dirname(rb0.command)}:/usr/bin:/bin` });
    const rs = validateInitResult(unwrap(stale.envelope));
    assert.equal(rs.launcher.state_before, 'stale');
    assert.ok(rs.next_steps.includes('install_launcher'));
    // Restore shared launcher for subsequent verified tests.
    assert.equal(f.runJson(['install']).status, 0);

    // Four next_steps combinations
    const a = f.runJson(['init', '--bot', 'ns-a', '--no-install'], { PATH: '/usr/bin:/bin' });
    const ra = validateInitResult(unwrap(a.envelope));
    assert.deepEqual(ra.next_steps, ['install_launcher', 'add_path', 'notify_init']);

    const b = f.runJson(['init', '--bot', 'ns-b'], { PATH: `${dirname(rb0.command)}:/usr/bin:/bin` });
    const rb = validateInitResult(unwrap(b.envelope));
    assert.deepEqual(rb.next_steps, ['notify_init']);
    assert.equal(rb.launcher.on_path, true);

    // Verified with matching secret_gen (P2-4)
    mkdirSync(join(rb0.home, 'notify'), { recursive: true, mode: 0o700 });
    const secretPath = join(f.secretsDir, `${rb0.home_id}.secret.json`);
    writeFileSync(secretPath, JSON.stringify({
      schema: 'gbdev.notify-secret.v1', url: 'https://example.invalid/x', key: 'GBDEVTESTKEY-x',
    }) + '\n', { mode: 0o600 });
    const gen = secretGenForFile(secretPath);
    writeFileSync(join(rb0.home, 'notify', 'state.json'), JSON.stringify({
      verified_by_bot: 'ns-b',
      verified_at: '2026-10-30T12:00:00.000-07:00',
      verified_secret_gen: gen,
      verified_notice_id: 'n_0123456789abcdef',
    }) + '\n');
    const cfgPath = homeConfigPath(rb0.home);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.notify = { enabled: true, key_name: 'X-Key', secret_source: 'file' };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    const d = f.runJson(['init', '--bot', 'ns-b'], { PATH: `${dirname(rb0.command)}:/usr/bin:/bin` });
    const rd = validateInitResult(unwrap(d.envelope));
    assert.equal(rd.notify.state, 'verified');
    assert.deepEqual(rd.next_steps, []);

    // Secret rotation → no longer verified
    const oldMtime = lstatSync(secretPath).mtimeMs;
    writeFileSync(secretPath, JSON.stringify({
      schema: 'gbdev.notify-secret.v1', url: 'https://example.invalid/rotated', key: 'GBDEVTESTKEY-rotated',
    }) + '\n', { mode: 0o600 });
    utimesSync(secretPath, new Date(oldMtime + 5000), new Date(oldMtime + 5000));
    const rotated = f.runJson(['init', '--bot', 'ns-b'], { PATH: `${dirname(rb0.command)}:/usr/bin:/bin` });
    const rr = validateInitResult(unwrap(rotated.envelope));
    assert.notEqual(rr.notify.state, 'verified');
    assert.ok(rr.next_steps.includes('notify_init'));

    // Restore matching gen, then old last_test gen → test_sent only if delivered+matching; stale test gen → not verified
    const gen2 = secretGenForFile(secretPath);
    writeFileSync(join(rb0.home, 'notify', 'state.json'), JSON.stringify({
      verified_by_bot: 'ns-b',
      verified_at: '2026-10-30T12:00:00.000-07:00',
      verified_secret_gen: '0:0:0',
      verified_notice_id: 'n_0123456789abcdef',
      last_test: { notice_id: 'n_0123456789abcdef', seq: 1, sent_at: '2026-10-30T12:00:00.000-07:00', http_status: 200, delivered: true },
      last_test_secret_gen: '0:0:0',
    }) + '\n');
    const oldTest = f.runJson(['init', '--bot', 'ns-b'], { PATH: `${dirname(rb0.command)}:/usr/bin:/bin` });
    const rot = validateInitResult(unwrap(oldTest.envelope));
    assert.notEqual(rot.notify.state, 'verified');
    assert.notEqual(rot.notify.state, 'test_sent');
    assert.ok(rot.next_steps.includes('notify_init'));
    void gen2;

    // Unsafe secret permissions → not verified
    writeFileSync(join(rb0.home, 'notify', 'state.json'), JSON.stringify({
      verified_by_bot: 'ns-b',
      verified_at: '2026-10-30T12:00:00.000-07:00',
      verified_secret_gen: secretGenForFile(secretPath),
      verified_notice_id: 'n_0123456789abcdef',
    }) + '\n');
    chmodSync(secretPath, 0o644);
    const unsafe = f.runJson(['init', '--bot', 'ns-b'], { PATH: `${dirname(rb0.command)}:/usr/bin:/bin` });
    const ru = validateInitResult(unwrap(unsafe.envelope));
    assert.notEqual(ru.notify.state, 'verified');
    assert.ok(ru.next_steps.includes('notify_init'));
  }
});

test('AC-24 init/install/doctor stdout/stderr/files contain no sentinel secrets', t => {
  const f = fixture(t);
  const init = f.runJson(['init', '--bot', 'safe-bot']);
  assert.equal(init.status, 0);
  f.assertNoSentinel(init.stdout, init.stderr ?? '');
  const r = validateInitResult(unwrap(init.envelope));
  f.assertNoSentinel(readFileSync(r.binding.path, 'utf8'), readFileSync(r.config.path, 'utf8'));
  f.assertNoSentinel(readFileSync(r.launcher.path, 'utf8'), readFileSync(r.bot_launcher.path, 'utf8'));

  const install = f.runJson(['install']);
  f.assertNoSentinel(install.stdout, install.stderr ?? '');
  validateInstallResult(unwrap(install.envelope));

  const doc = f.runJson(['doctor'], { GBDEV_HOME: r.home });
  f.assertNoSentinel(doc.stdout, doc.stderr ?? '');
  validateDoctorResult(unwrap(doc.envelope));
});

test('AC-25 HELP/COMMANDS include init+install; closed validators; unknown fields (P2-7)', t => {
  const f = fixture(t);
  const help = f.run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\binit\b/);
  assert.match(help.stdout, /\binstall\b/);
  assert.match(help.stdout, /init --bot/);

  const init = f.runJson(['init', '--bot', 'help-bot']);
  assert.equal(init.status, 0);
  const r = validateInitResult(unwrap(init.envelope));
  const install = f.runJson(['install']);
  validateInstallResult(unwrap(install.envelope));

  // Reverse: unknown nested fields / illegal enums rejected
  assert.throws(() => validateInitResult({ ...r, binding: { ...r.binding, extra: 1 } }));
  assert.throws(() => validateInitResult({ ...r, config: { ...r.config, foo: true } }));
  assert.throws(() => validateInitResult({ ...r, launcher: { ...r.launcher, weird: 'x' } }));
  assert.throws(() => validateInitResult({ ...r, bot_launcher: { ...r.bot_launcher, x: 1 } }));
  assert.throws(() => validateInitResult({
    ...r, notify: { ...r.notify, missing_step: 'not_a_real_step' },
  }));
  assert.throws(() => validateInitResult({
    ...r, notify: { ...r.notify, state: 'verified', missing_step: null, verified_by_bot: 'NOT VALID' },
  }));
});

test('doctor home bound:<label>; config detail includes home source', t => {
  const f = fixture(t);
  const init = f.runJson(['init', '--bot', 'doc-bot']);
  const r = validateInitResult(unwrap(init.envelope));
  const doc = f.runJson(['doctor'], { GBDEV_HOME: r.home });
  assert.equal(doc.status, 0);
  const checks = validateDoctorResult(unwrap(doc.envelope)).checks;
  assert.equal(checks.find(c => c.name === 'home')!.detail, 'bound:doc-bot');
  assert.equal(checks.find(c => c.name === 'home')!.ok, true);
  assert.match(String(checks.find(c => c.name === 'config')!.detail), /\(home\)/);

  const cfg = homeConfigPath(r.home);
  const bytes = readFileSync(cfg);
  rmSync(cfg);
  const target = join(f.root, 'link-target.json');
  writeFileSync(target, bytes);
  symlinkSync(target, cfg);
  const doc2 = f.runJson(['doctor'], { GBDEV_HOME: r.home });
  const cfgCheck = validateDoctorResult(unwrap(doc2.envelope)).checks.find(c => c.name === 'config')!;
  assert.match(String(cfgCheck.detail), /\(default; home config symlink ignored\)/);
});

test('three home resolution modes: --home, legacy verified, default ~/.gbdev-<label>', t => {
  const f = fixture(t);
  const custom = join(f.root, 'custom-home');
  const a = f.runJson(['init', '--bot', 'res-a', '--home', custom]);
  assert.equal(validateInitResult(unwrap(a.envelope)).home, custom);

  mkdirSync(join(f.defaultHome, 'notify'), { recursive: true });
  writeFileSync(join(f.defaultHome, 'notify', 'state.json'), JSON.stringify({
    verified_by_bot: 'res-b',
    verified_at: '2026-10-30T12:00:00.000-07:00',
    verified_secret_gen: '1:1:1',
  }) + '\n');
  const b = f.runJson(['init', '--bot', 'res-b']);
  const rb = validateInitResult(unwrap(b.envelope));
  assert.equal(rb.legacy_default, true);
  assert.equal(rb.home, f.defaultHome);

  const c = f.runJson(['init', '--bot', 'res-c']);
  assert.equal(validateInitResult(unwrap(c.envelope)).home, join(f.root, '.gbdev-res-c'));
});

test('init never touches shell rc files', t => {
  const f = fixture(t);
  const snap = () => Object.fromEntries(
    ['.zshrc', '.zprofile', '.bashrc', '.profile'].map(n => [n, readFileSync(join(f.root, n))]),
  );
  const before = snap();
  assert.equal(f.runJson(['init', '--bot', 'rc-bot']).status, 0);
  assert.deepEqual(snap(), before);
});

test('GBDEV_HOME in caller env does not affect init home resolution', t => {
  const f = fixture(t);
  const decoy = join(f.root, 'decoy-home');
  mkdirSync(decoy);
  const out = f.runJson(['init', '--bot', 'env-ignore'], { GBDEV_HOME: decoy });
  const r = validateInitResult(unwrap(out.envelope));
  assert.equal(r.home, join(f.root, '.gbdev-env-ignore'));
  assert.equal(existsSync(join(decoy, 'home.json')), false);
});

test('path_hint constant', () => {
  assert.equal(PATH_HINT, 'export PATH="$HOME/.gbdev-cli/bin:$PATH"');
  assert.equal(sharedLauncherPaths({ GBDEV_CLI_HOME: '/tmp/x' }, '/tmp').launcherDir.endsWith('/bin'), true);
});

test('P3-13 Step 0 skill prefers attach_hint; tmux attach -t gbdev only for default home', () => {
  const text = readFileSync(join(ROOT, 'skills/gbdev-usage/SKILL.md'), 'utf8');
  assert.match(text, /attach_hint/);
  assert.match(text, /tmux attach -t gbdev/);
  assert.match(text, /default.*home|默认/i);
  assert.match(text, /gbdev-<h6>/);
  assert.match(text, /does not affect running tasks|不影响任务/);
  assert.match(text, /~\/\.gbdev-<normalized label>|~\/\.gbdev-<规范化/);
  assert.equal(text.includes(SENTINEL_URL), false);
  assert.equal(text.includes(SENTINEL_KEY), false);
});

test('P2-10 --home pointing at a regular file or file symlink yields home_conflict (dry-run too)', t => {
  const f = fixture(t);
  const asFile = join(f.root, 'home-as-file');
  writeFileSync(asFile, 'not-a-dir\n');
  const linkToFile = join(f.root, 'home-link-file');
  symlinkSync(asFile, linkToFile);

  for (const [label, home] of [['file', asFile], ['link', linkToFile]] as const) {
    for (const dry of [false, true]) {
      const before = fixtureSnapshot(f.root);
      const args = ['init', '--bot', `p210-${label}${dry ? '-d' : ''}`, '--home', home];
      if (dry) args.push('--dry-run');
      const out = f.runJson(args);
      assert.equal(out.status, 1, `${label} dry=${dry}`);
      assert.equal(out.envelope.ok, false);
      if (!out.envelope.ok) assert.equal(out.envelope.error.code, 'home_conflict');
      assert.deepEqual(fixtureSnapshot(f.root), before);
    }
  }
});

test('P2-11 init secret metadata matches notify status for unsafe_location and too_large', t => {
  const f = fixture(t, { withGlobalNotify: true });
  const first = f.runJson(['init', '--bot', 'sec-meta']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const r = validateInitResult(unwrap(first.envelope));
  const home = r.home;
  const homeCfg = join(home, 'config', 'config.json');

  // Unsafe location: secret moved into bot home; metadata (mtime/size/ino) must stay unchanged.
  {
    const stolenDir = join(home, 'stolen-secrets');
    mkdirSync(stolenDir, { mode: 0o700 });
    const stolen = join(stolenDir, 'x.secret.json');
    writeFileSync(
      stolen,
      JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: 'https://example.invalid/hook', key: 'k'.repeat(32) }) + '\n',
      { mode: 0o600 },
    );
    const beforeSt = lstatSync(stolen);
    const cfg = JSON.parse(readFileSync(homeCfg, 'utf8')) as Record<string, unknown>;
    cfg.notify = {
      enabled: true,
      key_name: 'Authorization',
      key_placement: 'header',
      key_prefix: 'Bearer ',
      secret_source: 'file',
      secret_file: stolen,
    };
    writeFileSync(homeCfg, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });

    const initOut = f.runJson(['init', '--bot', 'sec-meta']);
    assert.equal(initOut.status, 0, initOut.stderr || initOut.stdout);
    const initR = validateInitResult(unwrap(initOut.envelope));
    assert.equal(initR.notify.state, 'not_configured');
    assert.equal(initR.notify.missing_step, 'setup_secret');

    const statusOut = f.runJson(['notify', 'status'], {
      PATH: `${dirname(r.command)}:${MIN_PATH}`,
      GBDEV_HOME: home,
    });
    // Clear inherited GBDEV_CONFIG from bot launcher by invoking CLI with env unset —
    // bot launcher unsets it; here we call CLI directly with GBDEV_HOME only so home config applies.
    assert.equal(statusOut.status, 0, statusOut.stderr || statusOut.stdout);
    const status = unwrap(statusOut.envelope) as {
      secret_ok: boolean; secret_problem: string | null; init: { state: string; missing_step: string | null };
    };
    assert.equal(status.secret_ok, false);
    assert.equal(status.secret_problem, 'unsafe_location');
    assert.equal(status.init.state, 'not_configured');
    assert.equal(status.init.missing_step, 'setup_secret');
    assert.equal(initR.notify.state, status.init.state);
    assert.equal(initR.notify.missing_step, status.init.missing_step);

    const afterSt = lstatSync(stolen);
    assert.equal(afterSt.mtimeMs, beforeSt.mtimeMs);
    assert.equal(afterSt.size, beforeSt.size);
    assert.equal(afterSt.ino, beforeSt.ino);
  }

  // Too large: >4096 bytes at a safe default secret path for this home.
  {
    const h12 = identity(home).h12;
    const bigPath = join(f.secretsDir, `${h12}.secret.json`);
    writeFileSync(bigPath, `${'x'.repeat(5000)}\n`, { mode: 0o600 });
    const cfg = JSON.parse(readFileSync(homeCfg, 'utf8')) as Record<string, unknown>;
    cfg.notify = {
      enabled: true,
      key_name: 'Authorization',
      key_placement: 'header',
      key_prefix: 'Bearer ',
      secret_source: 'file',
      // omit secret_file → default path under ~/.config/gbdev/notify/<h12>.secret.json
    };
    delete (cfg.notify as Record<string, unknown>).secret_file;
    writeFileSync(homeCfg, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });

    const initOut = f.runJson(['init', '--bot', 'sec-meta']);
    assert.equal(initOut.status, 0);
    const initR = validateInitResult(unwrap(initOut.envelope));
    assert.equal(initR.notify.state, 'not_configured');
    assert.equal(initR.notify.missing_step, 'setup_secret');

    const statusOut = f.runJson(['notify', 'status'], {
      PATH: `${dirname(r.command)}:${MIN_PATH}`,
      GBDEV_HOME: home,
    });
    assert.equal(statusOut.status, 0, statusOut.stderr || statusOut.stdout);
    const status = unwrap(statusOut.envelope) as {
      secret_ok: boolean; secret_problem: string | null; init: { state: string; missing_step: string | null };
    };
    assert.equal(status.secret_ok, false);
    assert.equal(status.secret_problem, 'too_large');
    assert.equal(status.init.state, initR.notify.state);
    assert.equal(status.init.missing_step, initR.notify.missing_step);
  }
});

test('P3-19 init inspectSecretMetadata: directory_owner_mismatch via lstat mock; content unread', async t => {
  const f = fixture(t, { withGlobalNotify: true });
  const first = f.runJson(['init', '--bot', 'sec-owner']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const r = validateInitResult(unwrap(first.envelope));
  const home = r.home;
  const homeCfg = join(home, 'config', 'config.json');
  const trapDir = join(f.root, 'trap-secrets');
  mkdirSync(trapDir, { mode: 0o700 });
  const trapFile = join(trapDir, 'trap.secret.json');
  writeFileSync(trapFile, JSON.stringify({
    schema: 'gbdev.notify-secret.v1',
    url: 'https://trap.example.invalid/do-not-read',
    key: 'TRAPKEY-must-not-appear-in-init-output',
  }) + '\n', { mode: 0o600 });
  const cfg = JSON.parse(readFileSync(homeCfg, 'utf8')) as Record<string, unknown>;
  cfg.notify = {
    enabled: true,
    key_name: 'Authorization',
    key_placement: 'header',
    key_prefix: 'Bearer ',
    secret_source: 'file',
    secret_file: trapFile,
  };
  writeFileSync(homeCfg, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });

  const fs = await import('node:fs');
  const original = fs.default.lstatSync;
  let openCalls = 0;
  const originalOpen = fs.default.openSync;
  t.mock.method(fs.default, 'lstatSync', (...args: Parameters<typeof original>) => {
    const result = original(...args);
    if (args[0] === trapDir) Object.defineProperty(result, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
    return result;
  });
  t.mock.method(fs.default, 'openSync', ((..._args: Parameters<typeof originalOpen>) => {
    openCalls++;
    throw new Error('P3-19 trap: secret body must not be opened');
  }) as typeof originalOpen);
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
  try {
    const { inspectSecretMetadata } = await import('../src/notify/secret.js');
    const { NOTIFY_DEFAULTS } = await import('../src/core/notifyConfig.js');
    const paths = resolvePaths({ GBDEV_HOME: home }, f.root);
    const inspected = inspectSecretMetadata({
      paths,
      config: {
        ...NOTIFY_DEFAULTS,
        enabled: true,
        key_name: 'Authorization',
        key_placement: 'header',
        key_prefix: 'Bearer ',
        secret_source: 'file',
        secret_file: trapFile,
      },
      allowed_repos: [join(f.root, 'repo')],
      home_id: identity(home).h12,
      env: { ...f.env, GBDEV_NOTIFY_TEST: '1' },
    });
    assert.equal(inspected.secret.ok, false);
    assert.equal(inspected.secret.problem, 'directory_owner_mismatch');
    assert.equal(openCalls, 0, 'metadata path must not open secret body');

    const { computeNotifyInitMeta } = await import('../src/commands/init.js');
    const meta = computeNotifyInitMeta(paths, { ...f.env, GBDEV_HOME: home, GBDEV_NOTIFY_TEST: '1' });
    assert.equal(meta.state, 'not_configured');
    assert.equal(meta.missing_step, 'setup_secret');
    assert.equal(meta.verified_by_bot, null);
    assert.equal(JSON.stringify(meta).includes('TRAPKEY'), false);
    assert.equal(JSON.stringify(inspected).includes('TRAPKEY'), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('P3-19 init: secret outside home but inside allowed_repos is not verified (metadata only)', t => {
  const f = fixture(t, { withGlobalNotify: true });
  const first = f.runJson(['init', '--bot', 'sec-repo']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const r = validateInitResult(unwrap(first.envelope));
  const home = r.home;
  const homeCfg = join(home, 'config', 'config.json');
  const repo = join(f.root, 'repo');
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  const stolen = join(repo, 'inside-allowed.secret.json');
  const trapKey = 'TRAPKEY-allowed-repos-body-must-not-leak';
  writeFileSync(
    stolen,
    JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: 'https://trap.example.invalid/allowed', key: trapKey }) + '\n',
    { mode: 0o600 },
  );
  const cfg = JSON.parse(readFileSync(homeCfg, 'utf8')) as Record<string, unknown>;
  cfg.allowed_repos = [repo];
  cfg.notify = {
    enabled: true,
    key_name: 'Authorization',
    key_placement: 'header',
    key_prefix: 'Bearer ',
    secret_source: 'file',
    secret_file: stolen,
  };
  writeFileSync(homeCfg, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });

  mkdirSync(join(home, 'notify'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'notify', 'state.json'), JSON.stringify({
    verified_by_bot: 'sec-repo',
    verified_at: '2026-10-30T12:00:00.000-07:00',
    verified_secret_gen: secretGenForFile(stolen),
    verified_notice_id: 'n_0123456789abcdef',
  }) + '\n');

  const initOut = f.runJson(['init', '--bot', 'sec-repo']);
  assert.equal(initOut.status, 0, initOut.stderr || initOut.stdout);
  const initR = validateInitResult(unwrap(initOut.envelope));
  assert.notEqual(initR.notify.state, 'verified');
  assert.equal(initR.notify.missing_step, 'setup_secret');
  assert.equal(initR.notify.verified_by_bot, null);
  f.assertNoSentinel(initOut.stdout, initOut.stderr);
  assert.equal(initOut.stdout.includes(trapKey), false);

  const statusOut = f.runJson(['notify', 'status'], {
    PATH: `${dirname(r.command)}:${MIN_PATH}`,
    GBDEV_HOME: home,
  });
  assert.equal(statusOut.status, 0, statusOut.stderr || statusOut.stdout);
  const status = unwrap(statusOut.envelope) as {
    secret_ok: boolean; secret_problem: string | null; init: { state: string; missing_step: string | null };
  };
  assert.equal(status.secret_ok, false);
  assert.equal(status.secret_problem, 'unsafe_location');
  assert.equal(status.init.state, initR.notify.state);
  assert.equal(status.init.missing_step, initR.notify.missing_step);
});

test('P3-13 attach_hint preference vs default-home-only tmux attach (semantic)', () => {
  const text = readFileSync(join(ROOT, 'skills/gbdev-usage/SKILL.md'), 'utf8');
  assert.match(text, /Prefer the real `attach_hint`/i);
  const attachIdx = text.indexOf('tmux attach -t gbdev');
  assert.ok(attachIdx >= 0);
  const window = text.slice(Math.max(0, attachIdx - 120), attachIdx + 180);
  assert.match(window, /default.*home|默认.*home/i);
  assert.match(text, /non-default home uses session `gbdev-<h6>`/);
  const preferAt = text.search(/Prefer the real `attach_hint`/);
  assert.ok(preferAt >= 0 && preferAt < attachIdx);
});
