#!/usr/bin/env node
/**
 * Capture builtin roles + rendered prompt matrix from dist/ (zero deps).
 * Used once on pre-S1 code to write test/fixtures/m6-prompts.snapshot.json;
 * tests re-import capturePrompts() against post-S1 dist and deepStrictEqual.
 *
 * Internal prompts (planner/resolver/conflictVerifier/finalReview) go through
 * the same pure assemblers as production (assembleRunJobPrompt /
 * assembleFinalReviewPrompt). integrationFix/finalFix keep the historical
 * step-prompt alias for the committed master snapshot; legal seed coverage
 * lives in test/m6-s1-roles.test.ts without new snapshot entries.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Historical M6 builtin set — snapshot fixtures stay frozen at these six names. */
const M6_ROLE_NAMES = ['planner', 'executor', 'fixer', 'reviewer', 'verifier', 'resolver'];

function projectM6Roles(roles) {
  const byName = new Map(roles.map(r => [r.name, r]));
  return M6_ROLE_NAMES.map(name => {
    const role = byName.get(name);
    if (!role) throw new Error(`m6-prompt-snapshot: missing historical role ${name}`);
    return role;
  });
}

function brief(sandbox) {
  return {
    schema: 'gbdev.task-brief.v1',
    brief_id: 'b_m6_snapshot_001',
    repo: '/snapshot/repo',
    base_ref: 'abc0001',
    role: 'executor',
    provider: 'fake',
    model: null,
    sandbox,
    timeout_min: 30,
    network: false,
    goal: 'Snapshot goal',
    context: 'Snapshot context',
    constraints: ['No new dependencies'],
    allowed_paths: ['src/**', 'test/**'],
    acceptance_criteria: [{ id: 'AC1', text: 'Tests pass', check_cmd: 'npm test' }],
    required_evidence: ['tests'],
    parent_job_id: null,
    answers: [],
  };
}

function handoff(seq) {
  return {
    schema: 'gbdev.handoff.v1',
    pipeline_id: 'p_m6_snapshot',
    seq,
    instance: `implement#${seq}`,
    role: 'executor',
    output: 'change',
    created_at: '2026-10-26T10:00:00-07:00',
    summary: `summary ${seq}`,
    files_changed: [`src/file${seq}.ts`],
    commits: [`deadbeef${seq} commit ${seq}`],
    tests: [],
    checks: [],
    evidence: [],
    decided: [],
    rejected: [],
    risks: [],
    remaining: [],
    open_questions: [],
    blockers: [],
    head_before: `base${seq}`,
    head_after: `head${seq}`,
    verdict: null,
  };
}

export async function capturePrompts(distRoot = join(ROOT, 'dist')) {
  const dist = pathToFileURL(join(distRoot, '/')).href;
  const { builtinRoles } = await import(`${dist}roles/builtin.js`);
  const { RoleRegistry } = await import(`${dist}roles/registry.js`);
  const {
    renderPrompt,
    renderWorkerBoundaries,
    renderFinalResponse,
    renderOrchestratorNotes,
    VERDICT_RETRY_NOTICE,
  } = await import(`${dist}core/prompt.js`);
  const { renderStepPrompt, renderUntrustedData, renderDecisions, renderPriorSteps } =
    await import(`${dist}pipeline/prompt.js`);
  const { assembleRunJobPrompt, assembleFinalReviewPrompt } =
    await import(`${dist}run/promptAssembly.js`);
  const { fragment } = await import(`${dist}roles/fragments.js`);

  const registry = new RoleRegistry(undefined);
  const fullList = registry.list();
  const m6RoleSummaries = fullList.roles.filter(r => M6_ROLE_NAMES.includes(r.name));
  const list = {
    ...fullList,
    roles: M6_ROLE_NAMES.map(name => {
      const role = m6RoleSummaries.find(r => r.name === name) ?? fullList.roles.find(r => r.name === name);
      if (!role) throw new Error(`m6-prompt-snapshot: missing historical role summary ${name}`);
      return role;
    }).sort((a, b) => a.name.localeCompare(b.name, 'en')),
  };
  const show = {};
  for (const name of [...M6_ROLE_NAMES, 'code-reviewer']) {
    show[name] = registry.resolve(name);
  }

  const extraFields = { handoff: { decided: [], rejected: [], risks: [], remaining: [] } };
  const renderPromptMatrix = {};
  for (const sandbox of ['workspace-write', 'read-only']) {
    for (const verdict of [false, true]) {
      for (const withExtra of [false, true]) {
        for (const withNotes of [false, true]) {
          const key = [
            sandbox === 'workspace-write' ? 'write' : 'readonly',
            verdict ? 'verdict' : 'no-verdict',
            withExtra ? 'extra' : 'no-extra',
            withNotes ? 'notes' : 'no-notes',
          ].join('/');
          let text = renderPrompt(brief(sandbox), 'Role instructions.', {
            verdict,
            ...(withExtra ? { extraFields } : {}),
          });
          if (withNotes) text += renderOrchestratorNotes('authorize AC1', 'retry note');
          renderPromptMatrix[key] = text;
        }
      }
    }
  }

  const finding = {
    id: 'F1',
    severity: 'major',
    file: 'src/a.ts',
    line: 10,
    message: 'Bug',
    suggestion: null,
  };
  const previous = {
    ...handoff(1),
    head_after: 'def456',
    verdict: { verdict: 'revise', normalized_from: null, findings: [finding] },
  };
  const decisions = [
    {
      instance: 'implement#1',
      attempt: 1,
      question_id: 'Q1',
      question: 'Which behavior?',
      answer: 'Option A',
      at: '2026-10-26T10:00:00-07:00',
    },
  ];
  // Historical shape retained for the committed master snapshot's stepPrompts /
  // integrationFix / finalFix aliases (must not change those snapshot entries).
  const seed = {
    schema: 'gbdev.seed-findings.v1',
    source: 'final_review',
    findings: [finding],
    logs: [{ id: 'gate', tail: 'line1\nline2' }],
  };

  const stepBase = {
    pipeline: 'implement-review',
    instance: 'review#1',
    index: 2,
    total: 2,
    round: 1,
    max_rounds: 2,
    kind: 'step',
    diff_base_sha: 'abc123',
    role: { output: 'verdict', instructions_text: 'Role instructions.' },
    prior_handoffs: [handoff(1), handoff(2)],
    decisions,
    latest_handoff_path: 'handoffs/02-implement-2.json',
    previous_verdict: previous,
  };

  const stepPrompts = {
    reviewWithPriorDecisionsAndPrevious: renderStepPrompt(
      { ...brief('read-only'), role: 'reviewer', sandbox: 'read-only' },
      stepBase,
    ),
    fixWithSeedAndFindings: renderStepPrompt(brief('workspace-write'), {
      ...stepBase,
      instance: 'fix#1',
      index: 3,
      kind: 'fix',
      role: { output: 'change', instructions_text: 'Fix instructions.' },
      seed_findings: seed,
      fix_findings: [
        finding,
        { ...finding, id: 'F2', severity: 'nit' },
        { ...finding, id: 'F3', severity: 'critical' },
      ],
      check_logs: [{ id: 'AC1', text: 'check ok\n' }],
      previous_verdict: undefined,
    }),
    implementPlain: renderStepPrompt(brief('workspace-write'), {
      ...stepBase,
      instance: 'implement#1',
      index: 1,
      kind: 'step',
      role: { output: 'change', instructions_text: 'Implement.' },
      prior_handoffs: [],
      decisions: [],
      previous_verdict: undefined,
    }),
  };

  const plannerBrief = {
    ...brief('read-only'),
    role: 'planner',
    sandbox: 'read-only',
    goal: 'Decompose the goal',
    acceptance_criteria: [],
  };
  const plannerExtra = {
    task_graph: {
      schema: 'gbdev.task-graph.v1',
      summary: 'Describe the task decomposition',
      tasks: [
        {
          id: 'task-1',
          title: 'Task title',
          goal: 'Describe the change',
          context: '',
          depends_on: [],
          file_scope: ['src/example.ts'],
          acceptance_criteria: [{ id: 'AC1', text: 'Describe acceptance', check: null }],
          pipeline: null,
          size: 'S',
          notes: null,
        },
      ],
    },
  };
  const resolverBrief = {
    ...brief('workspace-write'),
    role: 'resolver',
    goal: fragment('resolver-goal'),
    acceptance_criteria: [],
  };
  const resolverExtra = {
    resolution: {
      files: [
        {
          path: 'src/example.ts',
          strategy: 'both',
          note: 'Describe how both sides intent is preserved',
        },
      ],
      unresolved: [],
    },
  };
  const verifierBrief = {
    ...brief('read-only'),
    role: 'verifier',
    sandbox: 'read-only',
    goal: fragment('verifier-goal'),
    acceptance_criteria: [],
  };
  const evidencePayload = JSON.stringify({ conflicts: ['src/a.ts'], note: 'fake' });

  const finalReviewBrief = {
    ...brief('read-only'),
    role: 'reviewer',
    sandbox: 'read-only',
    acceptance_criteria: [{ id: 'AC1', text: 'Tests pass' }],
  };
  const finalReviewUntrusted = 'diff text\n' + JSON.stringify({ tasks: [], pipelines: [] });

  const internalPrompts = {
    planner: assembleRunJobPrompt({
      brief: plannerBrief,
      instructionsText: 'Planner instructions.',
      roleOutput: 'report',
      planning: true,
      resolving: false,
      extraFields: plannerExtra,
      notes: ['plan note'],
      evidence: evidencePayload,
    }),
    resolver: assembleRunJobPrompt({
      brief: resolverBrief,
      instructionsText: 'Resolver instructions.',
      roleOutput: 'change',
      planning: false,
      resolving: true,
      extraFields: resolverExtra,
      notes: ['authorize test expectation for AC1'],
      evidence: evidencePayload,
    }),
    conflictVerifier: assembleRunJobPrompt({
      brief: verifierBrief,
      instructionsText: 'Verifier instructions.',
      roleOutput: 'verdict',
      planning: false,
      resolving: false,
      notes: [],
      evidence: evidencePayload,
    }),
    // Retry branch (includeRetryNotice=true) matches the committed master snapshot entry.
    finalReview: assembleFinalReviewPrompt({
      brief: finalReviewBrief,
      instructionsText: 'Reviewer instructions.',
      notes: ['accepted by decider'],
      untrusted: finalReviewUntrusted,
      includeRetryNotice: true,
    }),
    // Historical aliases — do not diverge from committed snapshot entries.
    // Production first-step seed coverage (kind:'step', round:0) lives in
    // test/fixtures/m6-prompts.snapshot-extra.json + test/m6-s1-roles.test.ts.
    integrationFix: stepPrompts.fixWithSeedAndFindings,
    finalFix: stepPrompts.fixWithSeedAndFindings,
  };

  return {
    schema: 'gbdev.m6-prompts.snapshot.v1',
    builtinRoles: projectM6Roles(builtinRoles()),
    roles: { list, show },
    renderPromptMatrix,
    stepPrompts,
    internalPrompts,
    pieces: {
      VERDICT_RETRY_NOTICE,
      workerBoundariesWrite: renderWorkerBoundaries('workspace-write'),
      workerBoundariesReadonly: renderWorkerBoundaries('read-only'),
      finalResponseWrite: renderFinalResponse('workspace-write'),
      finalResponseReadonlyVerdict: renderFinalResponse('read-only', {}, true),
      finalResponseWithExtra: renderFinalResponse('workspace-write', extraFields, false),
      orchestratorNotes: renderOrchestratorNotes('note-a', 'note-b', 'note-a'),
      decisions: renderDecisions(decisions),
      priorSteps: renderPriorSteps([handoff(1), handoff(2)], 'handoffs/02-implement-2.json'),
      untrustedData: renderUntrustedData({ hello: 'world' }),
    },
  };
}

async function main() {
  const out = join(ROOT, 'test/fixtures/m6-prompts.snapshot.json');
  mkdirSync(dirname(out), { recursive: true });
  const data = await capturePrompts();
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(`wrote ${out}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
