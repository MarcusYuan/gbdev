import { compareInstantDesc } from './time.js';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { type JobStatus, validateJobStatus } from '../contracts/jobStatus.js';
import { JOB_ID_PATTERN, validateJobId } from './ids.js';
import { jobPaths, type GbdevPaths } from './paths.js';

/** Same-directory temp + rename ensures readers see either the old or new JSON. */
export function atomicWriteJson(path: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2);
  if (content === undefined) throw new GbdevError('internal_error', 'Cannot serialize undefined as JSON');
  atomicWriteText(path, `${content}\n`);
}

export function atomicWriteText(path: string, content: string): void {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

/** Mutating callers must hold the global lock; job.json is the sole status source. */
export class JobStore {
  constructor(readonly paths: GbdevPaths) {}

  create(status: JobStatus): void {
    validateJobStatus(status);
    const paths = jobPaths(this.paths, status.job_id);
    mkdirSync(this.paths.jobs, { recursive: true });
    try {
      mkdirSync(paths.dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new GbdevError('internal_error', 'Job already exists', { job_id: status.job_id });
      throw error;
    }
    try {
      atomicWriteJson(paths.job, status);
    } catch (error) {
      rmSync(paths.dir, { recursive: true, force: true });
      throw error;
    }
  }

  read(jobId: string): JobStatus {
    const path = jobPaths(this.paths, jobId).job;
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GbdevError('job_not_found', 'Job not found', { job_id: jobId });
      throw error;
    }
    try {
      const status = validateJobStatus(JSON.parse(content));
      if (status.job_id !== jobId) throw new Error('job_id does not match directory');
      return status;
    } catch {
      throw new GbdevError('internal_error', 'Invalid job.json', { job_id: jobId });
    }
  }

  write(status: JobStatus): void {
    validateJobStatus(status);
    this.read(status.job_id);
    atomicWriteJson(jobPaths(this.paths, status.job_id).job, status);
  }

  list(limit = 50): JobStatus[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new GbdevError('config_invalid', 'Job list limit must be 1–50');
    let entries;
    try {
      entries = readdirSync(this.paths.jobs, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries.filter(entry => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
      .map(entry => {
        validateJobId(entry.name);
        return this.read(entry.name);
      })
      .sort((a, b) => compareInstantDesc(a.created_at, b.created_at) || b.job_id.localeCompare(a.job_id))
      .slice(0, limit);
  }
}
