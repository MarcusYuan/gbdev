import { RUN_ID_PATTERN } from '../core/ids.js';
import { invalid } from './validation.js';
import { validatePipelineId } from './pipelineRun.js';
import { validateJobId } from '../core/ids.js';
import { integer, object, oneOf, schema, timestamp } from './validation.js';

export const EVENT_TYPES = ['policy_self_report_downgraded', 'recovery_step', 'invariant_violation', 'state_change', 'worker_output', 'warning', 'heartbeat', 'check', 'pipeline_state_change', 'step_started', 'step_finished', 'gate', 'decision_required', 'decider_decision', 'verdict_missing_accepted', 'run_state_change', 'plan_ready', 'plan_invalid', 'task_state_change', 'lane_assigned', 'lane_released', 'lane_setup', 'merge_queued', 'merge_precheck', 'merge_committed', 'gate_started', 'gate_finished', 'merge_rolled_back', 'resolver_started', 'resolver_finished', 'verifier_started', 'verifier_finished', 'decision_resolved', 'provider_cooldown', 'budget_warning', 'landed', 'launch_retry'] as const;
export interface JobEvent {
  schema: 'gbdev.event.v1';
  job_id: string | null;
  pipeline_id?: string;
  run_id?: string; task_id?: string; lane?: string;
  seq: number;
  at: string;
  source: 'gbdev' | 'worker';
  type: typeof EVENT_TYPES[number];
  data: Record<string, unknown>;
}

export function validateEvent(value: unknown): JobEvent {
  const v = object(value, 'event');
  schema(v, 'gbdev.event.v1');
  if (v.pipeline_id !== undefined) validatePipelineId(String(v.pipeline_id));
  if (v.run_id !== undefined && (typeof v.run_id !== 'string' || !RUN_ID_PATTERN.test(v.run_id))) invalid('Invalid run_id');
  if (v.task_id !== undefined && (typeof v.task_id !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(v.task_id))) invalid('Invalid task_id');
  if (v.lane !== undefined && (typeof v.lane !== 'string' || !/^lane-[1-4]$/.test(v.lane))) invalid('Invalid lane');
  if (v.job_id !== null || v.pipeline_id === undefined && v.run_id === undefined) validateJobId(v.job_id);
  integer(v.seq, 'seq', 1);
  timestamp(v.at, 'at');
  oneOf(v.source, ['gbdev', 'worker'], 'source');
  oneOf(v.type, EVENT_TYPES, 'type');
  object(v.data, 'data');
  return value as JobEvent;
}
