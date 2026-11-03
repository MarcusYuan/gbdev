import { JOB_ID_PATTERN, RUN_ID_PATTERN } from '../../core/ids.js';
import { str } from '../format.js';
import { PIPELINE_ID, finishedAt, retentionMs, terminal, terminalJob, textRow, ViewFiles, type ViewOptions } from './common.js';
export interface IndexSnapshot { rows: string[]; active: boolean }
export function indexView(files: ViewFiles, now: number, options: ViewOptions = {}): IndexSnapshot {
  const rows = [`gbdev overview${options.session ? ` · ${options.session}` : ''}`, 'UNIT                         STATE          JUMP'];
  let active = false;
  for (const [dir, pattern, file] of [['runs', RUN_ID_PATTERN, 'run.json'], ['pipelines', PIPELINE_ID, 'pipeline.json'], ['jobs', JOB_ID_PATTERN, 'job.json']] as const) {
    for (const id of files.names(dir, pattern)) {
      const unit = files.json(`${dir}/${id}/${file}`); if (!unit) continue;
      if (dir === 'pipelines' && (unit.run_id || unit.integration || (unit.workspace as { mode?: string } | undefined)?.mode === 'per_lane')) continue;
      if (dir === 'jobs' && (unit.run_id || unit.pipeline_id)) continue;
      const done = dir === 'jobs' ? terminalJob(unit.state) : terminal(unit.state);
      active ||= !done;
      const end = finishedAt(unit), retention = retentionMs(options.retainFinishedMin ?? 30);
      if (done && (!Number.isFinite(end) || now - end >= retention)) continue;
      const note = dir === 'jobs' && unit.kind === 'inspect'
        ? ` inspector ${str((unit.inspection as { target?: { id?: string } } | undefined)?.target?.id)} ${str((unit.inspection as { snapshot?: { target_sha?: string } } | undefined)?.snapshot?.target_sha).slice(0, 7)} committed`
        : '';
      rows.push(`${id}${note} ${str(unit.state).padEnd(14)} Ctrl-b w → ${id}`);
    }
  }
  rows.push('repair panes: gbdev dashboard ensure', 'Ctrl-b d 断开；关闭观看不会影响任务');
  return { rows: rows.map(row => textRow(row, options.columns)), active };
}
