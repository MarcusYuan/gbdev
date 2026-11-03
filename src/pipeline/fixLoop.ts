import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineDefinition } from '../contracts/pipeline.js';
import type { PipelineRun, PipelineStep } from '../contracts/pipelineRun.js';
import type { Finding } from '../contracts/workerResult.js';
import { JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { captureWorkspaceSnapshotSync, snapshotEntryMap } from '../core/workspaceSnapshot.js';
import { POLICY_REPAIR_CODE, isPolicyWhitelistPath } from '../core/policy.js';
import { optionalText } from '../core/runtime.js';
import { pipelinePaths, readSnapshot, stepResult } from './store.js';
export function readDefinition(store: JobStore, id: string): PipelineDefinition {
  return JSON.parse(readFileSync(pipelinePaths(store, id).definition, 'utf8')) as PipelineDefinition;
}
export function fixInput(store: JobStore, step: PipelineStep): { findings: Finding[]; logs: { id: string; text: string }[] } {
  const last = step.attempts.at(-1);
  if (!last) return { findings: [], logs: [] };
  const result = stepResult(store, last.job_id);
  const checks = result.gbdev_observed.checks.filter(c => c.exit_code !== 0);
  const checkFindings: Finding[] = [];
  const logs: { id: string; text: string }[] = [];
  if (result.failure_reason?.startsWith('check_failed:')) {
    // Deduplicate shared physical executions by execution_id; legacy records without it stay 1:1.
    const seenExec = new Set<string>();
    let findingIndex = 0;
    for (const check of checks) {
      const execKey = check.execution_id ?? `solo:${check.id}`;
      if (seenExec.has(execKey)) continue;
      seenExec.add(execKey);
      const group = check.execution_id
        ? checks.filter(c => c.execution_id === check.execution_id)
        : [check];
      const ids = group.map(c => c.id);
      findingIndex += 1;
      const catalogIds = [...new Set(group.map(c => c.check_id ?? c.id))];
      const label = catalogIds.join(', ');
      const shaNote = check.checked_sha ? ` (checked_sha=${check.checked_sha})` : '';
      checkFindings.push({
        id: `C${findingIndex}`, severity: 'major', file: null, line: null,
        message: ids.length > 1
          ? `checks ${label} failed: ${check.cmd} exited ${check.exit_code}${shaNote}`
          : `check ${label} failed: ${check.cmd} exited ${check.exit_code}${shaNote}`,
        suggestion: null,
      });
      const text = (optionalText(join(jobPaths(store.paths, last.job_id).dir, check.log)) ?? '')
        .replace(/\n$/, '').split('\n').slice(-80).join('\n');
      logs.push({ id: catalogIds.join(','), text });
    }
  }
  const policyIssues = result.gbdev_observed.policy_assessment?.repairable ?? [];
  const policyPaths = new Set(policyIssues.map(i => i.path));
  const workspaceFindings = (result.gbdev_observed.workspace_issues ?? []).filter(i => i.repairable && !policyPaths.has(i.path)).map((i, n) => ({
    id: `W${n + 1}`, severity: 'major' as const, file: i.path === '*' ? null : i.path, line: null,
    message: `workspace ${i.code}${i.path === '*' ? '' : `: ${i.path}`}`, suggestion: null,
  }));
  const policyFindings = policyIssues
    .map((i, n) => ({
      id: `P${n + 1}`, severity: 'major' as const, file: i.path, line: null,
      message: `policy repair scope: delete untracked file ${i.path} only (hash=${i.content_hash ?? 'unknown'})`,
      suggestion: `Delete only ${i.path} if it remains an untracked regular file; do not modify other paths.`,
    }));
  return {
    findings: [...checkFindings, ...(result.worker_reported?.review?.findings ?? []), ...workspaceFindings, ...policyFindings],
    logs: checkFindings.length ? logs : [],
  };
}
/** Revalidate recorded residue immediately before creating a fixer; never widen allowed_paths. */
export function policyRepairMismatch(store: JobStore, source: PipelineStep, worktree: string): string | null {
  const jobId = source.attempts.at(-1)?.job_id;
  if (!jobId) return null;
  const issues = stepResult(store, jobId).gbdev_observed.policy_assessment?.repairable ?? [];
  if (!issues.length) return null;
  try {
    const current = snapshotEntryMap(captureWorkspaceSnapshotSync(worktree, { job_id: jobId, phase: 'after_worker' }));
    for (const issue of issues) {
      const entry = current.get(issue.path);
      if (!isPolicyWhitelistPath(issue.path) || issue.code !== POLICY_REPAIR_CODE || !issue.content_hash ||
          !entry || entry.kind !== 'file' || entry.content_unknown || !entry.index_state.untracked || entry.index_state.staged ||
          entry.content_hash !== issue.content_hash) return `policy_repair_scope_mismatch: ${issue.path}`;
    }
    return null;
  } catch { return 'policy_repair_scope_mismatch: workspace evidence unavailable'; }
}
/** Mutates the run under its global lock; preserves every historical instance. */
export function insertFix(store: JobStore, run: PipelineRun, source: PipelineStep): void {
  const loop = readDefinition(store, run.pipeline_id).fix_loop!;
  const snapshot = readSnapshot(store, run.pipeline_id);
  const create = (id: string, kind: PipelineStep['kind']): PipelineStep => {
    const role = snapshot.steps[id]!;
    const n = run.steps.filter(s => s.step_id === id).length + 1;
    return { instance: `${id}#${n}`, step_id: id, kind, role: role.role, provider: role.provider, sandbox: role.sandbox,
      state: 'pending', round: run.round, attempts: [], gate: null, verdict: null, head_before: null, head_after: null, handoff: null, started_at: null, finished_at: null };
  };
  run.round++;
  const index = run.steps.indexOf(source), fix = create('fix', 'fix');
  // §7.4: only a failed fix reuses its already-pending re-review; preserve the linear suffix.
  const waitingReview = source.kind === 'fix' ? run.steps.slice(index + 1).find(s => s.step_id === loop.after && s.state === 'pending') : undefined;
  run.steps.splice(index + 1, 0, fix, ...(waitingReview ? [] : [create(loop.after, 'step')]));
  if (waitingReview) waitingReview.round = run.round;
}
