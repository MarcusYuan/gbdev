import { matchesAllowed } from './glob.js';
import type { TaskBrief } from '../contracts/brief.js';
import { parsePolicyIncidents, type WorkerResult } from '../contracts/workerResult.js';
import {
  snapshotEntryMap, WORKSPACE_AFTER_WORKER, WATCHED_EXTRA_PATHS,
  type WorkspaceEntry, type WorkspaceIssue, type WorkspaceSnapshot,
} from './workspaceSnapshot.js';

// Legacy repair/snapshot sentinel; WATCHED_EXTRA_PATHS is not a glob list.
export const POLICY_WHITELIST_PATH = WATCHED_EXTRA_PATHS[0];
export const POLICY_WHITELIST_PATTERNS = ['.omc/**', '**/.omc', '**/.omc/**'];
export const isPolicyWhitelistPath = (path: string): boolean => matchesAllowed(path, POLICY_WHITELIST_PATTERNS);
export const POLICY_WHITELIST_CATEGORY = 'temporary_workspace_file' as const;
export const POLICY_REPAIR_CODE = 'policy_temporary_residue';

export interface PolicyWarning {
  violation_index: number;
  category: string;
  path: string | null;
  evidence_ref: string;
  text?: string;
  reason?: string;
}

export interface PolicyRepairable {
  code: string;
  path: string;
  owner_job_id: string;
  evidence_ref: string;
  content_hash?: string | null;
}

export interface PolicyAssessment {
  policy_version: 1;
  warnings: PolicyWarning[];
  repairable: PolicyRepairable[];
  fatal: string[];
}

export interface AssessPolicyInput {
  sandbox: TaskBrief['sandbox'];
  jobId: string;
  observedViolations: readonly string[];
  outsideAllowedPaths: readonly string[];
  reported: WorkerResult | null;
  /** Normalization evidence survives removal of malformed incident objects. */
  reportedWarnings?: readonly string[];
  baseline?: WorkspaceSnapshot;
  afterWorker?: WorkspaceSnapshot;
  /** Paths touched in any commit from the job baseline through current HEAD. */
  committedPaths?: readonly string[];
  /** Live no-follow residue check also covers ignored paths absent from git snapshots. */
  remainingIncidentPaths?: readonly string[];
}

function entryPresent(entry: WorkspaceEntry | undefined): boolean {
  return !!entry && (entry.kind === 'file' || entry.kind === 'symlink' || (entry.kind === 'other' && entry.mode !== 0));
}

function isWhitelistResidue(entry: WorkspaceEntry | undefined): entry is WorkspaceEntry {
  return !!entry && entry.kind === 'file' && entry.index_state.untracked && !entry.index_state.staged;
}

function isDisallowedWhitelistShape(entry: WorkspaceEntry | undefined): boolean {
  if (!entryPresent(entry)) return false;
  if (entry!.kind === 'symlink' || entry!.kind === 'other') return true;
  if (entry!.kind === 'file' && !entry!.index_state.untracked) return true;
  return false;
}

/**
 * Classify self reports for all sandbox modes; repair only workspace-write residue.
 * Absent assessment callers keep legacy finalOutcome behavior.
 */
export function assessPolicy(input: AssessPolicyInput): PolicyAssessment {
  const warnings: PolicyWarning[] = [];
  const repairable: PolicyRepairable[] = [];
  const fatal: string[] = [];
  const empty: PolicyAssessment = { policy_version: 1, warnings, repairable, fatal };

  if (!input.baseline || !input.afterWorker) {
    fatal.push(...input.observedViolations);
    if (input.reported?.policy_violations.length) fatal.push(...input.reported.policy_violations);
    return empty;
  }

  const before = snapshotEntryMap(input.baseline);
  const after = snapshotEntryMap(input.afterWorker);
  const committed = new Set(input.committedPaths ?? []);
  const reportedViolations = input.reported?.policy_violations ?? [];
  const incidentWarnings = [...(input.reportedWarnings ?? [])];
  const incidents = input.reported?.policy_incidents === undefined ? [] :
    parsePolicyIncidents(input.reported.policy_incidents, reportedViolations.length, incidentWarnings);
  const invalidIncidents = incidentWarnings.some(w => /^policy_incidents(?:\[\d+\])?: ignored invalid /.test(w));
  if (invalidIncidents) fatal.push('invalid_policy_incidents');
  const explainedReported = new Set<number>();
  const explainedOutside = new Set<string>();

  // A self report alone is not machine evidence. Keep baseline ownership and commit
  // guards, and check descendants when the incident names a directory.
  const presentUnder = (entries: Map<string, WorkspaceEntry>, path: string) =>
    [...entries].some(([name, entry]) => (name === path || name.startsWith(`${path}/`)) && entryPresent(entry));
  if (!invalidIncidents && !input.observedViolations.length && !input.outsideAllowedPaths.length) {
    for (const [index, text] of reportedViolations.entries()) {
      const linked = incidents.filter(i => i.violation_index === index);
      if (!linked.every(i => i.cleaned && !input.remainingIncidentPaths?.includes(i.path) && !presentUnder(after, i.path) && !presentUnder(before, i.path)
        && ![...committed].some(path => path === i.path || path.startsWith(`${i.path}/`)))) continue;
      warnings.push({ violation_index: index, category: linked[0]?.category ?? 'self_report',
        path: linked[0]?.path ?? null, evidence_ref: WORKSPACE_AFTER_WORKER, text: text.slice(0, 300),
        reason: linked.length ? 'cleaned_without_observed_violation' : 'self_report_without_observed_violation' });
      explainedReported.add(index);
    }
  }

  for (const incident of incidents) {
    if (input.sandbox !== 'workspace-write' || incident.cleaned || !isPolicyWhitelistPath(incident.path)) continue;
    if (entryPresent(before.get(incident.path))) continue;
    if (committed.has(incident.path)) continue;
    const afterEntry = after.get(incident.path);
    // cleaned:false — only repairable when residue matches the narrow whitelist shape.
    if (!isWhitelistResidue(afterEntry)) continue;
    repairable.push({
      code: POLICY_REPAIR_CODE,
      path: incident.path,
      owner_job_id: input.jobId,
      evidence_ref: WORKSPACE_AFTER_WORKER,
      content_hash: afterEntry.content_hash,
    });
    explainedReported.add(incident.violation_index);
    explainedOutside.add(incident.path);
  }

  // Machine-observed whitelist residue and inherited cleanup retain B4 ownership guards.
  for (const path of new Set([...before.keys(), ...after.keys()].filter(isPolicyWhitelistPath))) {
    const leftover = after.get(path);
    const baselineEntry = before.get(path);
    if (input.sandbox === 'workspace-write' && !entryPresent(baselineEntry) && !committed.has(path)) {
      if (isWhitelistResidue(leftover) && !repairable.some(item => item.path === path)) {
        repairable.push({
          code: POLICY_REPAIR_CODE,
          path,
          owner_job_id: input.jobId,
          evidence_ref: WORKSPACE_AFTER_WORKER,
          content_hash: leftover.content_hash,
        });
        explainedOutside.add(path);
      } else if (isDisallowedWhitelistShape(leftover)) {
        // Symlink / tracked / non-file shapes stay fatal; narrow repair scope does not apply.
        explainedOutside.delete(path);
      }
    } else if (input.sandbox === 'workspace-write' && isWhitelistResidue(baselineEntry) && !entryPresent(leftover) && !committed.has(path)) {
      // Fixer (or worker) deleted an inherited whitelist temp file — attribute the cleanup, do not fail.
      explainedOutside.add(path);
    }
  }

  for (const code of input.observedViolations) {
    if (code === 'outside_allowed_paths') {
      const unexplained = input.outsideAllowedPaths.filter(path => !explainedOutside.has(path));
      // All outside paths explained by cleaned warning, repairable residue, or successful cleanup.
      if (unexplained.length === 0 && explainedOutside.size > 0) continue;
      if (input.outsideAllowedPaths.length === 0 && explainedOutside.size > 0) continue;
    }
    if (!fatal.includes(code)) fatal.push(code);
  }

  for (const [index, text] of reportedViolations.entries()) {
    if (explainedReported.has(index) && incidents.filter(i => i.violation_index === index).every(i =>
      i.cleaned ? warnings.some(w => w.violation_index === index) : repairable.some(r => r.path === i.path))) continue;
    if (!fatal.includes(text)) fatal.push(text);
  }

  // Mixed fatal + repairable: keep both recorded; callers must not auto-fix.
  return { policy_version: 1, warnings, repairable, fatal };
}

export function policyRepairWorkspaceIssues(assessment: PolicyAssessment): WorkspaceIssue[] {
  return assessment.repairable.map(item => ({
    code: item.code,
    path: item.path,
    owner_job_id: item.owner_job_id,
    source_phase: 'worker' as const,
    repairable: true,
  }));
}
