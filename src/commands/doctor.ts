import { notifyDiagnostic } from '../notify/status.js';
import { DASHBOARD_DEFAULTS, loadDashboard } from '../core/dashboardConfig.js';
import { binary, disabled, reportedVersion, supportedVersion, tmuxEnv } from '../dashboard/tmux.js';
import { dashboardDiagnostic } from '../dashboard/reconcile.js';
import { staleIntegrationLocks } from '../run/integrationLock.js';
import { homedir, tmpdir } from 'node:os';
import { PipelineRegistry } from '../pipeline/definitions.js';
import { readRunConfigFields, validateParallel, validateRunDefaults } from '../core/runConfig.js';
import { RoleRegistry } from '../roles/registry.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type DoctorResult, validateHomeBinding } from '../contracts/commandResults.js';
import { type Config, loadConfig } from '../core/config.js';
import { expandHome, type GbdevPaths } from '../core/paths.js';
import { inspectSharedLauncher, sharedLauncherPaths } from '../core/launcher.js';
import { findExecutable } from '../core/proc.js';
import { GbdevError } from '../contracts/error.js';
import { git } from '../core/git.js';

function homeCheck(paths: GbdevPaths, userHome = process.env.HOME ?? homedir()): { ok: boolean; detail: string } {
  const defaultHome = resolve(expandHome('~/.gbdev', userHome));
  let homeReal = paths.home;
  let defaultReal = defaultHome;
  try { homeReal = realpathSync(paths.home); } catch { /* compare resolved paths when missing */ }
  try { defaultReal = realpathSync(defaultHome); } catch { /* compare resolved paths when missing */ }
  if (homeReal === defaultReal) return { ok: true, detail: 'default' };

  const bindingPath = join(paths.home, 'home.json');
  if (!existsSync(bindingPath)) return { ok: true, detail: 'unbound' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(bindingPath, 'utf8'));
  } catch {
    return { ok: false, detail: 'unbound' };
  }
  try {
    const binding = validateHomeBinding(raw);
    if (binding.home !== homeReal && binding.home !== resolve(paths.home)) {
      return { ok: false, detail: `bound:${binding.bot_label}` };
    }
    return { ok: true, detail: `bound:${binding.bot_label}` };
  } catch {
    return { ok: false, detail: 'unbound' };
  }
}

/** Diagnostics never read credentials or expose login command output. */
export async function doctor(paths: GbdevPaths): Promise<DoctorResult> {
  const checks: DoctorResult['checks'] = [];
  const add = (name: string, ok: boolean, detail: DoctorResult['checks'][number]['detail']) => checks.push({ name, ok, detail });
  add('node', Number(process.versions.node.split('.')[0]) >= 24, process.version);
  const gitBin = findExecutable('git');
  if (gitBin) {
    try {
      const version = git(process.cwd(), ['--version'], 10_000);
      const match = /git version (\d+)\.(\d+)/.exec(version);
      const supported = match !== null && (Number(match[1]) > 2 || Number(match[1]) === 2 && Number(match[2]) >= 38);
      add('git', supported, `${gitBin}: ${version.trim()}`);
      if (!supported) add('git_merge_tree', false, 'requires git >=2.38');
      else {
        let directory: string | undefined;
        try {
          directory = mkdtempSync(join(tmpdir(), 'gbdev-merge-tree-'));
          git(directory, ['init', '--initial-branch=probe'], 10_000);
          git(directory, ['-c', 'user.name=gbdev', '-c', 'user.email=gbdev@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'probe'], 10_000);
          const result = git(directory, ['merge-tree', '--write-tree', 'HEAD', 'HEAD'], 10_000).trim();
          add('git_merge_tree', /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result), 'git >=2.38; merge-tree --write-tree temporary repository probe');
        } catch (error) { add('git_merge_tree', false, error instanceof GbdevError && error.contract.details.git_timeout ? { timed_out: true } : String(error)); }
        finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
      }
    } catch (error) { add('git', false, error instanceof GbdevError && error.contract.details.git_timeout
      ? { timed_out: true } : `${gitBin}: ${error instanceof Error ? error.message : String(error)}`); }
  } else add('git', false, 'git not found on PATH (requires >=2.38)');
  if (!checks.some(c => c.name === 'git_merge_tree')) add('git_merge_tree', false, 'git version check failed');

  let config: Config | undefined;
  const source = paths.configSource;
  const symlinkNote = paths.homeConfigSymlinkIgnored ? '; home config symlink ignored' : '';
  try { config = loadConfig(paths.config); add('config', true, `${paths.config} (${source}${symlinkNote})`); }
  catch (error) { add('config', false, `${error instanceof Error ? error.message : String(error)} (${source}${symlinkNote})`); }
  try {
    const roles = new RoleRegistry(paths.config).list();
    add('roles', roles.invalid.length === 0, roles.invalid.length ? roles.invalid.map(e => `${e.file}: ${e.code}: ${e.message}`).join('; ') : `${roles.roles.length} valid roles`);
  } catch (error) { add('roles', false, error instanceof Error ? error.message : String(error)); }
  for (const name of ['parallel_config', 'run_defaults'] as const) {
    try { const raw = readRunConfigFields(paths.config); const result = name === 'parallel_config' ? validateParallel(raw.parallel) : validateRunDefaults(raw.run_defaults, new PipelineRegistry(paths.config)); add(name, true, JSON.stringify(result)); }
    catch (error) { add(name, false, String(error)); }
  }
  try { const role = new RoleRegistry(paths.config).resolve('resolver'); add('resolver_role', role.output === 'change' && role.sandbox === 'workspace-write' && role.provider !== 'cursor' && !role.allowed_providers.includes('cursor'), 'resolver must be change/workspace-write and disallow cursor'); }
  catch (error) { add('resolver_role', false, String(error)); }
  try { const stale = staleIntegrationLocks(paths); add('stale_integration_locks', stale.length === 0, JSON.stringify(stale)); }
  catch (error) { add('stale_integration_locks', false, String(error)); }
  for (const name of ['codex', 'cursor'] as const) {
    const bin = config ? findExecutable(config.providers[name].bin) : null;
    if (!bin) {
      add(name, false, config ? 'Provider executable not found' : 'Skipped: invalid configuration');
      add(`${name}_login`, false, 'unknown (provider unavailable)');
      continue;
    }
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    add(name, version.status === 0, (version.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? { timed_out: true }
      : `${bin}: ${(version.stdout ?? '').trim() || `exit_code=${version.status}`}`);
    if (name === 'cursor') {
      // `status` is explicitly documented by the verified cursor-agent --help.
      const auth = spawnSync(bin, ['status'], { timeout: 10_000, killSignal: 'SIGKILL', stdio: 'ignore' });
      add('cursor_login', auth.status === 0, (auth.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? { timed_out: true }
        : `exit_code=${auth.status}${auth.signal ? ` signal=${auth.signal}` : ''}`);
    } else {
      const auth = spawnSync(bin, ['login', 'status'], { timeout: 10_000, killSignal: 'SIGKILL', stdio: 'ignore' });
      add('codex_login', auth.status === 0, (auth.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? { timed_out: true }
        : `exit_code=${auth.status}${auth.signal ? ` signal=${auth.signal}` : ''}`);
    }
  }
  // Preserve M2's optional check: presence/probe success, string detail, and 10s deadline.
  let dashboardConfig;
  try { dashboardConfig = loadDashboard(paths.config); } catch { dashboardConfig = { ...DASHBOARD_DEFAULTS, enabled: false }; }
  const disabledReason = disabled(dashboardConfig);
  let tmux: string | undefined;
  if (!disabledReason) { try { tmux = binary(dashboardConfig); } catch { /* optional */ } }
  let version: ReturnType<typeof spawnSync> | undefined;
  if (tmux) version = spawnSync(tmux, ['-V'], { shell: false, env: tmuxEnv(), encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  const timedOut = (version?.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const text = String(version?.stdout ?? '').trim();
  add('tmux', !!version && version.status === 0, timedOut ? { timed_out: true }
    : tmux ? `${tmux}: ${text || `exit_code=${version?.status}`}`
    : disabledReason ?? 'not installed (optional; dashboard disabled, use gbdev run watch)');
  const dashboard = dashboardDiagnostic(paths, version ? { code: version.status ?? 1, stdout: text, timedOut } : undefined);
  let supported = false; try { supportedVersion(text); supported = true; } catch { /* optional */ }
  Object.assign(checks.at(-1)!, { version: reportedVersion(text), supported, dashboard });
  let probe: string | undefined;
  try {
    mkdirSync(paths.home, { recursive: true });
    probe = mkdtempSync(join(paths.home, '.doctor-'));
    writeFileSync(join(probe, 'writable'), 'ok', { mode: 0o600 });
    add('home_writable', true, paths.home);
  } catch (error) { add('home_writable', false, error instanceof Error ? error.message : String(error)); }
  finally { if (probe) rmSync(probe, { recursive: true, force: true }); }
  checks.push(await notifyDiagnostic(paths));
  try {
    const status = inspectSharedLauncher(sharedLauncherPaths());
    checks.push({
      name: 'launcher',
      ok: status.state === 'current',
      detail: `${status.state}: ${status.path}`,
      launcher: {
        state: status.state,
        path: status.path,
        on_path: status.on_path,
        node_path: status.node_path,
        cli_path: status.cli_path,
      },
    });
  } catch (error) {
    add('launcher', false, error instanceof Error ? error.message : String(error));
  }
  const home = homeCheck(paths);
  add('home', home.ok, home.detail);
  return { checks };
}
