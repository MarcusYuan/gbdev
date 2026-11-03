import { createHash } from 'node:crypto';
import type { JobStatus } from '../contracts/jobStatus.js';
import type { JobResult } from '../contracts/jobResult.js';
import type { JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { event, locked, optionalText } from '../core/runtime.js';
import { loadConfig } from '../core/config.js';
import { NOTIFY_DEFAULTS, notifyDisabledReason } from '../core/notifyConfig.js';
import { identity } from '../dashboard/names.js';
import { readRun, writeRun } from '../run/store.js';
import { readRun as readPipeline } from '../pipeline/store.js';
import { notifyEvent } from './enqueue.js';
import { readSecret } from './secret.js';
import { readDeliveryState } from './state.js';
import type { StatusOptions } from './status.js';

/** Supervisor-only, in-memory comparison; never persists credentials or matching text. */
export async function checkNotifyExposure(store: JobStore, job: JobStatus, result: JobResult, options: StatusOptions = {}): Promise<void> {
  try {
    const env = options.env ?? process.env;
    if (env.GBDEV_NOTIFY === '0' || (env.NODE_TEST_CONTEXT !== undefined && env.GBDEV_NOTIFY_TEST !== '1')) return;
    const full = loadConfig(store.paths.config), config = full.notify ?? NOTIFY_DEFAULTS;
    if (notifyDisabledReason(config, env)) return;
    const paths = jobPaths(store.paths, job.job_id);
    let exposed = false;
    await readSecret({ paths: store.paths, config, allowed_repos: full.allowed_repos, home_id: identity(store.paths.home).h12, env,
      keychain_setup_at: readDeliveryState(store.paths.home).keychain_setup_at ?? null, ...options.secret }, secret => {
      exposed = [optionalText(paths.diff), optionalText(paths.finalMessage), result.worker_reported?.summary].some(text => text?.includes(secret.key));
    });
    if (!exposed) return;
    await locked(store, () => {
      const events = (optionalText(paths.events) ?? '').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      let warning = events.find(e => e.type === 'warning' && e.data?.code === 'notify_secret_exposed');
      if (!warning) { event(store, store.read(job.job_id), 'warning', { code: 'notify_secret_exposed' }); warning = JSON.parse((optionalText(paths.events) ?? '').trim().split('\n').at(-1)!); }
      let runId = job.run_id ?? job.branch.match(/^gbdev\/(r_\d{8}_\d{4}_[a-f0-9]{4})\//)?.[1];
      if (!runId && job.pipeline_id) { const pipeline = readPipeline(store, job.pipeline_id); if (pipeline.workspace.mode === 'per_lane') runId = pipeline.workspace.run_id; }
      const run = runId ? readRun(store, runId) : null;
      const pipeline = !run && job.pipeline_id ? readPipeline(store, job.pipeline_id) : null;
      const unit = run ? { kind: 'run' as const, id: run.run_id, state: run.state } : pipeline ? { kind: 'pipeline' as const, id: pipeline.pipeline_id, state: pipeline.state } : { kind: 'job' as const, id: job.job_id, state: job.state };
      // The persisted warning is the source identity; retries must not generate another health notice.
      const source = Number.parseInt(createHash('sha256').update(`${job.job_id}:${warning.seq}`).digest('hex').slice(0, 12), 16) || 1;
      if (run) {
        const marker = `notify_secret_exposed:${job.job_id}`;
        notifyEvent(store, unit, 'notify_secret_exposed', {}, source, warning.at);
        if (!run.warnings.includes(marker)) { run.warnings.push(marker); writeRun(store, run); }
      } else notifyEvent(store, unit, 'notify_secret_exposed', {}, source, warning.at);
    });
  } catch { /* Observability cannot change the worker outcome. */ }
}
