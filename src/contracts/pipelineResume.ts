import { GbdevError } from './error.js';
export interface PipelineResume {
  schema: 'gbdev.pipeline-resume.v1'; pipeline_id: string;
  action: 'answer' | 'retry' | 'extra_round' | 'accept';
  answers: { question_id: string; answer: string }[]; note: string | null;
  verdict_missing_reviewed?: boolean;
}
export function validatePipelineResume(value: unknown, id: string): PipelineResume {
  const v = value as PipelineResume;
  const invalid = (): never => { throw new GbdevError('config_invalid', 'Invalid pipeline resume input'); };
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['schema', 'pipeline_id', 'action', 'answers', 'note', 'verdict_missing_reviewed'].includes(k)) ||
      v.schema !== 'gbdev.pipeline-resume.v1' || v.pipeline_id !== id || !['answer', 'retry', 'extra_round', 'accept'].includes(v.action)) invalid();
  const answers = v.answers === undefined ? [] : v.answers, note = v.note ?? null;
  if (!Array.isArray(answers) || (v.action !== 'answer' && answers.length) ||
      (note !== null && (typeof note !== 'string' || note.length > 2000))) invalid();
  if ('verdict_missing_reviewed' in v && typeof v.verdict_missing_reviewed !== 'boolean') invalid();
  const seen = new Set<string>();
  for (const a of answers) {
    if (!a || typeof a !== 'object' || Object.keys(a).some(k => !['question_id', 'answer'].includes(k)) || typeof a.question_id !== 'string' || !a.question_id.trim() || typeof a.answer !== 'string' || !a.answer.trim() || seen.has(a.question_id)) invalid();
    seen.add(a.question_id);
  }
  return {
    schema: v.schema, pipeline_id: id, action: v.action, answers, note,
    ...('verdict_missing_reviewed' in v ? { verdict_missing_reviewed: v.verdict_missing_reviewed } : {}),
  };
}
