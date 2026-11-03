import { randomBytes } from 'node:crypto';
import { GbdevError } from '../contracts/error.js';

export const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;
export const JOB_ID_PATTERN = /^j_\d{8}_\d{4}_[a-f0-9]{4}$/;

export function validateIdentifier(value: unknown, name = 'identifier'): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) throw new GbdevError('config_invalid', `Invalid ${name}`);
}

export function validateBranchName(value: unknown): asserts value is string {
  validateIdentifier(value, 'branch name');
  // Git ref restrictions, in addition to the mandatory allowlist regexp.
  if (value === '@' || value.includes('..') || value.includes('//') || value.endsWith('.') ||
      value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock') || !part)) {
    throw new GbdevError('config_invalid', 'Invalid branch name');
  }
}

export function validateJobId(value: unknown): asserts value is string {
  validateIdentifier(value, 'job_id');
  if (!JOB_ID_PATTERN.test(value)) throw new GbdevError('config_invalid', 'job_id must have format j_YYYYMMDD_HHMM_<4 hex digits>');
}

export function createJobId(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new GbdevError('config_invalid', 'Invalid job date');
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = String(date.getFullYear()).padStart(4, '0');
  const id = `j_${year}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}_${randomBytes(2).toString('hex')}`;
  validateJobId(id);
  return id;
}

export function jobBranch(jobId: string): string {
  validateJobId(jobId);
  return `gbdev/${jobId}`;
}

export const RUN_ID_PATTERN = /^r_\d{8}_\d{4}_[a-f0-9]{4}$/;
export function createRunId(date = new Date()): string { return createJobId(date).replace(/^j_/, 'r_'); }
