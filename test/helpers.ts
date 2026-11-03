import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext } from 'node:test';
import { type TaskBrief } from '../src/contracts/brief.js';
import { type JobStatus } from '../src/contracts/jobStatus.js';
import { type WorkerResult } from '../src/contracts/workerResult.js';
import { type JobResult } from '../src/contracts/jobResult.js';
import { GbdevError, type ErrorCode } from '../src/contracts/error.js';
import { jobBranch } from '../src/core/ids.js';
import { localIso } from '../src/core/time.js';

export function temporary(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbdev-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

export function errorCode(code: ErrorCode) {
  return (error: unknown) => error instanceof GbdevError && error.contract.code === code;
}

export function brief(repo: string): TaskBrief {
  return {
    schema: 'gbdev.task-brief.v1', brief_id: 'b_20261025_1130_x1', repo, base_ref: 'HEAD',
    role: 'executor', provider: 'fake', model: null, sandbox: 'workspace-write', timeout_min: 30,
    network: false, goal: 'Add a version field', context: '', constraints: ['No new dependencies'],
    allowed_paths: ['src/**', 'test/**'], acceptance_criteria: [{ id: 'AC1', text: 'Tests pass', check_cmd: 'npm test' }],
    required_evidence: ['tests'], parent_job_id: null, answers: [],
  };
}

export function job(jobId = 'j_20261025_1131_a7f3', date = new Date('2026-10-25T18:31:02Z')): JobStatus {
  const at = localIso(date);
  return {
    schema: 'gbdev.job-status.v1', job_id: jobId, state: 'queued', session_id: null, provider: 'fake', role: 'executor',
    sandbox: 'workspace-write', repo: '/example/repo', worktree: `/example/worktrees/repo/${jobId}`,
    branch: jobBranch(jobId), base_sha: '9c1e4b2', pid: null, created_at: at, updated_at: at,
    deadline_at: localIso(new Date(date.getTime() + 30 * 60_000)),
    state_history: [{ state: 'queued', at, by: 'gbdev' }], last_event: null, parent_job_id: null,
  };
}

export function worker(): WorkerResult {
  return {
    schema: 'gbdev.worker-result.v1', status: 'succeeded', summary: 'Added version field',
    files_changed: ['src/server.ts'], commits: ['3f2a9c1 feat(health): include version'],
    tests: [{ cmd: 'npm test', exit_code: 0, passed: 2, failed: 0 }],
    evidence: [{ criterion_id: 'AC1', kind: 'test', ref: 'test/health.test.ts', note: 'Tests pass' }],
    open_questions: [], blockers: [], policy_violations: [],
  };
}

export function result(): JobResult {
  return {
    schema: 'gbdev.job-result.v1', job_id: job().job_id, state: 'succeeded', session_id: null, worker_exit_code: 0,
    duration_s: 1.25, failure_reason: null, worker_result_warnings: [], worker_reported: worker(), gbdev_observed: {
      head_before: '9c1e4b2', head_after: '3f2a9c1', commits: ['3f2a9c1 feat(health): include version'],
      files_changed: ['src/server.ts'], outside_allowed_paths: [], worktree_dirty_at_exit: false,
      snapshot_commit: null, checks: [{ id: 'AC1', cmd: 'npm test', exit_code: 0, log: 'checks/AC1.log' }],
      policy_violations: [],
    }, paths: { final_message: '/jobs/final.md', diff: '/jobs/diff.patch', events: '/jobs/events.jsonl', worker_log: '/jobs/worker.log' },
  };
}
