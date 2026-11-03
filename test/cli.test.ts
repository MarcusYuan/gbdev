import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { validateEnvelope } from '../src/contracts/envelope.js';

async function run(args: string[]) {
  let stdout = '';
  let stderr = '';
  const exit = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { stdout, stderr, exit };
}

test('cli: help is available in text and JSON without executing external tools', async () => {
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const output = await run(args);
    assert.equal(output.exit, 0);
    assert.match(output.stdout, /Usage: gbdev/);
    assert.match(output.stdout, /cleanup <job_id> \[--force-branch\]/);
    assert.equal(output.stderr, '');
  }
  const json = await run(['--help', '--json']);
  assert.equal(json.exit, 0);
  assert.equal(validateEnvelope(JSON.parse(json.stdout)).ok, true);
  assert.equal(json.stderr, '');
});

test('cli: usage/parse errors emit a single envelope and no stderr in JSON mode', async () => {
  for (const args of [['wat', '--json'], ['start', '--json'], ['status', '--bogus', '--json'],
    ['status', 'extra', '--json'], ['--json=true'], ['--json', '--unknown'],
    ['result', '--json'], ['cleanup', '--json'], ['doctor', '--force-branch', '--json'],
    ['install', '--force-branch', '--json'],
    ['result', '../bad', '--json'], ['doctor', 'extra', '--json']]) {
    // --json=true is invalid for a boolean option; the explicit --json still requests JSON errors.
    const actual = args[0] === '--json=true' ? [...args, '--json'] : args;
    const output = await run(actual);
    assert.equal(output.exit, 2, output.stderr || output.stdout);
    assert.equal(output.stderr, '');
    assert.equal(output.stdout.split('\n').length, 2);
    const envelope = validateEnvelope(JSON.parse(output.stdout));
    assert.equal(envelope.ok, false);
    if (!envelope.ok) assert.equal(envelope.error.code, 'usage_error');
  }
  const text = await run(['unknown']);
  assert.equal(text.exit, 2);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /Unknown command/);
});

test('cli: built entry has shebang and runs under Node with correct exit status', () => {
  assert.equal(readFileSync('dist/cli.js', 'utf8').split('\n')[0], '#!/usr/bin/env node');
  for (const [args, expected] of [[['--help', '--json'], 0], [['result', '--json'], 2]] as const) {
    const child = spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', env: {} });
    assert.equal(child.status, expected, child.stderr || child.stdout);
    assert.equal(child.stderr, '');
    validateEnvelope(JSON.parse(child.stdout));
  }
});

test('cli: entry via dist symlink still runs (OBS-1 realpath main-gate)', t => {
  const root = mkdtempSync(join(tmpdir(), 'gbdev-cli-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Intentional: do NOT realpath argv — reproduce symlink path mismatch with import.meta.url.
  symlinkSync(join(process.cwd(), 'dist'), join(root, 'dist'));
  const home = join(root, 'home');
  mkdirSync(home);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({
    version: 1,
    allowed_repos: [],
    providers: {
      codex: { bin: join(root, 'missing-codex') },
      cursor: { bin: join(root, 'missing-cursor-agent') },
    },
  }));
  const cliViaLink = join(root, 'dist', 'cli.js');
  const child = spawnSync(process.execPath, [cliViaLink, 'roles', 'list', '--json'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GBDEV_HOME: home,
      GBDEV_CONFIG: config,
      GBDEV_CLI_HOME: join(root, 'cli-home'),
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout || '(empty stdout — main-gate miss?)');
  assert.ok(child.stdout.trim(), 'expected JSON stdout when entered via symlink');
  const envelope = validateEnvelope(JSON.parse(child.stdout));
  assert.equal(envelope.ok, true);
});
