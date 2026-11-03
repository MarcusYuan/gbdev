#!/usr/bin/env node
// Read-only: explicit paths only; never walks worktrees or follows directory symlinks.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const jobs = new Map(), errors = [];
function collectJobs(dir, run) {
  const pipelines = new Set(run?.tasks?.flatMap(t => t.attempts.map(a => a.pipeline_id)) ?? []);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name), file = join(path, 'job.json');
    if (!existsSync(file)) continue;
    try {
      const job = read(file);
      if (!run || job.run_id === run.run_id || pipelines.has(job.pipeline_id) || job.branch === run.integration?.branch) jobs.set(path, job);
    } catch (e) { errors.push(`${file}: ${e.message}`); }
  }
}
const args = process.argv.slice(2), allowHome = args.includes('--allow-home'), ac30 = args.includes('--ac30');
for (const arg of args.filter(arg => !['--allow-home', '--ac30'].includes(arg))) {
  const path = resolve(arg);
  try {
    if (existsSync(join(path, 'job.json'))) jobs.set(path, read(join(path, 'job.json')));
    else if (existsSync(join(path, 'run.json'))) collectJobs(join(dirname(dirname(path)), 'jobs'), read(join(path, 'run.json')));
    else if (existsSync(join(path, 'jobs'))) {
      if (!allowHome) throw new Error('gbdev home root is not allowed by default; supply runs/<id> or jobs/<id> directories (use --allow-home only for an explicit historical audit)');
      collectJobs(join(path, 'jobs'));
    } else collectJobs(path);
  } catch (e) { errors.push(`${path}: ${e.message}`); }
}
let checked = 0, failed = 0, skipped = 0, cursor = 0, codex = 0;
const bypass = '--dangerously-' + 'bypass-approvals-and-sandbox';
for (const [path, job] of jobs) {
  if (job.provider !== 'cursor' && !(ac30 && job.provider === 'codex')) { skipped++; console.log(`SKIP ${job.job_id ?? path}: provider=${job.provider}`); continue; }
  checked++; if (job.provider === 'cursor') cursor++; else codex++;
  const problems = [];
  try {
    const record = read(join(path, 'provider.json')), argv = record.argv;
    if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) problems.push('missing/invalid recorded argv (unverified)');
    else {
      if (job.provider === 'cursor') {
        if (!argv.some((a, i) => a === '--model' && argv[i + 1] === 'auto')) problems.push('missing --model auto');
        if (argv.some((a, i) => (a === '--model' || a === '-m') && argv[i + 1] !== 'auto' || a.startsWith('--model='))) problems.push('conflicting/noncanonical model option');
      } else {
        if (!argv.some((a, i) => a === '-m' && argv[i + 1] === 'gpt-6-astra')) problems.push('missing -m gpt-6-astra');
        if (argv.some((a, i) => (a === '-m' || a === '--model') && argv[i + 1] !== 'gpt-6-astra' || a.startsWith('--model='))) problems.push('conflicting/noncanonical model option');
        if (!argv.some((a, i) => a === '-c' && argv[i + 1] === 'model_reasoning_effort=high')) problems.push('missing model_reasoning_effort=high');
        if (argv.some((a, i) => (a === '-c' || a === '--config') && /^model_reasoning_effort\s*=/.test(argv[i + 1] ?? '') && argv[i + 1] !== 'model_reasoning_effort=high' || a.startsWith('--config=model_reasoning_effort='))) problems.push('conflicting reasoning effort');
      }
      if (argv.some(a => a === bypass || a.startsWith(bypass + '='))) problems.push('approval bypass option');
      if (argv.some((a, i) => a === '--sandbox' && argv[i + 1] === 'disabled' || a === '--sandbox=disabled')) problems.push('disabled sandbox');
    }
  } catch (e) { problems.push(`missing/unreadable invocation: ${e.message}`); }
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${job.job_id ?? path}: ${problems.join('; ') || (job.provider === 'cursor' ? '--model auto; no forbidden options' : '-m gpt-6-astra; model_reasoning_effort=high; no forbidden options')} (${path})`);
}
for (const error of errors) console.error(`ERROR ${error}`);
console.log(`SUMMARY cursor=${cursor}${ac30 ? ` codex=${codex}` : ''} passed=${checked - failed} failed=${failed} skipped=${skipped} errors=${errors.length}`);
if (!checked) console.error(`UNVERIFIED: no ${ac30 ? 'Cursor/Codex' : 'Cursor'} jobs found. Supply job directories, runs/<id>, or jobs/; gbdev home requires --allow-home.`);
process.exitCode = failed || errors.length || !checked ? 1 : 0;
