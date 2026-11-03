import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Terminal JSON can precede a detached CLI's final writes and ensure exit. */
export async function waitForCliChildren(ids: Iterable<string>): Promise<void> {
  const targets = new Set(ids);
  if (!targets.size) return;
  const pids = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+.*\bcli\.js\s+__(?:supervise|pipeline-supervise|run-supervise|dashboard-ensure --target)\s+(\S+)(?:\s|$)/.exec(line);
    return match && targets.has(match[2]!) ? [Number(match[1])] : [];
  });
  const wait = async (timeout: number) => {
    const end = Date.now() + timeout;
    while (pids().length) {
      if (Date.now() >= end) throw new Error(`CLI children did not exit for ${[...targets].join(', ')}`);
      await delay(50);
    }
  };
  try { await wait(18000); }
  catch (error) {
    // Re-scan only this test's exact unit IDs before killing detached groups.
    for (const pid of pids()) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    await wait(5000);
    throw error;
  }
}
