import { validateInventory } from './inventory.js';
import { NOTIFY_REASONS, validateNotifyStatus, validateNotifyTest, validateNotifyAck } from './notify.js';
import { validateDashboardStatus } from './dashboardStatus.js';
import { validateRenderLines } from './renderLines.js';
import { validateRun } from './run.js';
import { validateRunResult } from './runResult.js';
import { validateMergeRecord } from './mergeRecord.js';
import { validatePipelineRun } from './pipelineRun.js';
import { validatePipelineResult } from './pipelineResult.js';
import { type ErrorContract, errorExitCode, toErrorContract, validateError } from './error.js';
import { validateResolvedRole, validateRoleList } from './role.js';
import { validateBrief } from './brief.js';
import { validateEvent } from './event.js';
import { validateJobStatus } from './jobStatus.js';
import { validateJobResult } from './jobResult.js';
import { validateInspectStart } from './inspect.js';
import { validateWorkerResult } from './workerResult.js';
import { validateCleanupResult, validateDoctorResult, validateInitResult, validateInstallResult } from './commandResults.js';
import { type Config } from '../core/config.js';
import { boolean, invalid, object, string } from './validation.js';

export type Envelope<T = unknown> = {
  contract_version: '1'; ok: true; command: string; result_schema: string; result: T;
} | {
  contract_version: '1'; ok: false; command: string; error: ErrorContract;
};

export function successEnvelope<T>(command: string, resultSchema: string, result: T): Envelope<T> {
  return { contract_version: '1', ok: true, command, result_schema: resultSchema, result };
}

export function failureEnvelope(command: string, error: unknown): Envelope<never> {
  return { contract_version: '1', ok: false, command, error: toErrorContract(error) };
}

export function envelopeExitCode(envelope: Envelope): 0 | 1 | 2 {
  return envelope.ok ? 0 : errorExitCode(envelope.error.code);
}

export function serializeEnvelope(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export function validateEnvelope(value: unknown, config?: Config): Envelope {
  const v = object(value, 'envelope');
  if (v.contract_version !== '1') invalid('contract_version must be "1"');
  boolean(v.ok, 'ok');
  string(v.command, 'command');
  if (!v.ok) {
    validateError(v.error);
    if ('result' in v || 'result_schema' in v) invalid('Error envelope must not have a result');
  } else {
    if ('error' in v) invalid('Success envelope must not have an error');
    string(v.result_schema, 'result_schema');
    if (!Object.hasOwn(v, 'result')) invalid('Success envelope requires result');
    const result = v.result;
    // Job/run/pipeline start results embed a compact notify hint; init's notify block is a different shape (validated by validateInitResult).
    if (v.result_schema !== 'gbdev.init.v1' && result && typeof result === 'object' && !Array.isArray(result) && 'notify' in result) {
      const hint = object(result.notify, 'notify hint');
      if (Object.keys(hint).some(key => !['enabled', 'reason', 'endpoint_host'].includes(key))) invalid('Invalid notify hint');
      boolean(hint.enabled, 'notify.enabled');
      if (hint.reason !== null && !(NOTIFY_REASONS as readonly unknown[]).includes(hint.reason)) invalid('Invalid notify reason');
      if (hint.endpoint_host !== null && (typeof hint.endpoint_host !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(hint.endpoint_host))) invalid('Invalid notify host');
    }
    switch (v.result_schema) {
      case 'gbdev.run-list.v1':
      case 'gbdev.pipeline-runs.v1':
      case 'gbdev.job-list.v1': validateInventory(v.result); break;
      case 'gbdev.notify-status.v1': validateNotifyStatus(v.result); break;
      case 'gbdev.notify-test.v1': validateNotifyTest(v.result); break;
      case 'gbdev.notify-ack.v1': validateNotifyAck(v.result); break;
      case 'gbdev.dashboard-status.v1': validateDashboardStatus(v.result); break;
      case 'gbdev.render-lines.v1': validateRenderLines(v.result); break;
      case 'gbdev.run.v1': {
        if (Array.isArray(result)) result.forEach(validateRun);
        else if (v.command === 'run start') {
          // CLI-only observations never become persisted run fields.
          const { notify: _notify, dashboard: _dashboard, ...run } = object(result, 'run start'); validateRun(run);
        } else validateRun(result);
        break;
      }
      case 'gbdev.run-result.v1': validateRunResult(v.result); break;
      case 'gbdev.merge-record.v1': validateMergeRecord(v.result); break;
      case 'gbdev.pipeline-run.v1':
        if (Array.isArray(v.result)) v.result.forEach(validatePipelineRun); else validatePipelineRun(v.result);
        break;
      case 'gbdev.pipeline-result.v1': validatePipelineResult(v.result); break;
      case 'gbdev.pipeline-list.v1': {
        const list = object(v.result, 'pipeline list');
        if (list.schema !== 'gbdev.pipeline-list.v1' || !Array.isArray(list.pipelines) || !Array.isArray(list.invalid)) invalid('Invalid pipeline list');
        break;
      }
      case 'gbdev.job-status.v1':
        if (Array.isArray(v.result)) v.result.forEach(validateJobStatus);
        else validateJobStatus(v.result);
        break;
      case 'gbdev.task-brief.v1':
        if (!config) invalid('Validating task-brief requires config');
        validateBrief(v.result, config);
        break;
      case 'gbdev.role.v1': validateResolvedRole(v.result); break;
      case 'gbdev.role-list.v1': validateRoleList(v.result); break;
      case 'gbdev.worker-result.v1': validateWorkerResult(v.result); break;
      case 'gbdev.job-result.v1': validateJobResult(v.result); break;
      case 'gbdev.inspect-start.v1': validateInspectStart(v.result); break;
      case 'gbdev.event.v1': validateEvent(v.result); break;
      case 'gbdev.error.v1': validateError(v.result); break;
      case 'gbdev.doctor.v1': validateDoctorResult(v.result); break;
      case 'gbdev.install.v1': validateInstallResult(v.result); break;
      case 'gbdev.init.v1': validateInitResult(v.result); break;
      case 'gbdev.cleanup.v1': validateCleanupResult(v.result); break;
      case 'gbdev.cli-help.v1': string(object(v.result, 'help result').text, 'help.text'); break;
      default: invalid(`Unknown result_schema: ${v.result_schema}`);
    }
  }
  return value as Envelope;
}
