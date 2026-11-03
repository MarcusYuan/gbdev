import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { temporary, job } from './helpers.js';
import { validateRunRequest, runRequestSchema } from '../src/contracts/runRequest.js';
import { assertSchema } from '../src/contracts/runValidation.js';
import { validateBrief } from '../src/contracts/brief.js';
import { validateConfig } from '../src/core/config.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';
import { validateDoctorResult } from '../src/contracts/commandResults.js';
import { JobRenderer } from '../src/render/job.js';
import { DASHBOARD_REASONS } from '../src/dashboard/safeArgs.js';

const materials = 'docs/smoke-m4-dashboard';
for (let n = 1; n <= 10; n++) test(`M4 S5 R${n} request validates using only tmpdir, no real provider`, t => {
  const root = temporary(t), value = JSON.parse(readFileSync(`${materials}/r${n}-request.json`, 'utf8'));
  assert.equal(value.repo, '/path/to/gbdev-smoke'); assert.equal(value.base_ref, 'main');
  value.repo = root;
  const config = validateConfig({ version: 1, allowed_repos: [root] });
  if (n === 1 || n === 10) {
    const brief = validateBrief(value, config); assert.equal(brief.provider, n === 1 ? 'codex' : 'fake');
  } else {
    assertSchema(value, runRequestSchema);
    const run = validateRunRequest(value, config, new PipelineRegistry(join(root, 'config.json')));
    assert.equal(run.lanes, 2); assert.equal(run.task_pipeline_overrides.review?.cursor_model, 'auto');
    assert.equal(run.task_pipeline_overrides.implement?.codex_model, 'gpt-6-astra');
    assert.equal(run.tasks!.length, 2);
    assert.deepEqual(run.tasks!.map(task => task.depends_on), [[], []]);
    const scopes = run.tasks!.flatMap(task => task.file_scope);
    assert.equal(new Set(scopes).size, 4);
    assert.ok(scopes.every(path => /^(?:src\/m4d-r\d+-[ab]\.js|test\/m4d-r\d+-[ab]\.test\.js)$/.test(path)));
    assert.equal(run.network, false); assert.deepEqual(value.allowed_paths, ['src/**', 'test/**']);
    assert.equal(value.checks[0].cmd, 'npm test'); assert.match(value.context, /ESM \.js/);
    assert.match(value.goal, /6–10 分钟/);
    for (const task of run.tasks!) {
      assert.equal(task.size, 'M'); assert.equal(task.goal.split('\n').filter(line => /^\d\. /.test(line)).length, 6);
      assert.ok(task.acceptance_criteria.some(ac => /每模块至少 36 个/.test(ac.text)));
      assert.match(task.context, /不得依赖另一任务/);
    }
  }
});

test('M4 S5 recipe preserves SPEC reminders and other rules verbatim, with v1 field mapping', () => {
  const spec = readFileSync('docs/specs/SPEC-M4.md', 'utf8').split('## 15.')[1]!.split('## 16.')[0]!;
  const recipe = readFileSync('docs/controller-recipe.md', 'utf8');
  for (const line of spec.split('\n').filter(line => line.startsWith('> ') || line.startsWith('- '))) {
    // M9 inventory now precedes the original M4 status/capture flow; other reminders stay verbatim.
    if (line.startsWith('- 用户问「它现在在干嘛」')) {
      const updated = recipe.split('\n').find(row => row.startsWith('- 用户问「它现在在干嘛」'));
      assert.ok(updated);
      assert.match(updated, /先用只读 `gbdev run list --active`.*再对选定 id 用 `gbdev run status <id> --json`.*status 会 reconcile，可能写状态/);
      assert.ok(updated.endsWith(line.slice(line.indexOf('需要描述画面时'))));
      assert.ok(!recipe.includes(line), 'do not retain the status-first instruction');
    } else assert.ok(recipe.includes(line), line);
  }
  assert.match(recipe, /<unit_id>.*window/); assert.match(recipe, /enabled=true.*reason=null.*attach_hint/);
  const readme = readFileSync('docs/reference.md', 'utf8'); assert.match(readme, /## 实时观看（tmux）/); assert.match(readme, /前沿去抖/);
  const smoke = readFileSync(`${materials}/README.md`, 'utf8');
  for (let n = 1; n <= 10; n++) assert.ok(smoke.includes(`### M4D-R${n} 记录`));
  assert.match(smoke, /未执行的公开验证模板/);
  assert.equal((smoke.match(/通过\/未通过\/未覆盖及原因 \| 未执行/g) ?? []).length, 10);
});

test('M4 S5 README and recipe reason tables exactly match source enum and SPEC 7.1', () => {
  const spec = readFileSync('docs/specs/SPEC-M4.md', 'utf8');
  const enumLine = spec.split('\n').find(line => line.startsWith('`reason` 枚举：'))!;
  const values = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
  assert.deepEqual(values(enumLine).slice(1).sort(), [...DASHBOARD_REASONS].sort());
  const expected = ['null', ...DASHBOARD_REASONS].sort();
  const tables = ['docs/reference.md', 'docs/controller-recipe.md'].map(file => {
    const text = readFileSync(file, 'utf8');
    const tables = [...text.matchAll(/^\| reason \| 中文说明 \|\r?\n\|[-| ]+\|\r?\n((?:\|[^\n]+\|\r?\n?)+)/gm)];
    assert.equal(tables.length, 1, `${file}: exactly one reason table`);
    const rows = tables[0]![1]!.trim().split('\n');
    const reasons = rows.map(row => {
      const match = /^\| `([^`]+)` \| (.+) \|$/.exec(row);
      assert.ok(match, `${file}: malformed reason row: ${row}`);
      return match[1]!;
    });
    // Arrays (not Sets) also reject duplicate rows, in addition to missing/extra values.
    assert.deepEqual(reasons.sort(), expected, `${file}: reason enum drift`);
    return rows.sort();
  });
  assert.deepEqual(tables[0], tables[1], 'README and recipe explanations must agree');
});

test('M4 doctor validates optional version supported dashboard without breaking legacy checks', () => {
  const check = { name: 'tmux', ok: true, detail: 'optional' };
  assert.doesNotThrow(() => validateDoctorResult({ checks: [check] }));
  const dashboard = { enabled: true, reason: null, tmux_path: '/tmp/fake', tmux_version: '3.6a', session: 'gbdev', session_state: 'absent', windows: [], attach_hint: null };
  assert.doesNotThrow(() => validateDoctorResult({ checks: [{ ...check, version: null, supported: false, dashboard }] }));
  assert.doesNotThrow(() => validateDoctorResult({ checks: [{ ...check, version: '3.6a', supported: true, dashboard }] }));
  for (const extra of [{ version: 3 }, { supported: 'yes' }, { dashboard: null }, { dashboard: { ...dashboard, windows: [{ panes: 'bad' }] } }]) {
    assert.throws(() => validateDoctorResult({ checks: [{ ...check, ...extra }] }));
  }
});

const codex = ['exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high'];
function record(root: string, id: string, provider: string, argv: unknown) {
  const dir = join(root, 'jobs', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ job_id: id, provider, run_id: 'r-current' }));
  writeFileSync(join(dir, 'provider.json'), JSON.stringify({ argv })); return dir;
}
const audit = (...args: string[]) => spawnSync(process.execPath, ['scripts/check-smoke-argv.mjs', '--ac30', ...args], { encoding: 'utf8' });

test('M4 AC-30 arbitrary explicit home/run/job audit checks both providers and never writes', t => {
  const root = temporary(t), home = join(root, 'arbitrary-home');
  const a = record(home, 'j-codex', 'codex', [...codex, 'DO_NOT_PRINT_PROMPT']), b = record(home, 'j-cursor', 'cursor', ['--model', 'auto']);
  record(home, 'j-fake', 'fake', []);
  const run = join(home, 'runs', 'r-current'); mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'run.json'), JSON.stringify({ run_id: 'r-current', tasks: [] }));
  const before = readFileSync(join(a, 'provider.json'), 'utf8');
  for (const args of [['--allow-home', home], [run, a, b], [join(home, 'jobs')]]) {
    const result = audit(...args); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /cursor=1 codex=1 passed=2 failed=0/);
    assert.doesNotMatch(result.stdout, /DO_NOT_PRINT_PROMPT/);
  }
  assert.equal(readFileSync(join(a, 'provider.json'), 'utf8'), before);
  assert.equal(audit(home).status, 1, 'home audit must remain explicit');
  assert.equal(audit(a).status, 0, 'R1 Codex-only job evidence is supported');
});

for (const [name, argv] of Object.entries({
  missing: undefined, model: ['-m', 'other', '-c', 'model_reasoning_effort=high'], effort: ['-m', 'gpt-6-astra'],
  conflict: [...codex, '--model', 'other'], effortConflict: [...codex, '-c', 'model_reasoning_effort=low'],
  bypass: [...codex, '--dangerously-' + 'bypass-approvals-and-sandbox'], sandbox: [...codex, '--sandbox', 'disabled'],
  sandboxEquals: [...codex, '--sandbox=disabled'], malformed: [42],
})) test(`M4 AC-30 Codex ${name} fails closed`, t => {
  const root = temporary(t), result = audit(record(root, 'j-bad', 'codex', argv));
  assert.equal(result.status, 1); assert.match(result.stdout, /FAIL j-bad/);
});

test('M4 AC-30 fake-only home is unverified, not a real provider pass', t => {
  const root = temporary(t), result = audit(record(root, 'j-fake', 'fake', []));
  assert.equal(result.status, 1); assert.match(result.stderr, /UNVERIFIED/);
});

test('M4 R10 fake worker emits fixture and renderer strips OSC title clipboard and fake key', async t => {
  const root = temporary(t), unit = { ...job(), provider: 'fake' as const, state: 'succeeded' as const }, dir = join(root, 'jobs', unit.job_id);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'job.json'), JSON.stringify(unit));
  const output = spawnSync(process.execPath, [resolve('test/fixtures/fake-worker.js'), 'dashboard_injection', dir], { cwd: root, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  assert.ok(output.stdout.includes(readFileSync('test/fixtures/dashboard-injection.jsonl', 'utf8')));
  writeFileSync(join(dir, 'raw.jsonl'), output.stdout);
  const lines = []; for await (const line of new JobRenderer(root, unit.job_id).lines()) lines.push(line.text);
  const text = lines.join('\n'); assert.match(text, /safe-before/); assert.match(text, /safe-after/); assert.match(text, /‹redacted›/);
  assert.doesNotMatch(text, /\x1b|\x07|GBDEV_FAKE_TITLE|sk-M4DashboardSmokeOnly/);
});
