import { DASHBOARD_DEFAULTS, type DashboardConfig } from '../core/dashboardConfig.js';
import { JOB_ID_PATTERN, RUN_ID_PATTERN } from '../core/ids.js';
import { JOB_STATES } from '../contracts/jobStatus.js';
import { PIPELINE_ID, ViewFiles, terminal, terminalJob, finishedAt, retentionMs } from '../render/views/common.js';
import { record, str } from '../render/format.js';
import { key, unitKind, type UnitKind } from './names.js';
export interface DesiredPane { key: string; name: string; kind: string; lane?: string }
export interface DesiredWindow { key: string; id: string; kind: UnitKind; state: string; finishedAt?: number; panes: DesiredPane[] }
/** Read-only desired state, including retained top-level units. Explicit targets reopen history. */
export function desired(home: string, target?: string, config: DashboardConfig = DASHBOARD_DEFAULTS, now = Date.now()): { windows: DesiredWindow[]; warnings: string[] } {
  const files = new ViewFiles(home), windows: DesiredWindow[] = [];
  const groups = [['run', 'runs', 'run.json', RUN_ID_PATTERN], ['pipeline', 'pipelines', 'pipeline.json', PIPELINE_ID], ['job', 'jobs', 'job.json', JOB_ID_PATTERN]] as const;
  for (const [kind, dir, file, pattern] of groups) {
    if (target && unitKind(target) !== kind) continue;
    for (const id of target ? [target] : files.names(dir, pattern)) {
      const path = `${dir}/${id}/${file}`;
      const unit = kind === 'run' ? files.run(id) : kind === 'pipeline' ? files.pipeline(id) : files.json(path);
      if (!unit) continue;
      const data = unit as unknown as Record<string, unknown>;
      if (data[`${kind}_id`] !== id || kind === 'job' && !(JOB_STATES as readonly unknown[]).includes(data.state)) { files.warn(path, new Error()); continue; }
      if (kind === 'pipeline' && (data.run_id || record(data.integration).run_id || record(data.workspace).run_id || record(data.workspace).mode === 'per_lane')) continue;
      if (kind === 'job' && (data.run_id || data.pipeline_id)) continue;
      const done = kind === 'job' ? terminalJob(data.state) : terminal(data.state), end = done ? finishedAt(data) : undefined;
      if (!target && done && (!Number.isFinite(end) || now - end! >= retentionMs(config.retain_finished_min))) continue;
      const pane = (name: string, paneKind: string, lane?: string): DesiredPane => ({ key: key(id, name), name, kind: paneKind, ...(lane ? { lane } : {}) });
      const lanes = new Set((Array.isArray(data.lanes) ? data.lanes : []).map(l => str(record(l).lane)).filter(l => /^lane-[1-4]$/.test(l)));
      if (kind === 'run') {
        // startRun persists the normalized request before run.json, whose lanes
        // is initially empty while worktrees are prepared. Startup ensure must
        // create the fixed topology now: assignment events inside T10's leading
        // debounce may otherwise leave both lanes absent until the first step ends.
        const request = files.json(`runs/${id}/request.json`), count = request?.lanes;
        if (request?.schema === 'gbdev.run-request.v1' && typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 4) {
          for (let i = 1; i <= count; i++) lanes.add(`lane-${i}`);
        }
      }
      const panes = kind === 'job' ? [pane('job', 'job')] : kind === 'pipeline' ? [pane('status', 'pipeline-status'), pane('step', 'pipeline-step')]
        : [pane('status', 'run-status'), ...[...lanes].sort().map(l => pane(l, 'run-lane', l)), pane('integration', 'run-integration')];
      windows.push({ key: key(id), id, kind, state: str(data.state), ...(done ? { finishedAt: end! } : {}), panes });
    }
  }
  return { windows, warnings: files.warnings(Date.now()).map(l => l.text) };
}
