import { createHash } from 'node:crypto';
import type { JobResult } from '../contracts/jobResult.js';
import type { RoleDefinition } from '../contracts/role.js';
import type { RunState } from '../contracts/pipelineRun.js';
import type { Finding } from '../contracts/workerResult.js';
export interface GateResult { rule: string; action: 'advance' | 'settle' | 'fix' | 'retry'; state?: RunState; reason?: string; detail?: string; warnings?: string[] }
export interface GateContext { hasFixLoop?: boolean; kind?: 'step' | 'fix'; verdictRetried?: boolean; attempts?: number; previousFindings?: readonly Finding[]; priorRepairablePaths?: readonly string[] }
export const DECISION_ACTIONS: Record<string, string[]> = {
  needs_input: ['answer'], blocked: ['retry'], max_rounds_exceeded: ['extra_round', 'accept'],
  findings_repeated: ['extra_round', 'accept'], review_rejected: ['extra_round', 'accept'],
  fix_no_changes: ['retry', 'accept'], verdict_missing: ['retry', 'accept'],
  step_failed: ['retry'], step_cancelled: ['retry'], job_budget_exhausted: ['accept'],
  launch_failed: ['retry'], prompt_too_large: ['retry'], workspace_unresolved: ['retry', 'accept'],
};
/** Advertise only structurally available actions; resume still validates saved decisions. */
export function decisionActions(reason: string, hasFixLoop: boolean, maxRounds: number, attempts = 0): string[] {
  return (DECISION_ACTIONS[reason] ?? [])
    .filter(action => action !== 'extra_round' || (hasFixLoop && maxRounds < 5))
    .filter(action => action !== 'retry' || attempts < 3);
}
export function findingsFingerprint(findings: readonly Finding[]): string | null {
  const lines = findings.filter(f => f.severity === 'critical' || f.severity === 'major')
    .map(f => `${f.severity}|${f.file ?? ''}|${f.message.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`).sort();
  return lines.length ? createHash('sha256').update(JSON.stringify(lines)).digest('hex') : null;
}
/** Ordered G1–G13 rules; job facts are never rewritten. */
export function gate(result: JobResult, output: RoleDefinition['output'], pipelineCancelled = false, context: GateContext = {}): GateResult {
  const reason = result.failure_reason ?? '';
  const pause = (rule: string, reason: string, detail?: string): GateResult => ({ rule, action: 'settle', state: 'needs_decision', reason, ...(detail ? { detail } : {}) });
  const missing = (): GateResult => context.verdictRetried || (context.attempts ?? 1) >= 3 ? pause('G9', 'verdict_missing') : { rule: 'G9', action: 'retry' };
  if (result.state === 'cancelled') return pipelineCancelled ? { rule: 'G1', action: 'settle', state: 'cancelled' } : pause('G2', 'step_cancelled');
  if (result.state === 'needs_input') return { rule: 'G3', action: 'settle', state: 'needs_input', reason: 'needs_input' };
  if (result.state === 'blocked') return { rule: 'G4', action: 'settle', state: 'blocked', reason: 'blocked', detail: reason };
  if (result.state === 'failed' && reason !== 'worker_stalled' && (reason === 'workspace_snapshot_invalid' || result.failure_reasons?.includes('workspace_snapshot_invalid'))) return pause('B3', 'step_failed', 'workspace_snapshot_invalid');
  const assessment = result.gbdev_observed.policy_assessment;
  // B4 only repairs the primary policy failure; B3/B7 and other failure facts retain priority.
  if (result.state === 'failed' && reason === 'policy_repair_required' && assessment && assessment.repairable.length && !assessment.fatal.length) {
    return context.hasFixLoop && output === 'change'
      ? { rule: 'B4', action: 'fix', warnings: ['policy_repair_required'] }
      : pause('B4', 'step_failed', 'policy_repair_required');
  }
  if (result.state === 'failed' && reason.startsWith('policy_violations:')) return { rule: 'G5', action: 'settle', state: 'failed', reason };
  if (result.state === 'failed' && reason.startsWith('check_failed:')) return context.hasFixLoop && output === 'change' ? { rule: 'G6', action: 'fix' } : pause('G6', 'step_failed', reason);
  if (result.state !== 'succeeded') {
    // B7: launch/prompt failures pause before G9; never auto-fix or accept.
    if (result.state === 'failed' && (reason === 'launch_failed' || reason === 'prompt_too_large')) {
      return pause('B7', reason, reason);
    }
    if (output === 'verdict' && result.state === 'failed' && (reason === 'worker_result_missing' || reason.startsWith('worker_result_invalid:'))) return missing();
    return pause('G7', 'step_failed', reason);
  }
  const workspaceIssues = result.gbdev_observed.workspace_issues ?? [];
  const blockingIssues = workspaceIssues.filter(i => !i.repairable);
  const repairableIssues = workspaceIssues.filter(i => i.repairable);
  if (output !== 'verdict') {
    // Known repairable residue (including check leftovers) enters the same pipeline fixer before reviewer.
    if (repairableIssues.length && context.hasFixLoop) return { rule: 'B3', action: 'fix' };
    if (workspaceIssues.length) return pause('B3', 'workspace_unresolved', blockingIssues.map(i => i.path).join(', '));
    const unchanged = result.gbdev_observed.head_before === result.gbdev_observed.head_after;
    if (output === 'change' && context.kind === 'fix' && unchanged) {
      const prior = context.priorRepairablePaths ?? [];
      const remaining = new Set([
        ...repairableIssues.map(i => i.path),
        ...(assessment?.repairable ?? []).map(i => i.path),
      ]);
      // Delete-only policy/workspace cleanup may leave HEAD unchanged; advance when prior issues are gone.
      if (prior.length && prior.every(path => !remaining.has(path))) {
        return { rule: 'G8', action: 'advance', warnings: ['fix_workspace_cleaned'] };
      }
      return pause('FIX_NO_CHANGES', 'fix_no_changes');
    }
    return { rule: 'G8', action: 'advance', warnings: output === 'change' && unchanged ? ['step_no_changes'] : [] };
  }
  const review = result.worker_reported?.review;
  if (!review || (review.verdict === 'revise' && !review.findings.length)) return missing();
  if (review.verdict === 'reject') return pause('G12', 'review_rejected');
  const inconsistent = review.verdict === 'approve' && review.findings.some(f => f.severity === 'critical' || f.severity === 'major');
  if (review.verdict === 'revise' || inconsistent) {
    const fingerprint = findingsFingerprint(review.findings);
    const decision = fingerprint && fingerprint === findingsFingerprint(context.previousFindings ?? [])
      ? pause('G11', 'findings_repeated')
      : context.hasFixLoop ? { rule: 'G11', action: 'fix' as const } : pause('G11', 'max_rounds_exceeded');
    return { ...decision, ...(inconsistent ? { rule: 'G10', warnings: ['verdict_inconsistent'] } : {}) };
  }
  // Approve: still cannot deliver with unresolved workspace issues; prefer fixer when repairable.
  if (repairableIssues.length && context.hasFixLoop) return { rule: 'B3', action: 'fix' };
  if (blockingIssues.length || workspaceIssues.length) {
    return pause('B3', 'workspace_unresolved', workspaceIssues.map(i => i.path).join(', '));
  }
  return { rule: 'G13', action: 'advance' };
}
