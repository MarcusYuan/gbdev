import { registerRunProcess } from '../core/processRegistry.js';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import type { RunRequest } from '../contracts/runRequest.js';
import type { MergeRecord } from '../contracts/mergeRecord.js';
import { gitGuardedAsync, git, type GitGuardContext } from '../core/git.js';
import { groupAlive, terminateGroup } from '../core/proc.js';
export async function runGate(context: GitGuardContext, request: RunRequest, ids: string[], logDir: string, signal: AbortSignal, timeoutMs: number): Promise<{ gate: NonNullable<MergeRecord['gate']>; warnings: string[] }> {
  mkdirSync(logDir, { recursive: true });
  const checks: NonNullable<MergeRecord['gate']>['checks'] = [], warnings: string[] = [];
  const deadline = performance.now() + timeoutMs;
  let passed = true;
  for (const id of [...new Set(ids)]) {
    const check = request.checks.find(c => c.id === id)!;
    if (!check) throw new Error(`Unknown trusted check ${id}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = performance.now(), fd = openSync(join(logDir, `${id}.log`), 'a', 0o600);
      let timedOut = false, timer: NodeJS.Timeout | undefined, stopping: Promise<void> | undefined;
      let code: number | null = null;
      try {
        if (signal.aborted || started >= deadline) { passed = false; break; }
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GBDEV_')));
        const child = spawn('/bin/sh', ['-c', check.cmd], { cwd: context.worktree, detached: true, stdio: ['ignore', fd, fd], env });
        const unregister = registerRunProcess(child.pid, 'gate', context.worktree);
        const stop = () => { if (child.pid) { stopping ??= terminateGroup(child.pid); void stopping.catch(() => {}); } };
        signal.addEventListener('abort', stop, { once: true });
        timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(check.timeout_min * 60_000, deadline - started)));
        try {
          code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        } finally {
          clearTimeout(timer); signal.removeEventListener('abort', stop); await stopping;
          if (child.pid && groupAlive(child.pid)) await terminateGroup(child.pid);
          unregister();
        }
      } finally { if (timer) clearTimeout(timer); closeSync(fd); }
      checks.push({ id, exit_code: code, duration_s: (performance.now() - started) / 1000 });
      if (signal.aborted || timedOut) { passed = false; break; }
      if (code === 0) { if (attempt) warnings.push('flaky_suspected'); break; }
      if (attempt === 1) passed = false;
    }
    if (signal.aborted || performance.now() >= deadline) { passed = false; break; }
  }
  const cleanupSignal = signal.aborted ? new AbortController().signal : signal;
  if ((await git(context.worktree, ['diff', 'HEAD', '--'], 120_000, cleanupSignal)).length) { warnings.push('gate_modified_worktree'); passed = false; }
  if ((await git(context.worktree, ['ls-files', '--others', '--exclude-standard', '-z'], 120_000, cleanupSignal)).length) { await gitGuardedAsync(context, { operation: 'clean' }, 120_000, cleanupSignal); warnings.push('gate_left_untracked'); }
  return { gate: { checks, passed, log_dir: logDir }, warnings };
}
