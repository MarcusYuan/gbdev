import { compareInstantDesc, instantMs } from '../core/time.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GbdevError } from '../contracts/error.js';
import { type InspectWarning } from '../contracts/inspect.js';
import { isTerminal } from '../contracts/jobStatus.js';
import { git } from '../core/git.js';
import { JobStore } from '../core/jobStore.js';
import { isPathInsideOrEqual, jobPaths } from '../core/paths.js';
import { allJobs } from '../core/runtime.js';
import { redactSecrets } from '../render/redact.js';
import { sanitizeForTerminal } from '../render/sanitize.js';
import { EVIDENCE_PROMPT_MAX, SOURCE_FILE_MAX, TEST_LOG_BYTES, TEST_LOG_LINES, TEST_LOGS_MAX, utf8Bytes, utf8Clip } from './limits.js';
import { readJobResultChecks, type ResolvedInspectTarget } from './target.js';
import { runPaths } from '../run/store.js';

export interface EvidenceSource { path: string; lines: string[] }
export interface TestEvidence {
  source_id: string;
  check_id: string;
  ordinal: number;
  exit_code: number | null;
  checked_sha: string | null;
  log_available: boolean;
  virtual: string;
  lines: string[];
}
export interface EvidencePack {
  files: string[];
  omitted: string[];
  diffs: EvidenceSource[];
  tests: TestEvidence[];
  warnings: InspectWarning[];
  diffRequested: boolean;
  testsRequested: boolean;
  diffAvailable: boolean;
  testsAvailable: boolean;
  diffTruncated: boolean;
  testsTruncated: boolean;
}

export function assertInspectPath(path: string): void {
  if (typeof path !== 'string' || path.includes('\0') || path.includes('\\') || path.includes(':') ||
      /[*?\n\r[\]]/.test(path) || isAbsolute(path) || path.startsWith('~')) {
    throw new GbdevError('inspect_path_invalid', 'Inspect path is not a safe relative path');
  }
  const parts = path.split('/');
  if (!parts.length || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new GbdevError('inspect_path_invalid', 'Inspect path is not a safe relative path');
  }
}

export function pathAllowed(file: string, paths: readonly string[]): boolean {
  if (file.split('/').some(part => part === '' || part === '.' || part === '..')) return false;
  if (!paths.length) return true;
  return paths.some(root => file === root || file.startsWith(`${root}/`));
}

export function canonicalLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  if (lines.length === 1 && lines[0] === '' && normalized === '') return [];
  return lines.map(line => redactSecrets(sanitizeForTerminal(line)));
}

function warn(warnings: InspectWarning[], code: InspectWarning): void {
  if (!warnings.includes(code)) warnings.push(code);
}

function readRegular(path: string, maxBytes: number): Buffer | 'skip' {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EPERM') throw new GbdevError('inspect_path_invalid', 'Inspect path is not a regular file');
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'skip';
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.isFIFO() || !stat.isFile()) return 'skip';
    if (stat.size > maxBytes) return 'skip';
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function insideWorktree(worktree: string, rel: string): string | null {
  if (!pathAllowed(rel, []) && rel.includes('..')) return null;
  const parts = rel.split('/');
  let cursor = worktree;
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); }
    catch { return null; }
    if (stat.isSymbolicLink()) return null;
  }
  const root = resolve(worktree);
  const target = resolve(cursor);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return cursor;
}

/** Read a regular snapshot file. Symlinks, FIFOs, binaries and oversize files are omitted. */
export function readSnapshotFile(worktree: string, rel: string): { lines: string[] } | { omit: 'binary' | 'missing' } {
  try { assertInspectPath(rel); }
  catch { return { omit: 'missing' }; }
  const full = insideWorktree(worktree, rel);
  if (!full) return { omit: 'missing' };
  let body: Buffer | 'skip';
  try { body = readRegular(full, SOURCE_FILE_MAX); }
  catch { return { omit: 'missing' }; }
  if (body === 'skip') return { omit: 'binary' };
  if (body.includes(0)) return { omit: 'binary' };
  try { return { lines: canonicalLines(new TextDecoder('utf-8', { fatal: true }).decode(body)) }; }
  catch { return { omit: 'binary' }; }
}

function listedFiles(repo: string, sha: string): { path: string; mode: string }[] {
  let text = '';
  try { text = git(repo, ['ls-tree', '-r', sha]); }
  catch { return []; }
  return text.split('\n').filter(Boolean).flatMap(line => {
    const match = /^(\d{6}) \S+ [0-9a-f]+\t(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) return [];
    return [{ mode: match[1], path: match[2] }];
  });
}

function parseDiff(text: string): { path: string; lines: string[]; binary: boolean }[] {
  const rows = text.replace(/\r\n/g, '\n').split('\n');
  const files: { path: string; lines: string[]; binary: boolean }[] = [];
  let current: { path: string; lines: string[]; binary: boolean } | null = null;
  const push = () => { if (current) files.push(current); };
  for (const line of rows) {
    if (line.startsWith('diff --git ')) {
      push();
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = { path: header?.[2] ?? 'unknown', lines: [line], binary: false };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch') || line.startsWith('Subproject commit') ||
        /\s(?:120000|160000)\b/.test(line)) current.binary = true;
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus?.[1] && plus[1] !== '/dev/null') current.path = plus[1];
  }
  push();
  return files.filter(file => file.path && file.path !== 'unknown');
}

export interface RecordedLog {
  source_id: string;
  check_id: string;
  exit_code: number | null;
  checked_sha: string | null;
  log_path: string | null;
  finished_at: string;
}

function openLog(path: string, root: string): string[] | null {
  if (isAbsolute(path) && !isPathInsideOrEqual(path, root)) return null;
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  let cursor = root;
  for (const part of rel.split(sep)) {
    if (!part || part === '.' || part === '..') return null;
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) return null; }
    catch { return null; }
  }
  let body: Buffer | 'skip';
  try { body = readRegular(cursor, TEST_LOG_BYTES * 4); }
  catch { return null; }
  if (body === 'skip' || body.includes(0)) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { return null; }
  const lines = canonicalLines(text);
  const tail = lines.slice(-TEST_LOG_LINES);
  let kept: string[] = [];
  let bytes = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i] ?? '';
    const next = utf8Bytes(line) + 1;
    if (bytes + next > TEST_LOG_BYTES) break;
    kept.unshift(line);
    bytes += next;
  }
  return kept;
}

export function buildTestEvidence(records: RecordedLog[], root: string, requested: boolean, targetSha: string): { tests: TestEvidence[]; warnings: InspectWarning[]; available: boolean; truncated: boolean } {
  const warnings: InspectWarning[] = [];
  const sorted = [...records].sort((a, b) => compareInstantDesc(a.finished_at, b.finished_at) || `${a.source_id}/${a.check_id}`.localeCompare(`${b.source_id}/${b.check_id}`));
  const truncated = sorted.length > TEST_LOGS_MAX;
  const chosen = sorted.slice(0, TEST_LOGS_MAX);
  if (truncated) warn(warnings, 'input_truncated');
  const tests: TestEvidence[] = [];
  const seen = new Map<string, number>();
  for (const record of chosen) {
    const key = `${record.source_id}/${record.check_id}`;
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    const lines = record.log_path ? openLog(record.log_path, root) : null;
    if (record.checked_sha && record.checked_sha !== targetSha) warn(warnings, 'tests_stale');
    if (!lines) warn(warnings, 'log_unavailable');
    tests.push({
      source_id: record.source_id, check_id: record.check_id, ordinal, exit_code: record.exit_code,
      checked_sha: record.checked_sha, log_available: !!lines, virtual: `test:${record.source_id}/${record.check_id}/${ordinal}`,
      lines: lines ?? [],
    });
  }
  const available = tests.some(test => test.log_available || test.exit_code !== null);
  if (requested && !available) warn(warnings, 'tests_unavailable');
  return { tests, warnings, available, truncated };
}

function collectRecords(store: JobStore, resolved: ResolvedInspectTarget): { records: RecordedLog[]; root: string } {
  const records: RecordedLog[] = [];
  const seenJobs = new Set<string>();
  const pushJob = (jobId: string, source: string) => {
    if (seenJobs.has(jobId)) return;
    seenJobs.add(jobId);
    const dir = jobPaths(store.paths, jobId).dir;
    for (const check of readJobResultChecks(store, jobId)) {
      let log: string | null = null;
      try { assertInspectPath(check.log); log = join(dir, check.log); } catch { /* Untrusted record cannot escape its job directory. */ }
      records.push({ source_id: source, check_id: check.id, exit_code: check.exit_code, checked_sha: check.sha, log_path: log, finished_at: check.at });
    }
  };
  if (resolved.target.kind === 'job' && resolved.target.job_id) pushJob(resolved.target.job_id, resolved.target.job_id);
  if (resolved.target.pipeline_id) {
    const when = resolved.target.job_id ? instantMs(store.read(resolved.target.job_id).updated_at) : Infinity;
    for (const job of allJobs(store)) {
      if (job.pipeline_id !== resolved.target.pipeline_id || !isTerminal(job.state)) continue;
      const updated = instantMs(job.updated_at);
      if (when === null || updated === null || updated > when) continue;
      pushJob(job.job_id, job.job_id);
    }
  }
  if (resolved.target.run_id) {
    const runDir = runPaths(store, resolved.target.run_id).dir;
    type GateRecord = { finished_at?: string; task_id?: string; merge_sha?: string; gate?: { log_dir?: string; checks?: { id?: string; exit_code?: number | null }[] } };
    const pushGate = (record: GateRecord, expectedDir: string, source: string, sha: string | null) => {
      const logDir = record.gate?.log_dir;
      for (const check of record.gate?.checks ?? []) {
        if (!check.id) continue;
        let log: string | null = null;
        try {
          assertInspectPath(check.id);
          if (!check.id.includes('/') && logDir === expectedDir) log = join(expectedDir, `${check.id}.log`);
        } catch { /* Keep the check summary, never open a forged path. */ }
        records.push({ source_id: source, check_id: check.id, exit_code: typeof check.exit_code === 'number' ? check.exit_code : null,
          checked_sha: sha, log_path: log, finished_at: record.finished_at || '' });
      }
    };
    try {
      const run = JSON.parse(readFileSync(runPaths(store, resolved.target.run_id).run, 'utf8')) as { base_sha?: string; created_at?: string };
      const baseline = JSON.parse(readFileSync(join(runDir, 'baseline-gate.json'), 'utf8')) as GateRecord;
      pushGate({ ...baseline, finished_at: run.created_at ?? '' }, join(runDir, 'baseline.gate'), resolved.target.run_id, run.base_sha ?? null);
    } catch { /* no baseline record */ }
    try {
      for (const name of readdirSync(join(runDir, 'merges'))) {
        if (!/^\d+\.json$/.test(name)) continue;
        try {
          const record = JSON.parse(readFileSync(join(runDir, 'merges', name), 'utf8')) as GateRecord;
          pushGate(record, join(runDir, 'merges', `${name.slice(0, -5)}.gate`), record.task_id || resolved.target.run_id, record.merge_sha ?? null);
        } catch { /* skip unreadable merge records */ }
      }
    } catch { /* no merge records */ }
    if (resolved.target.task_id) {
      try {
        const run = JSON.parse(readFileSync(runPaths(store, resolved.target.run_id).run, 'utf8')) as { tasks?: { task_id: string; attempts: { pipeline_id: string }[] }[] };
        const task = run.tasks?.find(item => item.task_id === resolved.target.task_id);
        for (const attempt of task?.attempts ?? []) {
          for (const job of allJobs(store)) if (job.pipeline_id === attempt.pipeline_id && isTerminal(job.state)) pushJob(job.job_id, job.job_id);
        }
      } catch { /* task checks are best-effort */ }
    }
  }
  return { records, root: store.paths.home };
}

export function buildDiffEvidence(repo: string, base: string, target: string, paths: readonly string[]): { diffs: EvidenceSource[]; warnings: InspectWarning[]; available: boolean; truncated: boolean } {
  const warnings: InspectWarning[] = [];
  let text = '';
  try {
    text = git(repo, ['-c', 'diff.external=', '-c', 'diff.renames=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', base, target, '--']);
  } catch {
    return { diffs: [], warnings, available: false, truncated: false };
  }
  const parsed = parseDiff(text).filter(file => pathAllowed(file.path, paths));
  const diffs: EvidenceSource[] = [];
  for (const file of parsed) {
    if (file.binary) {
      warn(warnings, 'binary_omitted');
      diffs.push({ path: `diff:${file.path}`, lines: [`binary ${file.path}`] });
      continue;
    }
    diffs.push({ path: `diff:${file.path}`, lines: file.lines.map(line => redactSecrets(sanitizeForTerminal(line))) });
  }
  return { diffs, warnings, available: diffs.length > 0, truncated: false };
}

export function buildEvidencePack(store: JobStore, worktree: string, resolved: ResolvedInspectTarget, paths: readonly string[], diff: boolean, tests: boolean): EvidencePack {
  const warnings = [...resolved.warnings];
  const listed = listedFiles(resolved.repo, resolved.target_sha);
  const files: string[] = [];
  const omitted: string[] = [];
  for (const entry of listed) {
    if (!pathAllowed(entry.path, paths)) continue;
    if (entry.mode === '120000' || entry.mode === '160000') {
      omitted.push(entry.path);
      warn(warnings, 'binary_omitted');
      continue;
    }
    const read = readSnapshotFile(worktree, entry.path);
    if ('omit' in read) {
      omitted.push(entry.path);
      if (read.omit === 'binary') warn(warnings, 'binary_omitted');
      continue;
    }
    files.push(entry.path);
  }
  for (const path of paths) if (!files.includes(path) && !omitted.includes(path)) omitted.push(path);
  const diffEvidence = diff ? buildDiffEvidence(resolved.repo, resolved.diff_base_sha, resolved.target_sha, paths) : { diffs: [], warnings: [], available: false, truncated: false };
  for (const code of diffEvidence.warnings) warn(warnings, code);
  const collected = tests ? collectRecords(store, resolved) : { records: [], root: store.paths.home };
  const testEvidence = buildTestEvidence(collected.records, collected.root, tests, resolved.target_sha);
  for (const code of testEvidence.warnings) warn(warnings, code);
  const pack: EvidencePack = {
    files, omitted, diffs: diffEvidence.diffs, tests: testEvidence.tests, warnings,
    diffRequested: diff, testsRequested: tests, diffAvailable: diffEvidence.available, testsAvailable: testEvidence.available,
    diffTruncated: diffEvidence.truncated, testsTruncated: testEvidence.truncated,
  };
  fitPrompt(pack);
  return pack;
}

function promptPayload(pack: EvidencePack): string {
  return JSON.stringify({
    files: pack.files, omitted: pack.omitted,
    diffs: pack.diffs.map(diff => ({ path: diff.path, lines: diff.lines })),
    tests: pack.tests.map(test => ({ path: test.virtual, exit_code: test.exit_code, checked_sha: test.checked_sha, log_available: test.log_available, lines: test.lines })),
    warnings: pack.warnings,
  });
}

export function fitPrompt(pack: EvidencePack): void {
  while (utf8Bytes(promptPayload(pack)) > EVIDENCE_PROMPT_MAX && (pack.diffs.length || pack.tests.length || pack.files.length)) {
    if (pack.diffs.length) {
      const last = pack.diffs.at(-1)!;
      if (last.lines.length > 20) last.lines = last.lines.slice(0, 20);
      else pack.diffs.pop();
      pack.diffTruncated = true;
    } else if (pack.tests.length) {
      const last = pack.tests.at(-1)!;
      if (last.lines.length) last.lines = [];
      else pack.tests.pop();
      pack.testsTruncated = true;
    } else {
      const dropped = pack.files.pop();
      if (dropped) pack.omitted.push(dropped);
    }
    warn(pack.warnings, 'input_truncated');
  }
  if (utf8Bytes(promptPayload(pack)) > EVIDENCE_PROMPT_MAX) {
    pack.omitted = pack.omitted.slice(0, 20).map(path => utf8Clip(path, 256).text);
    warn(pack.warnings, 'input_truncated');
    // Clip individual strings, never serialized JSON; persist the clipped values.
    while (utf8Bytes(promptPayload(pack)) > EVIDENCE_PROMPT_MAX && pack.omitted.length) pack.omitted.pop();
  }
}

export function evidencePromptText(pack: EvidencePack): string {
  return promptPayload(pack);
}

export function lookupSource(pack: EvidencePack, path: string): string[] | null {
  if (path.startsWith('diff:')) return pack.diffs.find(diff => diff.path === path)?.lines ?? null;
  if (path.startsWith('test:')) return pack.tests.find(test => test.virtual === path)?.lines ?? null;
  return null;
}
