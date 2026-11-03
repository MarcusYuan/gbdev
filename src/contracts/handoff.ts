import type { JobResult } from './jobResult.js';
import type { Review, WorkerHandoff, WorkerResult } from './workerResult.js';

export interface Handoff extends WorkerHandoff {
  schema: 'gbdev.handoff.v1';
  pipeline_id: string;
  seq: number;
  instance: string;
  role: string;
  job_id: string;
  job_state: JobResult['state'];
  failure_reason: string | null;
  summary: string;
  files_changed: string[];
  commits: string[];
  head_before: string;
  head_after: string;
  tests: WorkerResult['tests'];
  checks: JobResult['gbdev_observed']['checks'];
  verdict: (Review & { normalized_from: Review['verdict'] | null }) | null;
  warnings: string[];
  truncated: boolean;
  created_at: string;
}
