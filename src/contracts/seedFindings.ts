import { GbdevError } from './error.js';
import { assertSchema, closed, enumeration, laneSchema, list, nonempty, runIdSchema, taskIdSchema, textSchema } from './runValidation.js';
import { runFindingSchema, type RunFinding } from './runResult.js';
export interface SeedFindings { source: 'integration_gate' | 'final_review' | 'conflict'; findings: RunFinding[]; logs: { check_id: string; tail: string }[] }
export interface RunBinding { run_id: string; task_id: string; lane: string; worktree: string; branch: string }
export function validateSeedFindings(value: unknown): SeedFindings {
  try {
    assertSchema(value, closed({ source: enumeration('integration_gate', 'final_review', 'conflict'), findings: list(runFindingSchema), logs: list(closed({ check_id: nonempty, tail: textSchema })) }));
    const seed = value as SeedFindings;
    if (seed.logs.some(l => l.tail.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length > 80)) throw new Error('seed_findings log tail exceeds 80 lines');
    return structuredClone(seed);
  } catch (e) { throw new GbdevError('pipeline_invalid', String(e)); }
}
export function validateRunBinding(value: unknown): RunBinding {
  try { assertSchema(value, closed({ run_id: runIdSchema, task_id: taskIdSchema, lane: laneSchema, worktree: nonempty, branch: nonempty })); return structuredClone(value) as RunBinding; }
  catch (e) { throw new GbdevError('pipeline_invalid', String(e)); }
}
