import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture } from './helpers/m3.js';
import { temporary } from './helpers.js';
import { GbdevError } from '../src/contracts/error.js';
import { renderOrchestratorNotes } from '../src/core/prompt.js';
import { validateRunResume } from '../src/contracts/runResume.js';
import { validateRunRequest, runRequestSchema } from '../src/contracts/runRequest.js';
import { assertSchema } from '../src/contracts/runValidation.js';
import { validateConfig } from '../src/core/config.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { runCommand } from '../src/commands/run.js';
import { localSupervisors } from '../src/run/reconcile.js';
import { runPaths } from '../src/run/store.js';
import type { Run } from '../src/contracts/run.js';
import { prepareDecisions, readRuntime } from '../src/run/decisions.js';

test('D4 shared trusted renderer preserves verbatim multiline notes; 2000 limit unchanged', async t => {
  const note = '纯空白返回 Hello guest。\n仅修改指定测试断言。';
  assert.equal(renderOrchestratorNotes(null, '', undefined, note, note), `\nNote from the orchestrator: ${note}`);
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = 'blocked';
  const { run } = await f.execute(), decision = run.attention[0]!;
  const input = { schema: 'gbdev.run-resume.v1', run_id: run.run_id, decision_id: decision.decision_id, action: 'retry', task_id: decision.task_id, answers: null, task_graph: null, note: 'x'.repeat(2000) };
  assert.equal(validateRunResume(input, run).note?.length, 2000);
  assert.throws(() => validateRunResume({ ...input, note: 'x'.repeat(2001) }, run), e => e instanceof GbdevError && e.contract.code === 'run_invalid');
});

test('D4 retry_resolve lane-refresh note survives separately from refresh_conflict state reason', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = 'blocked';
  const { run } = await f.execute(), task = run.tasks[0]!, decision = run.attention[0]!;
  task.state_reason = 'refresh_conflict'; decision.allowed_actions = ['retry_resolve']; decision.reason = 'merge_conflict_unresolved';
  const note = 'Authorize the specified whitespace assertion.';
  const prepared = prepareDecisions(f.store, run, f.request, { schema: 'gbdev.run-resume.v1', run_id: run.run_id, decision_id: decision.decision_id, action: 'retry_resolve', task_id: task.task_id, answers: null, task_graph: null, note }, readRuntime(f.store, run));
  assert.equal(prepared.run.tasks[0]!.state, 'ready');
  assert.equal(prepared.run.tasks[0]!.state_reason, 'refresh_conflict');
  assert.equal(prepared.runtime.task_notes?.[task.task_id], note);
});

test('D6 R3 schema and semantics: shared trim-then-guest rule, disjoint tests, same function', t => {
  const root = temporary(t), value = JSON.parse(readFileSync('docs/smoke-m3/r3-request.json', 'utf8'));
  assertSchema(value, runRequestSchema); assert.equal(value.base_ref, 'main');
  const request = validateRunRequest({ ...value, repo: root }, validateConfig({ version: 1, allowed_repos: [root] }), new PipelineRegistry(join(root, 'config.json')));
  assert.equal(request.overlap_policy, 'allow');
  const [trim, guest] = request.tasks!; assert.ok(trim && guest);
  for (const task of [trim, guest]) {
    assert.deepEqual(task.depends_on, []);
    assert.ok(task.file_scope.includes('src/r3-label.js'));
    assert.match(task.goal, /同一 label\(name\) 返回表达式/);
    assert.match(task.context, /字符串先 trim.*trim 后为空字符串或 name 为 null\/undefined 时使用 'guest'.*返回 'Hello ' \+ 结果/);
    assert.match(task.context, /不要为对方负责的输入写断言/);
  }
  assert.match(trim.goal, /只负责字符串 trim.*仅测试 trim 后非空/);
  assert.match(trim.context, /测试不得断言纯空白输入的输出/);
  assert.match(guest.goal, /只负责空值\/空串→guest.*测试覆盖 null\/undefined\/''.*'Hello guest'/);
  assert.match(guest.context, /不负责 trim/);
  assert.match(readFileSync('docs/smoke-m3/README.md', 'utf8'), /t1 只测 trim 后非空.*t2 只测 null\/undefined\/''→guest/);
});

test('D7 attention wait refreshes a running snapshot before returning the settled view', async t => {
  const f = fixture(t); f.request.tasks = [f.request.tasks![0]!]; f.fakePlan['a/implement#1'] = 'blocked';
  const { run } = await f.execute(); assert.equal(run.state, 'needs_decision');
  const stale = { ...run, state: 'running', supervisor_pid: process.pid };
  localSupervisors.add(run.run_id); t.after(() => localSupervisors.delete(run.run_id));
  const original = fs.readFileSync, path = runPaths(f.store, run.run_id).run; let reads = 0;
  const mock = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === path && ++reads === 1) return JSON.stringify(stale);
    return original(...args);
  });
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const response = await runCommand(f.store, ['wait', run.run_id], { 'timeout-ms': '0', until: 'attention' });
  assert.equal((response.result as Run).state, 'needs_decision');
  assert.deepEqual((response.result as Run).attention, run.attention);
  assert.ok(reads >= 2, 're-read the latest atomic run snapshot after observing attention');
});
