import type { TaskBrief } from '../contracts/brief.js';
import { renderOrchestratorNotes, renderPrompt, VERDICT_RETRY_NOTICE } from '../core/prompt.js';
import { appendMissingResultRetryPrompt } from '../core/missingResultRetry.js';
import { renderUntrustedData } from '../pipeline/prompt.js';
import { fragment } from '../roles/fragments.js';

/** Pure runJob prompt assembly — shared by production and M6 snapshot. */
export function assembleRunJobPrompt(input: {
  brief: TaskBrief;
  instructionsText: string;
  roleOutput: 'change' | 'verdict' | 'report';
  planning: boolean;
  resolving: boolean;
  extraFields?: Record<string, unknown>;
  notes?: readonly (string | null | undefined)[];
  evidence: string;
}): string {
  const requirements = input.planning
    ? fragment('planner-requirements')
    : input.resolving
      ? fragment('resolver-requirements')
      : '';
  return renderPrompt(input.brief, input.instructionsText, {
    extraFields: input.extraFields ?? {},
    verdict: input.roleOutput === 'verdict',
    policyIncidents: true,
  })
    + requirements
    + renderOrchestratorNotes(...(input.notes ?? []))
    + fragment('run-job-evidence-header')
    + renderUntrustedData(input.evidence);
}

/** Pure finalReview prompt assembly — shared by production and M6 snapshot. */
export function assembleFinalReviewPrompt(input: {
  brief: TaskBrief;
  instructionsText: string;
  notes?: readonly (string | null | undefined)[];
  untrusted: string;
  includeRetryNotice: boolean;
  /** When true, omit untrusted header/body (caller supplies bounded section). */
  omitUntrusted?: boolean;
  /** B6: prior final-review job id + text for missing-result retry enrichment. */
  previousJobId?: string;
  previousFinalText?: string | null;
  previousHeadSha?: string | null;
}): string {
  const base = renderPrompt(input.brief, input.instructionsText, { verdict: true })
    + renderOrchestratorNotes(...(input.notes ?? []))
    + (input.omitUntrusted ? '' : fragment('final-review-untrusted-header') + renderUntrustedData(input.untrusted));
  if (!input.includeRetryNotice) return base;
  if (input.previousJobId) {
    return appendMissingResultRetryPrompt(base, {
      previousJobId: input.previousJobId,
      previousFinalText: input.previousFinalText ?? null,
      headSha: input.previousHeadSha ?? null,
    });
  }
  return base + VERDICT_RETRY_NOTICE;
}

/** Static rebuild/retry line for lane retry context (dynamic history remains in supervisor). */
export function rebuildOrRetryLine(kind: 'rebuild' | 'retry'): string {
  return fragment(kind === 'rebuild' ? 'task-rebuild-context' : 'task-retry-context');
}

/** Static integration-fix context prefix; caller supplies the integrated task id list. */
export function integrationFixContextLine(integratedTasks: string): string {
  return fragment('integration-fix-context', { integrated_tasks: integratedTasks });
}
