import type { Finding } from './workerResult.js';
import { assertSchema, bool, closed, dateSchema, enumeration, list, nullable, nonempty, number, runIdSchema, stringsSchema, taskIdSchema, textSchema, type JsonSchema } from './runValidation.js';
import { DECISION_REASONS, outcomeSchema, RUN_ACTIONS, TASK_STATES, type RunAction, type RunOutcome, type TaskState } from './run.js';
import { MERGE_RESULTS, type MergeRecord } from './mergeRecord.js';
export interface RunFinding { id: string; severity: 'critical' | 'major' | 'minor' | 'nit'; file: string | null; line: number | null; text: string }
export const runFindingSchema = closed({ id: nonempty, severity: enumeration('critical', 'major', 'minor', 'nit'), file: nullable(textSchema), line: nullable(number(1)), text: nonempty });
export interface RunResult {
  schema: 'gbdev.run-result.v1'; run_id: string; state: 'plan_review' | 'needs_decision' | 'succeeded' | 'failed' | 'cancelled';
  outcome: RunOutcome; repo: string; base_sha: string; integration_branch: string; integration_sha: string;
  diff_stat: { files: number; insertions: number; deletions: number }; commits: { sha: string; subject: string }[];
  tasks: { task_id: string; state: TaskState; merged_sha: string | null; pipelines: string[]; review: { verdict: 'approve' | 'revise' | 'reject' | null; unresolved_findings: Finding[] } | null; scope_exceeded: string[]; summary: string }[];
  dropped_tasks: string[]; merges: { seq: number; task_id: string; result: MergeRecord['result']; conflict: boolean; gate_passed: boolean }[];
  final_gate: { sha: string; passed: boolean } | null;
  final_review: {
    job_id: string; verdict: 'approve' | 'revise' | 'reject' | null; findings: Finding[];
    round_id?: string; reviewed_base_sha?: string; reviewed_head_sha?: string;
    failure_reason?: string | null; review_completed?: boolean;
  } | null;
  acceptance_criteria: { id: string; check: string | null; passed: boolean | null }[];
  decisions: {
    decision_id: string; reason: string; action: RunAction; by: string; at: string;
    note?: string | null; verdict_missing_reviewed?: boolean; instance?: string; job_ids?: string[];
  }[];
  landing: { eligible: boolean; target_hint: string | null; landed_sha: string | null };
  artifacts: { diff: string; events: string; merges_dir: string }; warnings: string[];
}
const reviewFindingSchema = closed({ id: { ...nonempty, pattern: '^F[0-9]{1,3}$' }, severity: enumeration('critical', 'major', 'minor', 'nit'), file: nullable(textSchema), line: nullable(number(1)), message: nonempty, suggestion: nullable(textSchema) });
const verdict = nullable(enumeration('approve', 'revise', 'reject'));
const decisionRecordSchema = closed({
  decision_id: nonempty, reason: enumeration(...DECISION_REASONS), action: enumeration(...RUN_ACTIONS), by: nonempty, at: dateSchema,
  note: nullable(textSchema), verdict_missing_reviewed: bool, instance: nonempty, job_ids: stringsSchema,
}, ['note', 'verdict_missing_reviewed', 'instance', 'job_ids']);
export const runResultSchema: JsonSchema = closed({
  schema: { type: 'string', const: 'gbdev.run-result.v1' }, run_id: runIdSchema,
  state: enumeration('plan_review', 'needs_decision', 'succeeded', 'failed', 'cancelled'), outcome: outcomeSchema,
  repo: nonempty, base_sha: nonempty, integration_branch: nonempty, integration_sha: nonempty,
  diff_stat: closed({ files: number(), insertions: number(), deletions: number() }),
  commits: list(closed({ sha: nonempty, subject: textSchema })),
  tasks: list(closed({ task_id: taskIdSchema, state: enumeration(...TASK_STATES), merged_sha: nullable(nonempty), pipelines: stringsSchema, review: nullable(closed({ verdict, unresolved_findings: list(reviewFindingSchema) })), scope_exceeded: stringsSchema, summary: textSchema })),
  dropped_tasks: list(taskIdSchema),
  merges: list(closed({ seq: number(1), task_id: taskIdSchema, result: enumeration(...MERGE_RESULTS), conflict: bool, gate_passed: bool })),
  final_gate: nullable(closed({ sha: nonempty, passed: bool })),
  final_review: nullable(closed({
    job_id: nonempty, verdict, findings: list(reviewFindingSchema),
    round_id: nonempty, reviewed_base_sha: nonempty, reviewed_head_sha: nonempty,
    failure_reason: nullable(textSchema), review_completed: bool,
  }, ['round_id', 'reviewed_base_sha', 'reviewed_head_sha', 'failure_reason', 'review_completed'])),
  acceptance_criteria: list(closed({ id: nonempty, check: nullable(taskIdSchema), passed: nullable(bool) })),
  decisions: list(decisionRecordSchema),
  landing: closed({ eligible: bool, target_hint: nullable(nonempty), landed_sha: nullable(nonempty) }),
  artifacts: closed({ diff: nonempty, events: nonempty, merges_dir: nonempty }), warnings: stringsSchema,
});
export function validateRunResult(value: unknown): RunResult { assertSchema(value, runResultSchema); return structuredClone(value) as RunResult; }
