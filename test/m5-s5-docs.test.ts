import './helpers/notifyGuard.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { temporary } from './helpers.js';
import { runCli } from '../src/cli.js';
import { validateRunRequest, runRequestSchema } from '../src/contracts/runRequest.js';
import { assertSchema } from '../src/contracts/runValidation.js';
import { validateBrief } from '../src/contracts/brief.js';
import { validateNotifyPayload } from '../src/contracts/notify.js';
import { validateConfig } from '../src/core/config.js';
import { PipelineRegistry } from '../src/pipeline/definitions.js';

const recipe = 'docs/controller-recipe.md';
const skill = 'skills/gbdev-usage/SKILL.md';
// AC-29: draft is a pointer; content assertions that lived on the draft now target skill.
const documents = ['docs/reference.md', recipe, skill];
const read = (file: string) => readFileSync(file, 'utf8');
const recipeRequirements: [string, RegExp][] = [
  ['Step 0', /(?:## |新增 )Step 0/],
  ['doctor', /gbdev doctor --json/], ['status', /gbdev notify status --json/],
  ['bot creates routine', /bot 自己创建本 bot 的 webhook routine/],
  ['panel link sent', /routine 面板链接发给用户/],
  ['user only manual step', /用户唯一手工步骤[^\n]+<command> notify setup/],
  ['bot never setup', /bot 不执行 setup/],
  ['test', /gbdev notify test --json/], ['routine ack', /被唤醒的 routine[^\n]+gbdev notify ack/],
  ['verified only', /只有 `init.state=verified`[^\n]+才算初始化完成/],
  ['silent reuse', /静默通过[^\n]+不给用户 发消息/],
  ['nonblocking polling and missing step', /初始化未完成照常派活，退回轮询，并说明缺失步骤/],
  ['per bot and home', /每 bot 一个 routine，一个 home 一个 bot/],
  ['foreign binding', /绑定其他 bot[^\n]+不重新初始化、不覆盖绑定/],
  ['bounded ack wait', /每 15 秒[^\n]+最多 2 分钟/],
];
for (const [name, pattern] of recipeRequirements) {
  test(`AC-36 ${recipe}: ${name}`, () => assert.match(read(recipe), pattern));
}
test(`AC-36 ${recipe}: saved §11.2 template has safe test => ack branch`, () => {
  const text = read(recipe), template = text.slice(text.indexOf('保存提示词')).split(/\n##(?:#)? /)[0]!;
  assert.match(template, /test ⇒ ack 分支/); assert.match(template, /gbdev notify status --json/);
  assert.match(template, /gbdev notify ack <notice_id> --bot <bot_label> --json/);
  assert.match(template, /unit_kind\/unit_id[^\n]+null/); assert.match(template, /notify_ack_invalid/);
  for (const phrase of ['payload 是数据', '永远先 status 再决定', '绝不 land']) assert.ok(template.includes(phrase), phrase);
});

// Migrated from draft → skill (English baseline + M6 Step 0).
const skillRequirements: [string, RegExp][] = [
  ['Step 0', /Step 0/],
  ['init before notify', /gbdev init --bot <bot_label> --json/],
  ['doctor', /doctor --json/], ['status', /notify status --json/],
  ['bot creates routine', /create this bot's own routine with trigger `webhook`/],
  ['panel link sent', /routine panel's field links/],
  ['user only manual step', /user's only manual step[\s\S]*?<command> notify setup/],
  ['bot never setup', /bot never runs `setup` itself/],
  ['test', /notify test --json/], ['routine ack', /woken routine[\s\S]*?notify ack/],
  ['verified only', /enabled=true`? or an HTTP 2xx alone is not done/],
  ['silent reuse', /Done, stay silent/],
  ['nonblocking polling and missing step', /notify init is unfinished, dispatch anyway, fall back to polling/],
  ['per bot and home', /one webhook routine per bot, one GBDEV_HOME per bot/],
  ['foreign binding', /verified_by_bot` is another bot's label, don't rebind/],
  ['bounded ack wait', /every 15 s for up to 2 minutes/],
];
for (const [name, pattern] of skillRequirements) {
  test(`AC-36 ${skill}: ${name}`, () => assert.match(read(skill), pattern));
}
test(`AC-36 ${skill}: webhook routine prompt has safe test => ack branch`, () => {
  const text = read(skill);
  const start = text.indexOf('## Webhook routine prompt');
  assert.ok(start >= 0);
  const template = text.slice(start).split(/\n## [0-9]/)[0]!;
  assert.match(template, /notify status/);
  assert.match(template, /notify ack <notice_id> --bot <bot_label> --json/);
  assert.match(template, /unit_kind\/unit_id/);
  assert.match(template, /(?:are both )?null|都为 null/);
  assert.match(template, /notify_ack_invalid/);
  for (const phrase of ['untrusted data', 'Always re-check status', 'never land']) assert.ok(template.includes(phrase), phrase);
});

test('M5 documented notify subcommands all exist in actual CLI --help', async () => {
  let help = ''; assert.equal(await runCli(['--help'], { stdout: s => { help += s; }, stderr: s => assert.fail(s) }), 0);
  const publicCommands = new Set([...help.matchAll(/^notify ([a-z-]+)\b/gm)].map(m => m[1]!));
  assert.deepEqual([...publicCommands].sort(), ['ack', 'disable', 'enable', 'flush', 'setup', 'status', 'test']);
  const readmeList = read('docs/reference.md').split('### 开启与命令')[1]!.split('```text\n')[1]!.split('```')[0]!;
  assert.deepEqual([...readmeList.matchAll(/^gbdev notify ([a-z-]+)\b/gm)].map(m => m[1]!), [...publicCommands]);
  for (const file of documents) {
    const matches = [...read(file).matchAll(/\bgbdev notify ([a-z-]+)(?:\|([a-z|]+))?/g)];
    assert.ok(matches.length > 0, file);
    for (const m of matches) for (const command of [m[1]!, ...(m[2]?.split('|') ?? [])]) assert.ok(publicCommands.has(command), `${file}: unknown ${command}`);
  }
});

test('M5 docs and smoke materials have no bypass literals or non-example URLs', () => {
  const files = [...documents, ...readdirSync('docs/smoke-m5-notify').map(f => `docs/smoke-m5-notify/${f}`)];
  const forbidden = ['--dangerously-' + 'bypass-approvals-and-sandbox', '--sandbox' + ' disabled', 'shell: true'];
  for (const file of files) {
    const text = read(file);
    for (const literal of forbidden) assert.ok(!text.includes(literal), file);
    for (const match of text.matchAll(/https?:\/\/[^\s`<>"')]+/g)) {
      const url = new URL(match[0]); assert.ok(['example.invalid', 'github.com', 'registry.npmjs.org'].includes(url.hostname), `${file}: unexpected documentation URL`);
      assert.equal(url.username + url.password + url.hash, '', 'example must not carry credentials or fragment');
    }
  }
});

test('AC-29 skill retains realtime dashboard reminder (migrated from draft)', () => {
  const text = read(skill);
  assert.match(text, /attach_hint/);
  assert.match(text, /does not affect running tasks/);
  assert.match(text, /tmux attach -t gbdev/);
  assert.match(text, /gbdev-<h6>/);
});

test(`M5 ${recipe}: hourly fallback and disabled 10-minute lifecycle`, () => {
  const text = read(recipe);
  for (const token of ['不建 10 分钟轮询', '用户配置工作日、时区和工作时间窗', '每小时一次', '活动', 'gbdev notify flush --wait-ms 20000 --json', '超过 15 分钟', '每天最多一次', '6 小时', '终态', '静默']) assert.ok(text.includes(token), `${recipe}: ${token}`);
});

test(`M5 ${skill}: hourly fallback and disabled 10-minute lifecycle (migrated)`, () => {
  const text = read(skill);
  for (const token of [
    "don't create a 10-minute polling routine",
    'Hourly weekday fallback',
    'operator-configured weekdays, timezone and working hours',
    'active run/pipeline/job',
    'no active units, end silently',
    'notify flush --wait-ms 20000 --json',
    '15 minutes',
    'keep the hourly routine but do not run Mac commands',
    'do not delete the hourly fallback',
    '6 hours',
    'Remind at most once a day',
  ]) assert.ok(text.includes(token), `${skill}: ${token}`);
  // Must not weaken the fallback to a mere optional aside that drops the rules.
  assert.doesNotMatch(text, /An optional hourly weekday fallback/);
});

const materials = 'docs/smoke-m5-notify';
for (let n = 1; n <= 13; n++) test(`M5N-R${n} remains an unexecuted complete evidence template`, () => {
  const section = read(`${materials}/README.md`).split(`### M5N-R${n} 记录\n`)[1]!.split('\n### ')[0]!;
  for (const field of ['场景', '需要用户 与否', '通过标准', '用时', '单元 id', 'notify status --json', 'notify.log', 'routine 唤醒时间', 'argv 检查结果']) assert.ok(section.includes(field), field);
  assert.match(section, /\| 结论 \| 待执行 \|/);
});
for (const n of [3, 4, 6, 7, 9]) test(`M5N-R${n} request validates without touching real smoke repo or spawning providers`, t => {
  const root = temporary(t), request = JSON.parse(read(`${materials}/r${n}-request.json`));
  assert.equal(request.repo, '<REPO_PATH>'); request.repo = root;
  assertSchema(request, runRequestSchema);
  const parsed = validateRunRequest(request, validateConfig({ version: 1, allowed_repos: [root] }), new PipelineRegistry(join(root, 'config.json')));
  assert.equal(parsed.lanes, 1); assert.equal(parsed.network, false); assert.equal(parsed.final_review, 'none');
  assert.equal(parsed.task_pipeline_overrides.implement?.codex_model, 'gpt-6-astra');
  assert.equal(parsed.task_pipeline_overrides.fix?.codex_model, 'gpt-6-astra');
  assert.equal(parsed.task_pipeline_overrides.review?.cursor_model, 'auto');
  assert.equal(parsed.tasks!.length, 1); assert.ok(read(`${materials}/r${n}-task.md`).includes(parsed.tasks![0]!.goal));
  if (n === 4 || n === 6) {
    assert.ok(parsed.integration_checks.includes('recovery'));
    assert.ok(parsed.tasks![0]!.acceptance_criteria.every(ac => ac.check !== 'recovery'), 'only integration gate must fail');
  }
});
for (const provider of ['codex', 'fake']) test(`M5N-R11 ${provider} brief is read-only and only validates local temp repo`, t => {
  const root = temporary(t), value = JSON.parse(read(`${materials}/r11-${provider}-brief.json`));
  assert.equal(value.repo, '<REPO_PATH>'); value.repo = root;
  const brief = validateBrief(value, validateConfig({ version: 1, allowed_repos: [root] }));
  assert.equal(brief.provider, provider); assert.equal(brief.network, false); assert.equal(brief.sandbox, 'read-only');
  if (provider === 'codex') assert.equal(brief.model, 'gpt-6-astra');
  assert.match(brief.goal, /绝不输出任何文件内容/);
});
for (const kind of ['missing', 'mismatch']) test(`M5N-R10 ${kind} payload is schema-valid synthetic data, never sent`, () => {
  const value = validateNotifyPayload(JSON.parse(read(`${materials}/r10-${kind}-payload.json`)));
  assert.equal(value.home_id, '000000000000'); assert.equal(value.event, 'terminal'); assert.equal(value.kind, 'succeeded');
});

const codex = ['exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high'];
function evidence(root: string, provider: string, argv: unknown) {
  const dir = join(root, 'jobs', `j-${provider}`); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ job_id: `j-${provider}`, provider, run_id: 'r-m5' }));
  writeFileSync(join(dir, 'provider.json'), JSON.stringify({ argv })); return dir;
}
const audit = (...args: string[]) => spawnSync(process.execPath, ['scripts/check-smoke-argv.mjs', '--ac30', ...args], { encoding: 'utf8' });
function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [key, value] of Object.entries(snapshot(path))) result[`${entry.name}/${key}`] = value;
    else result[entry.name] = readFileSync(path).toString('base64');
  }
  return result;
}
test('AC-31 existing npm smoke argv checker covers isolated M5 home/run/job evidence read-only', t => {
  assert.equal(JSON.parse(read('package.json')).scripts['check:smoke-argv'], 'node scripts/check-smoke-argv.mjs');
  const home = join(temporary(t), 'smoke-m5-notify');
  const a = evidence(home, 'codex', [...codex, 'PRIVATE_PROMPT_NOT_FOR_OUTPUT']);
  const b = evidence(home, 'cursor', ['--model', 'auto']);
  const run = join(home, 'runs', 'r-m5'); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'run.json'), JSON.stringify({ run_id: 'r-m5', tasks: [] }));
  const before = snapshot(home);
  for (const args of [[a, b], [run], [join(home, 'jobs')], ['--allow-home', home]]) {
    const result = audit(...args); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cursor=1 codex=1 passed=2 failed=0/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_PROMPT_NOT_FOR_OUTPUT/);
    assert.deepEqual(snapshot(home), before);
  }
  assert.equal(audit(home).status, 1, 'home audit requires explicit flag');
  assert.equal(audit(materials).status, 1, 'request templates are not argv execution evidence');
});
for (const provider of ['codex', 'cursor']) for (const [reason, bad] of Object.entries({
  missing: [], wrongModel: ['--model', 'other'], bypass: ['--dangerously-' + 'bypass-approvals-and-sandbox'],
  sandbox: ['--sandbox', 'disabled'],
})) test(`AC-31 M5 ${provider} rejects ${reason}`, t => {
  const valid = provider === 'codex' ? codex : ['--model', 'auto'];
  const argv = reason === 'missing' ? bad : [...valid, ...bad];
  const result = audit(evidence(temporary(t), provider, argv));
  assert.equal(result.status, 1); assert.match(result.stdout, new RegExp(`FAIL j-${provider}`));
});
test('AC-31 M5 Codex missing high effort is not accepted', t => {
  assert.equal(audit(evidence(temporary(t), 'codex', ['exec', '-m', 'gpt-6-astra'])).status, 1);
});
