export { validateEndpoint } from '../contracts/notify.js';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { HOME_ID, validateEndpoint, validateNotifySecret, type NotifySecret, type SecretProblem } from '../contracts/notify.js';
import type { NotifyConfig } from '../core/notifyConfig.js';
import type { GbdevPaths } from '../core/paths.js';
export type SecuritySpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface SecretOptions {
  paths: GbdevPaths; config: NotifyConfig; allowed_repos: readonly string[]; home_id: string;
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; uid?: number; spawn?: SecuritySpawn;
  keychain_setup_at?: string | null; defaultDirectory?: string;
}
export interface SecretResult {
  ok: boolean; reason: 'secret_missing' | 'secret_unsafe' | 'secret_unsupported' | 'url_invalid' | null;
  problem: SecretProblem | null; endpoint_host: string | null; secret_gen: string | null;
}
const bad = (problem: SecretProblem): SecretResult => ({ ok: false, reason: problem === 'not_found' ? 'secret_missing' : problem === 'unsupported' ? 'secret_unsupported' : problem === 'url_invalid' ? 'url_invalid' : 'secret_unsafe', problem, endpoint_host: null, secret_gen: null });
export function computeSecretGen(source: { source: 'file'; mtimeMs: number; size: number; ino: number } | { source: 'keychain'; keychain_setup_at: string | null }): string | null {
  return source.source === 'file' ? `${source.mtimeMs}:${source.size}:${source.ino}` : source.keychain_setup_at === null ? null : `keychain:${source.keychain_setup_at}`;
}
export function secretFilePath(options: SecretOptions): string {
  if (!HOME_ID.test(options.home_id)) throw new GbdevError('notify_unavailable', 'Invalid notify home identity');
  return options.config.secret_file ?? join(options.defaultDirectory ?? join(homedir(), '.config', 'gbdev', 'notify'), `${options.home_id}.secret.json`);
}
/** Metadata only: neither the caller's data nor secret is reflected on failure. */
export function assertNoSecret(value: unknown, secret: Pick<NotifySecret, 'url' | 'key'>): void {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; }
  catch { throw new GbdevError('notify_unavailable', 'Notify serialization refused', { reason: 'secret_unsafe', problem: 'invalid_schema' }); }
  for (const s of [secret.url, secret.key]) if (s && (text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1)))) throw new GbdevError('notify_unavailable', 'Notify secret exposure refused', { reason: 'secret_unsafe' });
}
/** Closed public projection: the only dynamic output is the validated hostname.
 * A key may equal that public hostname or a template word; substring scanning
 * cannot distinguish that coincidence from inserting a secret. */
export function setupOutput(fields: { endpoint_host: string }, secret: Pick<NotifySecret, 'url' | 'key'>, env: NodeJS.ProcessEnv = {}): { text: string } {
  if (Object.keys(fields).length !== 1 || !Object.hasOwn(fields, 'endpoint_host') ||
      fields.endpoint_host !== validateEndpoint(secret.url, env)) throw new GbdevError('notify_unavailable', 'Notify output projection refused');
  return { text: `endpoint_host: ${fields.endpoint_host}\n下一步执行 gbdev notify test\n` };
}
/** Canonicalize existing ancestors too, so a missing worktrees root cannot bypass containment. */
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; const parent = dirname(path); if (parent === path) throw e; return resolve(canonical(parent), relative(parent, path)); }
}
export function safeSecretLocation(path: string, options: SecretOptions): boolean {
  try {
    const file = canonical(path);
    return [options.paths.home, options.paths.worktrees, ...options.allowed_repos].every(root => { const r = relative(canonical(root), file); return r !== '' && (r === '..' || r.startsWith('../') || isAbsolute(r)); });
  } catch { return false; }
}
export function checkSecretDirectory(path: string, uid: number): SecretProblem | null {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || !s.isDirectory() || (s.mode & 0o7777) !== 0o700) return 'directory_not_0700';
  return s.uid !== uid ? 'directory_owner_mismatch' : null;
}
function fileProblem(s: Stats, uid: number): SecretProblem | null {
  return s.isSymbolicLink() ? 'symlink' : !s.isFile() ? 'not_regular_file' : s.uid !== uid ? 'owner_mismatch' : (s.mode & 0o7777) !== 0o600 ? 'mode_not_0600' : s.size > 4096 ? 'too_large' : null;
}
/**
 * Metadata-only secret projection (P2-11 / S-M6-1): same failure classes as the
 * file path of `readSecret`, including directory owner, size cap, and
 * `safeSecretLocation` with `allowed_repos`. Never opens or reads secret bytes.
 * A metadata/content disagreement (e.g. metadata ok, JSON invalid) can last
 * until the secret is fixed; callers should treat later `notify status` / test /
 * ack as the source of notify readiness — init must not read the body to reconcile.
 */
export function inspectSecretMetadata(options: SecretOptions): { secret: SecretResult; secretExists: boolean } {
  if (options.config.secret_source === 'keychain') {
    const gen = computeSecretGen({ source: 'keychain', keychain_setup_at: options.keychain_setup_at ?? null });
    const secretExists = !!options.keychain_setup_at;
    const secret: SecretResult = gen
      ? { ok: true, reason: null, problem: null, endpoint_host: null, secret_gen: gen }
      : bad('not_found');
    return { secret, secretExists };
  }
  const path = secretFilePath(options);
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return { secret: bad('unsupported'), secretExists: false };
  try {
    const before = lstatSync(path);
    const problem = fileProblem(before, uid);
    if (problem) return { secret: bad(problem), secretExists: true };
    const dirProblem = checkSecretDirectory(dirname(path), uid);
    if (dirProblem) return { secret: bad(dirProblem), secretExists: true };
    if (!safeSecretLocation(path, options)) return { secret: bad('unsafe_location'), secretExists: true };
    const gen = computeSecretGen({ source: 'file', mtimeMs: before.mtimeMs, size: before.size, ino: before.ino });
    return {
      secret: { ok: true, reason: null, problem: null, endpoint_host: null, secret_gen: gen },
      secretExists: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { secret: bad('not_found'), secretExists: false };
    }
    return { secret: bad('read_failed'), secretExists: false };
  }
}
export function securityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TZ']) if (env[name] !== undefined) out[name] = env[name];
  return out;
}
/** stdin is used only for setup; secrets never enter argv or env. stderr is discarded. */
export async function securityCall(options: SecretOptions, args: string[], input?: string): Promise<string | null> {
  if ((options.platform ?? process.platform) !== 'darwin') return null;
  // Never invoke the real keychain from a test process, even if a test forgot its stub.
  if ((process.env.NODE_TEST_CONTEXT !== undefined || options.env?.NODE_TEST_CONTEXT !== undefined) && !options.spawn) return null;
  return new Promise(resolvePromise => {
    let child: ChildProcess;
    try { child = (options.spawn ?? nodeSpawn)('/usr/bin/security', args, { shell: false, env: securityEnv(options.env ?? process.env), timeout: 3000, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolvePromise(null); return; }
    let bytes = 0, chunks: Buffer[] = [], done = false;
    const finish = (value: string | null) => { if (done) return; done = true; clearTimeout(timer); chunks = []; resolvePromise(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, 3000);
    child.on('error', () => finish(null));
    child.stdout?.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) { child.kill('SIGKILL'); finish(null); } else chunks.push(Buffer.from(chunk)); });
    child.on('close', code => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
    child.stdin?.on('error', () => finish(null));
    child.stdin?.end(input);
  });
}
/** Closed, sanitized failure: callers must not mistake callback errors for secret I/O. */
export class SecretUseError extends Error {
  constructor() { super('Notify secret callback failed'); this.name = 'SecretUseError'; }
}
/** The callback is the only interface exposing credentials, only for sending/self-check.
 * Its return value is discarded; its errors are replaced, never serialized. */
export async function readSecret(options: SecretOptions, use?: (secret: Readonly<NotifySecret>) => void | Promise<void>): Promise<SecretResult> {
  let fd: number | undefined;
  try {
    if (!HOME_ID.test(options.home_id)) return bad('read_failed');
    let content: string, gen: string | null;
    if (options.config.secret_source === 'keychain') {
      if ((options.platform ?? process.platform) !== 'darwin') return bad('unsupported');
      const out = await securityCall(options, ['find-generic-password', '-s', 'gbdev-notify', '-a', options.home_id, '-w']);
      if (out === null) return bad('keychain_failed');
      content = out; gen = computeSecretGen({ source: 'keychain', keychain_setup_at: options.keychain_setup_at ?? null });
    } else {
      const path = secretFilePath(options), uid = options.uid ?? process.getuid?.();
      if (uid === undefined) return bad('unsupported');
      const before = lstatSync(path), problem = fileProblem(before, uid);
      if (problem) return bad(problem);
      const dirProblem = checkSecretDirectory(dirname(path), uid);
      if (dirProblem) return bad(dirProblem);
      if (!safeSecretLocation(path, options)) return bad('unsafe_location');
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = fstatSync(fd), openedProblem = fileProblem(s, uid);
      if (openedProblem) return bad(openedProblem);
      if (s.dev !== before.dev || s.ino !== before.ino) return bad('read_failed');
      const buf = Buffer.alloc(4097); let size = 0, n: number;
      while (size < buf.length && (n = readSync(fd, buf, size, buf.length - size, null)) > 0) size += n;
      if (size > 4096) return bad('too_large');
      const after = fstatSync(fd);
      if (s.mtimeMs !== after.mtimeMs || s.size !== after.size || !safeSecretLocation(path, options)) return bad('read_failed');
      content = buf.subarray(0, size).toString('utf8');
      gen = computeSecretGen({ source: 'file', mtimeMs: s.mtimeMs, size: s.size, ino: s.ino });
    }
    let raw: unknown;
    try { raw = JSON.parse(content); } catch { return bad('invalid_json'); }
    if (raw && typeof raw === 'object' && 'key' in raw && (typeof raw.key !== 'string' || raw.key.length < 1 || raw.key.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(raw.key))) return bad('key_invalid');
    let secret: NotifySecret;
    if (raw && typeof raw === 'object' && 'url' in raw && typeof raw.url === 'string' && !validateEndpoint(raw.url, options.env ?? process.env)) return bad('url_invalid');
    try { secret = validateNotifySecret(raw, options.env ?? process.env); } catch { return bad('invalid_schema'); }
    const host = validateEndpoint(secret.url, options.env ?? process.env);
    if (!host) return bad('url_invalid');
    try { if (use) await use(secret); }
    catch (e) {
      if (e instanceof GbdevError && e.contract.details.reason === 'secret_unsafe') return bad('read_failed');
      throw new SecretUseError();
    }
    return { ok: true, reason: null, problem: null, endpoint_host: host, secret_gen: gen };
  } catch (e) { if (e instanceof SecretUseError) throw e; return bad((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'read_failed'); }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Never expose OS exception text. */ } } }
}
