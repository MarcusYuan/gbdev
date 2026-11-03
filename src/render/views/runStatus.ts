import type { Run } from '../../contracts/run.js';
import { LAUNCH_FAILED_STATUS_HINT, PROMPT_TOO_LARGE_STATUS_HINT, VERDICT_MISSING_STATUS_HINT } from '../../core/verdictAcceptance.js';
import { record, safeText, str } from '../format.js';
import { elapsed, launchRetryRows, records, textRow, ViewFiles, type ViewOptions } from './common.js';
export function mergeRecords(files: ViewFiles, id: string): Record<string, unknown>[] {
  const base = `runs/${id}/merges`;
  return files.names(base, /^\d+(?:\.pending)?\.json$/).map(n => files.json(`${base}/${n}`)).filter((m): m is Record<string, unknown> => !!m).sort((a, b) => Number(b.seq) - Number(a.seq));
}
function checks(gate: unknown): string { return records(record(gate).checks).map(c => `${str(c.id)} ${c.exit_code === 0 ? '✓' : c.exit_code === null ? '…' : '✗'} ${str(c.duration_s)}s`).join(', '); }
export function runStatus(files: ViewFiles, run: Run, now: number, options: ViewOptions = {}): string[] {
  const i = run.integration, m = i.merging, budget = run.budget;
  const safeSha = safeText(i.head_sha);
  const shortSha = safeSha.includes('‹redacted›') ? safeSha : safeSha.slice(0, 7);
  const rows = [`run ${run.run_id} ${run.state} ${elapsed(run.created_at, now)} jobs ${budget.jobs_used}/${budget.max_total_jobs} tasks ${run.progress.integrated}/${run.tasks.length} integrated${options.session ? ` [tmux: ${options.session} · Ctrl-b d 断开]` : ''}`,
    `integration ${i.branch} @${shortSha} ${i.head_sha === i.verified_sha ? 'verified' : 'unverified'} merging: ${m ? `${m.task_id} ${m.phase} (${elapsed(m.started_at, now)})` : '-'} merges ${i.merges} rollbacks ${i.rollbacks}`,
    'TASK        STATE          LANE    DEPS     ATTEMPTS  MERGE  TITLE'];
  // Titles are not present in run.json: project only title/id from the saved task graph/request.
  const graph = files.json(`runs/${run.run_id}/task-graph.json`) ?? files.json(`runs/${run.run_id}/request.json`);
  const titles = new Map(records(graph?.tasks).map(t => [str(t.id), Array.from(safeText(str(t.title))).slice(0, 40).join('')]));
  for (const task of run.tasks) rows.push(`${task.task_id.padEnd(11)} ${task.state.padEnd(14)} ${(task.lane ?? '-').padEnd(7)} ${(task.depends_on.join(',') || '-').padEnd(8)} ${String(task.attempts.length).padEnd(9)} ${task.merge_seq.map(n => `#${n}`).join(',') || '-'} ${task.state === 'integrated' ? '✓' : task.state === 'merging' ? '…' : ''}  ${titles.get(task.task_id) ?? ''}`);
  for (const lane of run.lanes) {
    const p = lane.pipeline_id ? files.pipeline(lane.pipeline_id) : undefined;
    const step = p?.steps.find(s => s.instance === p.current?.instance);
    rows.push(`LANES ${lane.lane} ${lane.state} ${lane.task_id ?? ''} ${p?.current?.instance ?? ''} ${step ? `(${step.provider}) ${elapsed(step.started_at, now)}` : ''}`);
  }
  const merges = mergeRecords(files, run.run_id);
  for (const merge of merges.slice(0, 5)) rows.push(`MERGES #${str(merge.seq)} ${str(merge.task_id)} ${m && m.seq === merge.seq ? m.phase : str(merge.result)} ${merge.result === 'integrated' ? '✓' : str(merge.result).startsWith('rolled_back') ? '✗' : ''}`);
  const baseline = record(files.json(`runs/${run.run_id}/baseline-gate.json`)?.gate);
  rows.push(`GATES baseline ${baseline.passed === true ? '✓' : baseline.passed === false ? '✗' : '…'} ${checks(baseline)}`);
  for (const merge of merges.slice(0, 5)) rows.push(`GATES #${str(merge.seq)}: ${checks(merge.gate) || (m?.seq === merge.seq ? '…' : '-')}`);
  const review = files.json(`runs/${run.run_id}/final-review.json`);
  if (review) {
    rows.push(`FINAL REVIEW ${str(review.verdict) || 'pending'} findings ${records(review.findings).length}`);
    if (review.failure_reason === 'launch_failed') rows.push(`  ${LAUNCH_FAILED_STATUS_HINT}`);
    if (review.failure_reason === 'prompt_too_large') rows.push(`  ${PROMPT_TOO_LARGE_STATUS_HINT}`);
  }
  for (const id of files.names('jobs', /^j_\d{8}_\d{4}_[a-f0-9]{4}$/)) {
    if (files.json(`jobs/${id}/job.json`)?.run_id === run.run_id) rows.push(...launchRetryRows(files, id, now));
  }
  rows.push('ATTENTION');
  // Separate identity/reason/actions rows prevent a long reason/detail from hiding decisions.
  for (const a of run.attention) {
    rows.push(`  ${a.decision_id} ${a.scope} ${a.task_id ?? ''}`, `    ${a.reason}`, ...a.allowed_actions.map(action => `    actions: ${action}`), `    ${a.detail}`);
    if (a.reason === 'launch_failed') rows.push(`    ${LAUNCH_FAILED_STATUS_HINT}`, `    recommended: ${a.allowed_actions.includes('retry') ? 'retry' : 'null'}`);
    else if (a.reason === 'prompt_too_large') rows.push(`    ${PROMPT_TOO_LARGE_STATUS_HINT}`, `    recommended: ${a.allowed_actions.includes('retry') ? 'retry' : 'null'}`);
    if (a.accept_requirements?.length) {
      rows.push(`    ${VERDICT_MISSING_STATUS_HINT}`);
      if (a.recommended_action) rows.push(`    recommended: ${a.recommended_action}`);
      rows.push(`    accept_requirements: ${a.accept_requirements.join(', ')}`);
    }
  }
  if (run.attention.length) rows.push('  （由控制器处理；请在对话中说明你的选择）');
  rows.push(`BUDGET jobs ${budget.jobs_used}/${budget.max_total_jobs} tasks ${run.tasks.length}/${budget.max_tasks} deadline ${run.deadline_at}${(run.paused_ms ?? 0) > 0 ? ` paused ${Math.floor(run.paused_ms! / 60_000)}m` : ''}`, `SLOTS ${run.slots.in_use}/${run.slots.max_workers} (codex ${run.slots.by_provider.codex}, cursor ${run.slots.by_provider.cursor})`);
  return rows.map(row => textRow(row, options.columns));
}
export function runSummary(files: ViewFiles, run: Run): string {
  const result = files.json(`runs/${run.run_id}/result.json`), final = record(result?.final_review);
  const findings = records(final.findings).length + records(result?.tasks).reduce((n, t) => n + records(record(t.review).unresolved_findings).length, 0);
  return `summary ${run.run_id} ${run.state} outcome=${str(result?.outcome ?? run.outcome) || '-'} merges=${run.integration.merges} findings=${result ? findings : 'unknown'}\nintegration=${str(result?.integration_branch) || run.integration.branch}\nsha=${str(result?.integration_sha) || run.integration.verified_sha}`;
}
