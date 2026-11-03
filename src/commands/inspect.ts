import { createHash } from 'node:crypto';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBrief } from '../contracts/brief.js';
import { GbdevError } from '../contracts/error.js';
import { type InspectStartResult } from '../contracts/inspect.js';
import { isTerminal, type JobStatus } from '../contracts/jobStatus.js';
import { loadConfig } from '../core/config.js';
import { failureResult } from '../core/finalize.js';
import { addDetachedWorktree } from '../core/git.js';
import { createJobId, jobBranch } from '../core/ids.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { jobPaths, worktreePath } from '../core/paths.js';
import { caffeinatePath, findExecutable, spawnProcess } from '../core/proc.js';
import { allJobs, event, locked, transition } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { acquireInspectAdmission, releaseInspectReservation, updateInspectReservation } from '../core/workerReservations.js';
import { providerAdapter } from '../providers/index.js';
import { RoleRegistry } from '../roles/registry.js';
import { reconcile } from './status.js';
import { buildEvidencePack, assertInspectPath } from '../inspect/evidence.js';
import { PATH_MAX, PATHS_MAX, QUESTION_MAX, utf8Bytes } from '../inspect/limits.js';
import { writeInspectionRequest } from '../inspect/lifecycle.js';
import { renderInspectPrompt } from '../inspect/prompt.js';
import { resolveInspectTarget } from '../inspect/target.js';

export interface InspectCommandOptions {
  id: string;
  question: string;
  task?: string;
  paths?: string[];
  diff?: boolean;
  tests?: boolean;
}

function validateQuestion(question: string): string {
  if (question.includes('\0')) throw new GbdevError('usage_error', 'question must not contain NUL');
  const trimmed = question.trim();
  if (!trimmed) throw new GbdevError('usage_error', 'inspect requires a non-empty --question');
  if (utf8Bytes(trimmed) > QUESTION_MAX) throw new GbdevError('usage_error', 'question exceeds 4096 UTF-8 bytes');
  return trimmed;
}

function validatePaths(paths: readonly string[]): string[] {
  if (paths.length > PATHS_MAX) throw new GbdevError('usage_error', 'inspect accepts at most 20 --paths');
  for (const path of paths) {
    if (utf8Bytes(path) > PATH_MAX) throw new GbdevError('inspect_path_invalid', 'Inspect path exceeds 256 UTF-8 bytes');
    assertInspectPath(path);
  }
  return [...paths];
}

export async function inspect(store: JobStore, options: InspectCommandOptions): Promise<Omit<InspectStartResult, 'dashboard' | 'notify'>> {
  const question = validateQuestion(options.question);
  const paths = validatePaths(options.paths ?? []);
  const diff = options.diff ?? false;
  const tests = options.tests ?? false;
  if (options.task !== undefined && !/^[a-z][a-z0-9-]{0,23}$/.test(options.task)) {
    throw new GbdevError('usage_error', 'Invalid task id');
  }
  const config = loadConfig(store.paths.config);
  const registry = new RoleRegistry(store.paths.config);
  const role = registry.resolve('inspector');
  const bin = role.provider === 'fake' ? process.execPath : findExecutable(config.providers[role.provider].bin);
  if (bin === null) throw new GbdevError('provider_not_found', 'Provider executable not found', { provider: role.provider });
  const adapter = providerAdapter(role.provider);
  adapter.buildInvocation({ bin, worktree: '', jobDir: '', prompt: '', sandbox: 'read-only', network: true, model: role.provider === 'cursor' ? 'auto' : null });
  const scale = Number(process.env.GBDEV_TIMEOUT_SCALE ?? 60_000);
  if (!Number.isFinite(scale) || scale <= 0 || scale * role.default_timeout_min > 2_147_483_647) {
    throw new GbdevError('config_invalid', 'GBDEV_TIMEOUT_SCALE must be a positive finite milliseconds-per-minute value');
  }
  for (const job of allJobs(store)) {
    if (job.kind === 'inspect' && !isTerminal(job.state)) await reconcile(store, job.job_id);
  }
  return locked(store, async () => {
    const resolved = resolveInspectTarget(store, options.id, options.task);
    const date = new Date();
    const at = localIso(date);
    const jobId = createJobId(date);
    acquireInspectAdmission(store, role.provider, jobId);
    const snapshot = {
      mode: 'committed' as const, target_sha: resolved.target_sha, diff_base_sha: resolved.diff_base_sha,
      captured_at: at, uncommitted_included: false as const,
    };
    const status: JobStatus = {
      schema: 'gbdev.job-status.v1', job_id: jobId, state: 'queued', provider: role.provider, role: 'inspector',
      sandbox: 'read-only', repo: resolved.repo, worktree: worktreePath(store.paths, resolved.repo, jobId),
      kind: 'inspect', inspection: {
        workspace_owned: true, detached: true, question, paths, diff, tests, target: resolved.target, snapshot,
      },
      pipeline_id: null, step_instance: null, attempt: null, failure_reasons: [],
      branch: jobBranch(jobId), base_sha: resolved.target_sha, pid: null, session_id: null, created_at: at, updated_at: at,
      deadline_at: localIso(new Date(date.getTime() + role.default_timeout_min * scale)),
      state_history: [{ state: 'queued', at, by: 'gbdev' }], last_event: null, parent_job_id: null,
    };
    let created = false;
    try {
      store.create(status);
      created = true;
      const pathsForJob = jobPaths(store.paths, jobId);
      event(store, status, 'state_change', { state: 'queued', by: 'gbdev' });
      transition(store, status, 'starting');
      addDetachedWorktree(status.repo, status.worktree, resolved.target_sha);
      const evidence = buildEvidencePack(store, status.worktree, resolved, paths, diff, tests);
      const brief = validateBrief({
        schema: 'gbdev.task-brief.v1', brief_id: `b_${jobId.slice(2)}`, repo: resolved.repo, base_ref: resolved.target_sha,
        role: 'inspector', provider: role.provider, sandbox: 'read-only', network: true, goal: question, context: '',
        constraints: ['Read only', 'Do not run tests or repository commands'],
        allowed_paths: paths.length ? paths : ['.'], acceptance_criteria: [], required_evidence: [], parent_job_id: null, answers: [],
      }, config, registry);
      atomicWriteJson(pathsForJob.brief, brief);
      atomicWriteJson(`${pathsForJob.dir}/provider.json`, { bin, writable_roots: [], schema_options: { inspection: true, pipelineStep: false, output: 'report' } });
      writeFileSync(pathsForJob.prompt, renderInspectPrompt(question, evidence, role.instructions_text));
      writeInspectionRequest(join(pathsForJob.dir, 'inspection.request.json'), {
        question, paths, diff, tests, repo: resolved.repo, source_branch: resolved.source_branch, source_worktree: resolved.source_worktree,
        target: resolved.target, snapshot, warnings: evidence.warnings,
        instructions_sha256: createHash('sha256').update(role.instructions_text).digest('hex'),
      });
      writeFileSync(role.provider === 'cursor' ? pathsForJob.rawJson : pathsForJob.rawJsonl, '');
      writeFileSync(pathsForJob.workerLog, '');
      const fd = openSync(pathsForJob.supervisorLog, 'a', 0o600);
      try {
        const wrapper = caffeinatePath();
        const args = [fileURLToPath(new URL('../cli.js', import.meta.url)), '__supervise', jobId];
        const child = await spawnProcess(wrapper ?? process.execPath, wrapper ? ['-i', process.execPath, ...args] : args, { detached: true, stdio: ['ignore', fd, fd] });
        status.pid = child.pid ?? null;
        if (status.pid) updateInspectReservation(store, jobId, status.pid, null);
        store.write(status);
        child.unref();
        return { schema: 'gbdev.inspect-start.v1' as const, job_id: jobId, state: status.state, target: resolved.target, snapshot, question, paths, diff, tests };
      } finally { closeSync(fd); }
    } catch (error) {
      releaseInspectReservation(store, jobId);
      if (created) {
        event(store, status, 'warning', { code: error instanceof GbdevError ? error.contract.code : 'internal_error', message: String(error) });
        const result = failureResult(store, status, null);
        result.inspection = null;
        result.failure_reason = `start_failed: ${error instanceof Error ? error.message : String(error)}`;
        result.failure_reasons = [result.failure_reason];
        atomicWriteJson(jobPaths(store.paths, jobId).result, result);
        transition(store, status, 'failed', 'gbdev', result.failure_reason, result.failure_reasons);
      }
      throw error;
    }
  });
}
