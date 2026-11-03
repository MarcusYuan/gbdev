import assert from 'node:assert/strict';
import { after } from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Installed for the entire default suite, including sanitized subprocess environments.
const root = mkdtempSync(join(tmpdir(), 'gbdev-suite-tmux-')), marker = join(root, 'called'), bin = join(root, 'tmux');
copyFileSync('test/fixtures/fake-tmux.js', bin); chmodSync(bin, 0o755);
writeFileSync(bin + '.json', JSON.stringify({ mode: 'fail', log: marker }));
const previousPath = process.env.PATH; process.env.PATH = `${root}:${previousPath ?? ''}`;
after(() => {
  try { assert.equal(existsSync(marker), false, 'AC-27: default suite must never execute PATH tmux'); }
  finally { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); }
});
