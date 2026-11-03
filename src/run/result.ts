import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../contracts/run.js';
import type { RunRequest } from '../contracts/runRequest.js';
import type { MergeRecord } from '../contracts/mergeRecord.js';
import { validateRunResult, type RunResult } from '../contracts/runResult.js';
import type { PipelineResult } from '../contracts/pipelineResult.js';
import { atomicWriteJson, atomicWriteText, JobStore } from '../core/jobStore.js';
import { git } from '../core/git.js';
import { optionalText } from '../core/runtime.js';
import { pipelinePaths } from '../pipeline/store.js';
import { jsonFile, runPaths } from './store.js';
export function mergeRecords(store: JobStore, run: Run): MergeRecord[] {
  return readdirSync(runPaths(store, run.run_id).merges).filter(n => /^\d+\.json$/.test(n)).map(n => jsonFile<MergeRecord>(join(runPaths(store, run.run_id).merges, n))).sort((a, b) => a.seq - b.seq);
}
export function writeResult(store: JobStore, run: Run, request: RunRequest): RunResult {
  const paths = runPaths(store, run.run_id), range = `${run.base_sha}..${run.integration.verified_sha}`;
  atomicWriteText(paths.diff, git(run.repo, ['diff', '--binary', range, '--']));
  const stats = git(run.repo, ['diff', '--numstat', range, '--']).trim().split('\n').filter(Boolean).map(l => l.split('\t'));
  const final = join(paths.dir, 'final-review.json'), finalGate = join(paths.dir, 'final-gate.json');
  const result: RunResult = {
    schema: 'gbdev.run-result.v1', run_id: run.run_id, state: run.state as RunResult['state'], outcome: run.outcome, repo: run.repo, base_sha: run.base_sha,
    integration_branch: run.integration.branch, integration_sha: run.integration.verified_sha,
    diff_stat: { files: stats.length, insertions: stats.reduce((n, s) => n + (Number(s[0]) || 0), 0), deletions: stats.reduce((n, s) => n + (Number(s[1]) || 0), 0) },
    commits: git(run.repo, ['log', '--format=%H%x00%s', range]).trim().split('\n').filter(Boolean).map(l => { const [sha, subject] = l.split('\0'); return { sha: sha!, subject: subject! }; }),
    tasks: run.tasks.map(t => {
      const p = t.attempts.at(-1), path = p ? pipelinePaths(store, p.pipeline_id).result : '';
      const result = path && existsSync(path) ? jsonFile<PipelineResult>(path) : null;
      return { task_id: t.task_id, state: t.state, merged_sha: t.merged_sha, pipelines: t.attempts.map(a => a.pipeline_id), review: result?.final_verdict ? { verdict: result.final_verdict.verdict, unresolved_findings: result.final_verdict.open_findings } : null, scope_exceeded: t.scope_exceeded, summary: result?.steps.map(s => s.summary).filter(Boolean).join('\n') ?? '' };
    }), dropped_tasks: run.tasks.filter(t => t.state === 'dropped').map(t => t.task_id),
    merges: mergeRecords(store, run).map(m => ({ seq: m.seq, task_id: m.task_id, result: m.result, conflict: !m.precheck.clean, gate_passed: m.gate?.passed ?? false })),
    final_gate: existsSync(finalGate) ? jsonFile(finalGate) : null, final_review: existsSync(final) ? jsonFile(final) : null,
    acceptance_criteria: request.acceptance_criteria.map(c => ({ id: c.id, check: c.check, passed: c.check && run.state === 'succeeded' ? true : null })), decisions: (optionalText(join(paths.dir, 'decisions.jsonl')) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(d => d.type === 'resolved').map(({ type: _type, ...d }) => d),
    landing: { eligible: run.state === 'succeeded', target_hint: run.base_ref, landed_sha: run.integration.landed_sha }, artifacts: { diff: paths.diff, events: paths.events, merges_dir: paths.merges }, warnings: run.warnings,
  };
  atomicWriteJson(paths.result, validateRunResult(result)); return result;
}
