import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const skill = 'skills/gbdev-usage/SKILL.md';
const recipe = 'docs/controller-recipe.md';
const readme = 'docs/reference.md';
const rolesReadme = 'roles/README.md';
const read = (file: string) => readFileSync(file, 'utf8');

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

/** Same extraction style as m6-s4-docs: all gbdev cmd/sub from docs, validate vs HELP. */
function extractGbdevInvocations(text: string): { cmd: string; sub: string | null; raw: string }[] {
  const found: { cmd: string; sub: string | null; raw: string }[] = [];
  const consider = (chunk: string) => {
    for (const logicalLine of chunk.split(/\n/)) {
      const normalized = logicalLine
        .replace(/<command>/g, 'gbdev')
        .replace(/gbdev-<label>/g, 'gbdev')
        .replace(/gbdev-[a-z0-9-]+/g, 'gbdev');
      for (const m of normalized.matchAll(/\bgbdev(?:[ \t]+|`)([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?/g)) {
        found.push({ cmd: m[1]!, sub: m[2] ?? null, raw: m[0]! });
      }
    }
  };
  const withoutFences = text.replace(/```[\w]*\n[\s\S]*?```/g, '\n');
  for (const block of text.matchAll(/```[\w]*\n([\s\S]*?)```/g)) consider(block[1]!);
  for (const inline of withoutFences.matchAll(/`([^`]+)`/g)) consider(inline[1]!);
  return found;
}

function parseHelpCommands(help: string): { top: Set<string>; subByCmd: Map<string, Set<string>> } {
  const top = new Set<string>();
  const commandsLine = help.match(/^Commands:\s*(.+)$/m);
  if (commandsLine) {
    for (const c of commandsLine[1]!.split(',').map(s => s.trim()).filter(Boolean)) top.add(c);
  }
  for (const line of help.split('\n')) {
    const topM =
      /^(notify|dashboard|run|pipeline|roles|doctor|install|init|start|inspect|logs|status|wait|result|cancel|cleanup)\b/.exec(
        line,
      );
    if (topM) top.add(topM[1]!);
  }
  const subByCmd = new Map<string, Set<string>>();
  for (const line of help.split('\n')) {
    const m = /^(notify|dashboard|run|pipeline|roles)\s+([a-z][a-z0-9-]*)\b/.exec(line);
    if (!m) continue;
    if (!subByCmd.has(m[1]!)) subByCmd.set(m[1]!, new Set());
    subByCmd.get(m[1]!)!.add(m[2]!);
  }
  return { top, subByCmd };
}

function assertInvocationsAgainstHelp(
  label: string,
  text: string,
  top: Set<string>,
  subByCmd: Map<string, Set<string>>,
): void {
  const invocations = extractGbdevInvocations(text);
  assert.ok(invocations.length > 0, label);
  for (const { cmd, sub, raw } of invocations) {
    assert.ok(top.has(cmd), `${label}: unknown command in ${raw}`);
    if (sub && subByCmd.has(cmd)) {
      assert.ok(subByCmd.get(cmd)!.has(sub), `${label}: unknown subcommand ${cmd} ${sub} in ${raw}`);
    }
  }
}

type Rule = {
  name: string;
  must: RegExp;
  mustNot: RegExp;
  dropMakesFail: (text: string) => string;
};

function assertRules(label: string, text: string, rules: Rule[]): void {
  for (const rule of rules) {
    assert.match(text, rule.must, `${label}: missing ${rule.name}`);
    assert.doesNotMatch(text, rule.mustNot, `${label}: matched anti-pattern for ${rule.name}`);
    const dropped = rule.dropMakesFail(text);
    assert.doesNotMatch(dropped, rule.must, `${label}: drop counterexample did not remove ${rule.name}`);
  }
}

test('AC-35 skill and recipe independently assert R1–R6 with drop counterexamples', () => {
  const r1toR6: Rule[] = [
    {
      name: 'R1 sole decider',
      must: /R1[^\n]{0,80}(?:Sole decider|唯一决策者)|(?:Sole decider|唯一决策者)[^\n]{0,40}R1/i,
      mustNot: /Codex (?:is|as) the (?:sole|only) decider|Codex 是唯一决策者/,
      dropMakesFail: t => t.replace(/R1[^\n]*/g, 'R1_REMOVED').replace(/Sole decider|唯一决策者/gi, 'DECIDER_REMOVED'),
    },
    {
      name: 'R2 direction-level planning',
      must: /R2[^\n]{0,100}(?:Direction-level planning|方向规划)|(?:Direction-level planning|方向规划)/i,
      mustNot: /controller (?:writes|owns) (?:file-by-file|逐文件) implementation/,
      dropMakesFail: t =>
        t.replace(/R2[^\n]*/g, 'R2_REMOVED').replace(/Direction-level planning only|方向规划/gi, 'PLAN_REMOVED'),
    },
    {
      name: 'R3 read-only',
      must: /R3[^\n]{0,80}(?:Read-only|只读)|(?:Read-only|只读)[^\n]{0,40}(?:project|repo|文件)/i,
      mustNot: /controller (?:edits|writes) (?:project|repo) files|controller 编辑项目文件/,
      dropMakesFail: t => t.replace(/R3[^\n]*/g, 'R3_REMOVED').replace(/\*\*R3[^*]*\*\*/g, 'R3_GONE'),
    },
    {
      name: 'R4 event-typed',
      // Require the R4 heading itself (not the later decision-table reuse of plan_review / 8 tasks).
      must: /R4[^\n]{0,120}(?:Event-typed handling|按事件)/i,
      mustNot: /always ask user for every attention|每个 attention 都问用户/,
      dropMakesFail: t => t.replace(/R4[^\n]*/g, 'R4_REMOVED'),
    },
    {
      name: 'R5 no day-to-day drive',
      must: /R5[^\n]{0,120}(?:Do not day-to-day-drive|不调度日常执行|不直接指挥)/i,
      mustNot: /controller (?:commands|drives) panes daily|controller 日常指挥 pane/,
      dropMakesFail: t => t.replace(/R5[^\n]*/g, 'R5_REMOVED'),
    },
    {
      name: 'R6 role fixed',
      must: /R6[^\n]{0,80}(?:role is fixed|角色固定)|role_fixed/i,
      mustNot: /Codex implements;\s*Cursor reviews/,
      dropMakesFail: t =>
        t.replace(/R6[^\n]*/g, 'R6_REMOVED').replace(/role_fixed/g, 'ROLE_FIXED_REMOVED'),
    },
  ];

  for (const file of [skill, recipe]) {
    assertRules(file, read(file), r1toR6);
    const text = read(file);
    assert.match(text, /planner\s*\/\s*fixer\s*\/\s*resolver|planner\/fixer\/resolver/);
    assert.match(text, /executor\s*\/\s*reviewer\s*\/\s*verifier\s*\/\s*inspector|executor\/reviewer\/verifier\/inspector/);
    assert.match(text, /gpt-6-astra/);
    assert.match(text, /model_reasoning_effort=high|--model auto/);
    assert.doesNotMatch(text, /Codex implements;\s*Cursor reviews/);
  }
});

function assertVerdictMissingDecision(label: string, document: string): void {
  const text = document.match(/^\|\s*verdict_missing\s*\|[^\n]*$/m)?.[0];
  assert.ok(text, `${label}: missing verdict_missing decision row`);
  assert.match(text, /verdict_missing_reviewed\s*:\s*true|verdict_missing_reviewed:true/);
  assert.match(text, /note/);
  assert.match(text, /retry[\s\S]{0,200}inspect[\s\S]{0,200}(?:accept|接受)/i);
  assert.match(text, /`?\bretry\b`?\s*(?:≠|!=|不是|is not)\s*`?retry_task\b/i, `${label}: retry must differ from retry_task`);
  assert.match(
    text,
    /stdout succeeded[^\n]{0,40}(?:review|审查)|succeeded[^\n]{0,40}(?:≠|不代表|不是)[^\n]{0,40}(?:review|审查)/i,
  );
  assert.match(
    text,
    /no structured reviewer|无 reviewer|无 reviewer 结构化|controller (?:accepted|基于取证接受)/i,
  );
  assert.doesNotMatch(text, /missing verdict[^\n]{0,40}default accept|缺失 verdict[^\n]{0,20}直接 accept/i);
}

test('AC-36 verdict_missing decision rows: retry → inspect → explicit accept; retry ≠ retry_task', () => {
  for (const file of [skill, recipe]) {
    const text = read(file);
    assertVerdictMissingDecision(file, text);
    // Drop counterexample: removing the verdict_missing row must fail the primary assertion.
    const dropped = text.replace(/^\|\s*verdict_missing\s*\|[^\n]*\n?/m, '');
    assert.notEqual(dropped, text);
    assert.throws(() => assertVerdictMissingDecision(file, dropped), /missing verdict_missing decision row/);
    // Merely retaining both action names must not satisfy the distinction assertion.
    const conflated = text.replace(/`retry` ≠ `retry_task`/g, '`retry` / `retry_task`');
    assert.notEqual(conflated, text);
    assert.throws(() => assertVerdictMissingDecision(file, conflated), /retry must differ from retry_task/);
  }
});

function assertReadmeVerdictRows(text: string): void {
  const rows = text.split('\n').filter(line => /^\s*\|/.test(line) && /\bverdict_missing\b/.test(line));
  assert.ok(rows.length > 0, 'README must retain verdict_missing decision rows');
  for (const row of rows) {
    assert.match(row, /verdict_missing_reviewed|\[M7 接受规则\]\(#verdict_missing-接受规则\)/,
      `verdict_missing table row must reference M7 evidence rules (no bare accept): ${row}`);
  }
}

test('AC-36 README verdict_missing table rows cannot bypass M7 evidence rules', () => {
  const text = read(readme);
  assertReadmeVerdictRows(text);
  for (const regression of [
    '| fix_no_changes / verdict_missing | retry、accept |',
    '| needs_decision: step_failed / verdict_missing | 看 result 后决定是否 retry |',
  ]) {
    // A valid rule elsewhere in the document must not excuse an unsafe row.
    assert.throws(() => assertReadmeVerdictRows(`${text}\n${regression}`), /must reference M7 evidence rules/);
  }
});

test('S4 review: webhook evidence rule, descriptive Codex model and optional JSON', () => {
  for (const file of [skill, recipe]) {
    const step = read(file).match(/^> 4\.[^\n]*$/m)?.[0];
    assert.ok(step, `${file}: missing webhook step 4`);
    assert.match(step, /verdict_missing[^\n]*retry[^\n]*inspect[^\n]*accept/);
  }
  assert.doesNotMatch(read(recipe), /-m\s+gpt-6-astra/);
  assert.match(read(recipe), /未显式配置时沿用 Codex 默认模型/);
  assert.match(read(recipe), /effort 恒为 high/);
  const inspectRow = read(readme).match(/^\| inspect \|[^\n]*$/m)?.[0];
  assert.ok(inspectRow, 'README inspect command row');
  assert.match(inspectRow, /\[--json\]/);
});

test('AC-37 inspect CLI surface, lifecycle, committed snapshot, return to attention', () => {
  for (const file of [skill, recipe]) {
    const text = read(file);
    assert.match(
      text,
      /inspect <run_id\|job_id> --question[^\n]*\[--task <task_id>\][^\n]*\[--paths <relative-path>\]\.\.\.[^\n]*\[--diff\][^\n]*\[--tests\]/,
    );
    assert.match(text, /status <inspect_job_id>|status `?<inspect/);
    assert.match(text, /wait <inspect_job_id>/);
    assert.match(text, /result <inspect_job_id>|result\.inspection/);
    assert.match(text, /uncommitted_excluded|uncommitted[^\n]{0,40}exclud/i);
    assert.match(text, /committed|已提交/);
    assert.match(text, /original\*{0,2} attention|\*{0,2}原\*{0,2} attention|回到[^*\n]{0,20}attention/i);
    assert.match(text, /never auto-accept|绝不自动 accept|绝不自动accept/i);
    assert.match(text, /--task`? (?:only with a|仅适用于) run_id/);
  }
});

test('AC-38 skill/recipe/readme gbdev commands match real HELP; inspect anti-examples fail', async () => {
  let help = '';
  assert.equal(
    await runCli(['--help'], {
      stdout: s => {
        help += s;
      },
      stderr: s => assert.fail(s),
    }),
    0,
  );
  const { top, subByCmd } = parseHelpCommands(help);
  assert.ok(top.has('inspect'), 'HELP must list inspect');
  assert.match(help, /inspect <run_id\|job_id> --question/);

  for (const file of [skill, recipe, readme]) {
    assertInvocationsAgainstHelp(file, read(file), top, subByCmd);
  }

  // Invented inspect sibling commands must fail — cannot expand a whitelist to pass them.
  assert.throws(
    () => assertInvocationsAgainstHelp('bad-top', 'Run `gbdev inspect-wait --json` now.', top, subByCmd),
    /unknown command/,
  );
  const extracted = extractGbdevInvocations('`gbdev inspect-deep --question x`');
  assert.ok(extracted.some(i => i.cmd === 'inspect-deep'));
  assert.throws(
    () => assertInvocationsAgainstHelp('bad-inspect-deep', '`gbdev inspect-deep --question x`', top, subByCmd),
    /unknown command/,
  );
  // Docs must not invent inspect flags that are not on the HELP usage line.
  for (const file of [skill, recipe, readme]) {
    const text = read(file);
    assert.doesNotMatch(text, /inspect[^\n`]*--(?:wait|provider|model|worktree|base-ref|request)\b/);
  }
});

test('AC-39 Step 0 / notify / dashboard / land / hourly / mkdir claim control-plane retained (§13)', () => {
  for (const file of [skill, recipe]) {
    const text = read(file);
    assert.match(text, /gbdev init --bot/);
    assert.match(text, /notify status/);
    assert.match(text, /legacy_default/);
    assert.match(text, /notify ack/);
    assert.match(text, /Hourly weekday fallback|§11\.3|每小时一次|用户配置工作日/);
    assert.match(text, /attach_hint|dashboard ensure/);
    assert.match(text, /explicit yes|用户明确|--confirm-user-approved/);
    assert.match(text, /mkdir[^\n]*handled|<state>\/handled/);
    assert.match(text, /control-plane|控制面/);
    assert.match(text, /(?:unit_kind\/unit_id|unit_kind\/unit_id)[^\n]{0,40}null|都为 null|are both null/);
    // Preferred stdin for decisions/requests
    assert.match(text, /--input -|--request -/);
  }
  // Anti-example: removing control-plane note while keeping mkdir is not enough for AC-39 §13.
  const skillText = read(skill);
  const noControlPlane = skillText.replace(/control-plane[^\n.]*/gi, 'STATE_REMOVED').replace(/控制面[^\n.]*/g, 'STATE_REMOVED');
  assert.doesNotMatch(noControlPlane, /control-plane|控制面/);
});

test('AC-40 README and roles README: configurable engineering roles, fixed controller, inspector', () => {
  const md = read(readme);
  const roles = read(rolesReadme);
  assert.match(md, /inspector/);
  assert.match(md, /role_fixed/);
  assert.match(md, /verdict_missing_reviewed/);
  assert.match(md, /inspect_path_invalid|inspect_target_unavailable/);
  assert.match(md, /gbdev inspect <run_id\|job_id> --question/);
  assert.match(md, /工程角色可配置|三层配置/);
  assert.match(md, /不是把内置默认全局|不是把内置默认/);
  assert.match(roles, /inspector/);
  assert.match(roles, /role_fixed/);
  assert.match(roles, /dispatcher/);
  assert.match(roles, /三层配置|dirname\(config\)\/roles/);
  for (const [label, text] of [[readme, md], [rolesReadme, roles]] as const) {
    assert.match(text, /inspector`[^\n]*(?:只读[^\n]*Cursor `--model auto`|Cursor `--model auto`[^\n]*只读)/, label);
    assert.match(text, /预算上限[^\n]*动态证据包与候选 inspection JSON 各 64 KiB[^\n]*raw\+stderr 合计 1 MiB/, label);
    assert.match(text, /answer ≤2048 字节[^\n]*excerpts 最多 8 个[^\n]*每个最多 40 行\/2048 字节[^\n]*总 text ≤8192 字节/, label);
    assert.match(text, /完整结果 JSON ≤16384 字节/, label);
    assert.match(text, /默认超时 10 min \/ stall 120 s/, label);
  }
  // Must not claim workflow Codex model is a global builtin default migration.
  assert.doesNotMatch(md, /内置默认[^\n]{0,40}全部改为 gpt-6-astra|builtin defaults? (?:are|were) (?:all )?changed to gpt-6-astra/i);
});

test('AC-41 no forbidden argv/shell literals in skills/roles; M7 docs clean', () => {
  const forbidden = ['--dangerously-' + 'bypass-approvals-and-sandbox', '--sandbox' + ' disabled', 'shell: ' + 'true'];
  const files = [...walkFiles('skills'), ...walkFiles('roles'), skill, recipe, readme, rolesReadme];
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = read(file);
    for (const literal of forbidden) {
      assert.ok(!text.includes(literal), `${file} contains ${literal}`);
    }
  }
  // No real webhook URL / secrets in the M7-touched docs.
  for (const file of [skill, recipe, readme, rolesReadme]) {
    const text = read(file);
    for (const match of text.matchAll(/https?:\/\/[^\s`<>"')]+/g)) {
      const url = new URL(match[0]!);
      assert.ok(['example.invalid', 'github.com', 'registry.npmjs.org'].includes(url.hostname), `${file}: unexpected documentation URL`);
      assert.equal(url.username + url.password, '', 'documentation URLs cannot contain credentials');
    }
  }
});

test('AC-42 test/index.ts imports all M7 tests', () => {
  const index = read('test/index.ts');
  for (const name of [
    'm7-s1-roles',
    'm7-s2-verdict',
    'm7-s3-inspect-cli',
    'm7-s3-inspect-evidence',
    'm7-s3-inspect-lifecycle',
    'm7-s3-inspect-concurrency',
    'm7-s3-inspect-notify',
    'm7-s4-docs',
  ]) {
    assert.match(index, new RegExp(`import '\\./${name}\\.test\\.js'`));
  }
});
