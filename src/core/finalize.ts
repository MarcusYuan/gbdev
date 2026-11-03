import { checkNotifyExposure } from '../notify/exposure.js';
import { readFileSync, readdirSync, lstatSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TaskBrief } from '../contracts/brief.js';
import { type JobState, type JobStatus } from '../contracts/jobStatus.js';
import { type JobResult, validateJobResult } from '../contracts/jobResult.js';
import { extractWorkerResult, type WorkerResult } from '../contracts/workerResult.js';
import { GbdevError } from '../contracts/error.js';
import { buildEvidencePack } from '../inspect/evidence.js';
import { RAW_OUTPUT_MAX } from '../inspect/limits.js';
import { type InspectionRequest } from '../inspect/lifecycle.js';
import { validateAndNormalizeInspection } from '../inspect/result.js';
import { releaseInspectReservation } from './workerReservations.js';
import { providerRateLimit } from './providerRateLimit.js';
import { providerFailureReason } from '../providers/cursor.js';
import { providerSessionId } from '../providers/index.js';
import { criteriaFromBrief, runJobChecks } from './checks.js';
import { changedFiles, committedPaths, dirtyFiles, git, head, isDirty } from './git.js';
import {
  baselineHasInheritedStaged, buildCheckPhaseIssues, buildInheritedWorkspaceIssues,
  captureWorkspaceSnapshot, captureWorkspaceSnapshotSync, jobFilesChanged, readWorkspaceSnapshot, workerAttributedPaths, WORKSPACE_AFTER_CHECKS, WORKSPACE_AFTER_WORKER, WORKSPACE_BEFORE,
  type WorkspaceIssue, type WorkspaceSnapshot,
} from './workspaceSnapshot.js';
import { assessPolicy, policyRepairWorkspaceIssues, isPolicyWhitelistPath, type PolicyAssessment } from './policy.js';
import { matchesAllowed } from './glob.js';
import { atomicWriteJson, JobStore } from './jobStore.js';
import { jobPaths } from './paths.js';
import { event, locked, optionalText, transition } from './runtime.js';
import { pipelinePaths } from '../pipeline/store.js';
import { runPaths } from '../run/store.js';

/** Use persisted owner deadlines, not fresh timeouts that would reset their budgets. */
function taskChecksDeadline(store: JobStore, status: JobStatus): number {
  const deadlines = [Date.parse(status.deadline_at)];
  let runId = status.run_id;
  if (status.pipeline_id) {
    const raw = optionalText(pipelinePaths(store, status.pipeline_id).run);
    if (raw !== null) {
      const pipeline = JSON.parse(raw) as { deadline_at: string; workspace?: { run_id?: string } };
      deadlines.push(Date.parse(pipeline.deadline_at));
      runId ??= pipeline.workspace?.run_id;
    }
  }
  if (runId) {
    const raw = optionalText(runPaths(store, runId).run);
    if (raw !== null) deadlines.push(Date.parse((JSON.parse(raw) as { deadline_at: string }).deadline_at));
  }
  return Math.min(...deadlines.filter(Number.isFinite));
}

/** Do not follow symlink ancestors when checking ignored incident paths.
 * Empty directories are intentionally not residue (git snapshots cannot represent them).
 */
function incidentRemains(worktree: string, path: string): boolean {
  let current = worktree;
  const parts = path.split('/');
  try {
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return true;
      if (index === parts.length - 1) return !stat.isDirectory() || readdirSync(current).length > 0;
      if (!stat.isDirectory()) return true;
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true; // Unreadable is not proof of cleanup.
  }
}

export type ForcedState = 'timeout' | 'cancelled' | 'failed' | 'worker_stalled';

/** SPEC §8.7: select state and reason together so lower-priority facts cannot overwrite either. */
export function finalOutcome(exitCode: number | null, reported: WorkerResult | null, violations: string[], forced?: ForcedState,
  checks: { id: string; exit_code: number | null }[] = [], providerFailure: string | null = null,
  reportFailure = 'worker_result_missing', readOnlyDelivery = false, readOnly = false, workerClosed = true,
  assessment?: PolicyAssessment | null): {
    state: JobState; failure_reason: string | null; failure_reasons: string[];
  } {
  // Normal finalization callers supply a completed exit; recovery explicitly marks unknown/unclosed workers.
  // Collect every matching §8.7 3x/4 fact even when forced/worker signals take priority.
  const reasons: string[] = [];
  if (providerFailure) reasons.push(providerFailure);
  if (workerClosed && exitCode !== 0) reasons.push(`worker_exit_nonzero:${exitCode}`);
  if (reportFailure === 'workspace_snapshot_invalid' || reported === null) reasons.push(reportFailure);
  if (assessment) {
    // Assessed path: do not re-add downgraded raw strings; repairable becomes policy_repair_required.
    if (assessment.fatal.length) reasons.push(`policy_violations: ${assessment.fatal.join(', ')}`);
  } else {
    if (violations.length) reasons.push(`policy_violations: ${violations.join(', ')}`);
    if (reported?.policy_violations.length) reasons.push(`policy_violations: ${reported.policy_violations.join(', ')}`);
  }
  if (reported?.status === 'failed') reasons.push('worker_reported_failed');
  if (assessment && !assessment.fatal.length && assessment.repairable.length) reasons.push('policy_repair_required');
  const failedChecks = checks.filter(check => check.exit_code !== 0);
  for (const check of failedChecks) reasons.push(`check_failed:${check.id}`);
  if (reportFailure === 'workspace_snapshot_invalid' && !preservesForcedCause(forced)) return { state: 'failed', failure_reason: reportFailure, failure_reasons: reasons };
  if (forced) return { state: forced === 'worker_stalled' ? 'failed' : forced,
    failure_reason: forced === 'cancelled' ? null : forced === 'timeout' || forced === 'worker_stalled' ? forced : 'worker_crashed',
    failure_reasons: reasons };
  if (reported?.status === 'needs_input') return { state: 'needs_input', failure_reason: null, failure_reasons: reasons };
  if (reported?.status === 'blocked') return { state: 'blocked',
    failure_reason: `worker_blocked: ${reported.blockers.map(x => x.detail).join('; ') || 'no detail'}`, failure_reasons: reasons };
  let reason = reasons[0] ?? null;
  if (readOnlyDelivery && reasons.length === 1 && reason === 'worker_result_missing') reason = null;
  // Missing prose-report JSON must not conceal a real failed read-only check.
  // Invalid JSON, provider/exit failures and policies retain their original precedence.
  if (readOnly && reported === null && reportFailure === 'worker_result_missing' &&
      !providerFailure && exitCode === 0 && violations.length === 0 && failedChecks.length > 0) {
    reason = `check_failed:${failedChecks[0]!.id}`;
  }
  return { state: reason ? 'failed' : 'succeeded', failure_reason: reason, failure_reasons: reason ? reasons : [] };
}

export function finalState(exitCode: number | null, reported: WorkerResult | null, violations: string[], forced?: ForcedState,
  checks: { id: string; exit_code: number | null }[] = [], providerFailure: string | null = null): JobState {
  return finalOutcome(exitCode, reported, violations, forced, checks, providerFailure).state;
}

export function emptyResult(store: JobStore, status: JobStatus, exitCode: number | null): JobResult {
  const paths = jobPaths(store.paths, status.job_id);
  return {
    schema: 'gbdev.job-result.v1', job_id: status.job_id, session_id: status.session_id ?? null, state: 'failed', worker_exit_code: exitCode,
    duration_s: Math.max(0, (Date.now() - Date.parse(status.created_at)) / 1000), worker_reported: null, worker_result_warnings: [], failure_reason: 'worker_crashed', failure_reasons: [],
    gbdev_observed: { head_before: status.base_sha, head_after: status.base_sha, commits: [], files_changed: [],
      outside_allowed_paths: [], worktree_dirty_at_exit: false, snapshot_commit: null, checks: [], policy_violations: [] },
    paths: { final_message: paths.finalMessage, diff: paths.diff, events: paths.events, worker_log: paths.workerLog },
  };
}

function applyJobPolicyFromDelta(observed: JobResult['gbdev_observed'], brief: TaskBrief, baseSha: string, jobDelta: string[]): void {
  observed.job_files_changed = [...jobDelta].sort();
  observed.outside_allowed_paths = jobDelta.filter(file => !matchesAllowed(file, brief.allowed_paths));
  if (observed.outside_allowed_paths.length) observed.policy_violations.push('outside_allowed_paths');
  if (brief.sandbox === 'read-only' && (observed.head_after !== baseSha || jobDelta.length > 0)) {
    observed.policy_violations.push('readonly_modified');
  }
}

function recordFactualGit(store: JobStore, status: JobStatus, result: JobResult, baseSha: string): void {
  const observed = result.gbdev_observed;
  observed.head_after = head(status.worktree);
  observed.commits = git(status.worktree, ['log', '--format=%h %s', `${baseSha}..HEAD`, '--']).trim().split('\n').filter(Boolean);
  observed.files_changed = [...new Set([...changedFiles(status.worktree, baseSha), ...dirtyFiles(status.worktree)])].sort();
  writeFileSync(jobPaths(store.paths, status.job_id).diff, git(status.worktree, ['diff', '--binary', '--no-ext-diff', baseSha, 'HEAD', '--']));
}

function observeGit(store: JobStore, status: JobStatus, brief: TaskBrief, result: JobResult, baseline?: WorkspaceSnapshot, afterWorker?: WorkspaceSnapshot): void {
  recordFactualGit(store, status, result, status.base_sha);
  const observed = result.gbdev_observed;
  if (baseline && afterWorker) {
    observed.workspace_baseline = WORKSPACE_BEFORE;
    observed.inherited_dirty_paths = [...baseline.inherited_dirty_paths].sort();
    applyJobPolicyFromDelta(observed, brief, baseline.head_sha, workerAttributedPaths(baseline, afterWorker, status.worktree));
  } else if (status.kind === 'inspect') {
    observed.outside_allowed_paths = observed.files_changed.filter(file => !matchesAllowed(file, brief.allowed_paths));
    if (observed.outside_allowed_paths.length) observed.policy_violations.push('outside_allowed_paths');
    if (brief.sandbox === 'read-only' && (observed.head_after !== status.base_sha || observed.worktree_dirty_at_exit)) observed.policy_violations.push('readonly_modified');
  }
}

async function observeGitAsync(store: JobStore, status: JobStatus, brief: TaskBrief, result: JobResult, signal: AbortSignal, baseline?: WorkspaceSnapshot, afterWorker?: WorkspaceSnapshot): Promise<void> {
  const observed = result.gbdev_observed;
  observed.head_after = (await git(status.worktree, ['rev-parse', 'HEAD'], 120_000, signal)).trim();
  observed.commits = (await git(status.worktree, ['log', '--format=%h %s', `${status.base_sha}..HEAD`, '--'], 120_000, signal)).trim().split('\n').filter(Boolean);
  observed.files_changed = [...new Set([...(await git(status.worktree, ['diff', '--name-only', '--no-renames', '-z', status.base_sha, '--'], 120_000, signal)).split('\0'), ...(await git(status.worktree, ['ls-files', '--others', '--exclude-standard', '-z'], 120_000, signal)).split('\0')].filter(Boolean))].sort();
  writeFileSync(jobPaths(store.paths, status.job_id).diff, await git(status.worktree, ['diff', '--binary', '--no-ext-diff', status.base_sha, 'HEAD', '--'], 120_000, signal));
  if (baseline && afterWorker) {
    observed.workspace_baseline = WORKSPACE_BEFORE;
    observed.inherited_dirty_paths = [...baseline.inherited_dirty_paths].sort();
    applyJobPolicyFromDelta(observed, brief, baseline.head_sha, workerAttributedPaths(baseline, afterWorker, status.worktree));
  } else if (status.kind === 'inspect') {
    observed.outside_allowed_paths = observed.files_changed.filter(file => !matchesAllowed(file, brief.allowed_paths));
    if (observed.outside_allowed_paths.length) observed.policy_violations.push('outside_allowed_paths');
    if (brief.sandbox === 'read-only' && (observed.head_after !== status.base_sha || observed.worktree_dirty_at_exit)) observed.policy_violations.push('readonly_modified');
  }
}

function mergeWorkspaceIssues(...groups: WorkspaceIssue[][]): WorkspaceIssue[] {
  const seen = new Set<string>(), out: WorkspaceIssue[] = [];
  for (const group of groups) for (const issue of group) {
    const key = `${issue.code}|${issue.path}|${issue.repairable}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function snapshotOptions(status: JobStatus) {
  // The worker is already reaped: allow bounded evidence cleanup after cancel/deadline.
  // Cancellation must not itself manufacture missing evidence or erase the terminal reason.
  return { deadlineAt: Math.max(Date.parse(status.deadline_at), Date.now() + 5_000) };
}
function preservesForcedCause(forced?: ForcedState): boolean {
  return forced === 'cancelled' || forced === 'timeout' || forced === 'worker_stalled';
}
function snapshotFailure(result: JobResult, forced?: ForcedState): void {
  if (!preservesForcedCause(forced)) {
    result.state = 'failed';
    result.failure_reason = 'workspace_snapshot_invalid';
  }
  result.failure_reasons = [...new Set([...(result.failure_reasons ?? []), 'workspace_snapshot_invalid'])];
}

async function loadBaselineAndAfterWorker(
  status: JobStatus, paths: ReturnType<typeof jobPaths>,
): Promise<{ baseline?: WorkspaceSnapshot; afterWorker?: WorkspaceSnapshot; snapshotError?: string }> {
  if (status.kind === 'merge_resolution' || status.kind === 'inspect') return {};
  const baselineFile = join(paths.dir, WORKSPACE_BEFORE);
  let baseline: WorkspaceSnapshot | undefined;
  try { baseline = readWorkspaceSnapshot(baselineFile, { job_id: status.job_id, phase: 'before_worker' }); }
  catch { return { snapshotError: 'workspace_snapshot_invalid' }; }
  try {
    const afterWorker = await captureWorkspaceSnapshot(status.worktree, {
      job_id: status.job_id, phase: 'after_worker', previous_job_id: baseline?.previous_job_id ?? null,
    }, snapshotOptions(status));
    atomicWriteJson(join(paths.dir, WORKSPACE_AFTER_WORKER), afterWorker);
    jobFilesChanged(baseline, afterWorker); // Reject unknown evidence before attribution or snapshot.
    return { baseline, afterWorker };
  } catch {
    return { baseline, snapshotError: 'workspace_snapshot_invalid' };
  }
}

function workerSchemaOptions(dir: string): { inspection?: boolean; policyIncidents?: boolean } {
  try { return JSON.parse(optionalText(join(dir, 'provider.json')) ?? '{}').schema_options ?? {}; }
  catch { return {}; }
}

function outputBytes(dir: string): number {
  const size = (name: string) => { try { return statSync(join(dir, name)).size; } catch { return 0; } };
  return size('raw.jsonl') + size('raw.json') + size('worker.log');
}

function applyInspect(store: JobStore, status: JobStatus, result: JobResult, dir: string, forced?: ForcedState): void {
  const candidate = result.worker_reported?.inspection;
  if (result.worker_reported) delete result.worker_reported.inspection;
  const oversize = existsSync(join(dir, 'inspect-output-limit.json')) || outputBytes(dir) >= RAW_OUTPUT_MAX;
  // Cancel/timeout/stall/crash terminals must not be promoted by a valid candidate.
  const terminalForced = forced === 'cancelled' || forced === 'timeout' || forced === 'worker_stalled' || forced === 'failed'
    || result.state === 'cancelled' || result.state === 'timeout';
  if (oversize) {
    result.inspection = null;
    // Oversize wins even when the supervisor also recorded a crash after killing the PG.
    if (forced !== 'cancelled' && result.state !== 'cancelled') {
      result.state = 'failed';
      result.failure_reason = 'inspect_output_too_large';
      result.failure_reasons = [...new Set([...(result.failure_reasons ?? []), 'inspect_output_too_large'])];
    }
    return;
  }
  if (terminalForced) {
    result.inspection = null;
    return;
  }
  const dirty = result.gbdev_observed.worktree_dirty_at_exit || result.gbdev_observed.head_after !== status.base_sha ||
    result.gbdev_observed.policy_violations.includes('readonly_modified');
  if (dirty || result.gbdev_observed.policy_violations.length) {
    result.inspection = null;
    if (result.state === 'succeeded' || result.state === 'needs_input' || result.state === 'blocked') {
      result.state = 'failed';
      result.failure_reason = result.failure_reason ?? 'policy_violations: readonly_modified';
      const reasons = result.failure_reasons ?? [];
      if (!reasons.includes(result.failure_reason)) result.failure_reasons = [...reasons, result.failure_reason];
    }
    return;
  }
  if (result.state === 'needs_input' || result.state === 'blocked') {
    result.inspection = null;
    return;
  }
  try {
    const request = JSON.parse(readFileSync(join(dir, 'inspection.request.json'), 'utf8')) as InspectionRequest;
    const resolved = {
      repo: request.repo, source_branch: request.source_branch, source_worktree: request.source_worktree,
      target: request.target, target_sha: request.snapshot.target_sha, diff_base_sha: request.snapshot.diff_base_sha,
      warnings: request.warnings,
    };
    const evidence = buildEvidencePack(store, status.worktree, resolved, request.paths ?? [], !!request.diff, !!request.tests);
    const normalized = validateAndNormalizeInspection(candidate, evidence, resolved, {
      job_id: status.job_id, worktree: status.worktree, paths: request.paths ?? [], captured_at: request.snapshot.captured_at,
    });
    // Only an already successful completion may publish an inspection.
    if (result.state === 'succeeded') {
      result.inspection = normalized;
      result.state = 'succeeded';
      result.failure_reason = null;
      result.failure_reasons = [];
    } else {
      result.inspection = null;
    }
  } catch (error) {
    result.inspection = null;
    if (result.state === 'cancelled' || result.state === 'timeout') return;
    result.state = 'failed';
    const code = error instanceof GbdevError && error.contract.code === 'inspect_output_too_large' ? 'inspect_output_too_large' : 'inspect_result_invalid';
    result.failure_reason = code;
    result.failure_reasons = [code];
  }
}

/** Best-effort facts on supervisor loss; never invent a successful worker report. Caller holds the lock. */
export function failureResult(store: JobStore, status: JobStatus, exitCode: number | null, workerClosed = false): JobResult {
  // The supervisor may have flushed stdout without publishing its metadata yet.
  // Callers persist this same status object when publishing the failed state.
  status.session_id ??= providerSessionId(status.provider, jobPaths(store.paths, status.job_id).dir);
  const result = emptyResult(store, status, exitCode);
  const paths = jobPaths(store.paths, status.job_id);
  let reportFailure = 'worker_result_missing';
  try { result.worker_reported = extractWorkerResult(optionalText(paths.finalMessage) ?? '', result.worker_result_warnings, workerSchemaOptions(paths.dir)); }
  catch (error) {
    if (error instanceof GbdevError && error.contract.code === 'result_invalid') reportFailure = `worker_result_invalid: ${error.message}`;
  }
  try {
    const brief = JSON.parse(optionalText(paths.brief) ?? '{}') as TaskBrief;
    result.gbdev_observed.worktree_dirty_at_exit = isDirty(status.worktree);
    let baseline: WorkspaceSnapshot | undefined;
    let afterWorker: WorkspaceSnapshot | undefined;
    if (status.kind !== 'inspect' && status.kind !== 'merge_resolution') {
      baseline = readWorkspaceSnapshot(join(paths.dir, WORKSPACE_BEFORE), { job_id: status.job_id, phase: 'before_worker' });
      // Never trust an earlier after-worker file on recovery; observe the current workspace.
      afterWorker = captureWorkspaceSnapshotSync(status.worktree, {
        job_id: status.job_id, phase: 'after_worker', previous_job_id: baseline.previous_job_id,
      });
      atomicWriteJson(join(paths.dir, WORKSPACE_AFTER_WORKER), afterWorker);
    }
    observeGit(store, status, brief, result, baseline, afterWorker);
  } catch (error) {
    if (status.kind !== 'inspect' && status.kind !== 'merge_resolution') reportFailure = 'workspace_snapshot_invalid';
    event(store, status, 'warning', { code: reportFailure === 'workspace_snapshot_invalid' ? reportFailure : 'internal_error', message: 'Crash recovery could not collect all workspace facts', detail: String(error) });
  }
  let providerFailure: string | null = null;
  try { providerFailure = providerFailureReason(status.provider, paths.dir); } catch { /* Recovery remains best-effort for unreadable raw/log files. */ }
  result.failure_reasons = finalOutcome(exitCode, result.worker_reported, result.gbdev_observed.policy_violations,
    'failed', result.gbdev_observed.checks, providerFailure, reportFailure, false, false, workerClosed).failure_reasons;
  // Recovery preserves the crash primary reason; invalid evidence remains a blocking fact.
  if (status.kind === 'inspect') {
    result.inspection = null;
    if (result.worker_reported) delete result.worker_reported.inspection;
  }
  return result;
}

export async function finalize(store: JobStore, status: JobStatus, brief: TaskBrief, exitCode: number | null, forced?: ForcedState, workerClosed = true, reportFailureOverride?: string): Promise<JobResult> {
  const paths = jobPaths(store.paths, status.job_id);
  const result = emptyResult(store, status, exitCode);
  const warn = (data: Record<string, unknown>) => locked(store, () => event(store, store.read(status.job_id), 'warning', data));
  const message = optionalText(paths.finalMessage);
  let reportFailure = reportFailureOverride ?? 'worker_result_missing';
  const launchOrPromptFail = reportFailureOverride === 'launch_failed' || reportFailureOverride === 'prompt_too_large';
  // M8 B6: optional Cursor extraction provenance (never invents a worker report).
  const extraction = (() => {
    try {
      const raw = optionalText(join(paths.dir, 'result-extraction.json'));
      return raw ? JSON.parse(raw) as {
        selected?: { kind: 'terminal_result' | 'assistant_final'; event_index: number; raw_file: string } | null;
        valid?: boolean;
        recovered_from_assistant?: boolean;
        force_invalid?: string;
      } : null;
    } catch { return null; }
  })();
  if (extraction?.force_invalid && !launchOrPromptFail) {
    result.worker_reported = null;
    reportFailure = `worker_result_invalid: ${extraction.force_invalid}`;
    await warn({ code: 'result_invalid', message: extraction.force_invalid, force_invalid: extraction.force_invalid });
  } else {
    try { result.worker_reported = extractWorkerResult(message ?? '', result.worker_result_warnings, workerSchemaOptions(paths.dir)); }
    catch (error) {
      // Missing/invalid reports are observations, never fabricated worker reports.
      // Launch/prompt failures keep their primary reason — do not emit result_missing as the driver.
      const code = error instanceof GbdevError ? error.contract.code : 'result_invalid';
      if (!launchOrPromptFail) {
        reportFailure = code === 'result_missing' ? 'worker_result_missing' : `worker_result_invalid: ${error instanceof Error ? error.message : String(error)}`;
        await warn({ code, message: String(error) });
      }
    }
  }
  if (extraction?.selected && result.worker_reported) {
    result.worker_result_source = {
      kind: extraction.selected.kind,
      event_index: extraction.selected.event_index,
      raw_file: extraction.selected.raw_file,
    };
    if (extraction.recovered_from_assistant) {
      result.worker_result_warnings.push('worker_result_recovered_from_assistant');
      await warn({
        code: 'worker_result_recovered_from_assistant',
        source: extraction.selected.kind,
        event_index: extraction.selected.event_index,
      });
    }
  }
  const observed = result.gbdev_observed;
  const scoped = status.branch.startsWith('gbdev/r_');
  const controller = new AbortController();
  const watch = scoped ? setInterval(() => { if (optionalText(paths.cancelRequest) !== null) controller.abort(); }, 50) : undefined;
  let baseline: WorkspaceSnapshot | undefined;
  let afterWorker: WorkspaceSnapshot | undefined;
  let remainingIncidentPaths: string[] = [];
  let workspaceIssues: WorkspaceIssue[] = [];
  try {
  observed.worktree_dirty_at_exit = scoped ? !!await git(status.worktree, ['status', '--porcelain=v1', '-z'], 120_000, controller.signal) : isDirty(status.worktree);
  if (status.kind !== 'merge_resolution' && status.kind !== 'inspect') {
    const loaded = await loadBaselineAndAfterWorker(status, paths);
    if (loaded.snapshotError) {
      await warn({ code: 'workspace_snapshot_invalid', message: loaded.snapshotError });
      reportFailure = 'workspace_snapshot_invalid';
    }
    baseline = loaded.baseline;
    afterWorker = loaded.afterWorker;
    remainingIncidentPaths = (result.worker_reported?.policy_incidents ?? [])
      .filter(incident => incidentRemains(status.worktree, incident.path)).map(incident => incident.path);
  }
  if (status.kind !== 'merge_resolution' && status.kind !== 'inspect' && observed.worktree_dirty_at_exit && brief.sandbox === 'workspace-write') {
    if (!baseline || !afterWorker) {
      workspaceIssues.push({ code: 'workspace_snapshot_invalid', path: '*', owner_job_id: null, source_phase: 'unknown', repairable: false });
    } else {
      const jobDelta = jobFilesChanged(baseline, afterWorker);
      const cachedBeforeCommit = git(status.worktree, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
      if (cachedBeforeCommit.length > 0 || (baseline && baselineHasInheritedStaged(baseline))) {
        workspaceIssues.push({
          code: 'inherited_staged_blocks_snapshot', path: cachedBeforeCommit[0] ?? '*', owner_job_id: baseline?.previous_job_id ?? null,
          source_phase: 'unknown', repairable: false,
        });
      } else {
        // A policy residue may be the only dirty file after the worker already committed its allowed edits.
        // Do not attempt an empty snapshot of those committed edits, or commit the temporary residue.
        const dirty = new Set(dirtyFiles(status.worktree));
        const temporary = new Set(afterWorker.entries.filter(entry => isPolicyWhitelistPath(entry.path) && entry.index_state.untracked).map(entry => entry.path));
        const toAdd = jobDelta.filter(file => dirty.has(file) && matchesAllowed(file, brief.allowed_paths) && !temporary.has(file));
        if (toAdd.length) {
          const addArgs = ['add', '--', ...toAdd];
          if (scoped) await git(status.worktree, addArgs, 120_000, controller.signal); else git(status.worktree, addArgs);
          const commitArgs = ['-c', 'user.name=gbdev', '-c', 'user.email=gbdev@localhost', '-c', 'commit.gpgsign=false',
            'commit', '--no-verify', '-m', `gbdev: snapshot ${status.job_id}${status.pipeline_id ? ` (${status.pipeline_id} ${status.step_instance})` : ''}`];
          if (scoped) await git(status.worktree, commitArgs, 120_000, controller.signal); else git(status.worktree, commitArgs);
          observed.snapshot_commit = head(status.worktree);
        }
      }
    }
  }
  if (status.kind === 'merge_resolution') {
    const metadata = JSON.parse(readFileSync(join(paths.dir, 'resolution.json'), 'utf8')) as { conflict_files: string[]; baseline: Record<string, string> };
    const markers = metadata.conflict_files.filter(file => { const path = join(status.worktree, file); return existsSync(path) && (!lstatSync(path).isFile() || /^(<<<<<<< |=======$|>>>>>>> )/m.test(readFileSync(path, 'utf8'))); });
    const files = [...new Set([...dirtyFiles(status.worktree), ...Object.keys(metadata.baseline)])];
    const content = (file: string) => { try { return lstatSync(join(status.worktree, file)).isFile() ? readFileSync(join(status.worktree, file)).toString('base64') : 'non-regular'; } catch { return 'absent'; } };
    const changed = files.filter(file => content(file) !== (metadata.baseline[file] ?? 'absent'));
    const nonConflict = changed.filter(file => !metadata.conflict_files.includes(file));
    atomicWriteJson(join(paths.dir, 'resolution-observed.json'), { markers_left: markers, touched_non_conflict: nonConflict });
    observed.head_after = head(status.worktree); observed.files_changed = changed;
    observed.outside_allowed_paths = changed.filter(file => !matchesAllowed(file, brief.allowed_paths));
    if (observed.outside_allowed_paths.length) observed.policy_violations.push('outside_allowed_paths');
    if (observed.head_after !== status.base_sha) observed.policy_violations.push('resolver_modified_head');
    if (markers.length) observed.policy_violations.push('conflict_markers_left');
    if (!result.worker_reported?.resolution || result.worker_reported.resolution.unresolved.length) observed.policy_violations.push('conflict_unresolved');
  } else if (scoped) await observeGitAsync(store, status, brief, result, controller.signal, baseline, afterWorker);
  else observeGit(store, status, brief, result, baseline, afterWorker);
  } finally { if (watch) clearInterval(watch); }
  // Check-phase delta must start after optional auto-snapshot, not the pre-snapshot after_worker evidence.
  let preChecks = afterWorker;
  if (status.kind !== 'merge_resolution' && status.kind !== 'inspect' && afterWorker) {
    try {
      preChecks = await captureWorkspaceSnapshot(status.worktree, {
        job_id: status.job_id, phase: 'after_worker', previous_job_id: status.parent_job_id ?? null,
      }, snapshotOptions(status));
    } catch (error) {
      preChecks = undefined;
      await warn({ code: 'workspace_snapshot_invalid', message: String(error) });
      reportFailure = 'workspace_snapshot_invalid';
    }
  }
  mkdirSync(paths.checks, { recursive: true });
  // Emit check events after the phase finishes so shared execution_id/reused_from are final.
  const checks = await runJobChecks({
    criteria: criteriaFromBrief(brief),
    cwd: status.worktree,
    jobDir: paths.dir,
    cancelRequest: paths.cancelRequest,
    processInfo: paths.processInfo,
    workspace: preChecks ?? null,
    // Opt-in B5 plans share the owner budget; legacy AC-only finalization is unchanged.
    ...((brief.execution_checks?.length ?? 0) > 0 ? { deadlineAt: taskChecksDeadline(store, status) } : {}),
  });
  for (const check of checks) {
    observed.checks.push(check);
    await locked(store, () => event(store, store.read(status.job_id), 'check', { ...check }));
  }
  if (status.kind !== 'merge_resolution' && status.kind !== 'inspect' && preChecks) {
    try {
      const afterChecks = await captureWorkspaceSnapshot(status.worktree, {
        job_id: status.job_id, phase: 'after_checks', previous_job_id: baseline?.previous_job_id ?? null,
      }, snapshotOptions(status));
      atomicWriteJson(join(paths.dir, WORKSPACE_AFTER_CHECKS), afterChecks);
      observed.check_files_changed = jobFilesChanged(preChecks, afterChecks);
      const previousObserved = (() => {
        const previousId = baseline?.previous_job_id;
        if (!previousId) return null;
        try {
          const raw = optionalText(jobPaths(store.paths, previousId).result);
          if (!raw) return null;
          const parent = JSON.parse(raw) as JobResult;
          return {
            job_id: parent.job_id,
            ...(parent.gbdev_observed.workspace_issues ? { workspace_issues: parent.gbdev_observed.workspace_issues } : {}),
            ...(parent.gbdev_observed.check_files_changed ? { check_files_changed: parent.gbdev_observed.check_files_changed } : {}),
          };
        } catch { return null; }
      })();
      workspaceIssues = mergeWorkspaceIssues(workspaceIssues,
        buildCheckPhaseIssues(status.job_id, preChecks, afterChecks),
        ...(baseline ? [buildInheritedWorkspaceIssues(baseline, afterChecks, previousObserved)] : []));
      if (workspaceIssues.length) observed.workspace_issues = workspaceIssues;
    } catch (error) {
      await warn({ code: 'workspace_snapshot_invalid', message: String(error) });
      reportFailure = 'workspace_snapshot_invalid';
    }
  }
  if (reportFailure === 'workspace_snapshot_invalid') {
    workspaceIssues = mergeWorkspaceIssues(workspaceIssues, [{ code: 'workspace_snapshot_invalid', path: '*', owner_job_id: null, source_phase: 'unknown', repairable: false }]);
  }
  if (workspaceIssues.length) observed.workspace_issues = workspaceIssues;
  let assessment: PolicyAssessment | null = null;
  // Invalid workspace evidence is already terminal; further git reads may fail too.
  if (reportFailure !== 'workspace_snapshot_invalid' && status.kind !== 'merge_resolution' && status.kind !== 'inspect' && baseline && afterWorker) {
    const jobCommittedPaths = committedPaths(status.worktree, baseline.head_sha);
    assessment = assessPolicy({
      sandbox: brief.sandbox,
      jobId: status.job_id,
      observedViolations: observed.policy_violations,
      outsideAllowedPaths: observed.outside_allowed_paths,
      reported: result.worker_reported,
      reportedWarnings: result.worker_result_warnings,
      baseline,
      afterWorker,
      committedPaths: jobCommittedPaths,
      remainingIncidentPaths,
    });
    observed.policy_assessment = assessment;
    const repairIssues = policyRepairWorkspaceIssues(assessment);
    if (repairIssues.length && !assessment.fatal.length) {
      workspaceIssues = mergeWorkspaceIssues(workspaceIssues, repairIssues);
      observed.workspace_issues = workspaceIssues;
    }
    for (const warning of assessment.warnings) {
      if (warning.path !== null) result.worker_result_warnings.push(`policy_warning_cleaned:${warning.path}`);
      if (warning.text) result.worker_result_warnings.push(`policy_self_report:${warning.text}`);
      await locked(store, () => event(store, store.read(status.job_id), 'policy_self_report_downgraded', { text: warning.text, incidents: result.worker_reported?.policy_incidents?.filter(i => i.violation_index === warning.violation_index) ?? [], reason: warning.reason }));
      await warn({ code: 'policy_warning_cleaned', path: warning.path, category: warning.category, violation_index: warning.violation_index, evidence_ref: warning.evidence_ref });
    }
    if (assessment.repairable.length && !assessment.fatal.length) {
      await warn({ code: 'policy_repair_required', paths: assessment.repairable.map(item => item.path) });
    }
  }
  await checkNotifyExposure(store, status, result);
  // A cancellation arriving during finalization must take precedence over the worker result.
  await locked(store, () => {
    const cancelled = optionalText(paths.cancelRequest) !== null;
    // Read-only prose success must never convert launch_failed / prompt_too_large into success.
    const readOnlyDelivery = !launchOrPromptFail && status.kind !== 'inspect' && result.worker_reported === null && brief.sandbox === 'read-only' && reportFailure === 'worker_result_missing' &&
      !!message?.trim() && observed.files_changed.length === 0 && observed.head_after === status.base_sha &&
      !observed.worktree_dirty_at_exit && observed.policy_violations.length === 0 && observed.checks.every(check => check.exit_code === 0);
    const effectiveForced: ForcedState | undefined = forced === 'timeout' || forced === 'worker_stalled' ? forced : cancelled ? 'cancelled' : forced;
    Object.assign(result, finalOutcome(exitCode, result.worker_reported, observed.policy_violations,
      effectiveForced, observed.checks,
      reportFailureOverride === 'rate_limit' || providerRateLimit(status.provider, paths.dir, exitCode) ? 'rate_limit' : providerFailureReason(status.provider, paths.dir), reportFailure, readOnlyDelivery, brief.sandbox === 'read-only', workerClosed, assessment));
    if (launchOrPromptFail && result.state === 'failed') {
      result.failure_reason = reportFailureOverride!;
      result.failure_reasons = [reportFailureOverride!, ...(result.failure_reasons ?? []).filter(r => r !== 'worker_result_missing' && r !== reportFailureOverride)];
      if (reportFailureOverride === 'prompt_too_large') result.worker_exit_code = null;
    }
    if (reportFailure === 'workspace_snapshot_invalid') snapshotFailure(result, effectiveForced);
    if (status.kind === 'inspect') applyInspect(store, status, result, paths.dir, effectiveForced);
    if ((readOnlyDelivery && result.state === 'succeeded') ||
        (brief.sandbox === 'read-only' && result.worker_reported === null && reportFailure === 'worker_result_missing' &&
          result.failure_reason?.startsWith('check_failed:'))) result.worker_result_warnings.push('worker_result_missing');
    result.duration_s = Math.max(0, (Date.now() - Date.parse(status.created_at)) / 1000);
    validateJobResult(result);
    atomicWriteJson(paths.result, result); // Publish result before making the terminal status visible.
    transition(store, store.read(status.job_id), result.state, result.state === 'cancelled' ? 'grok-bot' : 'gbdev', result.failure_reason, result.failure_reasons);
    if (status.kind === 'inspect') releaseInspectReservation(store, status.job_id);
  });
  return result;
}
