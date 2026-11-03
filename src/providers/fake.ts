import { buildWorkerResultSchema } from '../contracts/workerResultSchema.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GbdevError } from '../contracts/error.js';
import { optionalText } from '../core/runtime.js';
import { type ProviderAdapter } from './types.js';
import { providerOutputSchema } from './outputSchema.js';

/** Resolve fixture for both dist/providers (npm build) and dist/src/providers (test build). */
function fakeWorkerScript(): string {
  const candidates = [
    new URL('../../test/fixtures/fake-worker.js', import.meta.url),
    new URL('../../../test/fixtures/fake-worker.js', import.meta.url),
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return path;
  }
  throw new GbdevError('config_invalid', 'Fake provider worker script not found');
}

export const FAKE_SCENARIOS = ['dashboard_injection', 'rate_limit', 'ok', 'needs_input', 'blocked', 'crash', 'slow', 'no_json', 'outside_paths', 'readonly_violation', 'dirty_exit', 'review_approve', 'review_approve_with_critical', 'review_revise', 'review_revise_same', 'review_revise_changing', 'review_reject', 'review_no_verdict', 'review_bad_verdict', 'fix_ok', 'fix_noop', 'check_fail_then_fix', 'plan_ok', 'inspect_ok', 'inspect_dirty', 'inspect_no_json', 'inspect_flood', 'inspect_stderr_flood', 'inspect_needs_input', 'inspect_blocked', 'inspect_hold', 'launch_empty', 'empty_exit'] as const;

export const fake: ProviderAdapter = {
  name: 'fake',
  prepareJob(jobDir, options) { writeFileSync(join(jobDir, 'worker-result.schema.json'), JSON.stringify(providerOutputSchema(buildWorkerResultSchema(options)), null, 2)); },
  buildInvocation(ctx) {
    let actions: unknown[] = [], sleepMs = 0;
    let scenario = process.env.GBDEV_FAKE_SCENARIO ?? 'ok';
    if (process.env.GBDEV_FAKE_PLAN) {
      let plan: Record<string, string | { scenario?: string; actions?: unknown[]; sleep_ms?: number; by_execution?: Record<string, string | { scenario?: string; actions?: unknown[]; sleep_ms?: number }> }>;
      try {
        plan = JSON.parse(readFileSync(process.env.GBDEV_FAKE_PLAN, 'utf8')) as typeof plan;
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error();
        const okEntry = (s: unknown): boolean => typeof s === 'string'
          ? (FAKE_SCENARIOS as readonly unknown[]).includes(s)
          : !!(s && typeof s === 'object' && !Array.isArray(s)
            && ((s as { scenario?: string }).scenario === undefined || (FAKE_SCENARIOS as readonly unknown[]).includes((s as { scenario?: string }).scenario))
            && ((s as { actions?: unknown }).actions === undefined || Array.isArray((s as { actions?: unknown }).actions))
            && ((s as { sleep_ms?: number }).sleep_ms === undefined || (Number.isSafeInteger((s as { sleep_ms?: number }).sleep_ms) && (s as { sleep_ms: number }).sleep_ms >= 0))
            && ((s as { by_execution?: unknown }).by_execution === undefined || (typeof (s as { by_execution?: unknown }).by_execution === 'object' && (s as { by_execution?: unknown }).by_execution !== null)));
        if (!Object.values(plan).every(okEntry)) throw new Error();
      } catch { throw new GbdevError('config_invalid', 'Invalid GBDEV_FAKE_PLAN'); }
      const selected = (ctx.taskId && ctx.stepInstance ? plan[`${ctx.taskId}/${ctx.stepInstance}`] : undefined) ?? (ctx.stepInstance ? plan[ctx.stepInstance] : undefined);
      if (typeof selected === 'string') scenario = selected;
      else if (selected) {
        const execKey = process.env.GBDEV_LAUNCH_EXECUTION;
        const byExec = selected.by_execution && execKey ? selected.by_execution[execKey] : undefined;
        if (typeof byExec === 'string') scenario = byExec;
        else if (byExec && typeof byExec === 'object') {
          scenario = byExec.scenario ?? selected.scenario ?? 'fix_noop';
          actions = byExec.actions ?? selected.actions ?? [];
          sleepMs = byExec.sleep_ms ?? selected.sleep_ms ?? 0;
        } else {
          scenario = selected.scenario ?? 'fix_noop';
          actions = selected.actions ?? [];
          sleepMs = selected.sleep_ms ?? 0;
        }
      }
    }
    if (!(FAKE_SCENARIOS as readonly string[]).includes(scenario)) throw new GbdevError('config_invalid', 'Unknown fake provider scenario');
    return {
      cmd: process.execPath,
      args: [fakeWorkerScript(), scenario, ctx.jobDir, JSON.stringify({ actions, sleepMs })],
      cwd: ctx.worktree, finalMessageFile: join(ctx.jobDir, 'final.md'),
    };
  },
  extractFinalMessage(jobDir) { return optionalText(join(jobDir, 'final.md')); },
};
