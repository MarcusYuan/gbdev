#!/usr/bin/env node
/**
 * Read roles/ → emit src/roles/catalog.generated.ts (committed).
 * Zero deps. --check compares without writing (exit 1 on drift).
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ROLES_DIR = join(ROOT, 'roles');
const OUT = join(ROOT, 'src/roles/catalog.generated.ts');
const ROLE_FIELDS = [
  'schema', 'name', 'description', 'purpose', 'provider', 'mode', 'output',
  'allowed_providers', 'codex_model', 'cursor_model', 'default_timeout_min',
  'default_stall_timeout_s', 'prompt', 'aliases', 'used_by',
];
const FRAGMENT_FIELDS = ['id', 'file', 'placeholders', 'used_by', 'trailing_newlines'];

function fail(message) {
  process.stderr.write(`gen-roles: ${message}\n`);
  process.exit(1);
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

/**
 * roles/** text files must end with exactly one \\n, no CR, no trailing whitespace.
 * Returns body with the single file-terminator newline removed.
 */
function loadMdBody(path) {
  const raw = readText(path);
  if (!raw.endsWith('\n')) fail(`${path}: must end with a trailing newline`);
  if (raw.endsWith('\n\n')) fail(`${path}: extra blank line at EOF`);
  if (raw.includes('\r')) fail(`${path}: CR (\\r) is not allowed`);
  const lines = raw.split('\n');
  // Final split element is "" from the terminator newline.
  for (let i = 0; i < lines.length - 1; i++) {
    if (/[ \t]$/.test(lines[i])) fail(`${path}: trailing whitespace on line ${i + 1}`);
  }
  return raw.slice(0, -1);
}

function loadMd(path, trailingNewlines = 0) {
  if (!Number.isInteger(trailingNewlines) || trailingNewlines < 0) {
    fail(`${path}: trailing_newlines must be a non-negative integer`);
  }
  return loadMdBody(path) + '\n'.repeat(trailingNewlines);
}

function placeholdersIn(text) {
  const found = new Set();
  for (const match of text.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)) found.add(match[1]);
  return [...found].sort();
}

function assertPlaceholders(id, text, declared) {
  const found = placeholdersIn(text);
  const want = [...declared].sort();
  if (JSON.stringify(found) !== JSON.stringify(want)) {
    fail(`fragment ${id}: placeholders mismatch: found [${found}] declared [${want}]`);
  }
}

const RESERVED_ROLE_IDS = new Set(['grokbot', 'grok-bot', 'dispatcher', 'decider']);

function normalizeRoleId(value) {
  return String(value).trim().toLowerCase();
}

function assertNotReserved(label, value) {
  if (RESERVED_ROLE_IDS.has(normalizeRoleId(value))) {
    fail(`${label}: role_fixed (reserved identifier ${normalizeRoleId(value)})`);
  }
}

function loadRole(name) {
  assertNotReserved(`role dir ${name}`, name);
  const dir = join(ROLES_DIR, name);
  if (!statSync(dir).isDirectory()) fail(`missing role directory: ${name}`);
  const meta = JSON.parse(readText(join(dir, 'role.json')));
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail(`${name}/role.json: must be object`);
  for (const key of Object.keys(meta)) {
    if (!ROLE_FIELDS.includes(key)) fail(`${name}/role.json: unknown field ${key}`);
  }
  for (const key of ROLE_FIELDS) {
    if (!Object.hasOwn(meta, key)) fail(`${name}/role.json: missing field ${key}`);
  }
  if (meta.schema !== 'gbdev.role-source.v1') fail(`${name}: schema must be gbdev.role-source.v1`);
  if (meta.name !== name) fail(`${name}: name must equal directory name`);
  assertNotReserved(`${name}.name`, meta.name);
  if (meta.prompt !== 'prompt.md') fail(`${name}: prompt must be prompt.md`);
  if (meta.cursor_model !== 'auto') fail(`${name}: cursor_model_not_allowed (cursor_model must be "auto")`);
  const expectedMode = meta.output === 'change' ? 'workspace-write' : 'read-only';
  if (meta.mode !== expectedMode) fail(`${name}: mode ${meta.mode} inconsistent with output ${meta.output} (expected ${expectedMode})`);
  if (!Array.isArray(meta.allowed_providers) || !meta.allowed_providers.length) fail(`${name}: allowed_providers required`);
  if (!meta.allowed_providers.every(p => ['codex', 'cursor', 'fake'].includes(p))) {
    fail(`${name}: allowed_providers must be a nonempty subset of codex, cursor, fake`);
  }
  if (new Set(meta.allowed_providers).size !== meta.allowed_providers.length) {
    fail(`${name}: allowed_providers must be unique`);
  }
  if (!['codex', 'cursor', 'fake'].includes(meta.provider)) fail(`${name}: invalid provider`);
  if (!meta.allowed_providers.includes(meta.provider)) {
    fail(`${name}: provider must be in allowed_providers`);
  }
  if (name === 'resolver' && meta.allowed_providers.includes('cursor')) {
    fail(`${name}: resolver must not allow cursor`);
  }
  if (name === 'inspector') {
    if (meta.output !== 'report' || meta.mode !== 'read-only') fail(`${name}: must be report / read-only`);
    if (!meta.allowed_providers.every(p => p === 'cursor' || p === 'fake')) {
      fail(`${name}: allowed_providers must be a nonempty subset of cursor, fake`);
    }
    if (meta.provider !== 'cursor' && meta.provider !== 'fake') fail(`${name}: provider must be cursor or fake`);
  }
  if (!Array.isArray(meta.aliases) || !meta.aliases.every(a => typeof a === 'string')) fail(`${name}: aliases must be string[]`);
  for (const alias of meta.aliases) assertNotReserved(`${name}.alias`, alias);
  if (!Array.isArray(meta.used_by) || !meta.used_by.every(a => typeof a === 'string')) fail(`${name}: used_by must be string[]`);
  if (typeof meta.purpose !== 'string' || !meta.purpose.trim()) fail(`${name}: purpose required`);
  if (typeof meta.description !== 'string' || !meta.description.trim()) fail(`${name}: description required`);
  if (meta.description.length > 200) fail(`${name}: description must be at most 200 characters`);
  if (!['change', 'verdict', 'report'].includes(meta.output)) fail(`${name}: invalid output`);
  if (meta.codex_model !== null && (typeof meta.codex_model !== 'string' || !meta.codex_model.trim())) {
    fail(`${name}: codex_model must be string or null`);
  }
  if (!Number.isInteger(meta.default_timeout_min) || meta.default_timeout_min < 1 || meta.default_timeout_min > 240) {
    fail(`${name}: invalid default_timeout_min`);
  }
  if (!Number.isSafeInteger(meta.default_stall_timeout_s) || meta.default_stall_timeout_s < 0) {
    fail(`${name}: invalid default_stall_timeout_s`);
  }

  const promptText = loadMd(join(dir, 'prompt.md'));
  if (promptText.includes('\n\n') || promptText.split('\n').some(line => line === '')) {
    fail(`${name}/prompt.md: empty lines are not allowed`);
  }
  const instructions = promptText.length === 0 ? [] : promptText.split('\n');
  if (instructions.length > 40) fail(`${name}: instructions must contain at most 40 strings`);
  if (instructions.some(s => s.length > 500)) fail(`${name}: each instruction must be at most 500 characters`);
  return {
    schema: 'gbdev.role.v1',
    name: meta.name,
    description: meta.description,
    output: meta.output,
    sandbox: expectedMode,
    provider: meta.provider,
    allowed_providers: [...meta.allowed_providers],
    codex_model: meta.codex_model,
    cursor_model: 'auto',
    default_timeout_min: meta.default_timeout_min,
    default_stall_timeout_s: meta.default_stall_timeout_s,
    instructions,
    instructions_file: null,
    aliases: [...meta.aliases],
  };
}

const FRAGMENTS_ROOT_FIELDS = ['schema', 'fragments'];

function loadFragments() {
  const shared = join(ROLES_DIR, '_shared');
  const index = JSON.parse(readText(join(shared, 'fragments.json')));
  if (!index || typeof index !== 'object' || Array.isArray(index)) fail('fragments.json: must be object');
  for (const key of Object.keys(index)) {
    if (!FRAGMENTS_ROOT_FIELDS.includes(key)) fail(`fragments.json: unknown field ${key}`);
  }
  for (const key of FRAGMENTS_ROOT_FIELDS) {
    if (!Object.hasOwn(index, key)) fail(`fragments.json: missing field ${key}`);
  }
  if (index.schema !== 'gbdev.prompt-fragments.v1') fail('fragments.json: bad schema');
  if (!Array.isArray(index.fragments)) fail('fragments.json: fragments must be array');
  const out = {};
  const seen = new Set();
  for (const entry of index.fragments) {
    if (!entry || typeof entry !== 'object') fail('fragments.json: bad entry');
    for (const key of Object.keys(entry)) {
      if (!FRAGMENT_FIELDS.includes(key)) fail(`fragments.json: unknown field ${key}`);
    }
    const { id, file, placeholders, used_by } = entry;
    if (typeof id !== 'string' || !id) fail('fragments.json: id required');
    if (seen.has(id)) fail(`fragments.json: duplicate id ${id}`);
    seen.add(id);
    if (typeof file !== 'string' || !file.endsWith('.md')) fail(`fragment ${id}: bad file`);
    if (!Array.isArray(placeholders) || !placeholders.every(p => typeof p === 'string')) {
      fail(`fragment ${id}: placeholders must be string[]`);
    }
    if (!Array.isArray(used_by) || !used_by.every(u => typeof u === 'string')) {
      fail(`fragment ${id}: used_by must be string[]`);
    }
    let trailingNewlines = 0;
    if (Object.hasOwn(entry, 'trailing_newlines')) {
      trailingNewlines = entry.trailing_newlines;
      if (!Number.isInteger(trailingNewlines) || trailingNewlines < 0) {
        fail(`fragment ${id}: trailing_newlines must be a non-negative integer`);
      }
    }
    const text = loadMd(join(shared, file), trailingNewlines);
    assertPlaceholders(id, text, placeholders);
    out[id] = text;
  }
  return out;
}

function emit(roles, aliases, fragments) {
  const header = '// GENERATED by scripts/gen-roles.mjs — do not edit\n';
  const body = [
    header,
    'export const ROLE_SOURCES = ',
    JSON.stringify(roles, null, 2),
    ' as const;\n\n',
    'export const ROLE_ALIASES = ',
    JSON.stringify(aliases, null, 2),
    ' as const;\n\n',
    'export const PROMPT_FRAGMENTS = ',
    JSON.stringify(fragments, null, 2),
    ' as const;\n',
  ].join('');
  return body;
}

function main() {
  const check = process.argv.includes('--check');
  const entries = readdirSync(ROLES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
  const roleDirs = entries.filter(n => n !== '_shared');
  if (!entries.includes('_shared')) fail('missing roles/_shared');
  // Preserve catalog order while enforcing the exact seven-role closed set.
  const roleNames = ['planner', 'executor', 'fixer', 'reviewer', 'verifier', 'resolver', 'inspector'];
  if (JSON.stringify(roleDirs) !== JSON.stringify([...roleNames].sort())) {
    fail(`role name set mismatch: expected ${[...roleNames].sort().join(',')}; found ${roleDirs.join(',')}`);
  }

  const loaded = roleNames.map(loadRole);
  const aliases = {};
  for (const role of loaded) {
    for (const alias of role.aliases) {
      assertNotReserved(`alias ${alias}`, alias);
      assertNotReserved(`alias target ${alias}`, role.name);
      if (Object.hasOwn(aliases, alias)) fail(`duplicate alias ${alias}`);
      aliases[alias] = role.name;
    }
  }
  if (aliases['code-reviewer'] !== 'reviewer') fail('expected alias code-reviewer → reviewer');

  const roleSources = loaded.map(({ aliases: _a, ...role }) => role);
  const fragments = loadFragments();
  const text = emit(roleSources, aliases, fragments);

  if (check) {
    let existing = '';
    try { existing = readFileSync(OUT, 'utf8'); }
    catch { fail(`missing ${OUT}`); }
    if (existing !== text) fail(`${OUT} is out of date; run node scripts/gen-roles.mjs`);
    process.stdout.write('gen-roles: ok\n');
    return;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  process.stdout.write(`wrote ${OUT}\n`);
}

main();
