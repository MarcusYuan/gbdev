import type { TestContext } from 'node:test';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from '../helpers.js';
import { git, head } from '../../src/core/git.js';
import { resolvePaths } from '../../src/core/paths.js';
export function testEnv(t: TestContext, values: Record<string, string>): void {
  const before = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
let idUsers = 0;
let originalRandomBytes: typeof crypto.randomBytes;
export function uniqueJobIds(t: TestContext): void {
  // Job IDs have a minute timestamp and only 16 random bits. Multi-job M3
  // scenarios can collide even with a fresh mkdtemp home (birthday effect).
  // Overlapping fixtures share one installation and sequence. Only the last
  // cleanup restores it; TestContext mocks would auto-restore too early.
  // Make just the synchronous 2-byte ID entropy unique while fixtures are active;
  // keep clocks, UUIDs, other random bytes and duplicate-store rejection real.
  if (idUsers++ === 0) {
    originalRandomBytes = crypto.randomBytes;
    const randomBytes = originalRandomBytes.bind(crypto); let idSequence = 0;
    crypto.randomBytes = ((size: number, callback?: (error: Error | null, buffer: Buffer) => void) => {
      if (callback) return randomBytes(size, callback);
      if (size !== 2) return randomBytes(size);
      if (idSequence > 0xffff) throw new Error('Test fixture ID space exhausted');
      const bytes = Buffer.alloc(2); bytes.writeUInt16BE(idSequence++); return bytes;
    }) as typeof crypto.randomBytes;
    syncBuiltinESMExports();
  }
  t.after(() => {
    if (--idUsers === 0) { crypto.randomBytes = originalRandomBytes; syncBuiltinESMExports(); }
  });
}
export function runFixture(t: TestContext) {
  uniqueJobIds(t);
  const root = temporary(t), repo = join(root, 'repo'), config = join(root, 'config.json');
  const gitConfig = join(root, 'gitconfig'); writeFileSync(gitConfig, '');
  testEnv(t, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0' });
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, ['init', '--initial-branch=main']);
  const commit = (cwd: string, message: string) => { git(cwd, ['add', '-A']); git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message]); return head(cwd); };
  writeFileSync(join(repo, 'src', 'base.txt'), 'base\n'); writeFileSync(join(repo, '.gitignore'), 'cache/\n');
  const base = commit(repo, 'base');
  writeFileSync(config, JSON.stringify({ version: 1, allowed_repos: [repo], providers: { codex: { bin: join(root, 'missing') }, cursor: { bin: join(root, 'missing') } } }));
  const paths = resolvePaths({ GBDEV_HOME: join(root, 'home'), GBDEV_CONFIG: config });
  return { root, repo, paths, base, commit, run_id: 'r_20261027_0911_5be0' };
}
