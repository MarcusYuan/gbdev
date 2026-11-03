import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { validateJobResult } from '../src/contracts/jobResult.js';
import { validateJobStatus } from '../src/contracts/jobStatus.js';
import { extractWorkerResult, validateWorkerResult } from '../src/contracts/workerResult.js';
import { failureResult } from '../src/core/finalize.js';
import { JobStore } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { codexSessionId } from '../src/providers/codex.js';
import { cursor, cursorMetadata } from '../src/providers/cursor.js';
import { job, result, temporary, worker } from './helpers.js';
import { providerStub } from './helpers/providerStub.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';

for (const custom of [false, true]) {
  test(`H1: snapshot bypasses pre-commit, post-commit and post-index-change hooks (custom hooksPath=${custom})`, async t => {
    const h = tmpRepo(t, 'dirty_exit', { acceptance_criteria: [] });
    const hooks = join(h.repo, custom ? 'custom-hooks' : '.git/hooks');
    mkdirSync(hooks, { recursive: true });
    if (custom) h.git('config', 'core.hooksPath', hooks);
    for (const name of ['pre-commit', 'post-commit', 'post-index-change']) {
      // A pre-commit invocation would both leave evidence and prevent the snapshot.
      writeFileSync(join(hooks, name), `#!/bin/sh\nprintf executed > "${join(h.root, name)}"\nexit 1\n`, { mode: 0o700 });
    }
    const done = await h.wait((await h.launch()).job_id);
    const observed = h.result(done.job_id).gbdev_observed;
    assert.equal(done.state, 'succeeded');
    assert.equal(observed.worktree_dirty_at_exit, true);
    assert.equal(observed.snapshot_commit, observed.head_after);
    assert.match(observed.commits[0]!, /gbdev: snapshot/);
    for (const name of ['pre-commit', 'post-commit', 'post-index-change']) assert.equal(existsSync(join(h.root, name)), false);
    if (custom) assert.equal(h.git('config', '--get', 'core.hooksPath').trim(), hooks);
  });
}

test('G3: real Cursor stdout fixture exposes session_id and extracts the worker report', t => {
  const dir = temporary(t);
  const raw = readFileSync(resolve('test/fixtures/cursor-stdout-r4.json'), 'utf8');
  writeFileSync(join(dir, 'raw.json'), raw);
  assert.deepEqual(cursorMetadata(dir), { session_id: '00000000-0000-4000-8000-000000000003', failure_reason: null });
  assert.equal(extractWorkerResult(cursor.extractFinalMessage(dir)!).status, 'succeeded');
});

test('G3: Cursor JSONL takes the last nonempty top-level session_id and final result', t => {
  const dir = temporary(t);
  const objects = [
    { type: 'system', session_id: 'first' },
    { result: 'earlier final', session_id: 'second' },
    { type: 'result', result: JSON.stringify(worker()), subtype: 'success', session_id: 'last' },
    { session_id: '' }, { session_id: '  ' }, { session_id: 42 }, { nested: { session_id: 'nested' } },
  ];
  writeFileSync(join(dir, 'raw.json'), objects.map(object => JSON.stringify(object)).join('\r\n') + '\n{partial');
  assert.deepEqual(cursorMetadata(dir), { session_id: 'last', failure_reason: null });
  assert.equal(extractWorkerResult(cursor.extractFinalMessage(dir)!).summary, worker().summary);
  writeFileSync(join(dir, 'raw.json'), '{"type":"result","subtype":"execution_error","session_id":"failed-session"}\n{"type":"done"}');
  assert.deepEqual(cursorMetadata(dir), { session_id: 'failed-session', failure_reason: 'provider_error: execution_error' });
});

test('G3: Codex session_id comes only from a valid thread.started event', t => {
  const dir = temporary(t);
  assert.equal(codexSessionId(dir), null);
  writeFileSync(join(dir, 'raw.jsonl'), [
    { type: 'thread.started', thread_id: 'first-thread' },
    { type: 'thread.started', thread_id: 'last-thread' },
    { type: 'thread.started', thread_id: '' }, { type: 'thread.started', thread_id: 42 },
    { type: 'item.completed', thread_id: 'not-a-thread-start' },
  ].map(object => JSON.stringify(object)).join('\n') + '\n{partial');
  assert.equal(codexSessionId(dir), 'last-thread');
});

for (const provider of ['codex', 'cursor'] as const) {
  for (const failed of [false, true]) {
    test(`G3: ${provider} session_id survives ${failed ? 'failure' : 'success'} in persisted and CLI JSON status/result`, async t => {
      const h = tmpRepo(t, 'ok', { provider, acceptance_criteria: [] }, {
        GBDEV_STUB_JSONL: '1', GBDEV_STUB_EXIT: failed ? '23' : '0',
      });
      const stub = providerStub(h.root);
      writeFileSync(h.config, JSON.stringify({ version: 1, allowed_repos: [h.repo], providers: { [provider]: { bin: stub } } }));
      const done = await h.wait((await h.launch()).job_id);
      const expected = provider === 'codex' ? 'stub-thread-id' : 'stub-session-id';
      assert.equal(done.state, failed ? 'failed' : 'succeeded');
      assert.equal(done.session_id, expected);
      for (const filename of ['job.json', 'result.json']) {
        assert.equal(JSON.parse(readFileSync(join(h.jobDir(done.job_id), filename), 'utf8')).session_id, expected);
      }
      for (const command of ['status', 'result']) {
        assert.equal((unwrap((await h.command([command, done.job_id])).envelope) as { session_id: string }).session_id, expected);
      }
      const listed = unwrap((await h.command(['status'])).envelope) as { session_id: string }[];
      assert.equal(listed[0]?.session_id, expected);
    });
  }
}

test('G3: session_id is nullable and old v1 status/results remain readable without rewriting files', async t => {
  for (const session_id of [null, 'session']) {
    assert.equal(validateJobStatus({ ...job(), session_id }).session_id, session_id);
    assert.equal(validateJobResult({ ...result(), session_id }).session_id, session_id);
  }
  for (const session_id of [42, '', '  ', {}, []]) {
    assert.throws(() => validateJobStatus({ ...job(), session_id }), /session_id/);
    assert.throws(() => validateJobResult({ ...result(), session_id }), /session_id/);
  }
  const h = tmpRepo(t, 'ok', { acceptance_criteria: [] });
  const done = await h.wait((await h.launch()).job_id);
  for (const [filename, command] of [['job.json', 'status'], ['result.json', 'result']] as const) {
    const file = join(h.jobDir(done.job_id), filename);
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    delete legacy.session_id;
    const content = JSON.stringify(legacy);
    writeFileSync(file, content);
    assert.equal((unwrap((await h.command([command, done.job_id])).envelope) as { session_id: null }).session_id, null);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});

test('G3: crash recovery retains an already observed session_id', t => {
  const h = tmpRepo(t);
  const store = new JobStore(resolvePaths(h.env));
  const status = { ...job(), provider: 'cursor' as const, session_id: 'retained-session', repo: h.repo, worktree: h.repo, base_sha: h.git('rev-parse', 'HEAD').trim() };
  store.create(status);
  writeFileSync(join(h.jobDir(status.job_id), 'brief.json'), JSON.stringify(h.task));
  writeFileSync(join(h.jobDir(status.job_id), 'raw.json'), JSON.stringify({ session_id: 'must-not-overwrite' }));
  assert.equal(failureResult(store, status, null).session_id, 'retained-session');
});

for (const [key, value] of [['kind', 'network'], ['detail', 42]] as const) {
  test(`G4: invalid blockers[1].${key} reports the indexed field path`, () => {
    const valid = { kind: 'env', detail: 'First blocker' };
    const report = { ...worker(), blockers: [valid, { ...valid, [key]: value }] };
    const expected = new RegExp(`blockers\\[1\\]\\.${key}`);
    assert.throws(() => validateWorkerResult(report), expected);
    assert.throws(() => extractWorkerResult(JSON.stringify(report)), expected);
  });
}

test('G4: resolveBase propagates missing git instead of reporting repo_no_commits', t => {
  const dir = temporary(t);
  // Absolute node path plus empty PATH ensures this child cannot find git.
  const source = `import { resolveBase } from ${JSON.stringify(new URL('../src/core/git.js', import.meta.url).href)};
    try { resolveBase(${JSON.stringify(dir)}, 'HEAD'); process.exitCode = 1; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }`;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { PATH: dir }, stdio: 'pipe',
  }));
});
