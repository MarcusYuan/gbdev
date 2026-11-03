import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function providerStub(root: string): string {
  const binDir = join(root, 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'provider-stub.mjs');
  writeFileSync(file, `#!${process.execPath}\n${readFileSync(resolve('test/fixtures/provider-stub.js'), 'utf8')}`, { mode: 0o700 });
  return file;
}
