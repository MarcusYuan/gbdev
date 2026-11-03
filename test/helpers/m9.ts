import type { TestContext } from 'node:test';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmpRepo } from './tmpRepo.js';
import { job, worker } from '../helpers.js';
import { JobStore, atomicWriteJson } from '../../src/core/jobStore.js';
import { jobPaths, resolvePaths } from '../../src/core/paths.js';
import { localIso } from '../../src/core/time.js';
import { finalize } from '../../src/core/finalize.js';
import { captureWorkspaceSnapshot, WORKSPACE_BEFORE } from '../../src/core/workspaceSnapshot.js';
export function policyFixture(t: TestContext, sandbox: 'read-only' | 'workspace-write' = 'workspace-write') {
  const h = tmpRepo(t, sandbox === 'read-only' ? 'review_approve' : 'ok', {
    role: sandbox === 'read-only' ? 'reviewer' : 'executor', sandbox, acceptance_criteria: [],
  });
  const saved = { ...process.env };
  const systemTmp = tmpdir();
  for (const key of Object.keys(process.env)) if (key.startsWith('GBDEV_')) delete process.env[key];
  Object.assign(process.env, h.env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    // Nested fixtures must not leave TMPDIR pointing at a removed execution root.
    if (!process.env.TMPDIR || !existsSync(process.env.TMPDIR)) process.env.TMPDIR = systemTmp;
  });
  writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.omc/\n');
  const store = new JobStore(resolvePaths(h.env));
  const status = {
    ...job(undefined, new Date()), state: 'starting' as const, repo: h.repo, worktree: h.repo,
    base_sha: h.git('rev-parse', 'HEAD').trim(), role: h.task.role, sandbox,
    state_history: [{ state: 'starting' as const, at: localIso(), by: 'gbdev' }],
  };
  store.create(status);
  const paths = jobPaths(store.paths, status.job_id);
  atomicWriteJson(paths.brief, h.task);
  atomicWriteJson(join(paths.dir, 'provider.json'), {
    bin: process.execPath, writable_roots: sandbox === 'workspace-write' ? [h.repo] : [],
    schema_options: { pipelineStep: true, output: sandbox === 'read-only' ? 'verdict' : 'change', policyIncidents: true },
  });
  writeFileSync(paths.prompt, 'test policy');
  writeFileSync(paths.workerLog, '');
  writeFileSync(paths.rawJsonl, '');
  const baseline = async () => atomicWriteJson(join(paths.dir, WORKSPACE_BEFORE),
    await captureWorkspaceSnapshot(h.repo, { job_id: status.job_id, phase: 'before_worker' }));
  const report = (fields: Record<string, unknown> = {}) => {
    const body = {
      ...worker(), files_changed: [], commits: [], policy_violations: [],
      handoff: { decided: [], rejected: [], risks: [], remaining: [] },
      ...fields,
    };
    writeFileSync(paths.finalMessage, '```json\n' + JSON.stringify(body) + '\n```');
  };
  const finish = async (exitCode = 0) => finalize(store, status, h.task, exitCode);
  return { ...h, store, status, paths, baseline, report, finish };
}

