import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Handoff } from '../contracts/handoff.js';
import type { JobResult } from '../contracts/jobResult.js';
import type { RoleDefinition } from '../contracts/role.js';
import { HANDOFF_FIELDS } from '../contracts/workerResult.js';
import { integer, invalid } from '../contracts/validation.js';
import { atomicWriteJson } from '../core/jobStore.js';

export interface HandoffContext {
  pipeline_id: string;
  seq: number;
  instance: string;
  role: string;
  output: RoleDefinition['output'];
  created_at: string;
}

/** Pure projection of a finalized job. Never read the clock, filesystem or role registry. */
export function generateHandoff(result: JobResult, context: HandoffContext): Handoff {
  const worker = result.worker_reported, observed = result.gbdev_observed;
  let truncated = false;
  const clip = (text: string, limit: number): string => {
    if (text.length > limit) truncated = true;
    return text.slice(0, limit);
  };
  const handoff: Handoff = {
    schema: 'gbdev.handoff.v1', pipeline_id: context.pipeline_id, seq: context.seq,
    instance: context.instance, role: context.role, job_id: result.job_id, job_state: result.state,
    failure_reason: result.failure_reason, summary: clip(worker?.summary ?? '', 300),
    decided: [], rejected: [], risks: [], remaining: [],
    files_changed: [...observed.files_changed], commits: [...observed.commits],
    head_before: observed.head_before, head_after: observed.head_after,
    tests: (worker?.tests ?? []).slice(0, 10).map(t => ({ ...t, cmd: clip(t.cmd, 300) })), checks: structuredClone(observed.checks),
    verdict: null, warnings: [...result.worker_result_warnings], truncated: false, created_at: context.created_at,
  };
  for (const issue of observed.workspace_issues ?? []) {
    handoff.warnings.push(`workspace_issue:${issue.code}:${issue.path}`);
  }
  for (const warning of observed.policy_assessment?.warnings ?? []) {
    if (warning.path !== null) handoff.warnings.push(`policy_warning_cleaned:${warning.category}:${warning.path}`);
    if (warning.text) {
      const text = `policy_self_report:${clip(warning.text, 300)}`;
      if (!handoff.warnings.includes(text)) handoff.warnings.push(text);
    }
  }
  for (const item of observed.policy_assessment?.repairable ?? []) {
    handoff.warnings.push(`policy_repair_required:${item.code}:${item.path}`);
  }
  if ((worker?.tests.length ?? 0) > 10) truncated = true;
  for (const key of HANDOFF_FIELDS) {
    const entries = worker?.handoff?.[key] ?? [];
    if (entries.length > 10) truncated = true;
    handoff[key] = entries.slice(0, 10).map(text => clip(text, 300));
  }
  if (context.output === 'verdict' && worker?.review) {
    const review = worker.review;
    // Only the representation normalization required by §6.2; no gate or state transition.
    const inconsistent = review.verdict === 'approve' && review.findings.some(f => f.severity === 'critical' || f.severity === 'major');
    if (inconsistent) handoff.warnings.push('verdict_inconsistent');
    if (review.findings.length > 50) truncated = true;
    handoff.verdict = {
      verdict: inconsistent ? 'revise' : review.verdict,
      findings: [...review.findings].sort((a, b) => ['critical', 'major', 'minor', 'nit'].indexOf(a.severity) - ['critical', 'major', 'minor', 'nit'].indexOf(b.severity)).slice(0, 50).map(f => ({ ...f, message: clip(f.message, 500), file: f.file === null ? null : clip(f.file, 300), suggestion: f.suggestion === null ? null : clip(f.suggestion, 500) })),
      normalized_from: inconsistent ? 'approve' : null,
    };
  }
  handoff.truncated = truncated;
  return handoff;
}

/** Write one generated handoff beneath an explicitly supplied handoffs directory. */
export function writeHandoff(directory: string, handoff: Handoff): string {
  integer(handoff.seq, 'handoff.seq', 1);
  if (!/^[a-z][a-z0-9-]{0,23}#[1-9][0-9]*$/.test(handoff.instance)) invalid('Invalid handoff instance');
  const file = join(directory, `${String(handoff.seq).padStart(2, '0')}-${handoff.instance.replace('#', '-')}.json`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWriteJson(file, handoff);
  return file;
}
