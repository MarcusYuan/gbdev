import type { RunAttention } from '../contracts/run.js';
import { sanitizeForTerminal } from '../render/sanitize.js';
import { redactSecrets } from '../render/redact.js';

const reasons: Record<RunAttention['reason'], string> = {
  plan_review: '计划待确认', plan_invalid: '计划无效', task_paused: '任务暂停', task_failed: '任务失败',
  lane_broken: '执行通道异常', merge_conflict_unresolved: '合并冲突未解决', integration_gate_failed: '集成检查失败',
  final_review_revise: '最终评审需修改', final_review_rejected: '最终评审拒绝', run_budget_exhausted: '运行预算耗尽',
  supervisor_crashed: '监督进程中断', integration_corrupt: '集成状态异常', launch_failed: '启动失败', prompt_too_large: '提示过长',
};
export function safeDecisionText(text: string, limit: number): string {
  if (limit <= 0) return '';
  const safe = redactSecrets(sanitizeForTerminal(text));
  return safe.length > limit ? safe.slice(0, Math.max(0, limit - 1)) + '…' : safe;
}
export interface DecisionSummaryInput {
  reason: string; detail: string; allowed_actions: readonly string[];
  pending_questions?: readonly { question: string }[];
  pipeline_id?: string | null; instance?: string | undefined; job_id?: string | undefined; plan_path?: string | undefined;
  environment?: boolean; reviewer_verdict?: string;
}
/** Worker-derived detail/questions are labelled and bounded; identity/actions retain space. */
export function decisionSummary(input: DecisionSummaryInput): string {
  const pipelineReasons: Record<string, string> = { blocked: '步骤阻塞', needs_input: '等待输入', max_rounds_exceeded: '修复轮次耗尽', findings_repeated: '评审问题重复', review_rejected: '评审拒绝', fix_no_changes: '修复未产生修改', verdict_missing: '评审结论缺失', step_failed: '步骤失败', step_cancelled: '步骤取消', job_budget_exhausted: '作业预算耗尽', workspace_unresolved: '工作区问题未解决' };
  const label = reasons[input.reason as keyof typeof reasons] ?? pipelineReasons[input.reason] ?? input.reason;
  const ids = [input.instance, input.job_id, input.pipeline_id, input.plan_path].filter(Boolean).map(v => safeDecisionText(v!, 50)).join(' ');
  const verdict = input.reviewer_verdict ? `reviewer 结论 ${safeDecisionText(input.reviewer_verdict, 12)}` : '';
  const environment = input.environment ? `环境/沙箱限制${verdict ? `；${verdict}，但因环境限制 blocked` : ''}` : verdict;
  const advice = input.environment && input.allowed_actions.includes('retry')
    ? '建议 retry 时附说明（跳过受沙箱限制的命令，按其余证据评审）'
    : `建议动作：${safeDecisionText(input.allowed_actions.join('/'), 65) || '等待处理'}`;
  const questions = input.pending_questions?.length ? `；问题 ${input.pending_questions.length}，worker 报告：${safeDecisionText(input.pending_questions[0]!.question, 25)}` : '';
  const prefix = [safeDecisionText(label, 30), ids, environment].filter(Boolean).join('；');
  const suffix = `${questions}；${advice}`;
  const detailBudget = Math.max(0, 300 - prefix.length - suffix.length - '；worker 报告：'.length);
  return safeDecisionText(`${prefix}；worker 报告：${safeDecisionText(input.detail, Math.min(100, detailBudget))}${suffix}`, 300);
}
