import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type TestContext } from 'node:test';
import { type TaskBrief } from '../../src/contracts/brief.js';
import { validateEnvelope, type Envelope } from '../../src/contracts/envelope.js';
import { validateJobStatus, isTerminal, type JobStatus } from '../../src/contracts/jobStatus.js';
import { validateJobResult } from '../../src/contracts/jobResult.js';
import { brief } from '../helpers.js';
import { waitForCliChildren } from './children.js';

export async function eventually<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() >= until) throw new Error('Condition did not become true');
    await delay(25);
  }
}

export function tmpRepo(t: TestContext, scenario = 'ok', overrides: Partial<TaskBrief> = {}, extraEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gbdev-execution-'));
  const repo = join(root, 'repo');
  const home = join(root, 'gbdev');
  const config = join(root, 'config.json');
  const briefFile = join(root, 'brief.json');
  const gitConfig = join(root, 'empty-gitconfig');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(gitConfig, '');
  // Explicit environment isolates all subprocesses from personal config and credentials.
  const env: NodeJS.ProcessEnv = {
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TERMINAL_PROMPT: '0', GBDEV_HOME: home, GBDEV_CONFIG: config, GBDEV_FAKE_SCENARIO: scenario, ...extraEnv,
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main');
  writeFileSync(join(repo, 'src', 'initial.txt'), 'initial\n');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'chore: initial');
  writeFileSync(config, JSON.stringify({ version: 1, allowed_repos: [repo] }));
  const task = { ...brief(repo), ...(overrides.sandbox === 'read-only' ? { role: 'reviewer' } : {}), acceptance_criteria: [{ id: 'AC1', text: 'Check output', check_cmd: 'test -f src/ok.txt && echo checked' }], ...overrides };
  writeFileSync(briefFile, JSON.stringify(task));
  const cli = resolve('dist/cli.js');
  const command = async (args: string[], stdin?: string) => {
    const child = spawn(process.execPath, [cli, ...args, '--json'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.end(stdin);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (stderr !== '') throw new Error(`CLI stderr must be empty: ${stderr}`);
    const envelope = validateEnvelope(JSON.parse(stdout));
    if (args[0] === 'pipeline' && args[1] === 'start' && envelope.ok && !args.includes('--dry-run')) pipelines.add((envelope.result as { pipeline_id: string }).pipeline_id);
    if (args[0] === 'start' && envelope.ok) started.add(validateJobStatus(envelope.result).job_id);
    return { exit, envelope, stdout, stderr };
  };
  const getJob = (jobId: string) => validateJobStatus(JSON.parse(readFileSync(join(home, 'jobs', jobId, 'job.json'), 'utf8')));
  const started = new Set<string>();
  const pipelines = new Set<string>();
  t.after(async () => {
    for (const id of pipelines) { try { await command(['pipeline', 'cancel', id]); } catch { /* best effort */ } }
    for (const jobId of started) {
      try {
        const status = getJob(jobId);
        if (!isTerminal(status.state)) await command(['cancel', jobId]);
      } catch { /* Best effort on a setup/child-process failure. */ }
    }
    await waitForCliChildren([...pipelines, ...started]);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const launch = async (fromStdin = false): Promise<JobStatus> => {
    const output = await command(['start', '--brief', fromStdin ? '-' : briefFile], fromStdin ? JSON.stringify(task) : undefined);
    if (!output.envelope.ok) throw new Error(JSON.stringify(output.envelope));
    const status = validateJobStatus(output.envelope.result);
    return status;
  };
  return {
    root, repo, home, env, config, briefFile, task, git, command, launch, getJob,
    jobDir: (id: string) => join(home, 'jobs', id),
    result: (id: string) => validateJobResult(JSON.parse(readFileSync(join(home, 'jobs', id, 'result.json'), 'utf8'))),
    wait: async (id: string) => {
      const output = await command(['wait', id, '--timeout-ms', '60000']);
      if (!output.envelope.ok) throw new Error(JSON.stringify(output.envelope));
      return validateJobStatus(output.envelope.result);
    },
  };
}

export function unwrap(envelope: Envelope): unknown {
  if (!envelope.ok) throw new Error(JSON.stringify(envelope));
  return envelope.result;
}
