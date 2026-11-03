import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RoleRegistry } from '../roles/registry.js';
import { validateBrief } from '../contracts/brief.js';
import { GbdevError } from '../contracts/error.js';
import { type JobStatus } from '../contracts/jobStatus.js';
import { assertRepoAllowed, loadConfig } from '../core/config.js';
import { failureResult } from '../core/finalize.js';
import { addWorktree, resolveBase } from '../core/git.js';
import { createJobId, jobBranch } from '../core/ids.js';
import { atomicWriteJson, JobStore } from '../core/jobStore.js';
import { jobPaths, worktreePath } from '../core/paths.js';
import { caffeinatePath, findExecutable, spawnProcess } from '../core/proc.js';
import { renderPrompt } from '../core/prompt.js';
import { event, locked, transition } from '../core/runtime.js';
import { localIso } from '../core/time.js';
import { assertStartInspectCapacity } from '../core/workerReservations.js';
import { providerAdapter } from '../providers/index.js';
import { reconcileAll } from '../pipeline/reconcile.js';
import { assertIdle } from './pipeline.js';
import { reconcileInspectReservation } from './status.js';

export async function start(store: JobStore, briefFile: string): Promise<JobStatus> {
  const config = loadConfig(store.paths.config);
  let value: unknown;
  try { value = JSON.parse(readFileSync(briefFile === '-' ? 0 : briefFile, 'utf8')); }
  catch { throw new GbdevError('config_invalid', 'Cannot read brief JSON'); }
  const registry = new RoleRegistry(store.paths.config);
  const brief = validateBrief(value, config, registry);
  const role = registry.resolve(brief.role);
  brief.repo = assertRepoAllowed(brief.repo, config);
  const adapter = providerAdapter(brief.provider);
  const bin = brief.provider === 'fake' ? process.execPath : findExecutable(config.providers[brief.provider].bin);
  if (bin === null) throw new GbdevError('provider_not_found', 'Provider executable not found', { provider: brief.provider });
  // Validate testing controls before creating any persistent job/worktree.
  adapter.buildInvocation({ bin, worktree: '', jobDir: '', prompt: '', sandbox: brief.sandbox, network: brief.network, model: brief.model });
  const scale = Number(process.env.GBDEV_TIMEOUT_SCALE ?? 60_000);
  if (!Number.isFinite(scale) || scale <= 0 || scale * brief.timeout_min > 2_147_483_647) {
    throw new GbdevError('config_invalid', 'GBDEV_TIMEOUT_SCALE must be a positive finite milliseconds-per-minute value');
  }
  await reconcileAll(store);
  const inspectRecovery = reconcileInspectReservation(store);
  if (inspectRecovery) await inspectRecovery;
  return locked(store, async () => {
    assertIdle(store);
    assertStartInspectCapacity(store, brief.provider);
    const baseSha = resolveBase(brief.repo, brief.base_ref);
    const date = new Date();
    const at = localIso(date);
    const jobId = createJobId(date);
    const status: JobStatus = {
      schema: 'gbdev.job-status.v1', job_id: jobId, state: 'queued', provider: brief.provider,
      role: brief.role, sandbox: brief.sandbox, repo: brief.repo, worktree: worktreePath(store.paths, brief.repo, jobId),
      pipeline_id: null, step_instance: null, attempt: null, failure_reasons: [],
      branch: jobBranch(jobId), base_sha: baseSha, pid: null, session_id: null, created_at: at, updated_at: at,
      deadline_at: localIso(new Date(date.getTime() + brief.timeout_min * scale)),
      state_history: [{ state: 'queued', at, by: 'gbdev' }], last_event: null, parent_job_id: brief.parent_job_id,
    };
    store.create(status);
    const paths = jobPaths(store.paths, jobId);
    atomicWriteJson(paths.brief, brief);
    // Pin the resolved executable; later configuration changes must not redirect a queued job.
    atomicWriteJson(`${paths.dir}/provider.json`, { bin, writable_roots: [], schema_options: { policyIncidents: true, output: role.output } });
    event(store, status, 'state_change', { state: 'queued', by: 'gbdev' });
    try {
      transition(store, status, 'starting');
      addWorktree(status.repo, status.branch, status.worktree, baseSha);
      const writableRoots = brief.sandbox === 'workspace-write' ? [status.worktree] : [];
      atomicWriteJson(`${paths.dir}/provider.json`, { bin, writable_roots: writableRoots, schema_options: { policyIncidents: true, output: role.output } });
      writeFileSync(paths.prompt, renderPrompt(brief, role.instructions_text, { policyIncidents: true }));
      writeFileSync(brief.provider === 'cursor' ? paths.rawJson : paths.rawJsonl, '');
      writeFileSync(paths.workerLog, '');
      const fd = openSync(paths.supervisorLog, 'a', 0o600);
      try {
        const wrapper = caffeinatePath();
        const args = [fileURLToPath(new URL('../cli.js', import.meta.url)), '__supervise', jobId];
        const child = await spawnProcess(wrapper ?? process.execPath, wrapper ? ['-i', process.execPath, ...args] : args,
          { detached: true, stdio: ['ignore', fd, fd] });
        status.pid = child.pid!;
        store.write(status);
        child.unref();
      } finally { closeSync(fd); }
    } catch (error) {
      event(store, status, 'warning', { code: error instanceof GbdevError ? error.contract.code : 'internal_error', message: String(error) });
      const result = failureResult(store, status, null);
      result.failure_reason = `start_failed: ${error instanceof Error ? error.message : String(error)}`;
      result.failure_reasons = [...new Set([result.failure_reason, ...(result.failure_reasons ?? [])])];
      atomicWriteJson(paths.result, result);
      transition(store, status, 'failed', 'gbdev', result.failure_reason, result.failure_reasons);
      throw error;
    }
    return status;
  });
}
