import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const skill = 'skills/gbdev-usage/SKILL.md';
const recipe = 'docs/controller-recipe.md';
const readme = 'docs/reference.md';
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

/** Extract `gbdev <cmd>[ <sub>]` from inline code and fenced blocks (§9 / P2-15).
 * Normalizes bot launchers / placeholders to bare `gbdev`; does NOT filter by a known set.
 * Horizontal whitespace only between launcher/cmd/sub — never spans newlines (P2-21). */
function extractGbdevInvocations(text: string): { cmd: string; sub: string | null; raw: string }[] {
  const found: { cmd: string; sub: string | null; raw: string }[] = [];
  const consider = (chunk: string) => {
    // Split on newlines first so a fenced block's adjacent lines cannot merge into one match.
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
    const m = /^([a-z][a-z0-9-]*)\b/.exec(line);
    if (m && !['usage', 'options', 'commands'].includes(m[1]!)) {
      // keep scanning notify/dashboard/... lines below
    }
  }
  for (const line of help.split('\n')) {
    // M7: inspect is a top-level command (HELP Commands list + usage line).
    const topM = /^(notify|dashboard|run|pipeline|roles|doctor|install|init|start|inspect|logs|status|wait|result|cancel|cleanup)\b/.exec(line);
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

/**
 * Smallest instruction unit containing index: clause inside table cell or line
 * (sentence / comma-or-semicolon clause — not ±N chars, not a whole multi-command cell).
 * Returns trimmed unit plus the match's offset inside that trimmed string.
 */
function containingInstructionUnit(
  text: string,
  index: number,
  matchLen: number,
): { unit: string; relInUnit: number } {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const lineEndIdx = text.indexOf('\n', index);
  const lineEnd = lineEndIdx < 0 ? text.length : lineEndIdx;
  const line = text.slice(lineStart, lineEnd);
  const rel = index - lineStart;

  // Window: table cell that holds this command, else the whole line.
  // Table cells still get sentence/clause splits below (P2-20 residual).
  let windowStart = lineStart;
  let windowEnd = lineEnd;
  if (line.includes('|')) {
    let cellStart = line.lastIndexOf('|', rel);
    cellStart = cellStart < 0 ? 0 : cellStart + 1;
    let cellEnd = line.indexOf('|', rel + matchLen);
    if (cellEnd < 0) cellEnd = line.length;
    windowStart = lineStart + cellStart;
    windowEnd = lineStart + cellEnd;
  }

  // Clause boundary: 。！？；， or .!?;, when boundary-like.
  // Do not look past newlines — a prior line's legacy_default must not exempt this line.
  const isClauseBoundary = (i: number): boolean => {
    const ch = text[i]!;
    if ('。！？；，'.includes(ch)) return true;
    if (
      (ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === ',') &&
      (i + 1 >= text.length || /[\s"'”’]/.test(text[i + 1]!))
    ) {
      return true;
    }
    return false;
  };
  let start = windowStart;
  for (let i = index - 1; i >= windowStart; i--) {
    if (isClauseBoundary(i)) {
      start = i + 1;
      break;
    }
  }
  let end = windowEnd;
  for (let i = index + matchLen; i < windowEnd; i++) {
    if (isClauseBoundary(i)) {
      end = i + 1;
      break;
    }
  }
  const raw = text.slice(start, end);
  const leftTrim = raw.length - raw.trimStart().length;
  const unit = raw.trim();
  return { unit, relInUnit: index - start - leftTrim };
}

const OTHER_NOTIFY_SETUP = '`__OTHER_NOTIFY_SETUP__`';
/** Trailing legacy qualifier glued to a bare setup (swallowed when that setup is a sibling). */
const TRAILING_LEGACY_QUAL =
  /^(?:\s+(?:only\s+(?:for|when)\s+`?legacy_default`?|仅\s*`?legacy_default`?))/i;

/**
 * Mask every `gbdev notify setup` in unit except the one at relInUnit (occurrence-scoped
 * exemption). Also swallow a trailing `only for legacy_default` glued to masked siblings so
 * the next command cannot inherit that qualifier across `__OTHER_NOTIFY_SETUP__`.
 */
function maskOtherBareSetups(unit: string, relInUnit: number): string {
  let out = '';
  let last = 0;
  for (const m of unit.matchAll(/`gbdev notify setup`/g)) {
    const offset = m.index ?? 0;
    out += unit.slice(last, offset);
    if (offset === relInUnit) {
      out += m[0]!;
      last = offset + m[0]!.length;
      continue;
    }
    out += OTHER_NOTIFY_SETUP;
    last = offset + m[0]!.length;
    const trail = unit.slice(last).match(TRAILING_LEGACY_QUAL);
    if (trail) last += trail[0]!.length;
  }
  out += unit.slice(last);
  return out;
}

/**
 * Keep only the segment that still holds this occurrence so `[^。！？.\n]{0,80}` cannot
 * bridge `__OTHER_NOTIFY_SETUP__` and bind a neighbor's legacy/negation to this command.
 */
function truncateAtOtherSetups(scoped: string): string {
  for (const part of scoped.split(OTHER_NOTIFY_SETUP)) {
    if (part.includes('`gbdev notify setup`')) return part;
  }
  return scoped;
}

/**
 * User-facing bare `gbdev notify setup` is a violation unless THIS command's own
 * sentence / list-item / table-cell clause (a) ties it to legacy_default/default home, or
 * (b) is a negation example that the bot must not run it. Nearby keywords or a sibling
 * command's exemption in the same sentence/cell do not exempt this occurrence.
 */
function userFacingBareSetupViolations(text: string): string[] {
  const violations: string[] = [];
  for (const m of text.matchAll(/`gbdev notify setup`/g)) {
    const index = m.index ?? 0;
    const matchLen = m[0]!.length;
    const { unit, relInUnit } = containingInstructionUnit(text, index, matchLen);
    // Bind exemption patterns to THIS occurrence (not a sibling command in the same unit).
    if (unit.slice(relInUnit, relInUnit + matchLen) !== '`gbdev notify setup`') {
      violations.push(unit.replace(/\s+/g, ' ').slice(0, 160));
      continue;
    }
    // When the clause still holds multiple bare setups (no comma between them), mask siblings
    // (plus their glued legacy qualifiers) then keep only this occurrence's segment.
    const scoped = truncateAtOtherSetups(maskOtherBareSetups(unit, relInUnit));
    // Negation: this occurrence is the object of "bot never runs / 不执行".
    const isNegation =
      /(?:bot\s+(?:never\s+runs|不执行)|(?:^|[^\w])不执行)\s*`gbdev notify setup`/i.test(scoped) ||
      /(?:never\s+runs|不执行)\s*`gbdev notify setup`/i.test(scoped);
    // Legacy must qualify this same command occurrence, not a neighbor.
    const isLegacyQualified =
      /(?:bare\s+)?`gbdev notify setup`[^。！？.\n]{0,80}(?:only\s+(?:for|when)\s+`?legacy_default`?|仅\s*`?legacy_default`?)/i.test(scoped) ||
      /(?:only\s+(?:for|when)\s+`?legacy_default`?|仅\s*`?legacy_default`?)[^。！？.\n]{0,80}(?:bare\s+)?`gbdev notify setup`/i.test(scoped) ||
      /(?:legacy_default|默认 home|default home)[^。！？.\n]{0,60}(?:可用)?裸\s*`gbdev notify setup`/i.test(scoped) ||
      /裸\s*`gbdev notify setup`[^。！？.\n]{0,60}(?:legacy_default|默认 home|default home)/i.test(scoped);
    if (!isNegation && !isLegacyQualified) {
      violations.push(unit.replace(/\s+/g, ' ').slice(0, 160));
    }
  }
  return violations;
}

test('AC-26 skill exists with frontmatter; Step 0 starts with gbdev init --bot before notify', () => {
  const text = read(skill);
  assert.match(text, /^---\nname:\s+.+\ndescription:\s+>/m);
  assert.match(text, /^name:\s+/m);
  assert.match(text, /^description:\s+/m);
  const initAt = text.search(/gbdev init --bot/);
  const notifyAt = text.search(/notify status/);
  assert.ok(initAt >= 0, 'init present');
  assert.ok(notifyAt >= 0, 'notify status present');
  assert.ok(initAt < notifyAt, 'init before notify status');
});

test('AC-30 README has both M6 chapters with required rules', () => {
  const text = read(readme);
  assert.match(text, /## 每 bot GBDEV_HOME 与启动器（M6）/);
  assert.match(text, /## 角色与提示词目录（M6）/);
  assert.match(text, /不修改 shell rc|不改.*shell rc|不改 `~\/\.zshrc`/);
  assert.match(text, /启动器不是二进制/);
  assert.match(text, /播种一次，之后各 home 独立|home config.*独立|各 home 独立/);
  assert.match(text, /修改流程/);
  assert.match(text, /快照规则/);
});

test('AC-27 skill and recipe gbdev commands/subcommands exist in CLI help', async () => {
  let help = '';
  assert.equal(await runCli(['--help'], { stdout: s => { help += s; }, stderr: s => assert.fail(s) }), 0);
  const { top, subByCmd } = parseHelpCommands(help);
  assert.ok(top.has('init'));
  assert.ok(top.has('install'));
  assert.ok(top.has('notify'));
  for (const file of [skill, recipe]) {
    assertInvocationsAgainstHelp(file, read(file), top, subByCmd);
  }
});

test('P2-15 extract-all then validate; in-memory invalid commands/subs/placeholders fail', () => {
  const top = new Set(['notify', 'init', 'run', 'doctor']);
  const subByCmd = new Map([['notify', new Set(['status', 'setup', 'ack', 'test', 'enable', 'flush'])]]);
  // Positive: real-looking docs with placeholders normalize and pass.
  assertInvocationsAgainstHelp(
    'memory-ok',
    'Run `<command> notify status --json` and `gbdev-example-dev notify test --json` then `gbdev-<label> notify ack`.',
    top,
    subByCmd,
  );
  assert.throws(
    () => assertInvocationsAgainstHelp('bad-top', 'Use `gbdev frobnicate --json` now.', top, subByCmd),
    /unknown command/,
  );
  assert.throws(
    () => assertInvocationsAgainstHelp('bad-sub', 'Use `gbdev notify teleport --json` now.', top, subByCmd),
    /unknown subcommand/,
  );
  assert.throws(
    () => assertInvocationsAgainstHelp('bad-cmd-placeholder', 'Use `<command> frobnicate --json` now.', top, subByCmd),
    /unknown command/,
  );
  assert.throws(
    () => assertInvocationsAgainstHelp('bad-label-placeholder', 'Use `gbdev-<label> frobnicate --json` now.', top, subByCmd),
    /unknown command/,
  );
  // Extraction must surface unknown cmds (no hard-coded known skip).
  const extracted = extractGbdevInvocations('`gbdev totally-fake-cmd` and `<command> also-fake`');
  assert.ok(extracted.some(i => i.cmd === 'totally-fake-cmd'));
  assert.ok(extracted.some(i => i.cmd === 'also-fake'));

  // P2-21: adjacent fenced lines must not merge cmd+sub across newlines.
  const adjacentBare = '```sh\ngbdev doctor\ngbdev frobnicate --json\n```';
  const fromBare = extractGbdevInvocations(adjacentBare);
  assert.ok(fromBare.some(i => i.cmd === 'doctor' && i.sub === null), 'doctor must not swallow next line');
  assert.ok(fromBare.some(i => i.cmd === 'frobnicate'), 'frobnicate must be extracted as its own top command');
  assert.throws(
    () => assertInvocationsAgainstHelp('adj-bare', adjacentBare, top, subByCmd),
    /unknown command/,
  );

  const adjacentCommand = '```sh\n<command> doctor\n<command> frobnicate --json\n```';
  const fromCommand = extractGbdevInvocations(adjacentCommand);
  assert.ok(fromCommand.some(i => i.cmd === 'doctor' && i.sub === null));
  assert.ok(fromCommand.some(i => i.cmd === 'frobnicate'));
  assert.throws(
    () => assertInvocationsAgainstHelp('adj-command', adjacentCommand, top, subByCmd),
    /unknown command/,
  );

  const adjacentLabel = '```sh\ngbdev-<label> doctor\ngbdev-<label> frobnicate --json\n```';
  const fromLabel = extractGbdevInvocations(adjacentLabel);
  assert.ok(fromLabel.some(i => i.cmd === 'doctor' && i.sub === null));
  assert.ok(fromLabel.some(i => i.cmd === 'frobnicate'));
  assert.throws(
    () => assertInvocationsAgainstHelp('adj-label', adjacentLabel, top, subByCmd),
    /unknown command/,
  );

  // Unknown subcommand on its own line (not swallowed as part of prior cmd).
  const adjacentBadSub = '```sh\ngbdev notify status\ngbdev notify teleport --json\n```';
  const fromBadSub = extractGbdevInvocations(adjacentBadSub);
  assert.ok(fromBadSub.some(i => i.cmd === 'notify' && i.sub === 'status'));
  assert.ok(fromBadSub.some(i => i.cmd === 'notify' && i.sub === 'teleport'));
  assert.throws(
    () => assertInvocationsAgainstHelp('adj-bad-sub', adjacentBadSub, top, subByCmd),
    /unknown subcommand/,
  );
});

test('P1-14 user-facing notify setup uses bot launcher; bare gbdev only with legacy_default', () => {
  for (const file of [skill, recipe]) {
    const text = read(file);
    assert.match(text, /<command> notify setup|~\/\.gbdev-cli\/bin\/gbdev-<label> notify setup/);
    assert.match(text, /legacy_default/);
    assert.match(text, /result\.command|init 返回的|absolute bot launcher|bot 启动器绝对路径/);
    const violations = userFacingBareSetupViolations(text);
    assert.deepEqual(violations, [], `${file}: bare setup without legacy exception: ${violations.join(' | ')}`);
  }
  // In-memory anti-example: instructing user with bare setup and no legacy exception must fail.
  const bad = 'Ask user to run `gbdev notify setup` in his terminal after copying the key.';
  assert.ok(userFacingBareSetupViolations(bad).length > 0);
  const okLegacy = 'Only for `legacy_default` (default home) may user run `gbdev notify setup`.';
  assert.deepEqual(userFacingBareSetupViolations(okLegacy), []);
  const okBotNever = 'The bot never runs `gbdev notify setup` itself.';
  assert.deepEqual(userFacingBareSetupViolations(okBotNever), []);

  // P2-20: negation on the next sentence must not exempt a user "please run bare setup" instruction.
  const userPlusBotNever = [
    '用户唯一手工步骤：在 Mac 终端执行 `gbdev notify setup`。',
    'bot 不执行 `gbdev notify setup`，也不索要秘密。',
  ].join('\n');
  assert.ok(
    userFacingBareSetupViolations(userPlusBotNever).length > 0,
    'user bare-setup instruction must violate even when a nearby sentence says bot 不执行',
  );

  // P2-20: legacy on the previous line must not exempt a following ordinary-bot bare setup.
  const legacyPrevLineThenBare = [
    'Only for `legacy_default` (default home) is bare setup allowed.',
    'Ask user to run `gbdev notify setup` for the new bot.',
  ].join('\n');
  assert.ok(
    userFacingBareSetupViolations(legacyPrevLineThenBare).length > 0,
    'legacy on a prior line must not exempt a later bare setup instruction',
  );

  // P2-20 residual: same-sentence negation must not exempt a sibling user bare-setup command.
  const dualSameSentence =
    'bot 不执行 `gbdev notify setup`，请用户 在 Mac 终端执行 `gbdev notify setup`。';
  {
    const v = userFacingBareSetupViolations(dualSameSentence);
    assert.equal(v.length, 1, `same-sentence dual command: expected exactly 1 violation, got ${JSON.stringify(v)}`);
    assert.match(v[0]!, /用户/);
    assert.doesNotMatch(v[0]!, /bot\s+不执行/);
  }

  // P2-20 residual: table cell must keep sentence/clause splits; bot negation must not exempt user.
  const dualInTableCell =
    '| 操作 | 用户在 Mac 终端执行 `gbdev notify setup`。bot 不执行 `gbdev notify setup`。 |';
  {
    const v = userFacingBareSetupViolations(dualInTableCell);
    assert.equal(v.length, 1, `table-cell dual command: expected exactly 1 violation, got ${JSON.stringify(v)}`);
    assert.match(v[0]!, /用户/);
    assert.doesNotMatch(v[0]!, /bot\s+不执行/);
  }

  // P2-20 residual #2: same clause, no sentence punctuation — legacy on sibling must not exempt new-bot bare setup.
  // Exactly one violation (the new-bot occurrence); the legacy-qualified sibling must stay exempt.
  const newBotThenLegacy =
    'Ask user to run `gbdev notify setup` for the new bot and run `gbdev notify setup` only for `legacy_default`.';
  {
    const v = userFacingBareSetupViolations(newBotThenLegacy);
    assert.equal(v.length, 1, `new-bot then legacy: expected exactly 1 violation, got ${JSON.stringify(v)}`);
    assert.match(v[0]!, /new bot/);
  }
  const legacyThenNewBot =
    'Ask user to run `gbdev notify setup` only for `legacy_default` and run `gbdev notify setup` for the new bot.';
  {
    const v = userFacingBareSetupViolations(legacyThenNewBot);
    assert.equal(v.length, 1, `legacy then new-bot: expected exactly 1 violation, got ${JSON.stringify(v)}`);
    assert.match(v[0]!, /new bot/);
  }

  // Load-bearing: plain replace-to-placeholder without truncate/swallow lets the {0,80}
  // legacy window bridge the sibling and falsely exempt the new-bot command.
  {
    const { unit, relInUnit } = containingInstructionUnit(
      newBotThenLegacy,
      newBotThenLegacy.indexOf('`gbdev notify setup`'),
      '`gbdev notify setup`'.length,
    );
    const naiveMask = unit.replace(/`gbdev notify setup`/g, (occ, offset) =>
      offset === relInUnit ? occ : OTHER_NOTIFY_SETUP,
    );
    assert.ok(
      /`gbdev notify setup`[^。！？.\n]{0,80}only\s+for\s+`legacy_default`/i.test(naiveMask),
      'naive mask without truncate would falsely bind sibling legacy_default to new-bot setup',
    );
    assert.equal(
      /`gbdev notify setup`[^。！？.\n]{0,80}only\s+for\s+`legacy_default`/i.test(
        truncateAtOtherSetups(maskOtherBareSetups(unit, relInUnit)),
      ),
      false,
      'mask+truncate must prevent legacy window from crossing the sibling placeholder',
    );
  }
});

test('P2-18 Codex model is gpt-6-astra with high effort; Cursor only --model auto', () => {
  const text = read(skill);
  assert.match(text, /gpt-6-astra/);
  assert.match(text, /model_reasoning_effort=high/);
  assert.doesNotMatch(text, /e\.g\.\s*`?gpt-6-astra/);
  assert.match(text, /--model auto/);
  assert.doesNotMatch(text, /cursor_model:\s*"(?!auto)[^"]+"/);
});

test('AC-28 critical rule consistency table (independent assertions + counterexamples)', () => {
  const docs = { skill: read(skill), recipe: read(recipe) };
  const skillText = docs.skill;
  const routineStart = skillText.indexOf('## Webhook routine prompt');
  assert.ok(routineStart >= 0);
  const skillRoutine = skillText.slice(routineStart).split(/\n## [0-9]/)[0]!;
  const recipeRoutineStart = docs.recipe.indexOf('### §11.2');
  assert.ok(recipeRoutineStart >= 0);
  const recipeRoutine = docs.recipe.slice(recipeRoutineStart).split(/\n### §11\.[^2]/)[0]!;

  type Rule = {
    name: string;
    docs: 'both' | 'skill-routine' | 'recipe-routine' | 'both-routine';
    must: RegExp;
    mustNot: RegExp;
    dropMakesFail: (text: string) => string;
  };

  const rules: Rule[] = [
    {
      name: 'Step 0 init before notify status',
      docs: 'both',
      must: /gbdev init --bot[\s\S]*?notify status/,
      mustNot: /First run notify status, then gbdev init|先 notify status 再 gbdev init/,
      dropMakesFail: t => t.replace(/gbdev init --bot/g, 'SKIPPED_INIT'),
    },
    {
      name: 'Cursor --model auto only',
      docs: 'both',
      must: /--model auto/,
      mustNot: /cursor_model:\s*"(?!auto)[^"]+"/,
      dropMakesFail: t => t.replace(/--model auto/g, '--model other'),
    },
    {
      name: 'land needs user explicit approval',
      docs: 'both',
      must: /explicit yes|用户的明确|用户明确|--confirm-user-approved/,
      mustNot: /automatically land without approval|无需批准即可 land/,
      dropMakesFail: t => t.replace(/explicit yes|用户明确|--confirm-user-approved/g, 'APPROVAL_REMOVED'),
    },
    {
      name: 'bot never runs notify setup',
      docs: 'both',
      must: /never runs `setup`|不执行 setup|不执行 `gbdev notify setup`/,
      mustNot: /bot (?:should|must) run (?:`gbdev notify setup`|setup)/,
      dropMakesFail: t => t.replace(/never runs `setup`|不执行 setup|不执行 `gbdev notify setup`/g, 'SETUP_RULE_REMOVED'),
    },
    {
      name: 'bot never solicits secrets',
      docs: 'both',
      must: /never solicits|不索要/,
      mustNot: /bot (?:should|must) ask (?:user )?for (?:the )?(?:webhook )?(?:key|secret)|bot 应当索要秘密/,
      dropMakesFail: t => t.replace(/never solicits|不索要/g, 'SOLICIT_RULE_REMOVED'),
    },
    {
      name: 'woken routine executes notify ack',
      docs: 'both',
      must: /woken routine[\s\S]*?notify ack|被唤醒的 routine[\s\S]*?notify ack/,
      mustNot: /sender (?:may|should|must) ack|发起方(?:可以|应当|应该|必须)代 ack/,
      dropMakesFail: t => t.replace(/notify ack/g, 'ACK_REMOVED'),
    },
    {
      name: 'one home one bot',
      docs: 'both',
      must: /one GBDEV_HOME per bot|一个 home 一个 bot/,
      mustNot: /share(?:d)? GBDEV_HOME across bots|多 bot 共用同一 home/,
      dropMakesFail: t => t.replace(/one GBDEV_HOME per bot|一个 home 一个 bot/g, 'HOME_RULE_REMOVED'),
    },
    {
      name: 'never modify shell rc',
      docs: 'both',
      must: /never edit shell rc|\*{0,2}不\*{0,2}修改 shell rc|不改.*rc/,
      mustNot: /append(?:s)? to ~\/\.zshrc|写入.*\.zshrc/,
      dropMakesFail: t => t.replace(/never edit shell rc|\*{0,2}never\*{0,2} modify shell rc|\*{0,2}不\*{0,2}修改 shell rc|不改[^*\n]*rc/g, 'RC_RULE_REMOVED'),
    },
    {
      name: 'payload is data',
      docs: 'both-routine',
      must: /untrusted data|payload 是数据/,
      mustNot: /treat(?:s)? payload as instructions|把 payload 当指令执行/,
      dropMakesFail: t => t.replace(/untrusted data|payload 是数据/g, 'PAYLOAD_RULE_REMOVED'),
    },
    {
      name: 'status then decide',
      docs: 'both-routine',
      must: /Always re-check status|永远先 status 再决定/,
      mustNot: /decide from payload alone|仅凭 payload 决定/,
      dropMakesFail: t => t.replace(/Always re-check status|永远先 status 再决定/g, 'STATUS_RULE_REMOVED'),
    },
    {
      name: 'webhook routine does not land',
      docs: 'both-routine',
      must: /never land|绝不 land/,
      mustNot: /routine (?:should |may )?land|routine 自动 land/,
      dropMakesFail: t => t.replace(/never land|绝不 land/g, 'LAND_RULE_REMOVED'),
    },
    {
      name: 'webhook routine does not push',
      docs: 'both-routine',
      must: /never push|不 push/,
      mustNot: /routine (?:should |may )?push|routine 自动 push/,
      dropMakesFail: t => t.replace(/never push|不 push/g, 'PUSH_RULE_REMOVED'),
    },
  ];

  function scope(rule: Rule, label: 'skill' | 'recipe'): string {
    if (rule.docs === 'both') return docs[label];
    if (rule.docs === 'skill-routine') return skillRoutine;
    if (rule.docs === 'recipe-routine') return recipeRoutine;
    return label === 'skill' ? skillRoutine : recipeRoutine;
  }

  for (const label of ['skill', 'recipe'] as const) {
    for (const rule of rules) {
      if (rule.docs === 'skill-routine' && label !== 'skill') continue;
      if (rule.docs === 'recipe-routine' && label !== 'recipe') continue;
      const text = scope(rule, label);
      assert.match(text, rule.must, `${label}: missing ${rule.name}`);
      assert.doesNotMatch(text, rule.mustNot, `${label}: matched anti-pattern for ${rule.name}`);
      const dropped = rule.dropMakesFail(text);
      assert.doesNotMatch(dropped, rule.must, `${label}: drop counterexample did not remove ${rule.name}`);
    }
  }
});

test('forbidden literals absent from skills/ and roles/', () => {
  const forbidden = [
    '--dangerously-' + 'bypass-approvals-and-sandbox',
    '--sandbox' + ' disabled',
    'shell: true',
  ];
  const files = [...walkFiles('skills'), ...walkFiles('roles')];
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = read(file);
    for (const literal of forbidden) {
      assert.ok(!text.includes(literal), `${file} contains ${literal}`);
    }
  }
  assert.equal(
    walkFiles('skills').some(f => f.endsWith('DEPLOYED-BASELINE.md')),
    false,
    'DEPLOYED-BASELINE.md must be deleted',
  );
});

test('skill frontmatter has name and description', () => {
  const text = read(skill);
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm);
  assert.match(fm![1]!, /^name:\s+\S+/m);
  assert.match(fm![1]!, /^description:\s+/m);
});

test('P3-13 skill prefers real attach_hint; tmux attach -t gbdev only for default home', () => {
  const text = read(skill);
  assert.match(text, /Prefer the real `attach_hint`|prefer.*attach_hint|优先转述/);
  assert.match(text, /attach_hint/);
  // Default-home-only literal must appear with the default-home qualifier nearby.
  const attachIdx = text.indexOf('tmux attach -t gbdev');
  assert.ok(attachIdx >= 0);
  const window = text.slice(Math.max(0, attachIdx - 120), attachIdx + 160);
  assert.match(window, /default.*home|默认.*home/i);
  assert.match(text, /gbdev-<h6>/);
  assert.match(text, /does not affect running tasks|不影响任务/);
  // Non-default must not be instructed to use bare session name as the preferred command.
  assert.doesNotMatch(
    text,
    /non-default home[\s\S]{0,80}tmux attach -t gbdev`(?!.*default)/i,
  );
});
