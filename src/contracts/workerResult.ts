import { taskGraphSchema, type TaskGraph } from './taskGraph.js';
import { mergeResolutionSchema, type MergeResolution } from './mergeResolution.js';
import { schemaErrors } from './runValidation.js';
import type { WorkerSchemaOptions } from './workerResultSchema.js';
import { GbdevError } from './error.js';
import { array, boolean, integer, invalid, nullableString, object, oneOf, schema, string, strings } from './validation.js';

export const WORKER_STATUSES = ['succeeded', 'needs_input', 'blocked', 'failed'] as const;
export const VERDICTS = ['approve', 'revise', 'reject'] as const;
export const SEVERITIES = ['critical', 'major', 'minor', 'nit'] as const;
export const HANDOFF_FIELDS = ['decided', 'rejected', 'risks', 'remaining'] as const;
export type WorkerHandoff = Record<typeof HANDOFF_FIELDS[number], string[]>;
export interface Finding {
  id: string;
  severity: typeof SEVERITIES[number];
  file: string | null;
  line: number | null;
  message: string;
  suggestion: string | null;
}
export interface Review {
  verdict: typeof VERDICTS[number];
  findings: Finding[];
}
export interface OpenQuestion {
  id: string;
  question: string;
  options: string[];
  default: string | null;
  blocking: boolean;
}
export interface WorkerResult {
  schema: 'gbdev.worker-result.v1';
  status: typeof WORKER_STATUSES[number];
  summary: string;
  files_changed: string[];
  commits: string[];
  tests: { cmd: string; exit_code: number; passed?: number | boolean; failed?: number }[];
  evidence: { criterion_id: string; kind: string; ref: string; note: string }[];
  open_questions: OpenQuestion[];
  blockers: { kind: 'missing_dependency' | 'permission' | 'env' | 'other'; detail: string }[];
  policy_violations: string[];
  task_graph?: TaskGraph;
  resolution?: MergeResolution;
  handoff?: WorkerHandoff;
  review?: Review;
  /** Inspect candidate only. gbdev rebuilds excerpts; this is not a trusted quotation. */
  inspection?: { answer: string; excerpts: { path: string; start_line: number; end_line: number; text: string }[] };
  /** Opt-in structured policy self-report; ignored unless schema_options.policyIncidents is enabled. */
  policy_incidents?: PolicyIncident[];
}

export interface PolicyIncident {
  violation_index: number;
  category: 'temporary_workspace_file';
  path: string;
  cleaned: boolean;
}

function lexicalRepoPath(path: string): boolean {
  return !!path && !path.includes('\\') && !path.startsWith('/') && !path.split('/').includes('..') && !path.includes('\0');
}

/** Structural check only; ignored incidents remain visible as normalization warnings. */
export function parsePolicyIncidents(value: unknown, violationCount: number, warnings: string[] = []): PolicyIncident[] {
  if (!Array.isArray(value)) { warnings.push('policy_incidents: ignored invalid array'); return []; }
  const out: PolicyIncident[] = [];
  for (const [index, item] of value.entries()) {
    const skip = () => warnings.push(`policy_incidents[${index}]: ignored invalid incident`);
    if (!item || typeof item !== 'object' || Array.isArray(item)) { skip(); continue; }
    const raw = item as Record<string, unknown>;
    if (typeof raw.violation_index !== 'number' || !Number.isInteger(raw.violation_index) || raw.violation_index < 0 || raw.violation_index >= violationCount) { skip(); continue; }
    if (raw.category !== 'temporary_workspace_file') { skip(); continue; }
    if (typeof raw.path !== 'string' || !lexicalRepoPath(raw.path)) { skip(); continue; }
    if (typeof raw.cleaned !== 'boolean') { skip(); continue; }
    // Reject unknown fields so free-form objects cannot smuggle a downgrade.
    if (Object.keys(raw).some(key => !['violation_index', 'category', 'path', 'cleaned'].includes(key))) { skip(); continue; }
    out.push({
      violation_index: raw.violation_index,
      category: 'temporary_workspace_file',
      path: raw.path,
      cleaned: raw.cleaned,
    });
  }
  return out;
}

export function validateWorkerResult(value: unknown, warnings: string[] = []): WorkerResult {
  const v = object(value, 'worker-result');
  schema(v, 'gbdev.worker-result.v1');
  oneOf(v.status, WORKER_STATUSES, 'status');
  string(v.summary, 'summary');
  strings(v.files_changed, 'files_changed');
  strings(v.commits, 'commits');
  strings(v.policy_violations, 'policy_violations');
  if (v.policy_incidents !== undefined) {
    v.policy_incidents = parsePolicyIncidents(v.policy_incidents, (v.policy_violations as string[]).length, warnings);
  }
  array(v.tests, 'tests').forEach((item, i) => {
    const test = object(item, `tests[${i}]`);
    string(test.cmd, `tests[${i}].cmd`);
    integer(test.exit_code, `tests[${i}].exit_code`, -2_147_483_648, 2_147_483_647);
    if (test.passed !== undefined && typeof test.passed !== 'boolean') integer(test.passed, `tests[${i}].passed`);
    if (test.failed !== undefined) integer(test.failed, `tests[${i}].failed`);
  });
  array(v.evidence, 'evidence').forEach((item, i) => {
    const entry = object(item, `evidence[${i}]`);
    for (const key of ['criterion_id', 'kind', 'ref', 'note']) string(entry[key], `evidence[${i}].${key}`);
  });
  array(v.open_questions, 'open_questions').forEach((item, i) => {
    const question = object(item, `open_questions[${i}]`);
    string(question.id, `open_questions[${i}].id`);
    string(question.question, `open_questions[${i}].question`);
    strings(question.options, `open_questions[${i}].options`);
    nullableString(question.default, `open_questions[${i}].default`);
    if (question.default !== null && !question.options.includes(question.default)) invalid(`open_questions[${i}].default must be in options or null`);
    boolean(question.blocking, `open_questions[${i}].blocking`);
  });
  array(v.blockers, 'blockers').forEach((item, i) => {
    const blocker = object(item, `blockers[${i}]`);
    oneOf(blocker.kind, ['missing_dependency', 'permission', 'env', 'other'], `blockers[${i}].kind`);
    string(blocker.detail, `blockers[${i}].detail`);
  });
  if (v.handoff !== undefined) {
    const handoff = object(v.handoff, 'handoff');
    for (const key of HANDOFF_FIELDS) array(handoff[key], `handoff.${key}`).forEach((item, i) => {
      if (typeof item !== 'string') invalid(`handoff.${key}[${i}] must be a string`);
    });
  }
  if (v.review !== undefined) {
    const review = object(v.review, 'review');
    oneOf(review.verdict, VERDICTS, 'review.verdict');
    const ids = new Set<string>();
    array(review.findings, 'review.findings').forEach((item, i) => {
      const path = `review.findings[${i}]`, finding = object(item, path);
      string(finding.id, `${path}.id`);
      if (!/^F[0-9]{1,3}$/.test(finding.id) || ids.has(finding.id)) invalid(`${path}.id must be unique and match F[0-9]{1,3}`);
      ids.add(finding.id);
      oneOf(finding.severity, SEVERITIES, `${path}.severity`);
      for (const key of ['file', 'suggestion']) {
        if (finding[key] !== null && typeof finding[key] !== 'string') invalid(`${path}.${key} must be string or null`);
      }
      if (finding.line !== null) integer(finding.line, `${path}.line`, 1);
      string(finding.message, `${path}.message`);
    });
  }
  for (const [key, shape] of [['task_graph', taskGraphSchema], ['resolution', mergeResolutionSchema]] as const) {
    if (v[key] !== undefined) { const errors = schemaErrors(v[key], shape); if (errors.length) invalid(errors.join('; ')); }
  }
  return value as WorkerResult;
}

/** Normalize known provider variations, retaining a warning for every conversion. */
export function normalizeWorkerResult(value: unknown, warnings: string[] = [], options?: Pick<WorkerSchemaOptions, 'inspection' | 'policyIncidents'>): WorkerResult {
  const pick = (value: unknown, keys: string[], path: string): Record<string, unknown> => {
    const v = object(value, path);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      if (keys.includes(key)) out[key] = v[key];
      else warnings.push(`${path}.${key}: ignored unknown field`);
    }
    return out;
  };
  const v = pick(value, ['schema', 'status', 'summary', 'files_changed', 'commits', 'tests', 'evidence', 'open_questions', 'blockers', 'policy_violations', 'handoff', 'review', 'task_graph', 'resolution', ...(options?.inspection ? ['inspection'] : []), ...(options?.policyIncidents ? ['policy_incidents'] : [])], 'worker-result');
  for (const key of ['files_changed', 'commits', 'tests', 'evidence', 'open_questions', 'blockers', 'policy_violations']) {
    if (v[key] === undefined) { v[key] = []; warnings.push(`${key}: missing array defaulted to []`); }
  }
  v.commits = array(v.commits, 'commits').map((item, i) => {
    if (typeof item === 'string') return item;
    const commit = pick(item, ['hash', 'message'], `commits[${i}]`);
    string(commit.hash, `commits[${i}].hash`);
    string(commit.message, `commits[${i}].message`);
    warnings.push(`commits[${i}]: object converted to short hash and message`);
    return `${commit.hash.slice(0, 7)} ${commit.message}`;
  });
  v.tests = array(v.tests, 'tests').map((item, i) => {
    const path = `tests[${i}]`;
    const raw = object(item, path);
    const out = pick(raw, ['cmd', 'exit_code', 'passed', 'failed', 'command', 'check', 'status'], path);
    if (out.cmd === undefined && (raw.command !== undefined || raw.check !== undefined)) {
      out.cmd = raw.command ?? raw.check;
      warnings.push(`${path}: ${raw.command !== undefined ? 'command' : 'check'} converted to cmd`);
    }
    if (raw.status === 'passed' || raw.status === 'failed') {
      if (out.passed === undefined) { out.passed = raw.status === 'passed'; warnings.push(`${path}: status converted to passed boolean`); }
      if (out.exit_code === undefined) { out.exit_code = raw.status === 'passed' ? 0 : 1; warnings.push(`${path}: exit_code derived from status`); }
    }
    for (const key of ['command', 'check', 'status']) {
      if (key in out) { delete out[key]; warnings.push(`${path}.${key}: consumed alias field`); }
    }
    return out;
  });
  v.evidence = array(v.evidence, 'evidence').map((item, i) => {
    const path = `evidence[${i}]`;
    const raw = object(item, path);
    const out = pick(raw, ['criterion_id', 'kind', 'ref', 'note', 'type', 'command', 'output', 'detail'], path);
    if (['type', 'command', 'output', 'detail'].some(key => key in raw)) {
      out.criterion_id ??= 'unspecified';
      out.kind ??= raw.type ?? 'other';
      out.ref ??= raw.command ?? 'worker';
      out.note ??= [raw.detail, raw.output].filter(x => x !== undefined).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') || 'Worker evidence';
      warnings.push(`${path}: provider evidence mapped to criterion_id/kind/ref/note (unspecified criterion when absent)`);
    }
    for (const key of ['type', 'command', 'output', 'detail']) delete out[key];
    return out;
  });
  v.open_questions = array(v.open_questions, 'open_questions').map((x, i) => pick(x, ['id', 'question', 'options', 'default', 'blocking'], `open_questions[${i}]`));
  v.blockers = array(v.blockers, 'blockers').map((x, i) => pick(x, ['kind', 'detail'], `blockers[${i}]`));
  if (v.handoff !== undefined) v.handoff = pick(v.handoff, [...HANDOFF_FIELDS], 'handoff');
  if (v.review !== undefined) {
    const review = pick(v.review, ['verdict', 'findings'], 'review');
    if (typeof review.verdict === 'string') {
      const lower = review.verdict.toLowerCase();
      const normalized = lower === 'iterate' ? 'revise' : lower;
      if (normalized !== review.verdict) warnings.push(`review.verdict: ${review.verdict} converted to ${normalized}`);
      review.verdict = normalized;
    }
    review.findings = array(review.findings, 'review.findings').map((item, i) => {
      const path = `review.findings[${i}]`;
      const finding = pick(item, ['id', 'severity', 'file', 'line', 'message', 'suggestion'], path);
      if (finding.id === undefined) {
        finding.id = `F${i + 1}`;
        warnings.push(`${path}.id: missing id defaulted to ${finding.id}`);
      }
      const aliases = new Map([['high', 'major'], ['low', 'minor'], ['medium', 'minor'], ['info', 'nit']]);
      if (typeof finding.severity === 'string') {
        const lower = finding.severity.toLowerCase();
        const severity = aliases.get(lower) ?? lower;
        if (severity !== finding.severity) {
        warnings.push(`${path}.severity: ${finding.severity} converted to ${severity}`);
        finding.severity = severity;
        }
      }
      return finding;
    });
    v.review = review;
  }
  return validateWorkerResult(v, warnings);
}

/** Select the last complete, valid worker-result block; preserve formatting warnings. */
export function extractWorkerResult(message: string, warnings: string[] = [], options?: Pick<WorkerSchemaOptions, 'inspection' | 'policyIncidents'>): WorkerResult {
  const trimmed = message.trim();
  if (trimmed.startsWith('{')) {
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { /* Prose may precede a fence. */ }
    if (value !== undefined) {
      try { return normalizeWorkerResult(value, warnings, options); }
      catch (e) { throw new GbdevError('result_invalid', String(e)); }
    }
  }
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  let fence: { length: number; json: boolean; lines: string[] } | null = null;
  let selected: WorkerResult | undefined, selectedWarnings: string[] = [], end = -1, trailing = '', blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      const close = /^ {0,3}(`{3,})(.*)$/.exec(line);
      if (close && close[1]!.length >= fence.length) {
        if (fence.json) {
          blocks++;
          try {
            const local: string[] = [];
            const result = normalizeWorkerResult(JSON.parse(fence.lines.join('\n')), local, options);
            selected = result; selectedWarnings = local; end = i; trailing = close[2]!;
          } catch { /* A later complete block may be the actual result. */ }
        }
        fence = null;
      } else fence.lines.push(line);
    } else {
      const open = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
      if (open) fence = { length: open[1]!.length, json: open[2]!.trim().toLowerCase() === 'json', lines: [] };
    }
  }
  if (fence?.json) throw new GbdevError('result_invalid', 'Unclosed final json fence');
  if (selected) {
    warnings.push(...selectedWarnings);
    if ((trailing + lines.slice(end + 1).join('\n')).trim()) warnings.push('worker-result: trailing content after final result fence ignored');
    return selected;
  }
  throw new GbdevError(blocks || trimmed.startsWith('{') || trimmed.startsWith('[') ? 'result_invalid' : 'result_missing', 'No valid worker JSON result in final message');
}
