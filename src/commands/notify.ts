import { chmodSync, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { GbdevError } from '../contracts/error.js';
import { NOTIFY_REASONS, SECRET_PROBLEMS, validateNotifySecret } from '../contracts/notify.js';
import { validateConfig } from '../core/config.js';
import { validateNotify } from '../core/notifyConfig.js';
import type { GbdevPaths } from '../core/paths.js';
import { localIso } from '../core/time.js';
import { identity } from '../dashboard/names.js';
import { assertNoSecret, checkSecretDirectory, safeSecretLocation, secretFilePath, securityCall, setupOutput, validateEndpoint, type SecretOptions } from '../notify/secret.js';
export interface NotifySetupIO { isTTY: boolean; readHidden(prompt: string): Promise<string> }
export const terminalSetupIO: NotifySetupIO = {
  get isTTY() { return Boolean(process.stdin.isTTY && process.stderr.isTTY); },
  async readHidden(prompt) {
    if (!this.isTTY) throw new GbdevError('usage_error', 'Notify setup requires a terminal');
    return new Promise((resolve, reject) => {
      const stdin = process.stdin, wasRaw = stdin.isRaw, wasPaused = stdin.isPaused(), decoder = new StringDecoder('utf8');
      let value = '';
      const finish = (ok: boolean) => {
        stdin.removeListener('data', data); stdin.removeListener('error', error); stdin.removeListener('end', error);
        stdin.setRawMode(wasRaw); if (wasPaused) stdin.pause(); process.stderr.write('\n');
        if (ok) resolve(value); else reject(new GbdevError('usage_error', 'Notify setup cancelled'));
      };
      const error = () => finish(false);
      const data = (chunk: Buffer) => {
        for (const char of decoder.write(chunk)) {
          if (char === '\x03' || char === '\x04') { finish(false); return; }
          if (char === '\r' || char === '\n') { finish(true); return; }
          if (char === '\x7f' || char === '\b') value = Array.from(value).slice(0, -1).join(''); else value += char;
          if (value.length > 4096) { finish(false); return; }
        }
      };
      stdin.setRawMode(true); process.stderr.write(prompt); stdin.on('data', data); stdin.once('error', error); stdin.once('end', error); stdin.resume();
    });
  },
};
/** Explicit 0600 after exclusive create makes the mode independent of the user's umask. */
function atomicPrivateBytes(path: string, bytes: Buffer): void {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`); let fd: number | undefined, created = false;
  try {
    fd = openSync(temp, 'wx', 0o600); created = true; fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path);
  } finally { if (fd !== undefined) closeSync(fd); if (created) rmSync(temp, { force: true }); }
}
function atomicPrivateJson(path: string, value: unknown): void {
  atomicPrivateBytes(path, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
}
function rawConfig(path: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }; throw new GbdevError('config_invalid', 'Cannot read notify configuration'); }
}
function privateDirectory(path: string, uid: number): void {
  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (created !== undefined) chmodSync(path, 0o700);
  const problem = checkSecretDirectory(path, uid);
  if (problem) throw new GbdevError('notify_unavailable', 'Unsafe notify directory', { reason: 'secret_unsafe', problem });
}
function writeConfig(paths: GbdevPaths, raw: Record<string, unknown>, notify: Record<string, unknown>): void {
  const merged = { ...raw, notify }; validateConfig(merged);
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 }); atomicPrivateJson(paths.config, merged);
}
export async function notifyCommand(paths: GbdevPaths, args: string[], options: Record<string, unknown>, io: NotifySetupIO = terminalSetupIO, dependencies: Partial<Pick<SecretOptions, 'spawn' | 'platform' | 'env' | 'defaultDirectory'>> = {}): Promise<{ text: string }> {
  try {
    const sub = args[0];
    if (args.length !== 1 || !['setup', 'enable', 'disable'].includes(sub ?? '')) throw new GbdevError('usage_error', 'Use notify setup, enable, or disable');
    const allowed = sub === 'setup' ? ['keychain'] : sub === 'enable' ? ['key-placement', 'key-name', 'key-prefix'] : [];
    if (Object.keys(options).some(k => !allowed.includes(k))) throw new GbdevError('usage_error', 'Unsupported notify option');
    if (sub === 'setup' && !io.isTTY) throw new GbdevError('usage_error', 'Notify setup requires a terminal');
    const raw = rawConfig(paths.config);
    const prior = raw.notify === undefined ? {} : raw.notify;
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new GbdevError('config_invalid', 'Invalid notify configuration');
    if (sub !== 'setup') {
      const notify: Record<string, unknown> = { ...prior, enabled: sub === 'enable' };
      for (const [flag, field] of [['key-placement', 'key_placement'], ['key-name', 'key_name'], ['key-prefix', 'key_prefix']] as const) if (options[flag] !== undefined) notify[field] = options[flag];
      writeConfig(paths, raw, notify); return { text: `Notify ${sub === 'enable' ? 'enabled' : 'disabled'}\n` };
    }
    const config = validateConfig(raw), notify = validateNotify(raw.notify), uid = process.getuid?.();
    if (uid === undefined) throw new GbdevError('notify_unavailable', 'Notify secrets unsupported', { reason: 'secret_unsupported' });
    const opts: SecretOptions = { paths, config: notify, allowed_repos: config.allowed_repos, home_id: identity(paths.home).h12, ...dependencies };
    if (options.keychain && (opts.platform ?? process.platform) !== 'darwin') throw new GbdevError('notify_unavailable', 'Notify secrets unsupported', { reason: 'secret_unsupported' });
    const input = { schema: 'gbdev.notify-secret.v1', url: await io.readHidden('Webhook URL: '), key: await io.readHidden('Sender key: ') };
    const host = validateEndpoint(input.url, opts.env ?? process.env);
    if (!host || input.url.length > 4096) throw new GbdevError('notify_unavailable', 'Invalid notify endpoint', { reason: 'url_invalid' });
    // Preserve the validator's classified failure; never reflect input or exception text.
    let secret;
    try { secret = validateNotifySecret(input, opts.env ?? process.env); }
    catch (e) {
      if (e instanceof GbdevError) throw new GbdevError('notify_unavailable', 'Invalid notify secret', e.contract.details);
      throw new GbdevError('notify_unavailable', 'Invalid notify secret', { reason: 'secret_unsafe', problem: 'invalid_schema' });
    }
    const bytes = Buffer.from(JSON.stringify(secret) + '\n', 'utf8');
    if (bytes.length > 4096) throw new GbdevError('notify_unavailable', 'Notify secret too large', { reason: 'secret_unsafe', problem: 'too_large' });
    const output = setupOutput({ endpoint_host: host }, secret, opts.env ?? process.env);
    const source = options.keychain ? 'keychain' : 'file';
    // Validate any source switch before modifying either storage backend.
    const nextNotify = { ...prior, secret_source: source }; validateConfig({ ...raw, notify: nextNotify });
    if (options.keychain) {
      const dir = join(paths.home, 'notify');
      try { const problem = checkSecretDirectory(dir, uid); if (problem) throw new GbdevError('notify_unavailable', 'Unsafe notify directory', { reason: 'secret_unsafe', problem }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const statePath = join(dir, 'state.json'); let state: Record<string, unknown> = {};
      try {
        const st = lstatSync(statePath); if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777) !== 0o600) throw new Error();
        const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); state = parsed as Record<string, unknown>;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new GbdevError('notify_unavailable', 'Cannot read notify state'); }
      const { keychain_setup_at: priorSetupAt, ...retainedState } = state;
      const previous = typeof priorSetupAt === 'string' ? Date.parse(priorSetupAt) : NaN;
      // The generated timestamp is another public projection, not secret input.
      // Scan only retained, arbitrary state before changing either backend.
      if (Object.keys(retainedState).length) assertNoSecret(retainedState, secret);
      const next = { ...retainedState, keychain_setup_at: localIso(new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0))) };
      privateDirectory(dir, uid);
      // security's interactive command parser, not a shell. Only stdin carries the quoted JSON.
      const quoted = JSON.stringify(secret).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const out = await securityCall(opts, ['-i'], `add-generic-password -U -s gbdev-notify -a ${opts.home_id} -w "${quoted}"\n`);
      if (out === null) throw new GbdevError('notify_unavailable', 'Cannot store notify secret', { reason: 'secret_unsafe', problem: 'keychain_failed' });
      // Verify a round-trip before declaring success; interactive security may exit 0 after a failed command.
      const stored = await securityCall(opts, ['find-generic-password', '-s', 'gbdev-notify', '-a', opts.home_id, '-w']);
      let matches = false; try { const v = validateNotifySecret(JSON.parse(stored ?? ''), opts.env ?? process.env); matches = v.url === secret.url && v.key === secret.key; } catch { /* No raw keychain diagnostics. */ }
      if (!matches) throw new GbdevError('notify_unavailable', 'Cannot verify notify secret', { reason: 'secret_unsafe', problem: 'keychain_failed' });
      atomicPrivateJson(statePath, next);
    } else {
      const path = secretFilePath(opts);
      if (!safeSecretLocation(path, opts)) throw new GbdevError('notify_unavailable', 'Unsafe notify secret location', { reason: 'secret_unsafe', problem: 'unsafe_location' });
      privateDirectory(dirname(path), uid);
      try { const st = lstatSync(path); if (st.isSymbolicLink() || !st.isFile() || st.uid !== uid) throw new GbdevError('notify_unavailable', 'Unsafe notify secret file', { reason: 'secret_unsafe' }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      atomicPrivateBytes(path, bytes);
    }
    if (notify.secret_source !== source) writeConfig(paths, raw, nextNotify);
    return output;
  } catch (e) {
    // Even injected IO/filesystem/keychain errors can carry credentials. Never forward their text.
    if (e instanceof GbdevError) {
      const details: Record<string, unknown> = {};
      if ((NOTIFY_REASONS as readonly unknown[]).includes(e.contract.details.reason)) details.reason = e.contract.details.reason;
      if ((SECRET_PROBLEMS as readonly unknown[]).includes(e.contract.details.problem)) details.problem = e.contract.details.problem;
      throw new GbdevError(e.contract.code, e.contract.code === 'usage_error' ? 'Invalid notify usage; setup requires a TTY' : 'Notify operation failed', details);
    }
    throw new GbdevError('notify_unavailable', 'Notify operation failed');
  }
}
