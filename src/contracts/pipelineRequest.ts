import { validateSeedFindings, validateRunBinding, type SeedFindings, type RunBinding } from './seedFindings.js';
import { createHash } from 'node:crypto';
import { validateBrief, type Provider, type TaskBrief } from './brief.js';
import { type Config } from '../core/config.js';
import { fields, pipelineInvalid, range, record, validatePipeline, type PipelineDefinition } from './pipeline.js';
import { PipelineRegistry } from '../pipeline/definitions.js';
import type { ResolvedRole } from './role.js';
import { findExecutable } from '../core/proc.js';
import { GbdevError } from './error.js';
import { providerAdapter } from '../providers/index.js';
import { validateIdentifier } from '../core/ids.js';
import { assertNotReservedRoleId } from '../roles/reserved.js';
export interface StepOverride { provider?: Provider; codex_model?: string | null; cursor_model?: 'auto'; timeout_min?: number; stall_timeout_s?: number }
export interface PipelineRequest extends Pick<TaskBrief, 'repo' | 'base_ref' | 'goal' | 'context' | 'constraints' | 'allowed_paths' | 'acceptance_criteria' | 'execution_checks' | 'gate_checks' | 'required_evidence' | 'network'> {
  seed_findings?: SeedFindings | null; run_binding?: RunBinding;
  schema: 'gbdev.pipeline-request.v1'; request_id: string; pipeline: string | PipelineDefinition; diff_base_ref: string | null;
  step_overrides: Record<string, StepOverride>; max_rounds: number; timeout_min: number; max_total_jobs: number;
}
export interface SnapshotStep { role: string; source: ResolvedRole['source']; output: ResolvedRole['output']; sandbox: TaskBrief['sandbox']; provider: Provider; model: string | null; timeout_min: number; stall_timeout_s: number; bin: string }
export interface RoleSnapshot { schema: 'gbdev.role-snapshot.v1'; pipeline_id: string; resolved_at: string; steps: Record<string, SnapshotStep>; instructions_text: Record<string, string>; instructions_sha256: Record<string, string> }
export function resolveRequest(value: unknown, config: Config, registry: PipelineRegistry, options: { internal?: boolean } = {}): { request: PipelineRequest; definition: PipelineDefinition; snapshot: RoleSnapshot } {
  const v = record(value, 'request');
  fields(v, ['schema', 'request_id', 'pipeline', 'repo', 'base_ref', 'diff_base_ref', 'goal', 'context', 'constraints', 'allowed_paths', 'acceptance_criteria', 'required_evidence', 'execution_checks', 'gate_checks', 'step_overrides', 'max_rounds', 'timeout_min', 'max_total_jobs', 'network', 'seed_findings', 'run_binding']);
  if ('run_binding' in v && !options.internal) pipelineInvalid('run_binding is internal to run supervisor');
  const binding = 'run_binding' in v ? validateRunBinding(v.run_binding) : undefined;
  if (v.schema !== 'gbdev.pipeline-request.v1' || typeof v.request_id !== 'string' || !v.request_id.trim()) pipelineInvalid('Invalid request schema/request_id');
  const definition = typeof v.pipeline === 'string' ? registry.resolve(v.pipeline) : validatePipeline(v.pipeline, registry.roles);
  if (!options.internal && ['integration-fix', 'final-fix'].includes(definition.name)) pipelineInvalid('This template is internal to run supervisor');
  const seed = v.seed_findings === undefined || v.seed_findings === null ? null : validateSeedFindings(v.seed_findings);
  if (seed && definition.steps[0]?.role !== 'fixer') pipelineInvalid('seed_findings requires the first step to use the fixer role');
  const overrides = record(v.step_overrides ?? {}, 'step_overrides');
  for (const id of Object.keys(overrides)) assertNotReservedRoleId(id, 'step_overrides');
  const defaults = config.pipeline_defaults;
  const max_rounds = v.max_rounds ?? definition.fix_loop?.max_rounds ?? defaults?.max_rounds ?? 2;
  const timeout_min = v.timeout_min ?? definition.timeout_min ?? defaults?.timeout_min ?? 240;
  const max_total_jobs = v.max_total_jobs ?? defaults?.max_total_jobs ?? 12;
  range(max_rounds, 'max_rounds', 0, 5); range(timeout_min, 'timeout_min', 30, 480); range(max_total_jobs, 'max_total_jobs', 1, 20);
  const diff = v.diff_base_ref ?? null;
  if (diff !== null) validateIdentifier(diff, 'diff_base_ref');
  if (!definition.steps.some(s => registry.roles.resolve(s.role).output === 'change') && diff === null && definition.steps.some(s => registry.roles.resolve(s.role).output === 'verdict')) pipelineInvalid('review-only requires diff_base_ref');
  const allSteps = [...definition.steps, ...(definition.fix_loop ? [{ id: 'fix', role: definition.fix_loop.fix_role }] : [])];
  for (const id of Object.keys(overrides)) if (!allSteps.some(s => s.id === id)) pipelineInvalid(`Unknown override step: ${id}`);
  const snapshot: RoleSnapshot = { schema: 'gbdev.role-snapshot.v1', pipeline_id: '', resolved_at: '', steps: {}, instructions_text: {}, instructions_sha256: {} };
  let task: TaskBrief | undefined;
  for (const step of allSteps) {
    const role = registry.roles.resolve(step.role), o = record(overrides[step.id] ?? {}, 'override');
    if (typeof o.role === 'string') assertNotReservedRoleId(o.role, 'override.role');
    if (typeof o.name === 'string') assertNotReservedRoleId(o.name, 'override.name');
    fields(o, ['provider', 'codex_model', 'cursor_model', 'timeout_min', 'stall_timeout_s']);
    if (o.codex_model !== undefined && o.codex_model !== null && (typeof o.codex_model !== 'string' || !o.codex_model.trim())) pipelineInvalid('codex_model must be nonempty or null');
    const provider = o.provider ?? role.provider;
    if (!role.allowed_providers.includes(provider as Provider)) pipelineInvalid('Provider not allowed by role');
    task = validateBrief({ ...v, schema: 'gbdev.task-brief.v1', brief_id: v.request_id, role: role.name, provider,
      sandbox: role.sandbox, model: provider === 'codex' ? (o.codex_model === undefined ? role.codex_model : typeof o.codex_model === 'string' ? o.codex_model.trim() : null) : provider === 'cursor' ? 'auto' : null,
      timeout_min: o.timeout_min ?? role.default_timeout_min, stall_timeout_s: o.stall_timeout_s ?? role.default_stall_timeout_s,
      parent_job_id: null, answers: [] }, config, registry.roles);
    const bin = provider === 'fake' ? process.execPath : findExecutable(config.providers[provider as 'codex' | 'cursor'].bin);
    if (!bin) throw new GbdevError('provider_not_found', 'Provider executable not found', { provider });
    providerAdapter(task.provider).buildInvocation({ bin, worktree: '', jobDir: '', prompt: '', sandbox: task.sandbox, network: task.network, model: task.model });
    snapshot.steps[step.id] = { role: role.name, source: role.source, output: role.output, sandbox: task.sandbox, provider: task.provider, model: task.model, timeout_min: task.timeout_min, stall_timeout_s: task.stall_timeout_s!, bin };
    snapshot.instructions_text[role.name] = role.instructions_text;
    snapshot.instructions_sha256[role.name] = createHash('sha256').update(role.instructions_text).digest('hex');
  }
  const request: PipelineRequest = { ...('seed_findings' in v ? { seed_findings: seed } : {}), ...(binding ? { run_binding: binding } : {}), schema: 'gbdev.pipeline-request.v1', request_id: v.request_id, pipeline: typeof v.pipeline === 'string' ? v.pipeline : definition,
    repo: task!.repo, base_ref: task!.base_ref, goal: task!.goal, context: task!.context, constraints: task!.constraints, allowed_paths: task!.allowed_paths,
    ...(task!.gate_checks?.length ? { gate_checks: structuredClone(task!.gate_checks) } : {}),
    acceptance_criteria: task!.acceptance_criteria, execution_checks: structuredClone(task!.execution_checks ?? []), required_evidence: task!.required_evidence, network: task!.network,
    diff_base_ref: diff as string | null, step_overrides: structuredClone(overrides) as Record<string, StepOverride>, max_rounds, timeout_min, max_total_jobs };
  return { request, definition, snapshot };
}
