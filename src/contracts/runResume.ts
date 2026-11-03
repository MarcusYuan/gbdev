import { GbdevError } from './error.js';
import { RUN_ACTIONS, type Run, type RunAction } from './run.js';
import { taskGraphSchema, validateTaskGraph, type TaskGraph, type TaskGraphContext } from './taskGraph.js';
import { assertCursorModels, assertSchema, bool, closed, enumeration, list, nullable, nonempty, runIdSchema, runInvalid, taskIdSchema, textSchema, type JsonSchema } from './runValidation.js';
export interface RunResume {
  schema: 'gbdev.run-resume.v1'; run_id: string; decision_id: string; action: RunAction; task_id: string | null;
  answers: { question_id: string; answer: string }[] | null; task_graph: TaskGraph | null; note: string | null;
  verdict_missing_reviewed?: boolean;
}
export const runResumeSchema: JsonSchema = closed({
  schema: { type: 'string', const: 'gbdev.run-resume.v1' }, run_id: runIdSchema, decision_id: nonempty, action: enumeration(...RUN_ACTIONS),
  task_id: nullable(taskIdSchema), answers: nullable(list(closed({ question_id: nonempty, answer: nonempty }), 1)),
  task_graph: nullable(taskGraphSchema), note: nullable({ ...textSchema, maxLength: 2000 }),
  verdict_missing_reviewed: bool,
}, ['verdict_missing_reviewed']);
export function validateRunResume(value: unknown, run: Pick<Run, 'run_id' | 'attention'>, graphContext?: TaskGraphContext): RunResume {
  assertCursorModels(value); assertSchema(value, runResumeSchema); const input = structuredClone(value) as RunResume;
  if (input.run_id !== run.run_id) runInvalid(['run_id mismatch']);
  const decision = run.attention.find(d => d.decision_id === input.decision_id);
  if (!decision) throw new GbdevError('run_state_conflict', 'Decision is stale', { reason: 'stale_decision' });
  if (!decision.allowed_actions.includes(input.action) || decision.task_id !== input.task_id) throw new GbdevError('run_state_conflict', 'Action/task_id not allowed by decision');
  if (input.action === 'answer') {
    const answers = input.answers ?? [], ids = new Set(answers.map(a => a.question_id));
    if (!answers.length || answers.some(a => !a.answer.trim()) || ids.size !== answers.length || answers.some(a => !decision.pending_questions.some(q => q.id === a.question_id)) || decision.pending_questions.some(q => q.blocking && !ids.has(q.id))) runInvalid(['answers must cover blocking questions without unknown or duplicate ids']);
  } else if (input.answers !== null) runInvalid(['answers only allowed for answer']);
  if (input.task_graph !== null) {
    if (input.action !== 'approve_plan' || !graphContext) runInvalid(['task_graph requires approve_plan and graph validation context']);
    input.task_graph = validateTaskGraph(input.task_graph, graphContext);
  } else if (input.action === 'approve_plan' && decision.reason === 'plan_invalid') runInvalid(['plan_invalid approval requires task_graph']);
  return input;
}
