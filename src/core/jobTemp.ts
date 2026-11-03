import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Only these two job-local overrides are added to the caller's existing environment. */
export function jobTempEnv(jobDir: string): { TMPDIR: string; GBDEV_TMPDIR: string } {
  const path = join(jobDir, 'tmp');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return { TMPDIR: path, GBDEV_TMPDIR: path };
}
