import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type HomeBinding, type InitNextStep, type InitResultContract, type InitResourceAction,
  validateHomeBinding,
} from '../contracts/commandResults.js';
import { GbdevError } from '../contracts/error.js';
import { INIT_STATES, MISSING_STEPS, type NotifyInit } from '../contracts/notify.js';
import { validateConfig } from '../core/config.js';
import { atomicWriteJson } from '../core/jobStore.js';
import {
  PATH_HINT, installBotLauncher, installSharedLauncher, inspectSharedLauncher, resolveCliHome,
  sharedLauncherPaths, type InstallAction, type LauncherState,
} from '../core/launcher.js';
import { NOTIFY_LABEL, notifyDisabledReason } from '../core/notifyConfig.js';
import {
  defaultConfigPath, defaultHomePath, expandHome, homeConfigPath, isPathInsideOrEqual,
  resolvePaths, type GbdevPaths,
} from '../core/paths.js';
import { localIso } from '../core/time.js';
import { identity } from '../dashboard/names.js';
import { inspectSecretMetadata, type SecretResult } from '../notify/secret.js';
import { readDeliveryState } from '../notify/state.js';
import { currentTest, currentVerification, notifyConfiguration } from '../notify/status.js';

const RESERVED_LABELS = new Set(['cli', 'bootstrap']);

export function normalizeBotLabel(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/[^a-z0-9-]+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^[^a-z]+/, '');
  s = s.replace(/-+$/g, '');
  if (s.length > 32) {
    s = s.slice(0, 32);
    s = s.replace(/-+$/g, '');
  }
  if (!NOTIFY_LABEL.test(s) || RESERVED_LABELS.has(s)) {
    throw new GbdevError('usage_error', 'Invalid --bot label');
  }
  return s;
}

function samePath(a: string, b: string): boolean {
  let ar = a, br = b;
  try { ar = realpathSync(a); } catch { ar = resolve(a); }
  try { br = realpathSync(b); } catch { br = resolve(b); }
  return ar === br;
}

function readHomeBinding(path: string): { ok: true; binding: HomeBinding } | { ok: false; bound_bot_label: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, bound_bot_label: null };
  }
  try {
    return { ok: true, binding: validateHomeBinding(raw) };
  } catch {
    const label = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { bot_label?: unknown }).bot_label === 'string'
      ? (raw as { bot_label: string }).bot_label
      : null;
    return { ok: false, bound_bot_label: label && NOTIFY_LABEL.test(label) ? label : null };
  }
}

function directoryNonEmpty(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readVerifiedByBot(defaultHome: string): string | null {
  try {
    const state = readDeliveryState(defaultHome);
    const label = state.verified_by_bot;
    return typeof label === 'string' && NOTIFY_LABEL.test(label) ? label : null;
  } catch {
    return null;
  }
}

function homeConflict(message: string, path: string, extra: Record<string, unknown> = {}): never {
  throw new GbdevError('home_conflict', message, { path, bound_bot_label: null, ...extra });
}

function modeOctal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/** Reject symlink / wrong-type layout for home, home.json, config/, config.json (P1-2 / P2-10). */
function assertSafeHomeLayout(home: string, homeJsonPath: string, homeCfgPath: string): void {
  const check = (path: string, expect: 'file' | 'dir' | 'missing-or-file' | 'missing-or-dir') => {
    let st;
    try {
      st = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (expect === 'missing-or-file' || expect === 'missing-or-dir') return;
        homeConflict('Required home path is missing', path);
      }
      // ENOTDIR (e.g. --home is a regular file) must not escape as internal_error.
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        homeConflict('Home layout path is not a directory', path);
      }
      throw error;
    }
    if (st.isSymbolicLink()) {
      homeConflict('Home layout contains a symbolic link', path);
    }
    if (expect === 'file' || expect === 'missing-or-file') {
      if (!st.isFile()) homeConflict('Home layout path is not a regular file', path);
    } else if (expect === 'dir' || expect === 'missing-or-dir') {
      if (!st.isDirectory()) homeConflict('Home layout path is not a directory', path);
    }
  };
  // Check home itself first: probing <home>/home.json when home is a file yields ENOTDIR.
  check(home, 'missing-or-dir');
  check(homeJsonPath, 'missing-or-file');
  const configDir = join(home, 'config');
  check(configDir, 'missing-or-dir');
  check(homeCfgPath, 'missing-or-file');
}

/** Existing real directories must be 0700 (P2-6 / S-M6-4); never chmod through a link. */
function assertDirMode0700(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    homeConflict('Home path exists and is not a directory', path);
  }
  if ((st.mode & 0o777) !== 0o700) {
    homeConflict('Home directory mode must be 0700', path, { mode: modeOctal(st.mode) });
  }
}

/** Metadata-only notify init projection (no secret file content, no network). */
export function computeNotifyInitMeta(paths: GbdevPaths, env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  state: NotifyInit['state'];
  missing_step: NotifyInit['missing_step'];
  verified_by_bot: string | null;
} {
  let config;
  let allowed_repos: readonly string[] = [];
  try {
    ({ config, allowed_repos } = notifyConfiguration(paths));
  } catch {
    return { enabled: false, state: 'not_configured', missing_step: 'setup_secret', verified_by_bot: null };
  }
  const state = readDeliveryState(paths.home);
  const disabled = notifyDisabledReason(config, env);
  let secret: SecretResult = { ok: false, reason: 'secret_missing', problem: 'not_found', endpoint_host: null, secret_gen: null };
  let secretExists = false;
  if (disabled !== 'disabled_by_env' && disabled !== 'disabled_in_tests') {
    // P2-11: metadata-only (dir owner, size, safeSecretLocation + allowed_repos).
    // Never read secret bytes. If metadata looks fine but content would fail
    // (e.g. invalid JSON), init may disagree with a later notify status that
    // reads the body — that gap can last until the secret is fixed; treat
    // subsequent notify status / test / ack as the source of notify readiness.
    const inspected = inspectSecretMetadata({
      paths, config, allowed_repos, home_id: identity(paths.home).h12, env,
      keychain_setup_at: state.keychain_setup_at ?? null,
    });
    secret = inspected.secret;
    secretExists = inspected.secretExists;
  }
  const verified = currentVerification(state, secret);
  const tested = currentTest(state, secret) && !!state.last_test?.delivered;
  let initState: NotifyInit['state'] = 'configured_unverified';
  let missing: NotifyInit['missing_step'] = 'run_test';
  if (disabled === 'disabled_by_env' || disabled === 'disabled_in_tests') {
    initState = 'disabled'; missing = 'env_disabled';
  } else if (!config.enabled && secretExists) {
    initState = 'disabled'; missing = 'enable';
  } else if (!secret.ok) {
    initState = 'not_configured'; missing = 'setup_secret';
  } else if (!config.key_name) {
    initState = 'not_configured'; missing = 'set_key_name';
  } else if (state.paused) {
    initState = 'paused'; missing = 'resume_paused';
  } else if (verified) {
    initState = 'verified'; missing = null;
  } else if (tested) {
    initState = 'test_sent'; missing = 'await_ack';
  }
  if (!(INIT_STATES as readonly string[]).includes(initState)) initState = 'not_configured';
  if (missing !== null && !(MISSING_STEPS as readonly string[]).includes(missing)) missing = 'setup_secret';
  return {
    enabled: !disabled,
    state: initState,
    missing_step: missing,
    verified_by_bot: verified ? (state.verified_by_bot ?? null) : null,
  };
}

function seedSourcePath(env: NodeJS.ProcessEnv, userHome: string): string {
  if (env.GBDEV_CONFIG !== undefined) return resolve(expandHome(env.GBDEV_CONFIG, userHome));
  return defaultConfigPath(userHome);
}

function loadSeedConfig(seedPath: string): { raw: Record<string, unknown>; seededFrom: string } {
  let raw: Record<string, unknown>;
  try {
    const text = readFileSync(seedPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new GbdevError('config_invalid', 'Global config is not a JSON object');
    }
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GbdevError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      raw = { version: 1 };
    } else if (error instanceof SyntaxError) {
      throw new GbdevError('config_invalid', `Invalid JSON configuration: ${seedPath}`);
    } else {
      throw new GbdevError('config_invalid', `Cannot read configuration: ${seedPath}`);
    }
  }
  try {
    validateConfig(raw);
  } catch (error) {
    if (error instanceof GbdevError) throw error;
    throw new GbdevError('config_invalid', `Invalid configuration: ${seedPath}`);
  }
  const { notify: _notify, ...rest } = raw;
  return { raw: rest, seededFrom: seedPath };
}

function ensureDir0700(path: string): void {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      homeConflict('Home path exists and is not a directory', path);
    }
    if ((st.mode & 0o777) !== 0o700) {
      homeConflict('Home directory mode must be 0700', path, { mode: modeOctal(st.mode) });
    }
    return;
  } catch (error) {
    if (error instanceof GbdevError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    homeConflict('Home path exists and is not a directory', path);
  }
  chmodSync(path, 0o700);
}

function buildNextSteps(opts: {
  noInstall: boolean;
  launcherState: LauncherState;
  botLauncherState: LauncherState;
  onPath: boolean;
  notifyState: string;
  verifiedByBot: string | null;
  botLabel: string;
}): InitNextStep[] {
  const steps: InitNextStep[] = [];
  if (opts.noInstall && (opts.launcherState !== 'current' || opts.botLauncherState !== 'current')) {
    steps.push('install_launcher');
  }
  if (!opts.onPath) steps.push('add_path');
  if (opts.notifyState !== 'verified' || opts.verifiedByBot !== opts.botLabel) steps.push('notify_init');
  return steps;
}

function assertLauncherNotInsideDefaultHome(env: NodeJS.ProcessEnv, userHome: string, defaultHome: string): void {
  const cliHome = resolveCliHome(env, userHome);
  if (isPathInsideOrEqual(cliHome, defaultHome)) {
    throw new GbdevError('launcher_conflict', 'Launcher install root is inside the default home', {
      path: cliHome,
    });
  }
  const launcherDir = join(cliHome, 'bin');
  if (isPathInsideOrEqual(launcherDir, defaultHome)) {
    throw new GbdevError('launcher_conflict', 'Launcher directory is inside the default home', {
      path: launcherDir,
    });
  }
}

export interface InitOptions {
  bot: string;
  home?: string;
  noInstall?: boolean;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
}

export async function initCommand(options: InitOptions): Promise<InitResultContract> {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? env.HOME ?? homedir();
  const bot_label_input = options.bot;
  if (typeof bot_label_input !== 'string' || !bot_label_input.trim()) {
    throw new GbdevError('usage_error', 'init requires --bot <label>');
  }
  const bot_label = normalizeBotLabel(bot_label_input);
  const dryRun = options.dryRun === true;
  const noInstall = options.noInstall === true;
  const defaultHome = defaultHomePath(userHome);
  const verifiedOnDefault = readVerifiedByBot(defaultHome);

  let home: string;
  let legacy_default = false;

  if (options.home !== undefined) {
    const expanded = expandHome(options.home, userHome);
    if (!isAbsolute(expanded)) throw new GbdevError('usage_error', '--home must be an absolute path');
    home = resolve(expanded);
    if (samePath(home, defaultHome) || resolveLogicalEqual(home, defaultHome)) {
      if (verifiedOnDefault !== null && verifiedOnDefault !== bot_label) {
        throw new GbdevError('home_conflict', 'Default home is bound to a different bot', {
          path: defaultHome, bound_bot_label: verifiedOnDefault,
        });
      }
      legacy_default = true;
    }
  } else if (verifiedOnDefault === bot_label) {
    home = defaultHome;
    legacy_default = true;
  } else {
    home = resolve(join(userHome, `.gbdev-${bot_label}`));
  }

  // N7: never create/modify anything inside the default home.
  if (samePath(home, defaultHome) || resolveLogicalEqual(home, defaultHome)) legacy_default = true;

  // P1-3: non-legacy home must not sit inside (or equal) the default home tree, incl. ancestor aliases.
  if (!legacy_default && isPathInsideOrEqual(home, defaultHome)) {
    homeConflict('Home path is inside the default home', home);
  }

  // Launcher writes must also stay outside default home (N7); check before any write / dry-run plan.
  if (!noInstall) {
    assertLauncherNotInsideDefaultHome(env, userHome, defaultHome);
  }

  const seedPath = seedSourcePath(env, userHome);
  let seed: { raw: Record<string, unknown>; seededFrom: string } | null = null;
  if (!legacy_default) {
    // Invalid global config ⇒ config_invalid with zero writes (SPEC §6.4.3 / N5).
    seed = loadSeedConfig(seedPath);
  }

  const homeJsonPath = join(home, 'home.json');
  const homeCfgPath = homeConfigPath(home);
  let home_action: InitResultContract['home_action'] = 'none';
  let bindingAction: InitResourceAction = 'none';
  let configAction: InitResourceAction = 'none';
  let homeRealForBinding = home;

  if (!legacy_default) {
    // P1-2: reject unsafe layouts (symlinks / wrong types) with zero writes.
    assertSafeHomeLayout(home, homeJsonPath, homeCfgPath);
    // P2-6: existing home / config dirs must already be 0700.
    assertDirMode0700(home);
    assertDirMode0700(join(home, 'config'));

    try {
      const st = lstatSync(home);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        homeConflict('Home path exists and is not a directory', home);
      }
      try { homeRealForBinding = realpathSync(home); } catch { homeRealForBinding = home; }
      let hasBinding = false;
      try {
        const bst = lstatSync(homeJsonPath);
        if (bst.isSymbolicLink() || !bst.isFile()) {
          homeConflict('home.json exists and is not a regular file', homeJsonPath);
        }
        hasBinding = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (directoryNonEmpty(home) && !hasBinding) {
        throw new GbdevError('home_conflict', 'Target home directory is non-empty without home.json', {
          path: home, bound_bot_label: null,
        });
      }
      if (hasBinding) {
        const parsed = readHomeBinding(homeJsonPath);
        if (!parsed.ok) {
          throw new GbdevError('home_conflict', 'Existing home.json is invalid', {
            path: homeJsonPath, bound_bot_label: parsed.bound_bot_label,
          });
        }
        if (parsed.binding.bot_label !== bot_label) {
          throw new GbdevError('home_conflict', 'Home is bound to a different bot', {
            path: homeJsonPath, bound_bot_label: parsed.binding.bot_label,
          });
        }
        if (parsed.binding.home !== homeRealForBinding && parsed.binding.home !== resolve(home)) {
          throw new GbdevError('home_conflict', 'home.json home field does not match home path', {
            path: homeJsonPath, bound_bot_label: parsed.binding.bot_label,
          });
        }
        home_action = 'unchanged';
        bindingAction = 'unchanged';
      } else {
        home_action = dryRun ? 'would_create' : 'created';
        bindingAction = dryRun ? 'would_create' : 'created';
      }
    } catch (error) {
      if (error instanceof GbdevError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      home_action = dryRun ? 'would_create' : 'created';
      bindingAction = dryRun ? 'would_create' : 'created';
    }
    let configPresent = false;
    try {
      const cst = lstatSync(homeCfgPath);
      if (cst.isSymbolicLink() || !cst.isFile()) {
        homeConflict('Home config exists and is not a regular file', homeCfgPath);
      }
      configPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    configAction = configPresent ? 'unchanged' : (dryRun ? 'would_create' : 'created');
  }

  // Preflight launchers: layout + foreign checks (dry-run semantics) before any home writes.
  const skipLauncherWrite = dryRun || noInstall;
  const preflightShared = installSharedLauncher({ dryRun: true, env, userHome, pathEnv: env.PATH ?? '' });
  const preflightBot = installBotLauncher({
    label: bot_label, home, dryRun: true, skipWrite: true, env, userHome,
  });

  if (!dryRun && !legacy_default) {
    ensureDir0700(home);
    try { homeRealForBinding = realpathSync(home); } catch { homeRealForBinding = resolve(home); }
    const home_id = identity(home).h12;
    if (bindingAction === 'created') {
      const binding: HomeBinding = {
        schema: 'gbdev.home.v1',
        bot_label,
        home: homeRealForBinding,
        home_id,
        created_at: localIso(),
        gbdev_version: sharedLauncherPaths(env, userHome).version,
      };
      validateHomeBinding(binding);
      atomicWriteJson(homeJsonPath, binding);
      chmodSync(homeJsonPath, 0o600);
    }
    if (configAction === 'created' && seed) {
      const configDir = join(home, 'config');
      ensureDir0700(configDir);
      atomicWriteJson(homeCfgPath, seed.raw);
      chmodSync(homeCfgPath, 0o600);
    }
  }

  let sharedResult = preflightShared;
  let botResult = preflightBot;
  if (!skipLauncherWrite) {
    sharedResult = installSharedLauncher({ dryRun: false, env, userHome, pathEnv: env.PATH ?? '' });
    botResult = installBotLauncher({
      label: bot_label, home, dryRun: false, skipWrite: false, env, userHome,
    });
  }

  // After real install, refresh on_path / actions from the write path.
  const launcherState: LauncherState = sharedResult.state_before;
  const botLauncherState: LauncherState = botResult.state_before;
  let launcherAction: InitResourceAction = skipLauncherWrite
    ? (launcherState === 'missing' ? 'would_create' : launcherState === 'stale' ? 'would_update' : 'unchanged')
    : (sharedResult.action as InstallAction);
  let botAction: InitResourceAction = skipLauncherWrite
    ? (botResult.state_before === 'missing' ? 'would_create' : botResult.state_before === 'stale' ? 'would_update' : 'unchanged')
    : (botResult.action as InitResourceAction);

  // When --no-install and launcher already current, actions stay unchanged.
  if (noInstall && !dryRun) {
    launcherAction = launcherState === 'current' ? 'unchanged' : launcherAction;
    botAction = botResult.state_before === 'current' ? 'unchanged' : botAction;
  }

  const on_path = sharedResult.on_path;
  const home_id = identity(home).h12;

  // Notify meta uses the bot home (and home config if present). Clear GBDEV_CONFIG so
  // resolvePaths prefers home config; do not inherit a caller GBDEV_HOME for this projection.
  const notifyPaths = resolvePaths({ GBDEV_HOME: home }, userHome);
  // For legacy, effective config is the global default/env seed path.
  const notifyMetaPaths: GbdevPaths = legacy_default
    ? resolvePaths(
      env.GBDEV_CONFIG !== undefined
        ? { GBDEV_HOME: home, GBDEV_CONFIG: env.GBDEV_CONFIG }
        : { GBDEV_HOME: home },
      userHome,
    )
    : notifyPaths;
  const notifyMeta = computeNotifyInitMeta(notifyMetaPaths, env);

  const next_steps = buildNextSteps({
    noInstall,
    launcherState,
    botLauncherState,
    onPath: on_path,
    notifyState: notifyMeta.state,
    verifiedByBot: notifyMeta.verified_by_bot,
    botLabel: bot_label,
  });

  const effectiveConfigPath = legacy_default
    ? (env.GBDEV_CONFIG !== undefined ? resolve(expandHome(env.GBDEV_CONFIG, userHome)) : defaultConfigPath(userHome))
    : homeCfgPath;

  // Re-read inspect for launcher state_before (preflight captured it; real install may differ).
  const stateBefore = skipLauncherWrite
    ? inspectSharedLauncher(sharedLauncherPaths(env, userHome), env.PATH ?? '').state
    : sharedResult.state_before;

  const result: InitResultContract = {
    schema: 'gbdev.init.v1',
    bot_label,
    bot_label_input,
    home: resolve(home),
    home_id,
    legacy_default,
    home_action,
    binding: { path: resolve(homeJsonPath), action: bindingAction },
    config: {
      path: resolve(effectiveConfigPath),
      action: configAction,
      seeded_from: legacy_default ? null : seedPath,
    },
    launcher: {
      path: sharedResult.launcher_path,
      state_before: stateBefore,
      action: launcherAction,
      on_path,
      path_hint: PATH_HINT,
    },
    bot_launcher: { path: botResult.path, action: botAction },
    command: botResult.path,
    env: { GBDEV_HOME: resolve(home) },
    notify: {
      enabled: notifyMeta.enabled,
      state: notifyMeta.state,
      missing_step: notifyMeta.missing_step,
      verified_by_bot: notifyMeta.verified_by_bot,
    },
    next_steps,
    dry_run: dryRun,
  };
  return result;
}

function resolveLogicalEqual(a: string, b: string): boolean {
  return isPathInsideOrEqual(a, b) && isPathInsideOrEqual(b, a);
}

export function initText(result: InitResultContract): string {
  const lines = [
    `home: ${result.home}`,
    `command: ${result.command}`,
  ];
  if (!result.launcher.on_path) lines.push(`path_hint: ${result.launcher.path_hint}`);
  lines.push(`notify: ${result.notify.state}${result.notify.missing_step ? ` (${result.notify.missing_step})` : ''}`);
  if (result.next_steps.length) lines.push(`next_steps: ${result.next_steps.join(', ')}`);
  if (result.next_steps.includes('install_launcher')) {
    lines.push('hint: re-run `gbdev init` to install launchers (`gbdev install` alone does not create the bot launcher)');
  }
  if (result.legacy_default) lines.push('legacy_default: true');
  if (result.dry_run) lines.push('dry_run: true');
  return `${lines.join('\n')}\n`;
}
