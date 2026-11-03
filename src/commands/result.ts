import { readFileSync } from 'node:fs';
import { GbdevError } from '../contracts/error.js';
import { validateJobResult, type JobResult } from '../contracts/jobResult.js';
import { isTerminal } from '../contracts/jobStatus.js';
import { JobStore } from '../core/jobStore.js';
import { jobPaths } from '../core/paths.js';
import { reconcile } from './status.js';

export async function result(store: JobStore, jobId: string): Promise<JobResult> {
  const status = await reconcile(store, jobId);
  if (!isTerminal(status.state)) throw new GbdevError('job_not_terminal', 'Job is not terminal', { job_id: jobId });
  let content: string;
  try { content = readFileSync(jobPaths(store.paths, jobId).result, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GbdevError('result_missing', 'Job result is missing', { job_id: jobId });
    throw error;
  }
  try {
    const value = validateJobResult(JSON.parse(content));
    if (value.job_id !== jobId || value.state !== status.state) throw new Error('Result does not match job status');
    return value;
  } catch { throw new GbdevError('result_invalid', 'Invalid job result', { job_id: jobId }); }
}
