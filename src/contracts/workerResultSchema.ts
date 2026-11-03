import { mergeResolutionSchema } from './mergeResolution.js';
import { taskGraphSchema } from './taskGraph.js';
import type { RoleDefinition } from './role.js';

/** Codex structured output requires closed objects and every property in required. */
const str = { type: 'string' };
const strings = { type: 'array', items: str };
const closed = (properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
});
export const workerResultSchema = closed({
  schema: { type: 'string', const: 'gbdev.worker-result.v1' },
  status: { type: 'string', enum: ['succeeded', 'needs_input', 'blocked', 'failed'] },
  summary: str, files_changed: strings, commits: strings,
  tests: { type: 'array', items: closed({ cmd: str, exit_code: { type: 'integer' }, passed: { type: 'integer', minimum: 0 }, failed: { type: 'integer', minimum: 0 } }) },
  evidence: { type: 'array', items: closed({ criterion_id: str, kind: str, ref: str, note: str }) },
  open_questions: { type: 'array', items: closed({ id: str, question: str, options: strings, default: { type: ['string', 'null'] }, blocking: { type: 'boolean' } }) },
  blockers: { type: 'array', items: closed({ kind: { type: 'string', enum: ['missing_dependency', 'permission', 'env', 'other'] }, detail: str }) },
  policy_violations: strings,
});

export interface WorkerSchemaOptions {
  taskGraph?: boolean;
  mergeResolution?: boolean;
  pipelineStep: boolean;
  output: RoleDefinition['output'];
  /** Opt-in candidate {answer, excerpts}. Absent means the M1 schema bytes stay identical. */
  inspection?: boolean;
  /** Opt-in policy_incidents[]. Absent keeps M1/M2 fixture bytes identical. */
  policyIncidents?: boolean;
}

/** Explicit opt-in keeps every standalone role on the byte-identical M1 schema. */
export function buildWorkerResultSchema(options?: WorkerSchemaOptions): ReturnType<typeof closed> {
  if (!options?.pipelineStep && !options?.taskGraph && !options?.mergeResolution && !options?.inspection && !options?.policyIncidents) return structuredClone(workerResultSchema);
  const properties: Record<string, unknown> = {
    ...structuredClone(workerResultSchema.properties),
    ...(options?.pipelineStep ? { handoff: closed({ decided: strings, rejected: strings, risks: strings, remaining: strings }) } : {}),
  };
  if (options?.pipelineStep && options.output === 'verdict') properties.review = closed({
    verdict: { type: 'string', enum: ['approve', 'revise', 'reject'] },
    findings: { type: 'array', items: closed({
      id: { type: 'string', pattern: '^F[0-9]{1,3}$' },
      severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
      file: { type: ['string', 'null'] }, line: { type: ['integer', 'null'], minimum: 1 },
      message: { type: 'string', minLength: 1, pattern: '\\S' }, suggestion: { type: ['string', 'null'] },
    }) },
  });
  if (options?.taskGraph) properties.task_graph = structuredClone(taskGraphSchema);
  if (options?.mergeResolution) properties.resolution = structuredClone(mergeResolutionSchema);
  if (options?.inspection) properties.inspection = closed({
    answer: str,
    excerpts: { type: 'array', maxItems: 8, items: closed({
      path: str,
      start_line: { type: 'integer', minimum: 1 },
      end_line: { type: 'integer', minimum: 1 },
      text: str,
    }) },
  });
  if (options?.policyIncidents) properties.policy_incidents = {
    type: 'array',
    items: closed({
      violation_index: { type: 'integer', minimum: 0 },
      category: { type: 'string', const: 'temporary_workspace_file' },
      path: str,
      cleaned: { type: 'boolean' },
    }),
  };
  return closed(properties);
}
