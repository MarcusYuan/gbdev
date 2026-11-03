import type { RunRequest } from '../contracts/runRequest.js';
import type { GraphTask } from '../contracts/taskGraph.js';
import type { PipelineDefinition } from '../contracts/pipeline.js';
import type { StepOverride } from '../contracts/pipelineRequest.js';
import { PipelineRegistry } from '../pipeline/definitions.js';
export function pipelineValue(request: RunRequest, task: GraphTask | null, registry: PipelineRegistry, fix = false) {
  const definition = registry.resolve(task ? fix ? 'integration-fix' : task.pipeline ?? request.default_task_pipeline : 'review-only');
  return valueForDefinition(request, task, definition);
}
export function valueForDefinition(request: RunRequest, task: GraphTask | null, definition: PipelineDefinition) {
  const ids = [...definition.steps.map(s => s.id), ...(definition.fix_loop ? ['fix'] : [])];
  const overrides: Record<string, StepOverride> = Object.fromEntries(Object.entries(request.task_pipeline_overrides).filter(([id]) => ids.includes(id)));
  const execution_checks = (request.task_checks ?? []).map(id => {
    const check = request.checks.find(x => x.id === id)!;
    return { id: check.id, cmd: check.cmd, timeout_min: check.timeout_min };
  });
  return { schema: 'gbdev.pipeline-request.v1', request_id: `${request.request_id}:${task?.id ?? 'final_review'}`, pipeline: definition, repo: request.repo, base_ref: request.base_ref,
    diff_base_ref: task ? null : request.base_ref, goal: task?.goal ?? request.goal, context: request.context + '\n' + (task?.context ?? ''), constraints: request.constraints, allowed_paths: request.allowed_paths,
    acceptance_criteria: (task?.acceptance_criteria ?? request.acceptance_criteria).map(c => ({ id: c.id, text: c.text, ...(c.check && task ? { check_cmd: request.checks.find(x => x.id === c.check)!.cmd, timeout_min: request.checks.find(x => x.id === c.check)!.timeout_min } : {}) })),
    ...(request.integration_checks.length ? { gate_checks: request.integration_checks.map(id => { const c = request.checks.find(c => c.id === id)!; return { id: c.id, cmd: c.cmd }; }) } : {}),
    execution_checks, required_evidence: [], network: request.network ?? true, step_overrides: overrides };
}
