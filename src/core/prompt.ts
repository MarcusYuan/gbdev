import { type TaskBrief } from '../contracts/brief.js';
import { fragment } from '../roles/fragments.js';

export const VERDICT_RETRY_NOTICE = fragment('verdict-retry-notice');

/** Orchestrator notes are trusted input, never automated evidence. Shared by M2 and M3. */
export function renderOrchestratorNotes(...notes: readonly (string | null | undefined)[]): string {
  return [...new Set(notes.filter((note): note is string => !!note))]
    .map(note => fragment('orchestrator-notes', { note })).join('');
}

export function renderPrompt(brief: TaskBrief, instructionsText = '', output: { verdict?: boolean; extraFields?: Record<string, unknown>; policyIncidents?: boolean } = {}): string {
  // An empty execution_checks list (B5 default) is omitted so prompts without task_checks stay byte-identical.
  const { execution_checks: executionChecks, ...rest } = brief;
  const view = executionChecks && executionChecks.length > 0 ? brief : rest;
  return `# gbdev worker task\n\n${JSON.stringify(view, null, 2)}\n
## Role
${instructionsText}

${renderWorkerBoundaries(brief.sandbox, brief.network ?? true)}
${renderFinalResponse(brief.sandbox, output.extraFields, output.verdict, output.policyIncidents ? { policyIncidents: true } : {})}`;
}

export function renderWorkerBoundaries(sandbox: TaskBrief['sandbox'], network = true): string {
  return fragment('worker-boundaries', {
    sandbox,
    network_rules: fragment(network ? 'worker-network-enabled' : 'worker-network-disabled'),
    sandbox_rules: fragment(sandbox === 'workspace-write' ? 'worker-boundaries-write' : 'worker-boundaries-readonly'),
  });
}

export function renderFinalResponse(sandbox: TaskBrief['sandbox'], extraFields: Record<string, unknown> = {}, verdict = false,
  options: { policyIncidents?: boolean } = {}): string {
  if (verdict) extraFields = { ...extraFields, review: { verdict: 'revise', findings: [
    { id: 'F1', severity: 'major', file: null, line: null, message: 'Describe an actual finding', suggestion: null },
  ] } };
  if (options.policyIncidents && !Object.hasOwn(extraFields, 'policy_incidents')) {
    extraFields = {
      ...extraFields,
      policy_incidents: [{ violation_index: 0, category: 'temporary_workspace_file', path: 'temporary-example.txt', cleaned: true }],
    };
  }
  const extra = Object.entries(extraFields).map(([key, value]) => `,\n  ${JSON.stringify(key)}:${JSON.stringify(value)}`).join('');
  const body = fragment('final-response', {
    readonly_note: sandbox === 'read-only' ? fragment('final-response-readonly-note') : '',
    extra_fields: extra,
    verdict_section: verdict ? fragment('final-response-verdict') : '',
  });
  return options.policyIncidents ? `${body}${fragment('final-response-policy-incidents')}` : body;
}
