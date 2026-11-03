import { existsSync } from 'node:fs';
import { type InspectSnapshot, type InspectTarget, type InspectWarning } from '../contracts/inspect.js';
import { git } from '../core/git.js';
import { atomicWriteJson, type JobStore } from '../core/jobStore.js';
import { releaseInspectReservation } from '../core/workerReservations.js';

export interface InspectionRequest {
  question: string;
  paths: string[];
  diff: boolean;
  tests: boolean;
  repo: string;
  source_branch: string;
  source_worktree: string;
  target: InspectTarget;
  snapshot: InspectSnapshot;
  warnings: InspectWarning[];
  instructions_sha256: string;
}

export function writeInspectionRequest(path: string, request: InspectionRequest): void {
  atomicWriteJson(path, request);
}

/** Remove only the detached inspect worktree. Never deletes branches or other refs. */
export function cleanupInspectWorktree(repo: string, worktree: string): void {
  if (!existsSync(worktree)) return;
  git(repo, ['worktree', 'remove', worktree]);
}

export function releaseInspectLease(store: JobStore, jobId: string): void {
  releaseInspectReservation(store, jobId);
}
