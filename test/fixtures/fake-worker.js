// Invoked only by the fake adapter. No real provider, credentials, or network.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [scenario, jobDir, controlsJson] = process.argv.slice(2);
const controls = JSON.parse(controlsJson ?? '{}');
const delayMs = controls.sleepMs || Number(process.env.GBDEV_FAKE_DELAY_MS || 0);
if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const report = {
  schema: 'gbdev.worker-result.v1', status: 'succeeded', summary: `Fake scenario: ${scenario}`,
  handoff: { decided: [], rejected: [], risks: [], remaining: [] },
  files_changed: [], commits: [], tests: [], evidence: [], open_questions: [], blockers: [], policy_violations: [],
};
function change(file) {
  mkdirSync('src', { recursive: true });
  writeFileSync(file, `fake ${scenario}${scenario === 'fix_ok' ? ` ${process.env.GBDEV_STEP_INSTANCE} ${jobDir}` : ''}\n`);
  report.files_changed.push(file);
}
function commit() {
  git('add', '-A');
  git('-c', 'user.name=Fake Worker', '-c', 'user.email=fake@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', `feat(fake): ${scenario}`);
  report.commits.push(git('log', '-1', '--format=%h %s').trim());
}

if (scenario === 'launch_empty' || scenario === 'empty_exit') {
  // Fast empty exit: no stdout, no final.md — used by B7 launch_failed classification.
  process.exitCode = 0;
} else if (scenario !== 'inspect_stderr_flood') console.log(JSON.stringify({ scenario, pid: process.pid }));
if (scenario === 'launch_empty' || scenario === 'empty_exit') {
  /* done */
} else if (scenario === 'slow') {
  // A descendant in the provider's process group proves cancellation reaches the group.
  const ignoreTerm = process.env.GBDEV_FAKE_IGNORE_TERM === '1';
  if (ignoreTerm) process.on('SIGTERM', () => {});
  const descendant = spawn(process.execPath, ['-e', `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1000); process.stdout.write('ready');`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  descendant.stdout.once('data', () => {
    writeFileSync(join(jobDir, 'fake-processes.json'), JSON.stringify({ worker: process.pid, descendant: descendant.pid }));
  });
  if (process.env.GBDEV_FAKE_OUTPUT_EVENTS === '1') for (let i = 0; i < 25; i++) console.log(JSON.stringify({ event: i }));
  setInterval(() => {}, 1000);
} else if (scenario === 'rate_limit') {
  console.error('429 rate limit: quota exceeded');
  process.exitCode = 29;
} else if (scenario === 'crash') {
  console.error('Intentional fake crash');
  process.exitCode = 23;
} else if (scenario === 'inspect_no_json') {
  writeFileSync(join(jobDir, 'final.md'), 'The committed code looks fine.\n');
} else if (scenario === 'inspect_hold') {
  writeFileSync(join(jobDir, 'fake-processes.json'), JSON.stringify({ worker: process.pid }));
  setInterval(() => {}, 1000);
} else if (scenario === 'inspect_stderr_flood') {
  process.stderr.write('x'.repeat(1024 * 1024));
  setInterval(() => {}, 1000); // Must be terminated by the output cap, not normal exit.
} else if (scenario === 'inspect_flood') {
  process.stdout.write('x'.repeat(1024 * 1024 + 64));
} else if (scenario === 'no_json' || scenario === 'inspect_no_json') {
  writeFileSync(join(jobDir, 'final.md'), 'No structured report.\n');
} else {
  if (scenario === 'needs_input') {
    report.status = 'needs_input';
    report.open_questions.push({ id: 'Q1', question: 'Which behavior?', options: ['A', 'B'], default: 'A', blocking: true });
  } else if (scenario === 'blocked') {
    report.status = 'blocked';
    report.blockers.push({ kind: 'env', detail: 'Intentional fake blocker' });
  } else if (scenario === 'outside_paths') { change('outside.txt'); commit(); }
  else if (scenario === 'readonly_violation') {
    change('src/readonly.txt');
    if (process.env.GBDEV_FAKE_READONLY_MODE === 'staged') { change('staged.txt'); git('add', '-A'); }
    if (process.env.GBDEV_FAKE_READONLY_MODE === 'committed') commit();
  }
  else if (scenario === 'dirty_exit') { change('src/dirty.txt'); }
  else if (scenario.startsWith('review_')) {
    if (scenario !== 'review_no_verdict') report.review = { verdict: scenario === 'review_bad_verdict' ? 'invalid' : scenario === 'review_reject' ? 'reject' : scenario.startsWith('review_approve') ? 'approve' : 'revise', findings: scenario === 'review_approve' ? [] : [{ id: 'F1', severity: scenario === 'review_approve_with_critical' ? 'critical' : 'major', file: 'src/ok.txt', line: 1, message: scenario === 'review_revise_changing' ? `Fix issue ${process.env.GBDEV_STEP_INSTANCE}` : 'Fix the fake issue', suggestion: null }] };
  }
  else if (scenario === 'plan_ok') report.handoff.remaining = ['Implement', 'Test', 'Review'];
  else if (scenario === 'dashboard_injection') {
    process.stdout.write(readFileSync(new URL('./dashboard-injection.jsonl', import.meta.url), 'utf8'));
  }
  else if (scenario === 'fix_noop') { /* intentionally unchanged */ }
  else if (scenario === 'fix_ok') { change('src/fix.txt'); if (existsSync('src/check-fail.txt')) unlinkSync('src/check-fail.txt'); }
  else if (scenario === 'check_fail_then_fix') change('src/check-fail.txt');
  else if (['inspect_ok', 'inspect_needs_input', 'inspect_blocked'].includes(scenario)) {
    if (scenario === 'inspect_needs_input') { report.status = 'needs_input'; report.open_questions.push({ id: 'Q1', question: 'Clarify?', options: [], default: null, blocking: true }); }
    if (scenario === 'inspect_blocked') { report.status = 'blocked'; report.blockers.push({ kind: 'env', detail: 'Blocked' }); }
    report.inspection = { answer: 'Committed evidence does not show a definitive defect.', excerpts: [] };
  } else if (scenario === 'inspect_dirty') {
    change('src/inspect-dirty.txt');
    report.inspection = { answer: 'Committed evidence does not show a definitive defect.', excerpts: [] };
  } else if (scenario === 'ok') { change('src/ok.txt'); commit(); }
  else throw new Error(`Unknown scenario: ${scenario}`);
  for (const action of controls.actions ?? []) {
    if (action.type === 'snapshot_process') writeFileSync(join(jobDir, 'test-process.json'), JSON.stringify({ pid: process.pid, env: process.env, argv: process.argv }));
    else if (action.type === 'notify_exposure') { const secret = JSON.parse(readFileSync(action.file, 'utf8')); mkdirSync('src', { recursive: true }); writeFileSync('src/exposed.txt', secret.key); report.summary = secret.key; }
    else if (action.type === 'report_fields') Object.assign(report, action.fields);
    else if (action.type === 'emit_task_graph') report.task_graph = action.graph;
    else if (action.type === 'emit_task_graph_cycle') {
      const task = id => ({ id, title: id, goal: id, context: '', depends_on: [id === 'a' ? 'b' : 'a'], file_scope: ['src/**'], acceptance_criteria: [{ id: 'AC1', text: 'works', check: null }], pipeline: null, size: 'S', notes: null });
      report.task_graph = { schema: 'gbdev.task-graph.v1', summary: 'cycle', tasks: [task('a'), task('b')] };
    } else if (action.type === 'resolve_conflicts' || action.type === 'leave_markers') {
      const files = git('diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
      report.resolution = { files: files.map(path => ({ path, strategy: 'both', note: 'fake resolution' })), unresolved: [] };
      if (action.type === 'emit_task_graph') report.task_graph = action.graph;
    else if (action.type === 'emit_task_graph_cycle') {
      const task = id => ({ id, title: id, goal: id, context: '', depends_on: [id === 'a' ? 'b' : 'a'], file_scope: ['src/**'], acceptance_criteria: [{ id: 'AC1', text: 'works', check: null }], pipeline: null, size: 'S', notes: null });
      report.task_graph = { schema: 'gbdev.task-graph.v1', summary: 'cycle', tasks: [task('a'), task('b')] };
    } else if (action.type === 'resolve_conflicts') for (const file of files) writeFileSync(file, readFileSync(file, 'utf8').replace(/^<<<<<<< .*\n|^=======\n|^>>>>>>> .*\n/gm, ''));
    } else if (action.type === 'sleep_ms') await new Promise(resolve => setTimeout(resolve, action.ms));
    else if (action.type === 'emit_json') console.log(JSON.stringify(action.value));
    else if (action.type === 'write_file' || action.type === 'append_line') {
      if (action.path.startsWith('/') || action.path.split('/').includes('..')) throw new Error('Unsafe fake path');
      mkdirSync(dirname(action.path), { recursive: true });
      if (action.type === 'write_file') writeFileSync(action.path, action.content);
      else appendFileSync(action.path, action.line + '\n');
      report.files_changed.push(action.path);
    } else if (action.type === 'unlink') {
      if (action.path.startsWith('/') || action.path.split('/').includes('..')) throw new Error('Unsafe fake path');
      if (existsSync(action.path)) unlinkSync(action.path);
    } else throw new Error('Unknown fake action');
  }
  writeFileSync(join(jobDir, 'final.md'), `${scenario === 'review_no_verdict' ? 'Verdict: approve\nNo findings.' : 'Fake worker finished.'}\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`${process.env.GBDEV_FAKE_RESULT_SUFFIX ?? ''}\n`);
}
