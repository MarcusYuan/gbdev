#!/usr/bin/env node
import { notifyActionCommand, type NotifyActionOptions } from './commands/notifyActions.js';
import { addNotify, notifyHintText } from './notify/status.js';
import { remind } from './notify/reminder.js';
import { deliver } from './notify/deliver.js';
import { notifyCommand, type NotifySetupIO } from './commands/notify.js';
import { addDashboard, dashboardHintText } from './dashboard/hints.js';
import { dashboardCommand } from './commands/dashboard.js';
import { watch, pane } from './commands/watch.js';
import { logs } from './commands/logs.js';
import { runCommand, runText } from './commands/run.js';
import { superviseRun } from './run/supervisor.js';
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type CleanupResult } from './contracts/commandResults.js';
import { GbdevError } from './contracts/error.js';
import { envelopeExitCode, failureEnvelope, serializeEnvelope, successEnvelope } from './contracts/envelope.js';
import { JobStore } from './core/jobStore.js';
import { resolvePaths } from './core/paths.js';
import { validateJobId } from './core/ids.js';
import { start } from './commands/start.js';
import { inspect } from './commands/inspect.js';
import { list, listText, statusListText } from './commands/list.js';
import { status } from './commands/status.js';
import { wait } from './commands/wait.js';
import { cancel } from './commands/cancel.js';
import { supervise } from './commands/supervise.js';
import { result as jobResult } from './commands/result.js';
import { cleanup } from './commands/cleanup.js';
import { listRoles, showRole } from './commands/roles.js';
import { pipelineCommand, pipelineText } from './commands/pipeline.js';
import { supervisePipeline } from './pipeline/supervisor.js';
import { validatePipelineId } from './contracts/pipelineRun.js';
import { doctor } from './commands/doctor.js';
import { installCommand, installText } from './commands/install.js';
import { initCommand, initText } from './commands/init.js';

function reportDashboardFailure(reason: string): void {
  if (process.connected && process.send) {
    try { process.send({ dashboard_reason: reason }, () => {}); } catch { /* Supervisor may already have exited. */ }
  }
}

const COMMANDS = ['notify', 'dashboard', 'run', 'pipeline', 'roles', 'doctor', 'install', 'init', 'start', 'inspect', 'logs', 'list', 'status', 'wait', 'result', 'cancel', 'cleanup'] as const;
const HELP = `gbdev — local single-worker jobs

Usage: gbdev <command> [options]
Commands: ${COMMANDS.join(', ')}
Options: --json  Machine-readable envelope
         --help  Show this help

start --brief <file|->
inspect <run_id|job_id> --question <text> [--task <task_id>] [--paths <relative-path>]... [--diff] [--tests] [--json]
list [--active] [--state <s>] [--limit <1..500>] [--all] [--json]
status [job_id] (reconciles; read-only inventory: list; without id, text supports --all, not with --json; JSON inventory: gbdev list --all --json)
wait <job_id> --timeout-ms <n>
cancel <job_id>
result <job_id>
logs <job_id> [--follow] [--tail <0..5000>] [--from-start] [--verbose] [--no-color] [--json]
cleanup <job_id> [--force-branch] [--dry-run]
doctor
install [--dry-run] [--json]
init --bot <label> [--home <path>] [--no-install] [--dry-run] [--json]
notify status [--pending] [--json]
notify test [--json]
notify flush [--wait-ms <0..60000>] [--retry-auth] [--json]
notify ack <notice_id> --bot <bot_label> [--json]
notify setup [--keychain] [--json]
notify enable [--key-placement header|body_field] [--key-name <n>] [--key-prefix <p>] [--json]
notify disable [--json]
dashboard status [--json]
dashboard ensure [--target <unit_id>] [--json]
dashboard capture <unit_id>[:<pane>] [--lines <1..2000>] [--json]
dashboard close <unit_id>|--all [--json]
roles list
roles show <name>
run start --request <file|->
run list [--active] [--state <s>] [--limit <1..500>] [--json]
run status [run_id] (reconciles; read-only inventory: run list)
run watch <run_id> [--pane status|lane-<n>|integration|all] [--once] [--verbose] [--no-color] [--json]
run wait <run_id> --timeout-ms <0..540000> [--until attention|settled] [--with-result]
run result <run_id>
run cancel <run_id>
run resume <run_id> --input <file|-> | --answers-file <array-file>
run cleanup <run_id> [--force-branch] [--dry-run]
run land <run_id> --target <branch> --confirm-user-approved [--dry-run] [--approval-note <text>]
pipeline templates
pipeline start --request <file|-> [--dry-run]
pipeline list [--active] [--state <s>] [--limit <1..500>] [--standalone] [--json]
pipeline status [pipeline_id] (reconciles; read-only inventory: pipeline list)
pipeline watch <pipeline_id> [--once] [--verbose] [--no-color] [--json]
pipeline wait <pipeline_id> --timeout-ms <1000..3600000> [--with-result]
pipeline result <pipeline_id>
pipeline resume <pipeline_id> --input <file|->
pipeline cancel <pipeline_id>
pipeline cleanup <pipeline_id> [--force-branch] [--dry-run]`;

function branchKept(reason: CleanupResult['branch_retained_reason']): string {
  return reason ? `branch kept: ${reason}${reason === 'unmerged_job_commits' ? ' (use --force-branch only with user approval)' : ''}\n` : '';
}

export interface CliIO { notifyActions?: NotifyActionOptions; notifySetup?: NotifySetupIO; stdout(text: string): void; stderr(text: string): void }

const DEFAULT_IO: CliIO = { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } };

export async function runCli(argv: string[], io: CliIO = DEFAULT_IO): Promise<0 | 1 | 2> {
  let command = argv.find(arg => !arg.startsWith('-')) ?? 'help';
  const json = argv.includes('--json');
  try {
    for (const flag of ['--question', '--task']) {
      if (argv.filter(arg => arg === flag || arg.startsWith(`${flag}=`)).length > 1) {
        throw new GbdevError('usage_error', `Option ${flag} accepts a single value`);
      }
    }
    const { values, positionals } = parseArgs({ args: argv, options: {
      active: { type: 'boolean' }, state: { type: 'string', multiple: true }, limit: { type: 'string' }, standalone: { type: 'boolean' },
      pending: { type: 'boolean' }, 'wait-ms': { type: 'string' }, 'retry-auth': { type: 'boolean' }, bot: { type: 'string' },
      keychain: { type: 'boolean' }, 'key-placement': { type: 'string' }, 'key-name': { type: 'string' }, 'key-prefix': { type: 'string' },
      lines: { type: 'string' }, all: { type: 'boolean' },
      once: { type: 'boolean' }, pane: { type: 'string' },
      follow: { type: 'boolean' }, tail: { type: 'string' }, 'from-start': { type: 'boolean' }, verbose: { type: 'boolean' }, 'no-color': { type: 'boolean' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      'answers-file': { type: 'string' }, events: { type: 'boolean' }, since: { type: 'string' }, until: { type: 'string' }, request: { type: 'string' }, input: { type: 'string' }, 'with-result': { type: 'boolean' },
      brief: { type: 'string' }, question: { type: 'string' }, task: { type: 'string' }, paths: { type: 'string', multiple: true },
      diff: { type: 'boolean' }, tests: { type: 'boolean' }, 'timeout-ms': { type: 'string' },
      target: { type: 'string' }, 'confirm-user-approved': { type: 'boolean' }, 'approval-note': { type: 'string' },
      'force-branch': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
      home: { type: 'string' }, 'no-install': { type: 'boolean' },
    }, allowPositionals: true, strict: true });
    command = positionals[0] ?? 'help';
    if (command !== 'help' && command !== '__notify-deliver' && command !== '__notify-remind' && command !== '__dashboard-ensure' && command !== '__pane' && command !== '__supervise' && command !== '__run-supervise' && command !== '__pipeline-supervise' && !(COMMANDS as readonly string[]).includes(command)) throw new GbdevError('usage_error', `Unknown command: ${command}`);
    if (values.help || (positionals.length === 0 && argv.length === 0) || command === 'help') {
      if (json) io.stdout(serializeEnvelope(successEnvelope('help', 'gbdev.cli-help.v1', { text: HELP })));
      else io.stdout(`${HELP}\n`);
      return 0;
    }
    const listKind = command === 'list' ? 'job' : (command === 'run' || command === 'pipeline') && positionals[1] === 'list' ? command : null;
    if (listKind) {
      if (positionals.length !== (listKind === 'job' ? 1 : 2)) throw new GbdevError('usage_error', 'List takes no id');
      command = listKind === 'job' ? 'list' : `${listKind} list`;
      const { json: _json, help: _help, ...options } = values;
      const output = list(new JobStore(resolvePaths()), listKind, options);
      io.stdout(json ? serializeEnvelope(successEnvelope(command, output.schema, output.result)) : listText(output.result, listKind));
      return 0;
    }
    if (['active', 'state', 'limit', 'standalone'].some(k => Object.hasOwn(values, k))) throw new GbdevError('usage_error', 'List options require list');
    if (command === 'notify') {
      const { json: _json, help: _help, paths: _paths, state: _state, ...options } = values;
      command = `notify ${['setup', 'enable', 'disable', 'status', 'test', 'flush', 'ack'].includes(positionals[1] ?? '') ? positionals[1] : ''}`.trim();
      if (['status', 'test', 'flush', 'ack'].includes(positionals[1] ?? '')) {
        const output = await notifyActionCommand(new JobStore(resolvePaths()), positionals.slice(1), options, io.notifyActions);
        io.stdout(json ? serializeEnvelope(successEnvelope(command, output.schema, output.result)) : output.text); return 0;
      }
      const output = await notifyCommand(resolvePaths(), positionals.slice(1), options, io.notifySetup);
      io.stdout(json ? serializeEnvelope(successEnvelope(command, 'gbdev.cli-help.v1', output)) : output.text);
      return 0;
    }
    if (command !== 'init' && ['pending', 'wait-ms', 'retry-auth', 'bot', 'keychain', 'key-placement', 'key-name', 'key-prefix'].some(k => Object.hasOwn(values, k))) {
      throw new GbdevError('usage_error', 'Notify options require notify');
    }
    if (command !== 'init' && (values.home !== undefined || values['no-install'] !== undefined)) {
      throw new GbdevError('usage_error', '--home/--no-install are only supported by init');
    }
    const writer = io === DEFAULT_IO
      ? (text: string) => new Promise<void>((resolve, reject) => { process.stdout.write(text, error => error ? reject(error) : resolve()); })
      : (text: string) => io.stdout(text);
    if (command === '__notify-deliver' || command === '__notify-remind') {
      if (positionals.length !== 1 || Object.keys(values).length) throw new GbdevError('usage_error', 'Invalid delivery arguments');
      await (command === '__notify-remind' ? remind : deliver)(new JobStore(resolvePaths())); return 0;
    }
    if (command === 'dashboard' || command === '__dashboard-ensure') {
      const hidden = command === '__dashboard-ensure';
      const { json: _json, help: _help, paths: _paths, state: _state, ...options } = values;
      const args = hidden ? ['ensure', ...positionals.slice(1)] : positionals.slice(1);
      command = hidden ? command : `dashboard ${args[0] ?? ''}`.trim();
      const output = await dashboardCommand(resolvePaths(), args, options, hidden);
      if (hidden && output.result.reason) reportDashboardFailure(output.result.reason);
      if (!hidden) io.stdout(json ? serializeEnvelope(successEnvelope(command, 'gbdev.dashboard-status.v1', output.result)) : output.text);
      return 0;
    }
    if (values.lines !== undefined || (values.all !== undefined && !(command === 'status' && positionals.length === 1 && !json))) throw new GbdevError('usage_error', '--lines requires dashboard; --all requires dashboard, list or status text list (without id or --json); JSON inventory: gbdev list --all --json');
    if (command === '__pane') {
      if (Object.keys(values).length) throw new GbdevError('usage_error', 'Pane accepts only positional arguments');
      return await pane(resolvePaths().home, positionals.slice(1), writer);
    }
    if ((command === 'run' || command === 'pipeline') && positionals[1] === 'watch') {
      const type = command; command = `${type} watch`;
      if (positionals.length !== 3 || Object.keys(values).some(key => !['json', 'help', 'once', 'pane', 'verbose', 'no-color'].includes(key))) throw new GbdevError('usage_error', 'Invalid watch arguments');
      return await watch(resolvePaths().home, type, positionals[2], values, writer);
    }
    if (values.once !== undefined || values.pane !== undefined) throw new GbdevError('usage_error', '--once/--pane are only supported by watch');
    const logKeys = ['follow', 'tail', 'from-start', 'verbose', 'no-color'] as const;
    if (command !== 'logs' && logKeys.some(key => values[key] !== undefined)) throw new GbdevError('usage_error', 'Log options are only supported by logs');
    if (command === 'logs') {
      if (positionals.length !== 2 || Object.keys(values).some(key => !['json', 'help', ...logKeys].includes(key))) throw new GbdevError('usage_error', 'Use logs <job_id> [--follow] [--tail <n>] [--from-start] [--verbose] [--no-color] [--json]');
      await logs(resolvePaths().home, positionals[1], values, io === DEFAULT_IO
        ? text => new Promise<void>((resolve, reject) => { process.stdout.write(text, error => error ? reject(error) : resolve()); })
        : text => io.stdout(text)); return 0;
    }
    if (command === '__run-supervise') {
      if (positionals.length !== 2) throw new GbdevError('usage_error', 'Missing run_id');
      await superviseRun(new JobStore(resolvePaths()), positionals[1]!); return 0;
    }
    if (command === 'run') {
      command = `run ${positionals[1] ?? ''}`.trim();
      const { json: _json, help: _help, paths: _paths, state: _state, ...options } = values;
      const output = await runCommand(new JobStore(resolvePaths()), positionals.slice(1), options);
      io.stdout(json ? serializeEnvelope(successEnvelope(command, output.schema, output.result)) : runText(output.result) + dashboardHintText(output.result) + notifyHintText(output.result)); return 0;
    }
    if (values.target !== undefined || values['confirm-user-approved'] !== undefined || values['approval-note'] !== undefined) throw new GbdevError('usage_error', 'Land options are only supported by run land');
    if (values['answers-file'] !== undefined) throw new GbdevError('usage_error', '--answers-file is only supported by run resume');
    if (values.until !== undefined || values.events !== undefined || values.since !== undefined) throw new GbdevError('usage_error', '--until is only supported by run wait; --events/--since are only supported by run status');
    if (command === '__pipeline-supervise') {
      if (positionals.length !== 2) throw new GbdevError('usage_error', 'Missing pipeline_id');
      validatePipelineId(positionals[1]!); await supervisePipeline(new JobStore(resolvePaths()), positionals[1]!); return 0;
    }
    if (command === 'pipeline') {
      command = `pipeline ${positionals[1] ?? ''}`.trim();
      if (values.brief !== undefined) throw new GbdevError('usage_error', 'pipeline does not support --brief');
      const output = await pipelineCommand(new JobStore(resolvePaths()), positionals.slice(1), { input: values.input, request: values.request, 'dry-run': values['dry-run'], 'force-branch': values['force-branch'], 'timeout-ms': values['timeout-ms'], 'with-result': values['with-result'] });
      io.stdout(json ? serializeEnvelope(successEnvelope(command, output.schema, output.result)) : pipelineText(output.result) + dashboardHintText(output.result) + notifyHintText(output.result)); return 0;
    }
    if (values.input !== undefined || values.request !== undefined || values['with-result'] !== undefined) throw new GbdevError('usage_error', 'Option is only supported by pipeline');
    const jobId = positionals[1];
    const takesJob = ['status', 'wait', 'cancel', 'result', 'cleanup', '__supervise'].includes(command);
    const takesTarget = takesJob || command === 'inspect';
    if (positionals.length > (command === 'roles' ? 3 : takesTarget ? 2 : 1)) throw new GbdevError('usage_error', 'Unexpected positional arguments');
    if (jobId && takesJob) {
      try { validateJobId(jobId); } catch { throw new GbdevError('usage_error', 'Invalid job_id'); }
    }
    if (['wait', 'cancel', 'result', 'cleanup', '__supervise'].includes(command) && !jobId) throw new GbdevError('usage_error', 'Missing job_id');
    if ((values.brief !== undefined && command !== 'start') || (values['timeout-ms'] !== undefined && command !== 'wait') ||
        (values['force-branch'] !== undefined && command !== 'cleanup') ||
        (values['dry-run'] !== undefined && command !== 'cleanup' && command !== 'install' && command !== 'init')) {
      throw new GbdevError('usage_error', 'Option is not supported by this command');
    }
    if (command === 'install') {
      if (positionals.length !== 1) throw new GbdevError('usage_error', 'install takes no positional arguments');
      // install whitelist: only --json / --help / --dry-run (help handled earlier).
      if (Object.keys(values).some(key => !['json', 'help', 'dry-run'].includes(key))) {
        throw new GbdevError('usage_error', 'install only supports --dry-run and --json');
      }
      const result = installCommand({ dryRun: values['dry-run'] ?? false });
      if (json) io.stdout(serializeEnvelope(successEnvelope(command, 'gbdev.install.v1', result)));
      else io.stdout(installText(result));
      return 0;
    }
    if (command === 'init') {
      if (positionals.length !== 1) throw new GbdevError('usage_error', 'init takes no positional arguments');
      if (Object.keys(values).some(key => !['json', 'help', 'dry-run', 'bot', 'home', 'no-install'].includes(key))) {
        throw new GbdevError('usage_error', 'init only supports --bot, --home, --no-install, --dry-run, and --json');
      }
      if (values.bot === undefined) throw new GbdevError('usage_error', 'init requires --bot <label>');
      const result = await initCommand({
        bot: values.bot,
        ...(values.home !== undefined ? { home: values.home } : {}),
        noInstall: values['no-install'] ?? false,
        dryRun: values['dry-run'] ?? false,
      });
      if (json) io.stdout(serializeEnvelope(successEnvelope(command, 'gbdev.init.v1', result)));
      else io.stdout(initText(result));
      return 0;
    }
    if (command !== 'inspect' && ['question', 'task', 'paths', 'diff', 'tests'].some(key => values[key as 'question'] !== undefined)) {
      throw new GbdevError('usage_error', 'Inspect options are only supported by inspect');
    }
    if (command === 'start' && !values.brief) throw new GbdevError('usage_error', 'start requires --brief <file|->');
    if (command === 'inspect') {
      if (positionals.length !== 2) throw new GbdevError('usage_error', 'inspect requires <run_id|job_id>');
      if (!values.question) throw new GbdevError('usage_error', 'inspect requires --question <text>');
    }
    const timeout = values['timeout-ms'];
    if (command === 'wait' && (timeout === undefined || !/^\d+$/.test(timeout) || !Number.isSafeInteger(Number(timeout)))) {
      throw new GbdevError('usage_error', 'wait requires a nonnegative safe integer --timeout-ms');
    }
    if (command === 'roles' && !((positionals[1] === 'list' && positionals.length === 2) ||
      (positionals[1] === 'show' && positionals.length === 3))) throw new GbdevError('usage_error', 'Use roles list or roles show <name>');
    const store = new JobStore(resolvePaths());
    if (command === '__supervise') { await supervise(store, jobId!); return 0; }
    let result;
    let schema = 'gbdev.job-status.v1';
    switch (command) {
      case 'roles': result = positionals[1] === 'list' ? listRoles(store.paths) : showRole(store.paths, positionals[2]!); schema = positionals[1] === 'list' ? 'gbdev.role-list.v1' : 'gbdev.role.v1'; break;
      case 'start': { const started = await start(store, values.brief!); result = await addNotify(store.paths, await addDashboard(store.paths, started, started.job_id, 'job')); break; }
      case 'inspect': {
        const question = typeof values.question === 'string' ? values.question : '';
        const task = typeof values.task === 'string' ? values.task : undefined;
        const paths = Array.isArray(values.paths) ? values.paths : [];
        const started = await inspect(store, { id: positionals[1]!, question, ...(task !== undefined ? { task } : {}), paths, diff: values.diff === true, tests: values.tests === true });
        result = await addNotify(store.paths, await addDashboard(store.paths, started, started.job_id, 'job'));
        schema = 'gbdev.inspect-start.v1';
        break;
      }
      case 'status': result = await status(store, jobId); break;
      case 'wait': result = await wait(store, jobId!, Number(timeout)); break;
      case 'cancel': result = await cancel(store, jobId!); break;
      case 'result': result = await jobResult(store, jobId!); schema = 'gbdev.job-result.v1'; break;
      case 'cleanup': result = await cleanup(store, jobId!, values['force-branch'] ?? false, values['dry-run'] ?? false); schema = 'gbdev.cleanup.v1'; break;
      case 'doctor': result = await doctor(store.paths); schema = 'gbdev.doctor.v1'; break;
      default: throw new GbdevError('usage_error', 'Unsupported command');
    }
    if (json) io.stdout(serializeEnvelope(successEnvelope(command, schema, result)));
    else if ('roles' in result) io.stdout(`${result.roles.map(role => `${role.name} ${role.output} ${role.sandbox} ${role.provider} (${role.source}): ${role.description}`).join('\n')}\n${result.invalid.map(e => `invalid ${e.file}: ${e.code}: ${e.message}\n`).join('')}alias code-reviewer -> reviewer\n`);
    else if ('instructions_text' in result) io.stdout(`${result.name} ${result.output} ${result.sandbox} ${result.provider} (${result.source})\n${result.description}\n${result.instructions_text}\n`);
    else if ('checks' in result) io.stdout(`${result.checks.map(check => `${check.ok ? 'ok' : '!!'} ${check.name}: ${typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail)}`).join('\n')}\n`);
    else if (Array.isArray(result)) io.stdout(statusListText(store, result, values.all));
    else if ('branch_retained' in result && result.dry_run) io.stdout(`${result.job_id}: dry-run, would remove worktree=${result.would_remove_worktree}, would delete branch=${result.would_delete_branch}\n${branchKept(result.branch_retained_reason)}`);
    else if ('branch_retained' in result) io.stdout(`${result.job_id}: worktree ${result.worktree_removed ? 'removed' : 'absent'}, branch ${result.branch_deleted ? 'deleted' : result.branch_retained ? 'retained' : 'absent'}\n${branchKept(result.branch_retained_reason)}`);
    else if ('worker_reported' in result) io.stdout(`${result.job_id} ${result.state}: ${result.failure_reason ?? result.worker_reported?.summary ?? 'no valid worker report'}\n`);
    else io.stdout(`${result.job_id} ${result.state}${'failure_reason' in result && result.failure_reason ? `: ${result.failure_reason}` : ''}\n`);
    if (!json && (command === 'start' || command === 'inspect')) io.stdout(dashboardHintText(result) + notifyHintText(result));
    return 0;
  } catch (error) {
    const normalized = (command === 'notify' || command.startsWith('notify ')) && !(error instanceof GbdevError) ? new GbdevError(error instanceof TypeError ? 'usage_error' : 'notify_unavailable', 'Invalid notify operation') : error instanceof GbdevError ? error :
      error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_') ?
        new GbdevError('usage_error', error.message) : error;
    const envelope = failureEnvelope(command, normalized);
    if (json) io.stdout(serializeEnvelope(envelope));
    else io.stderr(`${envelope.ok ? '' : envelope.error.message}\n${!envelope.ok && envelope.error.details.branch_retained_reason === 'delete_failed_retry_safe'
      ? branchKept('delete_failed_retry_safe') : ''}`);
    return envelopeExitCode(envelope);
  }
}

// Compare realpaths so symlink argv (e.g. /var → /private/var, or ln -s dist) still enters main.
if (process.argv[1]) {
  let entry = process.argv[1];
  let self = fileURLToPath(import.meta.url);
  try { entry = realpathSync(entry); } catch { /* keep lexical argv */ }
  try { self = realpathSync(self); } catch { /* keep lexical module path */ }
  if (entry === self) {
    const guard = process.argv[2] === '__dashboard-ensure' ? setTimeout(() => { reportDashboardFailure('tmux_timeout'); process.exit(0); }, 15000) : undefined;
    guard?.unref();
    try { process.exitCode = await runCli(process.argv.slice(2)); } finally { if (guard) clearTimeout(guard); if (process.argv[2] === '__dashboard-ensure' && process.connected) process.disconnect?.(); }
  }
}
