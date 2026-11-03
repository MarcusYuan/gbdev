import { validateDashboardStatus } from './dashboardStatus.js';
import type { DashboardStatus } from '../dashboard/reconcile.js';
import { validateJobId } from '../core/ids.js';
import { MISSING_STEPS } from './notify.js';
import { array, boolean, invalid, object, oneOf, string, nullableString, timestamp } from './validation.js';

export interface DoctorLauncherInfo {
  state: 'missing' | 'current' | 'stale' | 'foreign';
  path: string;
  on_path: boolean;
  node_path: string;
  cli_path: string;
}
export interface DoctorResult {
  checks: {
    name: string;
    ok: boolean;
    detail: string | { timed_out: true };
    version?: string | null;
    supported?: boolean;
    dashboard?: DashboardStatus;
    launcher?: DoctorLauncherInfo;
  }[];
}
export interface CleanupResult {
  job_id: string | null;
  pipeline_id?: string;
  dry_run?: boolean;
  would_remove_worktree?: boolean;
  would_delete_branch?: boolean;
  worktree_removed: boolean;
  branch_deleted: boolean;
  branch_retained: boolean;
  branch_retained_reason?: 'checked_out' | 'unmerged_job_commits' | 'delete_failed_retry_safe' | null;
}
export interface InstallResultContract {
  schema: 'gbdev.install.v1';
  launcher_dir: string;
  launcher_path: string;
  node_path: string;
  cli_path: string;
  version: string;
  state_before: 'missing' | 'current' | 'stale' | 'foreign';
  action: 'created' | 'updated' | 'unchanged' | 'would_create' | 'would_update';
  on_path: boolean;
  path_hint: string;
  dry_run: boolean;
}

const INSTALL_FIELDS = [
  'schema', 'launcher_dir', 'launcher_path', 'node_path', 'cli_path', 'version',
  'state_before', 'action', 'on_path', 'path_hint', 'dry_run',
] as const;

export function validateDoctorResult(value: unknown): DoctorResult {
  const v = object(value, 'doctor result');
  for (const item of array(v.checks, 'checks')) {
    const check = object(item, 'check');
    string(check.name, 'check.name');
    boolean(check.ok, 'check.ok');
    if (check.version !== undefined) nullableString(check.version, 'check.version');
    if (check.supported !== undefined) boolean(check.supported, 'check.supported');
    if (check.dashboard !== undefined) validateDashboardStatus(check.dashboard);
    if (check.launcher !== undefined) {
      const launcher = object(check.launcher, 'check.launcher');
      oneOf(launcher.state, ['missing', 'current', 'stale', 'foreign'], 'check.launcher.state');
      string(launcher.path, 'check.launcher.path');
      boolean(launcher.on_path, 'check.launcher.on_path');
      string(launcher.node_path, 'check.launcher.node_path');
      string(launcher.cli_path, 'check.launcher.cli_path');
    }
    if (typeof check.detail === 'string') string(check.detail, 'check.detail');
    else if (object(check.detail, 'check.detail').timed_out !== true) invalid('check.detail.timed_out must be true');
  }
  return value as DoctorResult;
}

export function validateInstallResult(value: unknown): InstallResultContract {
  const v = object(value, 'install result');
  for (const key of Object.keys(v)) {
    if (!(INSTALL_FIELDS as readonly string[]).includes(key)) invalid(`Unknown install field: ${key}`);
  }
  for (const key of INSTALL_FIELDS) {
    if (!Object.hasOwn(v, key)) invalid(`Missing install field: ${key}`);
  }
  if (v.schema !== 'gbdev.install.v1') invalid('schema must be gbdev.install.v1');
  for (const key of ['launcher_dir', 'launcher_path', 'node_path', 'cli_path', 'version', 'path_hint'] as const) {
    string(v[key], key);
  }
  oneOf(v.state_before, ['missing', 'current', 'stale', 'foreign'], 'state_before');
  oneOf(v.action, ['created', 'updated', 'unchanged', 'would_create', 'would_update'], 'action');
  boolean(v.on_path, 'on_path');
  boolean(v.dry_run, 'dry_run');
  if (v.path_hint !== 'export PATH="$HOME/.gbdev-cli/bin:$PATH"') invalid('path_hint must be the exact PATH export line');
  return value as InstallResultContract;
}

export function validateCleanupResult(value: unknown): CleanupResult {
  const v = object(value, 'cleanup result');
  if (v.job_id === null) { if (typeof v.pipeline_id !== 'string' || !/^p_\d{8}_\d{4}_[a-f0-9]{4}$/.test(v.pipeline_id)) invalid('Invalid pipeline_id'); }
  else validateJobId(v.job_id);
  for (const key of ['worktree_removed', 'branch_deleted', 'branch_retained']) boolean(v[key], key);
  for (const key of ['dry_run', 'would_remove_worktree', 'would_delete_branch']) if (v[key] !== undefined) boolean(v[key], key);
  if (v.branch_retained_reason !== undefined && v.branch_retained_reason !== null) oneOf(v.branch_retained_reason, ['checked_out', 'unmerged_job_commits', 'delete_failed_retry_safe'], 'branch_retained_reason');
  return value as CleanupResult;
}

export interface HomeBinding {
  schema: 'gbdev.home.v1';
  bot_label: string;
  home: string;
  home_id: string;
  created_at: string;
  gbdev_version: string;
}

const HOME_FIELDS = ['schema', 'bot_label', 'home', 'home_id', 'created_at', 'gbdev_version'] as const;
const BOT_LABEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
const HOME_ID_RE = /^[a-f0-9]{12}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

export function validateHomeBinding(value: unknown): HomeBinding {
  const v = object(value, 'home binding');
  for (const key of Object.keys(v)) {
    if (!(HOME_FIELDS as readonly string[]).includes(key)) invalid(`Unknown home field: ${key}`);
  }
  for (const key of HOME_FIELDS) {
    if (!Object.hasOwn(v, key)) invalid(`Missing home field: ${key}`);
  }
  if (v.schema !== 'gbdev.home.v1') invalid('schema must be gbdev.home.v1');
  string(v.bot_label, 'bot_label');
  if (!BOT_LABEL_RE.test(v.bot_label)) invalid('bot_label must match NOTIFY_LABEL');
  string(v.home, 'home');
  string(v.home_id, 'home_id');
  if (!HOME_ID_RE.test(v.home_id)) invalid('home_id must be 12 hex chars');
  timestamp(v.created_at, 'created_at');
  string(v.gbdev_version, 'gbdev_version');
  if (!VERSION_RE.test(v.gbdev_version)) invalid('gbdev_version must be a semver string');
  return value as HomeBinding;
}

export type InitResourceAction = 'created' | 'updated' | 'unchanged' | 'would_create' | 'would_update' | 'none';
export type InitHomeAction = 'created' | 'unchanged' | 'would_create' | 'none';
export type InitNextStep = 'install_launcher' | 'add_path' | 'notify_init';

export interface InitResultContract {
  schema: 'gbdev.init.v1';
  bot_label: string;
  bot_label_input: string;
  home: string;
  home_id: string;
  legacy_default: boolean;
  home_action: InitHomeAction;
  binding: { path: string; action: InitResourceAction };
  config: { path: string; action: InitResourceAction; seeded_from: string | null };
  launcher: {
    path: string;
    state_before: 'missing' | 'current' | 'stale' | 'foreign';
    action: InitResourceAction;
    on_path: boolean;
    path_hint: string;
  };
  bot_launcher: { path: string; action: InitResourceAction };
  command: string;
  env: { GBDEV_HOME: string };
  notify: {
    enabled: boolean;
    state: string;
    missing_step: string | null;
    verified_by_bot: string | null;
  };
  next_steps: InitNextStep[];
  dry_run: boolean;
}

const INIT_FIELDS = [
  'schema', 'bot_label', 'bot_label_input', 'home', 'home_id', 'legacy_default', 'home_action',
  'binding', 'config', 'launcher', 'bot_launcher', 'command', 'env', 'notify', 'next_steps', 'dry_run',
] as const;
const INIT_ACTIONS = ['created', 'updated', 'unchanged', 'would_create', 'would_update', 'none'] as const;
const INIT_HOME_ACTIONS = ['created', 'unchanged', 'would_create', 'none'] as const;
const INIT_NEXT = ['install_launcher', 'add_path', 'notify_init'] as const;
const INIT_NOTIFY_STATES = ['disabled', 'not_configured', 'paused', 'configured_unverified', 'test_sent', 'verified'] as const;

export function validateInitResult(value: unknown): InitResultContract {
  const v = object(value, 'init result');
  for (const key of Object.keys(v)) {
    if (!(INIT_FIELDS as readonly string[]).includes(key)) invalid(`Unknown init field: ${key}`);
  }
  for (const key of INIT_FIELDS) {
    if (!Object.hasOwn(v, key)) invalid(`Missing init field: ${key}`);
  }
  if (v.schema !== 'gbdev.init.v1') invalid('schema must be gbdev.init.v1');
  string(v.bot_label, 'bot_label');
  if (!BOT_LABEL_RE.test(v.bot_label)) invalid('bot_label must match NOTIFY_LABEL');
  string(v.bot_label_input, 'bot_label_input');
  string(v.home, 'home');
  string(v.home_id, 'home_id');
  if (!HOME_ID_RE.test(v.home_id)) invalid('home_id must be 12 hex chars');
  boolean(v.legacy_default, 'legacy_default');
  oneOf(v.home_action, INIT_HOME_ACTIONS, 'home_action');
  const binding = object(v.binding, 'binding');
  for (const key of Object.keys(binding)) {
    if (!['path', 'action'].includes(key)) invalid(`Unknown binding field: ${key}`);
  }
  string(binding.path, 'binding.path');
  oneOf(binding.action, INIT_ACTIONS, 'binding.action');
  const config = object(v.config, 'config');
  for (const key of Object.keys(config)) {
    if (!['path', 'action', 'seeded_from'].includes(key)) invalid(`Unknown config field: ${key}`);
  }
  string(config.path, 'config.path');
  oneOf(config.action, INIT_ACTIONS, 'config.action');
  nullableString(config.seeded_from, 'config.seeded_from');
  const launcher = object(v.launcher, 'launcher');
  for (const key of Object.keys(launcher)) {
    if (!['path', 'state_before', 'action', 'on_path', 'path_hint'].includes(key)) invalid(`Unknown launcher field: ${key}`);
  }
  string(launcher.path, 'launcher.path');
  oneOf(launcher.state_before, ['missing', 'current', 'stale', 'foreign'], 'launcher.state_before');
  oneOf(launcher.action, INIT_ACTIONS, 'launcher.action');
  boolean(launcher.on_path, 'launcher.on_path');
  string(launcher.path_hint, 'launcher.path_hint');
  if (launcher.path_hint !== 'export PATH="$HOME/.gbdev-cli/bin:$PATH"') invalid('path_hint must be the exact PATH export line');
  const botLauncher = object(v.bot_launcher, 'bot_launcher');
  for (const key of Object.keys(botLauncher)) {
    if (!['path', 'action'].includes(key)) invalid(`Unknown bot_launcher field: ${key}`);
  }
  string(botLauncher.path, 'bot_launcher.path');
  oneOf(botLauncher.action, INIT_ACTIONS, 'bot_launcher.action');
  string(v.command, 'command');
  const env = object(v.env, 'env');
  string(env.GBDEV_HOME, 'env.GBDEV_HOME');
  for (const key of Object.keys(env)) {
    if (key !== 'GBDEV_HOME') invalid(`Unknown env field: ${key}`);
  }
  const notify = object(v.notify, 'notify');
  for (const key of Object.keys(notify)) {
    if (!['enabled', 'state', 'missing_step', 'verified_by_bot'].includes(key)) invalid(`Unknown notify field: ${key}`);
  }
  boolean(notify.enabled, 'notify.enabled');
  oneOf(notify.state, INIT_NOTIFY_STATES, 'notify.state');
  if (notify.missing_step !== null) {
    oneOf(notify.missing_step, MISSING_STEPS, 'notify.missing_step');
  }
  nullableString(notify.verified_by_bot, 'notify.verified_by_bot');
  if (notify.verified_by_bot !== null && !BOT_LABEL_RE.test(notify.verified_by_bot)) {
    invalid('notify.verified_by_bot must match NOTIFY_LABEL');
  }
  if (!Array.isArray(v.next_steps) || !v.next_steps.every((s: unknown) => typeof s === 'string' && (INIT_NEXT as readonly string[]).includes(s))) {
    invalid('next_steps must be an ordered subset of install_launcher, add_path, notify_init');
  }
  // Enforce declared order and uniqueness.
  let last = -1;
  for (const step of v.next_steps as string[]) {
    const idx = (INIT_NEXT as readonly string[]).indexOf(step);
    if (idx <= last) invalid('next_steps must be unique and in enum order');
    last = idx;
  }
  boolean(v.dry_run, 'dry_run');
  return value as InitResultContract;
}
