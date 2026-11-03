import type { SeedFindings } from '../contracts/seedFindings.js';
import type { TaskBrief } from '../contracts/brief.js';
import type { Handoff } from '../contracts/handoff.js';
import type { ResolvedRole } from '../contracts/role.js';
import type { Finding } from '../contracts/workerResult.js';
import type { DeciderDecision } from '../contracts/pipelineRun.js';
import { renderFinalResponse, renderWorkerBoundaries } from '../core/prompt.js';
import { fragment } from '../roles/fragments.js';

export const PRIOR_STEPS_BUDGET = 12_000;
const DATA_TOKEN = 'GBDEV_UNTRUSTED_DATA';
const DATA_NOTICE = fragment('untrusted-data-notice');

export function renderUntrustedData(value: unknown, notice = DATA_NOTICE): string {
  const text = JSON.stringify(value, null, 2).replaceAll(DATA_TOKEN, `${DATA_TOKEN}_`);
  return `${notice}\n<<<${DATA_TOKEN}\n${text}\n${DATA_TOKEN}>>>`;
}

/** Bound prompt context only; never truncate the persisted audit history. */
export function renderDecisions(decisions: readonly DeciderDecision[]): string {
  if (!decisions.length) return '';
  const entries = decisions.slice(-20).map(d => ({ ...d, question: d.question.slice(0, 500), answer: d.answer.slice(0, 500),
    truncated: d.question.length > 500 || d.answer.length > 500 }));
  return `${fragment('decisions-header')}${renderUntrustedData({ decisions: entries, truncated: decisions.length > 20 || entries.some(d => d.truncated) },
    fragment('decisions-untrusted-notice'))}`;
}

/** Budget includes the notice, fences and omission marker; use a bounded summary when the newest handoff is oversized. */
export function renderPriorSteps(handoffs: readonly Handoff[], latestPath?: string): string {
  if (!handoffs.length) return '';
  const latest = handoffs.at(-1)!;
  const earlier = handoffs.slice(0, -1).map(h => ({
    instance: h.instance, summary: h.summary, files_changed: h.files_changed,
    verdict: h.verdict?.verdict ?? null, findings_count: h.verdict?.findings.length ?? 0,
    ...(h.warnings?.some(w => w.startsWith('policy_')) ? { policy_warnings: h.warnings.filter(w => w.startsWith('policy_')).slice(0, 5).map(w => w.slice(0, 350)) } : {}),
  }));
  const render = (start: number) => `${start > 0 ? '[earlier handoffs omitted]\n' : ''}${renderUntrustedData([...earlier.slice(start), latest])}`;
  let start = 0, rendered = render(start);
  while (rendered.length > PRIOR_STEPS_BUDGET && start < earlier.length) rendered = render(++start);
  if (rendered.length > PRIOR_STEPS_BUDGET) rendered = `${earlier.length ? '[earlier handoffs omitted]\n' : ''}${renderUntrustedData([{
    instance: latest.instance.slice(0, 80), summary: latest.summary.slice(0, 300),
    files_count: latest.files_changed.length, commits_count: latest.commits.length,
    tests_count: latest.tests.length, checks_count: latest.checks.length,
    verdict: latest.verdict?.verdict ?? null, findings_count: latest.verdict?.findings.length ?? 0,
    ...(latest.warnings?.some(w => w.startsWith('policy_')) ? { policy_warnings: latest.warnings.filter(w => w.startsWith('policy_')).slice(0, 5).map(w => w.slice(0, 350)) } : {}),
    handoff_file: (latestPath ?? `handoffs/${String(latest.seq).padStart(2, '0')}-${latest.instance.replace('#', '-')}.json`).slice(0, 1024),
  }])}`;
  return rendered;
}

export interface StepPromptContext {
  seed_findings?: SeedFindings | null;
  pipeline: string;
  instance: string;
  index: number;
  total: number;
  round: number;
  max_rounds: number;
  kind: 'step' | 'fix';
  diff_base_sha: string;
  role: Pick<ResolvedRole, 'output' | 'instructions_text'>;
  prior_handoffs: readonly Handoff[];
  decisions?: readonly DeciderDecision[];
  latest_handoff_path?: string | undefined;
  previous_verdict?: Handoff;
  fix_findings?: readonly Finding[];
  check_logs?: readonly { id: string; text: string }[];
}

/** Library-only step rendering: no pipeline commands, store, gate or process side effects. */
export function renderStepPrompt(brief: TaskBrief, context: StepPromptContext): string {
  // Read-only jobs never run forwarded task checks; an empty list is omitted so prompts without task_checks stay byte-identical.
  const { execution_checks: executionChecks, gate_checks: gateChecks, ...rest } = brief;
  const forwarded = brief.sandbox === 'read-only' ? [] : [...(executionChecks ?? [])];
  const task = {
    ...rest,
    acceptance_criteria: brief.acceptance_criteria.map(criterion =>
      brief.sandbox === 'read-only' ? { id: criterion.id, text: criterion.text } : { ...criterion }),
    ...(forwarded.length > 0 ? { execution_checks: forwarded } : {}),
  };
  const sections = [
    '# gbdev worker task', `## Role\n${context.role.instructions_text}`,
    renderWorkerBoundaries(brief.sandbox, brief.network ?? true).trimEnd(), `## Task\n${JSON.stringify(task, null, 2)}`,
    `## Pipeline context\nPipeline ${context.pipeline}, step ${context.instance} (${context.index}/${context.total}), round ${context.round}/${context.max_rounds}`,
  ];
  if (gateChecks?.length && (context.role.output === 'change' || brief.role === 'reviewer')) {
    sections.push(`## 合并 gate 将运行的检查（信息性清单）\n${gateChecks.map(c => `- ${c.id}: ${c.cmd}`).join('\n')}\n提交前请在可行时自行运行其中的廉价检查（例如格式检查）；如沙箱限制无法运行，请在报告中说明而不是 blocked。此清单不要求 worker 强制执行全部检查。`);
  }
  const decisions = renderDecisions(context.decisions ?? []);
  if (decisions) sections.push(decisions);
  if (context.role.output === 'verdict') {
    sections.push(fragment('step-review-complete', { diff_base_sha: context.diff_base_sha }));
    if (context.previous_verdict) {
      sections.push(fragment('step-review-increment', { head_after: context.previous_verdict.head_after }));
      sections.push(renderUntrustedData({ previous_findings: context.previous_verdict.verdict?.findings ?? [] }));
    }
  }
  if (context.seed_findings) sections.push(fragment('seed-findings-header'), renderUntrustedData(context.seed_findings));
  if (context.kind === 'fix') {
    const rank = { critical: 0, major: 1, minor: 2, nit: 3 };
    const findings = [...(context.fix_findings ?? [])].sort((a, b) => rank[a.severity] - rank[b.severity]);
    sections.push(fragment('pending-findings'));
    sections.push(renderUntrustedData({ findings: findings.map(finding => ({ ...finding,
      requirement: rank[finding.severity] < 2 ? '必须 / MUST' : finding.severity === 'minor' ? '应当 / SHOULD' : '可选 / optional',
    })), check_logs: (context.check_logs ?? []).map(log => ({ id: log.id,
      tail: log.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').slice(-80).join('\n'),
    })) }));
  }
  sections.push(`## Prior steps\n${renderPriorSteps(context.prior_handoffs, context.latest_handoff_path)}`);
  const extra: Record<string, unknown> = { handoff: { decided: [], rejected: [], risks: [], remaining: [] } };
  sections.push(renderFinalResponse(brief.sandbox, extra, context.role.output === 'verdict', { policyIncidents: true }).trimEnd());
  sections.push(fragment('handoff-include'));
  return `${sections.join('\n\n')}\n`;
}
