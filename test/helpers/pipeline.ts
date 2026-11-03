import type { TestContext } from 'node:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRepo, unwrap } from './tmpRepo.js';
import type { PipelineRun } from '../../src/contracts/pipelineRun.js';
export function pipelineFixture(t: TestContext, initialPlan: Record<string, string> = { 'implement#1': 'ok', 'review#1': 'review_approve' }) {
  const f = tmpRepo(t), planFile = join(f.root, 'plan.json');
  writeFileSync(planFile, JSON.stringify(initialPlan)); f.env.GBDEV_FAKE_PLAN = planFile;
  const request = { schema: 'gbdev.pipeline-request.v1', request_id: 'pr_test', pipeline: 'implement-review', repo: f.repo, base_ref: 'HEAD', diff_base_ref: null,
    goal: 'Implement and review', context: '', constraints: [], allowed_paths: ['src/**'], acceptance_criteria: [{ id: 'AC1', text: 'ok exists', check_cmd: 'test -f src/ok.txt' }], required_evidence: [], network: false,
    step_overrides: { implement: { provider: 'fake' }, review: { provider: 'fake' }, fix: { provider: 'fake' } } };
  const launch = async (patch: Record<string, unknown> = {}, dryRun = false) => f.command(['pipeline', 'start', '--request', '-', ...(dryRun ? ['--dry-run'] : [])], JSON.stringify({ ...request, ...patch }));
  const start = async (patch: Record<string, unknown> = {}) => unwrap((await launch(patch)).envelope) as PipelineRun;
  // Multi-round fake pipelines spawn many Node/Git processes. This is only the
  // fixture's CLI polling budget; production deadlines and timeout tests are unchanged.
  const wait = async (id: string, withResult = false) => unwrap((await f.command(['pipeline', 'wait', id, '--timeout-ms', '60000', ...(withResult ? ['--with-result'] : [])])).envelope);
  const read = (id: string) => JSON.parse(readFileSync(join(f.home, 'pipelines', id, 'pipeline.json'), 'utf8')) as PipelineRun;
  const plan = (value: Record<string, string>) => writeFileSync(planFile, JSON.stringify(value));
  const resume = (id: string, action: string, patch: Record<string, unknown> = {}) => f.command(['pipeline', 'resume', id, '--input', '-'], JSON.stringify({ schema: 'gbdev.pipeline-resume.v1', pipeline_id: id, action, answers: [], note: null, ...patch }));
  return { ...f, launchStandalone: f.launch, waitJob: f.wait, plan, resume, request, launch, start, wait, read, pipelineDir: (id: string) => join(f.home, 'pipelines', id) };
}
