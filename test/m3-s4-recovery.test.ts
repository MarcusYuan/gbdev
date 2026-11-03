import { assertOrchestratorNote } from './helpers/orchestratorNote.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, until } from './helpers/m3.js';
import { cancelRun, runCommand } from '../src/commands/run.js';
import { readRun, runPaths } from '../src/run/store.js';
import { runJobs } from '../src/run/invariants.js';
import { jobPaths } from '../src/core/paths.js';
import { isProcessAlive } from '../src/core/lock.js';
import { groupAlive, terminateGroup } from '../src/core/proc.js';
import { head } from '../src/core/git.js';
import type { Run } from '../src/contracts/run.js';
for (const phase of ['running', 'merging', 'finalizing'] as const) test(`AC-S4.4 F15 SIGKILL ${phase}: status restores, stops groups, resume_run succeeds`, { timeout: 120_000 }, async t => {
  let cleanup: (() => Promise<void>) | undefined; t.after(async () => cleanup?.());
  const f = fixture(t); if (phase !== 'merging') f.request.tasks = [f.request.tasks![0]!];
  if (phase === 'running') f.fakePlan['a/implement#1'] = 'slow';
  if (phase === 'merging') {
    f.request.overlap_policy = 'allow';
    for (const task of f.request.tasks!) { task.file_scope = ['src/base.txt']; f.fakePlan[`${task.id}/implement#1`] = { sleep_ms: task.id === 'a' ? 100 : 1500, actions: [{ type: 'write_file', path: 'src/base.txt', content: `${task.id}\n` }] }; }
    f.fakePlan['run:resolver#2.1'] = 'slow';
  }
  if (phase === 'finalizing') { f.request.final_review = 'reviewer'; f.fakePlan['run:final_review#1'] = 'slow'; }
  f.savePlan(); const file = join(f.root, 'request.json'); writeFileSync(file, JSON.stringify(f.request));
  const output = execFileSync(process.execPath, [resolve('dist/cli.js'), 'run', 'start', '--request', file, '--json'], { encoding: 'utf8', env: { ...process.env, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config } });
  const initial = JSON.parse(output).result as Run; const id = initial.run_id;
  cleanup = async () => {
    try { await cancelRun(f.store, id); } finally {
      for (const j of runJobs(f.store, readRun(f.store, id))) { const p = jobPaths(f.paths, j.job_id).processInfo; if (existsSync(p)) { const info = JSON.parse(readFileSync(p, 'utf8')); for (const pid of [info.worker_pgid, info.check_pgid]) if (pid && groupAlive(pid)) await terminateGroup(pid, 100); } }
      const pid = readRun(f.store, id).supervisor_pid; if (pid && isProcessAlive(pid)) await until(() => !isProcessAlive(pid));
    }
  };
  // Observe the real resolver/worker phase before injecting SIGKILL. Process
  // startup on a loaded host is not part of the recovery behavior being asserted.
  await until(() => { try { const r = readRun(f.store, id); return phase === 'merging' ? r.integration.merging?.phase === 'resolving' && runJobs(f.store, r).some(j => j.role === 'resolver' && j.state === 'running') : phase === 'finalizing' ? r.state === 'finalizing' && runJobs(f.store, r).some(j => j.step_instance?.startsWith('run:final') && j.state === 'running') : runJobs(f.store, r).some(j => j.state === 'running'); } catch { return false; } }, 45_000);
  const before = readRun(f.store, id), pid = before.supervisor_pid!; process.kill(pid, 'SIGKILL'); await until(() => !isProcessAlive(pid));
  const recovered = (await runCommand(f.store, ['status', id], {})).result as Run;
  assert.equal(recovered.state, 'needs_decision', JSON.stringify(recovered)); assert.equal(head(recovered.integration.worktree), recovered.integration.verified_sha); assert.ok(recovered.attention.some(d => d.reason === 'supervisor_crashed'));
  for (const job of runJobs(f.store, recovered)) { const info = JSON.parse(readFileSync(jobPaths(f.paths, job.job_id).processInfo, 'utf8')); if (info.worker_pgid) assert.equal(groupAlive(info.worker_pgid), false); }
  assert.match(readFileSync(runPaths(f.store, id).events, 'utf8'), /recovery_step/); f.invariants(id);
  f.fakePlan['a/implement#1'] = { actions: [{ type: 'write_file', path: 'src/a.txt', content: 'a\n' }] }; f.fakePlan['run:final_review#1'] = 'review_approve'; f.fakePlan['run:final_review#2'] = 'review_approve'; f.fakePlan['run:resolver#3.1'] = { actions: [{ type: 'resolve_conflicts' }] }; f.fakePlan['run:verifier#3'] = 'review_approve'; f.savePlan();
  const oldJobs = new Set(runJobs(f.store, recovered).map(j => j.job_id));
  const answers = recovered.attention.map(d => ({ schema: 'gbdev.run-resume.v1', run_id: id, decision_id: d.decision_id, action: d.reason === 'supervisor_crashed' ? 'resume_run' : 'retry_task', task_id: d.task_id, answers: null, task_graph: null, note: d.reason === 'supervisor_crashed' ? 'Continue recovered run.' : `Retry recovered task ${d.task_id}.` }));
  const answerFile = join(f.root, 'answers.json'); writeFileSync(answerFile, JSON.stringify(answers));
  execFileSync(process.execPath, [resolve('dist/cli.js'), 'run', 'resume', id, '--answers-file', answerFile, '--json'], { encoding: 'utf8', env: { ...process.env, GBDEV_HOME: f.paths.home, GBDEV_CONFIG: f.paths.config } });
  const done = (await runCommand(f.store, ['wait', id], { 'timeout-ms': '60000', until: 'settled' })).result as Run;
  assert.equal(done.state, 'succeeded', JSON.stringify(done));
  if (phase === 'finalizing') assert.deepEqual(runJobs(f.store, done).filter(j => j.step_instance?.startsWith('run:final_review#')).map(j => j.step_instance).sort(), ['run:final_review#1', 'run:final_review#2']);
  const newJobs = runJobs(f.store, done).filter(j => !oldJobs.has(j.job_id));
  assert.ok(newJobs.length);
  assertOrchestratorNote(readFileSync(jobPaths(f.paths, newJobs[0]!.job_id).prompt, 'utf8'), 'Continue recovered run.');
  for (const answer of answers.filter(a => a.action === 'retry_task')) {
    const job = newJobs.find(j => j.task_id === answer.task_id)!; assert.ok(job);
    assertOrchestratorNote(readFileSync(jobPaths(f.paths, job.job_id).prompt, 'utf8'), answer.note);
  }
  f.invariants(id);
});
