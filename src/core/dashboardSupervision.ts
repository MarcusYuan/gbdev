import { withDashboard } from '../dashboard/trigger.js';
import { unitKind } from '../dashboard/names.js';
import { runEvent, readRun, runPaths } from '../run/store.js';
import { pipelineEvent, readRun as readPipeline, pipelinePaths } from '../pipeline/store.js';
import type { JobStore } from './jobStore.js';
import { jobPaths } from './paths.js';
import { event, locked, optionalText } from './runtime.js';
/** Warning de-duplication is persisted in the existing event log, including resumes. */
export function dashboardSupervision<T>(store: JobStore, id: string, work: () => Promise<T>, testing: Parameters<typeof withDashboard>[4] = {}): Promise<T> {
  return withDashboard(store.paths, id, reason => {
    return locked(store, () => {
      const kind = unitKind(id);
      const path = kind === 'run' ? runPaths(store, id).events : kind === 'pipeline' ? pipelinePaths(store, id).events : jobPaths(store.paths, id).events;
      if ((optionalText(path) ?? '').split('\n').some(line => { try { const e = JSON.parse(line); return e.type === 'warning' && e.data?.code === 'dashboard_unavailable'; } catch { return false; } })) return;
      const data = { code: 'dashboard_unavailable', reason };
      if (kind === 'run') runEvent(store, readRun(store, id), 'warning', data);
      else if (kind === 'pipeline') pipelineEvent(store, readPipeline(store, id), 'warning', data);
      else event(store, store.read(id), 'warning', data);
    });
  }, work, testing);
}
