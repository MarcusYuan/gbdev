import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { superviseJob } from '../src/core/supervise.js';
import { supervise } from '../src/commands/supervise.js';
import { JobStore, atomicWriteJson } from '../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../src/core/paths.js';
import { localIso } from '../src/core/time.js';
import { job, worker } from './helpers.js';
import { tmpRepo } from './helpers/tmpRepo.js';

test('S2/E7 supervisor library: 12 sequential in-process jobs and terminal re-entry never grow signal listeners', async t => {
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [] }), store = new JobStore(resolvePaths(h.env));
  const stub = join(h.root, 'fake-codex.mjs');
  writeFileSync(stub, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nconst file = process.argv[process.argv.indexOf('--output-last-message') + 1];\nwriteFileSync(file, ${JSON.stringify(JSON.stringify(worker()))});\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'test-session'}));\n`, { mode: 0o700 });
  const listeners = ['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal));
  for (const [index, invoke] of Array.from({ length: 12 }, (_, i) => i % 2 ? (id: string, store: JobStore) => supervise(store, id) : superviseJob).entries()) {
    const status = { ...job(`j_20261026_1011_a7f${index.toString(16)}`), state: 'starting' as const, repo: h.repo, worktree: h.repo,
      provider: 'codex' as const, role: 'reviewer', sandbox: 'read-only' as const, base_sha: h.git('rev-parse', 'HEAD').trim(),
      deadline_at: localIso(new Date(Date.now() + 60_000)),
      state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }] };
    store.create(status);
    const paths = jobPaths(store.paths, status.job_id);
    atomicWriteJson(paths.brief, { ...h.task, provider: 'codex', role: 'reviewer', sandbox: 'read-only' });
    atomicWriteJson(join(paths.dir, 'provider.json'), { bin: stub, writable_roots: [] });
    writeFileSync(paths.prompt, 'A task.');
    await invoke!(status.job_id, store);
    const done = store.read(status.job_id);
    assert.equal(done.state, 'succeeded'); assert.equal(done.session_id, 'test-session');
    assert.equal(h.result(status.job_id).worker_reported!.summary, worker().summary);
    assert.deepEqual(['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal)), listeners);
    const before = readFileSync(paths.job, 'utf8');
    await superviseJob(status.job_id, store); // Terminal job: idempotent no-op.
    assert.equal(readFileSync(paths.job, 'utf8'), before);
    assert.deepEqual(['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal)), listeners);
  }
});
