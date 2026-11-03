import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipelineFixture } from './helpers/pipeline.js';
import { tmpRepo, unwrap } from './helpers/tmpRepo.js';
import { builtinRoles } from '../src/roles/builtin.js';
import { decisionActions } from '../src/pipeline/gate.js';
import { pipelineText } from '../src/commands/pipeline.js';
import type { PipelineRun } from '../src/contracts/pipelineRun.js';
import type { PipelineResult } from '../src/contracts/pipelineResult.js';

test('F1 review-only revise advertises accept only; extra_round rejected without mutation; accept retains findings', async t => {
  const f = pipelineFixture(t, { 'review#1': 'review_revise' });
  const run = await f.start({ pipeline: 'review-only', diff_base_ref: 'main', step_overrides: { review: { provider: 'fake' } }, acceptance_criteria: [] });
  const paused = await f.wait(run.pipeline_id) as PipelineRun;
  assert.equal(paused.state, 'needs_decision');
  assert.equal(paused.state_reason, 'max_rounds_exceeded');
  assert.deepEqual(paused.decision!.allowed_actions, ['accept']);
  const before = readFileSync(join(f.pipelineDir(run.pipeline_id), 'pipeline.json'), 'utf8');
  const refused = await f.resume(run.pipeline_id, 'extra_round');
  assert.equal(refused.exit, 1);
  assert.equal(refused.envelope.ok, false);
  if (!refused.envelope.ok) {
    assert.equal(refused.envelope.error.code, 'pipeline_state_conflict');
    assert.equal(refused.envelope.error.details.reason, 'action_not_allowed');
  }
  assert.equal(readFileSync(join(f.pipelineDir(run.pipeline_id), 'pipeline.json'), 'utf8'), before);
  const accepted = unwrap((await f.resume(run.pipeline_id, 'accept')).envelope) as PipelineRun;
  assert.equal(accepted.state, 'succeeded');
  assert.equal(accepted.outcome, 'accepted_by_decider');
  assert.equal(accepted.jobs_used, 1);
  const result = unwrap((await f.command(['pipeline', 'result', run.pipeline_id])).envelope) as PipelineResult;
  assert.equal(result.final_verdict!.open_findings.length, 1);
});

test('F1 all extra-round decision reasons filter absent loop and absolute cap without changing the action table', () => {
  for (const reason of ['max_rounds_exceeded', 'findings_repeated', 'review_rejected']) {
    for (const max of [0, 2, 4, 5]) assert.deepEqual(decisionActions(reason, false, max), ['accept']);
    assert.deepEqual(decisionActions(reason, true, 5), ['accept']);
    assert.deepEqual(decisionActions(reason, true, 4), ['extra_round', 'accept']);
  }
  assert.deepEqual(decisionActions('step_failed', false, 5), ['retry']);
});

for (const state of ['needs_input', 'needs_decision', 'blocked']) test(`F3 ${state} text suggests result and resume`, () => {
  const id = 'p_20261026_1011_9c2e';
  const text = pipelineText({ pipeline_id: id, state, state_reason: 'reason' });
  assert.ok(text.includes(`${id} ${state}: reason`));
  assert.ok(text.includes(`gbdev pipeline result ${id}`));
  assert.ok(text.includes(`gbdev pipeline resume ${id} --input <file|->`));
});

test('AC-S5.2 every src file excludes approval bypass and disabled sandbox flags', () => {
  const files = readdirSync(resolve('src'), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  assert.ok(files.length > 0);
  for (const entry of files) {
    const file = join(entry.parentPath, entry.name), source = readFileSync(file, 'utf8');
    assert.ok(!source.includes('--dangerously-bypass-approvals-and-sandbox'), file);
    // Also catches argv arrays, not just the shell-style spelling.
    assert.doesNotMatch(source, /--sandbox(?:\s+|['"`]\s*,\s*['"`])disabled/, file);
  }
});

// A local executable fixture, never a real Cursor client. Capture the actual spawned argv.
function cursorStub(root: string): string {
  const bin = join(root, 'cursor-stub.mjs');
  writeFileSync(bin, `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), prompt = args.at(-1);
appendFileSync(process.env.GBDEV_STUB_LOG, JSON.stringify(args) + '\\n');
if (args.includes('--force')) writeFileSync('src/cursor.txt', prompt);
const revise = prompt.includes('step review#1 ');
const report = { schema: 'gbdev.worker-result.v1', status: 'succeeded', summary: 'Local cursor stub', files_changed: [], commits: [], tests: [], evidence: [], open_questions: [], blockers: [], policy_violations: [], handoff: { decided: [], rejected: [], risks: [], remaining: [] }, review: { verdict: revise ? 'revise' : 'approve', findings: revise ? [{ id: 'F1', severity: 'major', file: 'src/cursor.txt', line: 1, message: 'Fix stub issue', suggestion: null }] : [] } };
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(report) }));
`, { mode: 0o700 });
  return bin;
}
function configureCursor(f: ReturnType<typeof tmpRepo>) {
  const bin = cursorStub(f.root);
  f.env.GBDEV_STUB_LOG = join(f.root, 'argv.jsonl');
  writeFileSync(f.config, JSON.stringify({ version: 1, allowed_repos: [f.repo], providers: { cursor: { bin }, codex: { bin: join(f.root, 'never-run-codex') } } }));
  mkdirSync(join(f.root, 'roles'));
  for (const role of builtinRoles().filter(r => r.allowed_providers.includes('cursor'))) writeFileSync(join(f.root, 'roles', `${role.name}.json`), JSON.stringify({ schema: 'gbdev.role.v1', name: role.name, provider: 'cursor', codex_model: 'must-not-leak' }));
  return () => readFileSync(f.env.GBDEV_STUB_LOG!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
}
function assertCursorArgs(args: string[], sandbox: string) {
  assert.equal(args.filter(arg => arg === '--model').length, 1);
  assert.equal(args[args.indexOf('--model') + 1], 'auto');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'enabled');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(!args.includes('must-not-leak'));
  assert.equal(args.includes('--force'), sandbox === 'workspace-write');
  if (sandbox === 'read-only') assert.equal(args[args.indexOf('--mode') + 1], 'plan');
}
for (const role of builtinRoles().filter(r => r.allowed_providers.includes('cursor'))) test(`AC-S5.2 standalone ${role.name} actual cursor argv always uses auto`, async t => {
  const f = tmpRepo(t, 'ok', { role: role.name, provider: 'cursor', sandbox: role.sandbox, acceptance_criteria: [] });
  const calls = configureCursor(f);
  for (const model of [undefined, null, 'auto']) {
    writeFileSync(f.briefFile, JSON.stringify({ ...f.task, model }));
    assert.equal((await f.wait((await f.launch()).job_id)).state, 'succeeded');
  }
  assert.equal(calls().length, 3);
  for (const args of calls()) assertCursorArgs(args, role.sandbox);
});

test('AC-S5.2 pipeline cursor argv covers planner/executor/reviewer/verifier and inserted fixer/re-review', async t => {
  const f = pipelineFixture(t);
  // configureCursor only needs the shared fixture fields, not its launch/wait helpers.
  const calls = configureCursor({ ...f, launch: f.launchStandalone, wait: f.waitJob });
  const run = await f.start({ pipeline: { schema: 'gbdev.pipeline.v1', name: 'all-cursor', description: 'All role paths',
    steps: [{ id: 'plan', role: 'planner' }, { id: 'implement', role: 'executor' }, { id: 'review', role: 'reviewer' }, { id: 'verify', role: 'verifier' }],
    fix_loop: { after: 'review', fix_role: 'fixer', max_rounds: 1 }, timeout_min: 240 },
    step_overrides: { verify: { provider: 'cursor', cursor_model: 'auto', codex_model: 'must-not-leak' }, fix: { provider: 'cursor', cursor_model: 'auto' } }, acceptance_criteria: [] });
  const done = await f.wait(run.pipeline_id) as PipelineRun;
  assert.equal(done.state, 'succeeded');
  assert.equal(done.round, 1);
  assert.deepEqual(done.steps.map(s => s.role), ['planner', 'executor', 'reviewer', 'fixer', 'reviewer', 'verifier']);
  assert.equal(calls().length, 6);
  done.steps.forEach((step, i) => assertCursorArgs(calls()[i]!, step.sandbox));
});
