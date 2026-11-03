import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertRepoAllowed, loadConfig, validateConfig } from '../src/core/config.js';
import { createJobId, jobBranch, validateBranchName, validateIdentifier, validateJobId } from '../src/core/ids.js';
import { expandHome, jobPaths, resolvePaths, worktreePath } from '../src/core/paths.js';
import { deadlineAt, localIso } from '../src/core/time.js';
import { errorCode, temporary } from './helpers.js';

test('paths: home/config defaults, GBDEV_HOME and GBDEV_CONFIG overrides, tilde expansion', t => {
  const root = temporary(t);
  assert.deepEqual(resolvePaths({}, root), {
    home: join(root, '.gbdev'), config: join(root, '.config/gbdev/config.json'), configSource: 'default',
    jobs: join(root, '.gbdev/jobs'), worktrees: join(root, '.gbdev/worktrees'), lock: join(root, '.gbdev/lock'),
  });
  const paths = resolvePaths({ GBDEV_HOME: '~/state', GBDEV_CONFIG: '~/settings.json' }, root);
  assert.equal(paths.home, join(root, 'state'));
  assert.equal(paths.config, join(root, 'settings.json'));
  assert.equal(paths.configSource, 'env');
  assert.equal(expandHome('~', root), root);
  assert.equal(expandHome('node', root), 'node');
  assert.throws(() => resolvePaths({ GBDEV_HOME: '' }, root), errorCode('config_invalid'));
  assert.throws(() => expandHome('~someone/config', root), errorCode('config_invalid'));
});

test('paths: job layout and worktree layout stay under the selected home', t => {
  const root = temporary(t);
  const paths = resolvePaths({ GBDEV_HOME: root });
  const id = 'j_20261025_1131_a7f3';
  const files = jobPaths(paths, id);
  assert.equal(files.job, join(root, 'jobs', id, 'job.json'));
  for (const file of Object.values(files)) assert.equal(file.startsWith(`${root}/jobs/${id}`), true);
  assert.equal(worktreePath(paths, '/projects/some-repo/', id), join(root, 'worktrees', 'some-repo', id));
  for (const bad of ['../escape', 'a/b', '', '/tmp/job', 'j_20261025_1131_a7f3/../../escape']) {
    assert.throws(() => jobPaths(paths, bad), errorCode('config_invalid'));
    assert.throws(() => worktreePath(paths, '/projects/repo', bad), errorCode('config_invalid'));
  }
  assert.throws(() => worktreePath(paths, 'relative', id), errorCode('config_invalid'));
  assert.throws(() => worktreePath(paths, '/', id), errorCode('config_invalid'));
});

test('ids: required identifier regexp and git-safe branch names', () => {
  for (const good of ['HEAD', 'main', 'gbdev/j_20261025_1131_a7f3', 'a_1.2-3']) {
    assert.doesNotThrow(() => validateIdentifier(good));
    assert.doesNotThrow(() => validateBranchName(good));
  }
  for (const bad of ['', '-option', '_bad', '.hidden', 'a b', 'a;echo', 'a\nb', 'a$(x)', 'a@{1}', null, 1]) {
    assert.throws(() => validateIdentifier(bad), errorCode('config_invalid'));
    assert.throws(() => validateBranchName(bad), errorCode('config_invalid'));
  }
  for (const bad of ['a..b', 'a//b', 'a/', 'a.', 'a/.hidden', 'a.lock', 'a.lock/b']) {
    assert.throws(() => validateBranchName(bad), errorCode('config_invalid'));
  }
});

test('ids: job ids use local date/minute and four random hex digits', () => {
  const date = new Date(2026, 9, 25, 11, 31);
  for (let i = 0; i < 10; i++) {
    const id = createJobId(date);
    assert.match(id, /^j_20261025_1131_[a-f0-9]{4}$/);
    validateJobId(id);
    assert.equal(jobBranch(id), `gbdev/${id}`);
  }
  for (const bad of ['main', 'j_20261025_1131_abc', 'j_20261025_1131_gggg', '../a', 'j_20261025_1131_a7f3/child']) {
    assert.throws(() => validateJobId(bad), errorCode('config_invalid'));
  }
  assert.throws(() => createJobId(new Date(NaN)), errorCode('config_invalid'));
});

test('time: local ISO includes numeric offset, preserves instant and validates deadlines', () => {
  const date = new Date('2026-10-25T18:31:02.123Z');
  const formatted = localIso(date);
  assert.match(formatted, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:02\.123[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(formatted), date.getTime());
  assert.equal(Date.parse(deadlineAt(date, 30)), date.getTime() + 1_800_000);
  for (const bad of [0, 241, 1.5, NaN]) assert.throws(() => deadlineAt(date, bad), errorCode('config_invalid'));
  assert.throws(() => localIso(new Date(NaN)), errorCode('config_invalid'));
});

test('time: offsets follow each instant across DST and support non-hour offsets', () => {
  const script = 'import { localIso } from "./dist/core/time.js"; console.log(JSON.stringify([localIso(new Date("2026-03-08T09:59:00Z")), localIso(new Date("2026-03-08T10:01:00Z"))]));';
  const la = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { TZ: 'America/Los_Angeles' },
  });
  assert.equal(la.status, 0, la.stderr);
  assert.deepEqual(JSON.parse(la.stdout), ['2026-03-08T01:59:00.000-08:00', '2026-03-08T03:01:00.000-07:00']);
  const nepal = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { TZ: 'Asia/Kathmandu' },
  });
  assert.equal(nepal.status, 0, nepal.stderr);
  assert.match(JSON.parse(nepal.stdout)[0], /\+05:45$/);
});

test('config: missing file and omitted fields default to deny-all, PATH bins, timeout 30, concurrency 1', t => {
  const config = loadConfig(join(temporary(t), 'missing.json'));
  assert.deepEqual(config, { version: 1, allowed_repos: [], providers: {
    codex: { bin: 'codex' }, cursor: { bin: 'cursor-agent' },
  }, default_timeout_min: 30, default_stall_timeout_s: 600, concurrency: 1 });
  assert.throws(() => assertRepoAllowed(temporary(t), config), errorCode('repo_not_allowed'));
});

test('config: loads JSON, expands provider paths and canonicalizes exact whitelist entries', t => {
  const root = temporary(t);
  const file = join(root, 'config.json');
  const value = { version: 1, allowed_repos: [root], providers: {
    codex: { bin: '/custom/codex' }, cursor: { bin: '~/.local/bin/cursor-agent' },
  }, default_timeout_min: 240, concurrency: 1 };
  writeFileSync(file, JSON.stringify(value));
  const config = loadConfig(file);
  assert.equal(config.providers.codex.bin, '/custom/codex');
  assert.equal(config.providers.cursor.bin.endsWith('/.local/bin/cursor-agent'), true);
  assert.equal(config.providers.cursor.bin.startsWith('~'), false);
  const alias = join(root, 'alias');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  symlinkSync(repo, alias);
  assert.equal(assertRepoAllowed(alias, validateConfig({ ...value, allowed_repos: [repo] })), assertRepoAllowed(repo, validateConfig({ ...value, allowed_repos: [alias] })));
  assert.throws(() => assertRepoAllowed(file, config), errorCode('config_invalid'));
  assert.throws(() => assertRepoAllowed(join(root, 'missing'), config), errorCode('config_invalid'));
  assert.throws(() => assertRepoAllowed('relative', config), errorCode('config_invalid'));
  assert.equal(existsSync(file), true);
});

test('config: rejects invalid JSON and invalid configuration instead of silently falling back', t => {
  const root = temporary(t);
  const file = join(root, 'config.json');
  writeFileSync(file, '{bad');
  assert.throws(() => loadConfig(file), errorCode('config_invalid'));
  assert.throws(() => loadConfig(root), errorCode('config_invalid'));
  for (const value of [null, [], {}, { version: 2 }, ...Object.entries({
    allowed_repos: [null, ['relative'], [2]], providers: [null, [], { codex: 3 }, { codex: { bin: '' } }],
    concurrency: [0, 2, '1', null], default_timeout_min: [0, 241, 1.5, '30', null],
  }).flatMap(([key, values]) => values.map(value => ({ version: 1, [key]: value })))]) {
    assert.throws(() => validateConfig(value), errorCode('config_invalid'), JSON.stringify(value));
  }
  assert.equal(readFileSync(file, 'utf8'), '{bad');
});
