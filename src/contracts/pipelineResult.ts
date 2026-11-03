import type { PipelineRun } from './pipelineRun.js';
import { validateDecisions } from './pipelineRun.js';
import type { JobResult } from './jobResult.js';
import type { Finding, Review } from './workerResult.js';
export interface PipelineResult extends Pick<PipelineRun, 'pipeline_id' | 'pipeline' | 'state' | 'state_reason' | 'outcome' | 'failure_reason' | 'decision' | 'decisions' | 'pending_questions' | 'repo' | 'base_sha' | 'diff_base_sha' | 'head_sha' | 'round' | 'jobs_used' | 'warnings'> {
  schema: 'gbdev.pipeline-result.v1'; branch: string; worktree: string; duration_s: number; commits: string[]; files_changed: string[]; outside_allowed_paths: string[];
  final_checks: { job_id: string; checks: JobResult['gbdev_observed']['checks'] } | null;
  final_verdict: { instance: string; verdict: Review['verdict']; open_findings: Finding[] } | null;
  steps: { instance: string; state: string; job_ids: string[]; gate: string | null; verdict?: Review['verdict']; summary: string }[];
  paths: { pipeline: string; diff: string; handoffs: string; events: string };
}

export function validatePipelineResult(value: unknown): PipelineResult {
  const r = value as PipelineResult;
  if (!r || r.schema !== 'gbdev.pipeline-result.v1' || !['needs_input', 'blocked', 'needs_decision', 'succeeded', 'failed', 'cancelled'].includes(r.state) ||
    !Array.isArray(r.steps) || !Array.isArray(r.commits) || !Array.isArray(r.files_changed) || !r.paths || typeof r.paths.diff !== 'string') throw new Error('Invalid pipeline result');
  return { ...r, decisions: validateDecisions(r.decisions) };
}
