import { array, boolean, integer, invalid, nullableString, object, oneOf, schema, string, strings, timestamp } from './validation.js';
import { ANSWER_MAX, EXCERPT_MAX, RESULT_JSON_MAX, utf8Bytes } from '../inspect/limits.js';

export const INSPECT_WARNINGS = [
  'input_truncated', 'output_truncated', 'whole_file_omitted', 'tests_unavailable', 'tests_stale',
  'log_unavailable', 'binary_omitted', 'active_target_base_only', 'uncommitted_excluded',
] as const;
export type InspectWarning = typeof INSPECT_WARNINGS[number];

export interface InspectTarget {
  kind: 'run' | 'job';
  id: string;
  run_id: string | null;
  task_id: string | null;
  job_id: string | null;
  pipeline_id: string | null;
}

export interface InspectSnapshot {
  mode: 'committed';
  target_sha: string;
  diff_base_sha: string;
  captured_at: string;
  uncommitted_included: false;
}

export interface InspectExcerpt {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
}

export interface InspectCheckCoverage {
  source_id: string;
  check_id: string;
  exit_code: number | null;
  checked_sha: string | null;
  log_available: boolean;
}

export interface InspectResult {
  schema: 'gbdev.inspect-result.v1';
  job_id: string;
  target: InspectTarget;
  snapshot: InspectSnapshot;
  answer: string;
  excerpts: InspectExcerpt[];
  coverage: {
    files: { requested: string[]; omitted: string[] };
    diff: { requested: boolean; available: boolean; truncated: boolean };
    tests: { requested: boolean; available: boolean; checks: InspectCheckCoverage[]; truncated: boolean };
  };
  truncated: boolean;
  warnings: InspectWarning[];
}

export interface InspectStartResult {
  schema: 'gbdev.inspect-start.v1';
  job_id: string;
  state: string;
  target: InspectTarget;
  snapshot: InspectSnapshot;
  question: string;
  paths: string[];
  diff: boolean;
  tests: boolean;
  dashboard: {
    enabled: boolean;
    reason: string | null;
    session: string | null;
    window: string;
    attach_hint: string | null;
    watch_hint: string;
  };
  notify: { enabled: boolean; reason: string | null; endpoint_host: string | null };
}

export interface JobInspectionMeta {
  workspace_owned: true;
  detached: true;
  question: string;
  paths: string[];
  diff: boolean;
  tests: boolean;
  target: InspectTarget;
  snapshot: InspectSnapshot;
}

const SHA = /^[0-9a-f]{40}$/;

function target(value: unknown, name: string): InspectTarget {
  const v = object(value, name);
  oneOf(v.kind, ['run', 'job'], `${name}.kind`);
  string(v.id, `${name}.id`);
  for (const key of ['run_id', 'task_id', 'job_id', 'pipeline_id'] as const) nullableString(v[key], `${name}.${key}`);
  return v as unknown as InspectTarget;
}

function snapshot(value: unknown, name: string): InspectSnapshot {
  const v = object(value, name);
  if (v.mode !== 'committed') invalid(`${name}.mode must be committed`);
  string(v.target_sha, `${name}.target_sha`);
  string(v.diff_base_sha, `${name}.diff_base_sha`);
  if (!SHA.test(v.target_sha) || !SHA.test(v.diff_base_sha)) invalid(`${name} SHAs must be full lowercase hashes`);
  timestamp(v.captured_at, `${name}.captured_at`);
  if (v.uncommitted_included !== false) invalid(`${name}.uncommitted_included must be false`);
  return v as unknown as InspectSnapshot;
}

export function validateInspectTarget(value: unknown): InspectTarget {
  return target(value, 'target');
}

export function validateInspectSnapshot(value: unknown): InspectSnapshot {
  return snapshot(value, 'snapshot');
}

export function validateJobInspectionMeta(value: unknown): JobInspectionMeta {
  const v = object(value, 'inspection');
  if (v.workspace_owned !== true || v.detached !== true) invalid('inspection workspace must be owned and detached');
  string(v.question, 'inspection.question');
  strings(v.paths, 'inspection.paths');
  boolean(v.diff, 'inspection.diff');
  boolean(v.tests, 'inspection.tests');
  target(v.target, 'inspection.target');
  snapshot(v.snapshot, 'inspection.snapshot');
  return v as unknown as JobInspectionMeta;
}

function hints(value: Record<string, unknown>): void {
  const dashboard = object(value.dashboard, 'dashboard');
  boolean(dashboard.enabled, 'dashboard.enabled');
  if (dashboard.reason !== null && typeof dashboard.reason !== 'string') invalid('dashboard.reason must be a string or null');
  if (dashboard.session !== null && typeof dashboard.session !== 'string') invalid('dashboard.session must be a string or null');
  string(dashboard.window, 'dashboard.window');
  if (dashboard.attach_hint !== null && typeof dashboard.attach_hint !== 'string') invalid('dashboard.attach_hint must be a string or null');
  string(dashboard.watch_hint, 'dashboard.watch_hint');
  const notify = object(value.notify, 'notify');
  boolean(notify.enabled, 'notify.enabled');
  if (notify.reason !== null && typeof notify.reason !== 'string') invalid('notify.reason must be a string or null');
  if (notify.endpoint_host !== null && typeof notify.endpoint_host !== 'string') invalid('notify.endpoint_host must be a string or null');
}

export function validateInspectStart(value: unknown): InspectStartResult {
  const v = object(value, 'inspect-start');
  schema(v, 'gbdev.inspect-start.v1');
  string(v.job_id, 'job_id');
  string(v.state, 'state');
  target(v.target, 'target');
  snapshot(v.snapshot, 'snapshot');
  string(v.question, 'question');
  strings(v.paths, 'paths');
  boolean(v.diff, 'diff');
  boolean(v.tests, 'tests');
  hints(v);
  return v as unknown as InspectStartResult;
}

export function validateInspectResult(value: unknown): InspectResult {
  const v = object(value, 'inspect-result');
  schema(v, 'gbdev.inspect-result.v1');
  string(v.job_id, 'job_id');
  target(v.target, 'target');
  snapshot(v.snapshot, 'snapshot');
  string(v.answer, 'answer');
  if (utf8Bytes(v.answer) > ANSWER_MAX) invalid('answer exceeds 2048 bytes');
  const excerpts = array(v.excerpts, 'excerpts');
  if (excerpts.length > EXCERPT_MAX) invalid('too many excerpts');
  excerpts.forEach((item, i) => {
    const excerpt = object(item, `excerpts[${i}]`);
    string(excerpt.path, `excerpts[${i}].path`);
    integer(excerpt.start_line, `excerpts[${i}].start_line`, 1);
    integer(excerpt.end_line, `excerpts[${i}].end_line`, 1);
    if (excerpt.start_line > excerpt.end_line) invalid(`excerpts[${i}] start_line must be <= end_line`);
    if (typeof excerpt.text !== 'string') invalid(`excerpts[${i}].text must be a string`);
  });
  const coverage = object(v.coverage, 'coverage');
  const files = object(coverage.files, 'coverage.files');
  strings(files.requested, 'coverage.files.requested');
  strings(files.omitted, 'coverage.files.omitted');
  const diff = object(coverage.diff, 'coverage.diff');
  for (const key of ['requested', 'available', 'truncated'] as const) boolean(diff[key], `coverage.diff.${key}`);
  const tests = object(coverage.tests, 'coverage.tests');
  boolean(tests.requested, 'coverage.tests.requested');
  boolean(tests.available, 'coverage.tests.available');
  boolean(tests.truncated, 'coverage.tests.truncated');
  array(tests.checks, 'coverage.tests.checks').forEach((item, i) => {
    const check = object(item, `checks[${i}]`);
    string(check.source_id, `checks[${i}].source_id`);
    string(check.check_id, `checks[${i}].check_id`);
    if (check.exit_code !== null) integer(check.exit_code, `checks[${i}].exit_code`, -2_147_483_648, 2_147_483_647);
    nullableString(check.checked_sha, `checks[${i}].checked_sha`);
    boolean(check.log_available, `checks[${i}].log_available`);
  });
  boolean(v.truncated, 'truncated');
  const warnings = array(v.warnings, 'warnings');
  warnings.forEach((item, i) => oneOf(item, INSPECT_WARNINGS, `warnings[${i}]`));
  if (utf8Bytes(JSON.stringify(v)) > RESULT_JSON_MAX) invalid('inspect result exceeds 16384 bytes');
  return v as unknown as InspectResult;
}
