import { RoleRegistry } from '../roles/registry.js';
import { GbdevError } from './error.js';
import { isAbsolute } from 'node:path';
import { assertRepoAllowed, type Config } from '../core/config.js';
import { validateIdentifier, validateJobId } from '../core/ids.js';
import { array, integer, invalid, nullableString, object, oneOf, schema, string, strings } from './validation.js';

export const PROVIDERS = ['codex', 'cursor', 'fake'] as const;
export const SANDBOXES = ['read-only', 'workspace-write'] as const;
export type Provider = typeof PROVIDERS[number];
export type Role = string;
export type Sandbox = typeof SANDBOXES[number];

/** Validated, role-resolved brief persisted for a job; incoming JSON may omit routing defaults. */
export interface TaskBrief {
  schema: 'gbdev.task-brief.v1';
  brief_id: string;
  repo: string;
  base_ref: string;
  role: Role;
  provider: Provider;
  model: string | null;
  sandbox: Sandbox;
  timeout_min: number;
  stall_timeout_s?: number;
  network: boolean;
  goal: string;
  context: string;
  constraints: string[];
  allowed_paths: string[];
  acceptance_criteria: { id: string; text: string; check_cmd?: string }[];
  /** Trusted catalog checks frozen for change-step finalize; default []. */
  execution_checks?: { id: string; cmd: string; timeout_min: number }[];
  /** Informational merge gate catalog; never executed by finalize. */
  gate_checks?: { id: string; cmd: string }[];
  required_evidence: string[];
  parent_job_id: string | null;
  answers: { question_id: string; answer: string }[];
}

export function validateBrief(value: unknown, config: Config, registry = new RoleRegistry()): TaskBrief {
  const v = { ...object(value, 'brief') };
  schema(v, 'gbdev.task-brief.v1');
  string(v.brief_id, 'brief_id');
  string(v.repo, 'repo');
  if (!isAbsolute(v.repo)) invalid('repo must be absolute');
  validateIdentifier(v.base_ref, 'base_ref');
  string(v.role, 'role');
  const role = registry.resolve(v.role);
  v.role = role.name;
  if (v.provider === undefined) v.provider = role.provider;
  if (v.sandbox === undefined) v.sandbox = role.sandbox;
  oneOf(v.provider, PROVIDERS, 'provider');
  oneOf(v.sandbox, SANDBOXES, 'sandbox');
  if (v.model === undefined) v.model = v.provider === 'codex' ? role.codex_model : null;
  if (v.provider === 'cursor' && v.model !== null && v.model !== 'auto') throw new GbdevError('cursor_model_not_allowed', 'Cursor model must be null or auto');
  if (!role.allowed_providers.includes(v.provider)) throw new GbdevError('config_invalid', 'Provider is not allowed by role', { code: 'role_provider_not_allowed' });
  if (v.sandbox !== role.sandbox) throw new GbdevError('config_invalid', 'Sandbox does not match role', { code: 'role_sandbox_mismatch' });
  nullableString(v.model, 'model');
  if (v.timeout_min === undefined) v.timeout_min = role.default_timeout_min ?? config.default_timeout_min;
  if (v.stall_timeout_s === undefined) v.stall_timeout_s = role.default_stall_timeout_s ?? config.default_stall_timeout_s;
  integer(v.timeout_min, 'timeout_min', 1, 240);
  integer(v.stall_timeout_s, 'stall_timeout_s');
  if (v.network === undefined) v.network = true;
  if (typeof v.network !== 'boolean') invalid('network must be a boolean');
  string(v.goal, 'goal');
  if (typeof v.context !== 'string') invalid('context must be a string');
  strings(v.constraints, 'constraints');
  strings(v.allowed_paths, 'allowed_paths', true);
  strings(v.required_evidence, 'required_evidence');
  const criterionIds = new Set<string>();
  array(v.acceptance_criteria, 'acceptance_criteria').forEach((item, i) => {
    const criterion = object(item, `acceptance_criteria[${i}]`);
    string(criterion.id, 'criterion.id');
    if (criterionIds.has(criterion.id)) invalid('acceptance criterion ids must be unique');
    criterionIds.add(criterion.id);
    string(criterion.text, 'criterion.text');
    if (criterion.check_cmd !== undefined) string(criterion.check_cmd, 'criterion.check_cmd');
  });
  // B5: execution_checks is optional; absent stays absent so briefs without task_checks keep their old shape (consumers use ?? []).
  const executionIds = new Set<string>();
  if (v.execution_checks !== undefined) array(v.execution_checks, 'execution_checks').forEach((item, i) => {
    const check = object(item, `execution_checks[${i}]`);
    string(check.id, 'execution_checks.id');
    if (executionIds.has(check.id)) invalid('execution_checks ids must be unique');
    executionIds.add(check.id);
    string(check.cmd, 'execution_checks.cmd');
    integer(check.timeout_min, 'execution_checks.timeout_min', 1, 60);
  });
  if (v.gate_checks !== undefined) array(v.gate_checks, 'gate_checks').forEach(item => {
    const check = object(item, 'gate_check');
    string(check.id, 'gate_check.id'); string(check.cmd, 'gate_check.cmd');
    if (Object.keys(check).some(key => !['id', 'cmd'].includes(key))) invalid('Unknown gate_check field');
  });
  if (v.parent_job_id !== null) validateJobId(v.parent_job_id);
  array(v.answers, 'answers').forEach((item, i) => {
    const answer = object(item, `answers[${i}]`);
    string(answer.question_id, 'answer.question_id');
    string(answer.answer, 'answer.answer');
  });
  assertRepoAllowed(v.repo, config);
  return v as unknown as TaskBrief;
}
