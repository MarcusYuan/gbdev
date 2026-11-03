import { notifySupervisorStarted } from '../notify/enqueue.js';
import { dashboardSupervision } from './dashboardSupervision.js';
import { closeSync, fstatSync, openSync, readSync, readFileSync, writeFileSync, writeSync, existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { basename } from 'node:path';
import { type ChildProcess, spawn } from 'node:child_process';
import { type TaskBrief } from '../contracts/brief.js';
import { GbdevError } from '../contracts/error.js';
import { isTerminal } from '../contracts/jobStatus.js';
import { failureResult, finalize, type ForcedState } from './finalize.js';
import { atomicWriteJson, JobStore } from './jobStore.js';
import { jobPaths, resolvePaths } from './paths.js';
import { RAW_OUTPUT_MAX } from '../inspect/limits.js';
import { groupAlive, terminateGroup } from './proc.js';
import { event, locked, optionalText, transition } from './runtime.js';
import { releaseInspectReservation, updateInspectReservation } from './workerReservations.js';
import type { WorkerSchemaOptions } from '../contracts/workerResultSchema.js';
import { providerAdapter, providerSessionId } from '../providers/index.js';
import { RoleRegistry } from '../roles/registry.js';
import { jsonObjects } from '../providers/jsonOutput.js';
import { providerRateLimit } from './providerRateLimit.js';
import { jobTempEnv } from './jobTemp.js';
import { providerFailureReason } from '../providers/cursor.js';
import { selectStructuredCursorResult, type StructuredSelection } from '../providers/cursorResults.js';
import { effectiveWorkerLaunch, loadConfig } from './config.js';
import { getActiveClock } from './time.js';
import {
  assertSnapshotDecidable, captureWorkspaceSnapshot, jobFilesChanged, readWorkspaceSnapshot, WORKSPACE_BEFORE,
} from './workspaceSnapshot.js';
import { join } from 'node:path';
import { classifyLaunchFailure, summaryFromChain, type LaunchClassification } from './retryPolicy.js';
import {
  archiveLaunchAttempt,
  ensureRetryChain,
  isArgTooLongError,
  markExecutionSuccess,
  markLaunchRetriesExhausted,
  resetExecutionOutputs,
  scheduleLaunchRetry,
  waitLaunchBackoff,
} from './launchRetry.js';
import { assertPromptWithinLimit, measureUtf8Bytes } from './promptBudget.js';
import { DEFAULT_REVIEW_PROMPT } from './retryPolicy.js';
import { ActivityTracker, createWorkspaceFileProbe, type ActivityEmit, type ProcessProbe } from './activity.js';

interface ActivityProbeOptions { processProbe?: ProcessProbe }

async function superviseJobWork(jobId: string, store = new JobStore(resolvePaths()), signal?: AbortSignal, probes: ActivityProbeOptions = {}): Promise<void> {
  const paths = jobPaths(store.paths, jobId);
  let forced: ForcedState | undefined;
  let child: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  const cancelMonitor = setInterval(() => { if (optionalText(paths.cancelRequest) !== null) stop('cancelled'); }, 50);
  const stop = (reason: ForcedState) => {
    forced ??= reason;
    if (child?.pid && !stopping) { stopping = terminateGroup(child.pid); void stopping.catch(() => {}); }
  };
  const cancel = () => stop('cancelled');
  const abort = () => {
    atomicWriteJson(paths.cancelRequest, { by: 'gbdev', reason: 'pipeline_timeout' });
    stop('cancelled');
  };
  signal?.addEventListener('abort', abort, { once: true });
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  let exitCode: number | null = null;
  let workerSpawned = false;
  let workerClosed = false;
  let reportFailureOverride: string | undefined;
  let launchSummary: ReturnType<typeof summaryFromChain> | undefined;
  const clock = getActiveClock();
  try {
    if (signal?.aborted) abort();
    let status = await locked(store, () => {
      const current = store.read(jobId);
      if (isTerminal(current.state)) return current;
      // Guard the internal command against duplicate supervisors.
      if (current.state !== 'starting' || optionalText(paths.processInfo) !== null) throw new GbdevError('busy', 'Job already has a supervisor');
      current.pid = process.pid;
      atomicWriteJson(paths.processInfo, { supervisor_pid: process.pid, worker_pgid: null });
      if (current.kind === 'inspect') updateInspectReservation(store, jobId, process.pid, null);
      store.write(current);
      return current;
    });
    if (isTerminal(status.state)) return;
    const brief = JSON.parse(readFileSync(paths.brief, 'utf8')) as TaskBrief;
    const adapter = providerAdapter(brief.provider);
    const providerRecord = JSON.parse(readFileSync(`${paths.dir}/provider.json`, 'utf8'));
    // schema_options may include opt-in policyIncidents (M8 B4); prepareJob/finalize honor the same record.
    const { bin, writable_roots: writableRoots = [], schema_options: schemaOptions } = providerRecord as { bin: string; writable_roots?: string[]; schema_options?: WorkerSchemaOptions };
    const rawName = brief.provider === 'cursor' ? 'raw.json' : 'raw.jsonl';
    const config = (() => { try { return loadConfig(store.paths.config); } catch { return loadConfig(); } })();
    const launchPolicy = effectiveWorkerLaunch(config);
    const reviewMax = config.review_prompt?.max_bytes ?? DEFAULT_REVIEW_PROMPT.max_bytes;
    const chain = ensureRetryChain(paths, {
      job_id: jobId,
      pipeline_id: status.pipeline_id ?? null,
      run_id: status.run_id ?? null,
      step_instance: status.step_instance ?? null,
    }, launchPolicy);
    let execution = Math.max(1, chain.executions_completed + (chain.pending_execution ? 0 : 1));
    if (chain.pending_execution) execution = chain.pending_execution;

    // Resume pending backoff if a prior supervisor left a scheduled retry.
    if (chain.retry_not_before && chain.pending_execution) {
      const ok = await waitLaunchBackoff(chain.retry_not_before, clock, signal, Date.parse(status.deadline_at));
      if (!ok || optionalText(paths.cancelRequest) !== null || clock.now() >= Date.parse(status.deadline_at)) {
        forced = optionalText(paths.cancelRequest) !== null || signal?.aborted ? 'cancelled' : 'timeout';
      } else {
        resetExecutionOutputs(store.paths, jobId, brief.provider);
        execution = chain.pending_execution;
      }
    }

    if (optionalText(paths.cancelRequest) !== null) forced = 'cancelled';
    if (!forced && clock.now() >= Date.parse(status.deadline_at)) forced = 'timeout';

    let classification: LaunchClassification = 'other';
    let lastDurationMs = 0;
    let lastRawEvents = 0;
    let lastBytes = 0;
    let lastHasFinal = false;
    let promptTooLarge = false;

    const baselineFile = join(paths.dir, WORKSPACE_BEFORE);
    const needsBaseline = status.kind !== 'merge_resolution' && status.kind !== 'inspect';
    if (needsBaseline) {
      try {
        if (!existsSync(baselineFile)) {
          if (existsSync(join(paths.dir, 'launch-attempts'))) throw new GbdevError('workspace_snapshot_invalid', 'Retried job has lost its baseline');
          // No worker has started in this supervisor. Even a pre-spawn cancellation
          // gets bounded evidence so cancellation itself does not invent an invalid snapshot.
          const options = forced ? { deadlineAt: Date.now() + 5_000 } : {
            signal, deadlineAt: Date.parse(status.deadline_at), cancelled: () => optionalText(paths.cancelRequest) !== null,
          };
          const meta = { job_id: jobId, phase: 'before_worker' as const,
            previous_job_id: status.parent_job_id ?? providerRecord.previous_job_id ?? null };
          let snap;
          try { snap = await captureWorkspaceSnapshot(status.worktree, meta, options); }
          catch (error) {
            // A stop arriving during initial capture has not launched a worker.
            // Complete evidence under the same bounded cleanup policy as finalize.
            // Real probe/read errors still propagate; only cancellation is retried.
            const interrupted = error instanceof Error && /^(git_cancelled|Workspace observation cancelled or deadline exceeded)$/.test(error.message);
            if (!interrupted || (!forced && !signal?.aborted && optionalText(paths.cancelRequest) === null)) throw error;
            snap = await captureWorkspaceSnapshot(status.worktree, meta, { deadlineAt: Date.now() + 5_000 });
          }
          atomicWriteJson(baselineFile, snap);
        }
        const baseline = readWorkspaceSnapshot(baselineFile, { job_id: jobId, phase: 'before_worker' });
        assertSnapshotDecidable(baseline); // Unknown content without a stat identity cannot authorize worker execution.
      } catch (error) {
        throw new GbdevError('workspace_snapshot_invalid', 'Could not capture workspace baseline', { detail: String(error) });
      }
    }
    if (optionalText(paths.cancelRequest) !== null || signal?.aborted) forced = 'cancelled';
    if (!forced && clock.now() >= Date.parse(status.deadline_at)) forced = 'timeout';
    while (!forced) {
      // Validate, but never recreate or overwrite a lost/corrupt baseline on retry.
      if (needsBaseline) readWorkspaceSnapshot(baselineFile, { job_id: jobId, phase: 'before_worker' });
      adapter.prepareJob?.(paths.dir, schemaOptions);
      const promptText = readFileSync(paths.prompt, 'utf8');
      process.env.GBDEV_LAUNCH_EXECUTION = String(execution);
      // Cursor argv precheck (and any oversized prompt): fail without spawn.
      if (brief.provider === 'cursor' || schemaOptions?.output === 'verdict') {
        try {
          assertPromptWithinLimit(promptText, reviewMax, brief.provider, jobId);
        } catch (error) {
          if (error instanceof GbdevError && error.contract.code === 'prompt_too_large') {
            promptTooLarge = true;
            classification = 'prompt_too_large';
            reportFailureOverride = 'prompt_too_large';
            markLaunchRetriesExhausted(paths, chain, {
              execution, worker_duration_ms: 0, exit_code: null, raw_events: 0, bytes: 0,
              has_final_message: false, classification: 'prompt_too_large', raw_name: rawName,
            });
            launchSummary = summaryFromChain(chain, { bytes: measureUtf8Bytes(promptText), max: reviewMax });
            break;
          }
          throw error;
        }
      }
      let invocation;
      try {
        invocation = adapter.buildInvocation({
          bin, worktree: status.worktree, jobDir: paths.dir,
          prompt: promptText, sandbox: status.sandbox, network: brief.network ?? true, model: brief.model, writableRoots,
          taskId: status.task_id ?? status.branch.match(/\/t\/([a-z][a-z0-9-]*?)(?:-r[0-9]+)?$/)?.[1],
          stepInstance: status.step_instance ?? undefined,
        });
      } catch (error) {
        if (isArgTooLongError(error) || (error instanceof GbdevError && error.contract.code === 'prompt_too_large')) {
          promptTooLarge = true;
          classification = 'prompt_too_large';
          reportFailureOverride = 'prompt_too_large';
          markLaunchRetriesExhausted(paths, chain, {
            execution, worker_duration_ms: 0, exit_code: null, raw_events: 0, bytes: 0,
            has_final_message: false, classification: 'prompt_too_large', raw_name: rawName,
          });
          launchSummary = summaryFromChain(chain, { bytes: measureUtf8Bytes(promptText), max: reviewMax });
          break;
        }
        throw error;
      }
      // Persist the exact invocation, without environment or credentials.
      atomicWriteJson(`${paths.dir}/provider.json`, { ...providerRecord, provider: brief.provider, cmd: invocation.cmd, argv: invocation.args, cwd: invocation.cwd });
      let rawFd = -1, logFd = -1;
      let bytes = 0, rawEvents = 0, summarizedEvents = 0;
      let outputWrites = Promise.resolve();
      workerSpawned = false;
      workerClosed = false;
      exitCode = null;
      stopping = undefined;
      const spawnMono = clock.monotonic();
      const stallTimeout = brief.stall_timeout_s ?? 600;
      const parseCursorActivity = brief.provider === 'cursor' && status.kind !== 'inspect';
      const activity = new ActivityTracker({
        stallTimeoutS: stallTimeout,
        clock,
        pgid: () => child?.pid ?? null,
        ...probes,
        // Inspect freezes job.json bytes for parent-cancel assertions (M7 S3). Keep its
        // stall signal output-only: no file/CPU probes and no activity heartbeats.
        ...(status.kind === 'inspect'
          ? {
            processProbe: () => ({
              unavailable: false, identityChanged: false, cpuDeltaMs: 0, cpuTotalMs: 0, state: new Map(),
            }),
          }
          : {
            fileProbe: createWorkspaceFileProbe(status.worktree, jobId, {
              ...(signal ? { signal } : {}),
              cancelled: () => optionalText(paths.cancelRequest) !== null,
              deadlineAt: Date.parse(status.deadline_at),
            }),
          }),
      });
      const emitActivity = (emits: ActivityEmit[]) => {
        for (const item of emits) {
          if (status.kind === 'inspect' && item.type === 'heartbeat') continue;
          if (status.kind === 'inspect' && item.type === 'warning' && item.data.code === 'activity_probe_unavailable') continue;
          const payload = item.data;
          outputWrites = outputWrites.then(() => locked(store, () => event(store, store.read(jobId), item.type, payload)));
          void outputWrites.catch(() => {});
        }
      };
      try {
        rawFd = openSync(brief.provider === 'cursor' ? paths.rawJson : paths.rawJsonl, 'w+', 0o600);
        logFd = openSync(paths.workerLog, 'a', 0o600);
        try {
          child = spawn(invocation.cmd, invocation.args, {
            cwd: invocation.cwd, detached: true,
            // Regular-file stdout can be read synchronously before a stall decision,
            // even when the event loop has not serviced any pipe data callbacks.
            // Inspect retains its bounded pipe capture and output-only activity.
            stdio: ['ignore', status.kind === 'inspect' ? 'pipe' : rawFd, status.kind === 'inspect' ? 'pipe' : logFd],
            env: {
              ...process.env,
              ...jobTempEnv(paths.dir),
              GBDEV_LAUNCH_EXECUTION: String(execution),
              ...(brief.provider === 'fake' && status.step_instance ? { GBDEV_STEP_INSTANCE: status.step_instance } : {}),
              ...(status.branch.match(/^gbdev\/(r_\d{8}_\d{4}_[a-f0-9]{4})\//) ? { GBDEV_RUN_ID: status.branch.split('/')[1]!, GBDEV_LANE: basename(status.worktree) } : {}),
            },
          });
        } catch (error) {
          if (isArgTooLongError(error)) {
            promptTooLarge = true;
            classification = 'prompt_too_large';
            reportFailureOverride = 'prompt_too_large';
            markLaunchRetriesExhausted(paths, chain, {
              execution, worker_duration_ms: 0, exit_code: null, raw_events: 0, bytes: 0,
              has_final_message: false, classification, raw_name: rawName,
            });
            launchSummary = summaryFromChain(chain, { bytes: measureUtf8Bytes(promptText), max: reviewMax });
            break;
          }
          throw error;
        }
        let logSize = fstatSync(logFd).size;
        let inspectBytes = fstatSync(rawFd).size + logSize;
        let rawOffset = 0;
        const stdoutDecoder = new StringDecoder('utf8');
        const writeOutput = (fd: number, chunk: Buffer) => {
          if (status.kind !== 'inspect') { writeSync(fd, chunk); return; }
          const remaining = Math.max(0, RAW_OUTPUT_MAX - inspectBytes);
          if (remaining) writeSync(fd, chunk.subarray(0, remaining));
          inspectBytes += chunk.length;
          if (inspectBytes >= RAW_OUTPUT_MAX) {
            try { atomicWriteJson(`${paths.dir}/inspect-output-limit.json`, { code: 'inspect_output_too_large' }); } catch { /* marker is best-effort */ }
            stop('failed');
          }
        };
        if (status.kind === 'inspect') child.stderr!.on('data', (chunk: Buffer) => {
          writeOutput(logFd, chunk);
          if (chunk.length) emitActivity(activity.noteOutput());
        });
        const consumeOutput = (chunk: Buffer): ActivityEmit[] => {
          const emits: ActivityEmit[] = [];
          if (chunk.length) {
            emits.push(...activity.noteOutput());
            if (parseCursorActivity) emits.push(...activity.consumeStdout(stdoutDecoder.write(chunk)));
          }
          bytes += chunk.length;
          for (const byte of chunk) if (byte === 10) rawEvents++;
          if (rawEvents - summarizedEvents >= 20) {
            const data = { raw: rawName, bytes, raw_events: rawEvents, execution };
            summarizedEvents = rawEvents;
            outputWrites = outputWrites.then(() => locked(store, () => event(store, store.read(jobId), 'worker_output', data, 'worker')));
            void outputWrites.catch(() => {});
          }
          return emits;
        };
        if (status.kind === 'inspect') child.stdout!.on('data', (chunk: Buffer) => {
          writeOutput(rawFd, chunk);
          emitActivity(consumeOutput(chunk));
        });
        const drainOutput = (): ActivityEmit[] => {
          const emits: ActivityEmit[] = [];
          if (status.kind === 'inspect') return emits;
          // Bound this pass to the size observed at entry; a continuous writer must
          // not keep us here indefinitely. Positional reads preserve the writer offset.
          const end = fstatSync(rawFd).size;
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(0, end - rawOffset)));
          while (rawOffset < end) {
            const n = readSync(rawFd, buffer, 0, Math.min(buffer.length, end - rawOffset), rawOffset);
            if (!n) break;
            rawOffset += n;
            emits.push(...consumeOutput(buffer.subarray(0, n)));
          }
          const size = fstatSync(logFd).size;
          if (size > logSize) emits.push(...activity.noteOutput());
          logSize = size;
          return emits;
        };
        const exited = new Promise<number | null>((resolve, reject) => {
          child!.once('spawn', () => { workerSpawned = true; });
          child!.once('error', err => {
            if (isArgTooLongError(err)) {
              promptTooLarge = true;
              resolve(null);
              return;
            }
            reject(err);
          });
          child!.once('close', code => {
            workerClosed = workerSpawned;
            if (workerClosed) exitCode = code;
            resolve(code);
          });
        });
        void exited.catch(() => {});
        if (child.pid) atomicWriteJson(paths.processInfo, { supervisor_pid: process.pid, worker_pgid: child.pid });
        await locked(store, () => {
          status = store.read(jobId);
          if (status.kind === 'inspect') updateInspectReservation(store, jobId, process.pid, child?.pid ?? null);
          if (status.state === 'starting') transition(store, status, 'running');
          status.retry_not_before = null;
          status.chain_id = chain.chain_id;
          status.execution_count = execution;
          status.launch_retries_used = chain.launch_retries_used;
          store.write(status);
        });
        if (forced || optionalText(paths.cancelRequest) !== null) stop(status.kind === 'inspect' ? forced ?? 'cancelled' : forced === 'timeout' ? 'timeout' : 'cancelled');
        else timer = setTimeout(() => stop('timeout'), Math.max(1, Date.parse(status.deadline_at) - clock.now()));
        let stallWatchInFlight = false;
        if (!forced) watchdog = setInterval(() => {
          if (stallWatchInFlight || forced) return;
          // Also consume streams when S=0; output accounting/lifecycle parsing
          // remain enabled independently of stall detection.
          emitActivity(drainOutput());
          stallWatchInFlight = true;
          void activity.tick(drainOutput).then(result => {
            emitActivity(result.events.filter(item => item.type === 'heartbeat' || item.data.code !== 'worker_stalled'));
            // A synchronous probe can straddle the absolute deadline before its
            // timer gets a turn. Deadline/cancel must still win over stall/grace.
            if (!forced && (signal?.aborted || optionalText(paths.cancelRequest) !== null)) stop('cancelled');
            if (!forced && clock.now() >= Date.parse(status.deadline_at)) stop('timeout');
            if (!forced && result.stalled) {
              stop('worker_stalled');
              const stallEvents = result.events.filter(item => item.type === 'warning' && item.data.code === 'worker_stalled');
              emitActivity(stallEvents.length ? stallEvents : [{
                type: 'warning',
                data: {
                  code: 'worker_stalled', retryable: true, stall_timeout_s: stallTimeout, ...result.diagnostics,
                },
              }]);
            }
          }).catch(() => { /* probe faults are recorded inside tick */ }).finally(() => { stallWatchInFlight = false; });
        }, activity.intervalMs);
        exitCode = await exited;
        if (timer) { clearTimeout(timer); timer = undefined; }
        if (watchdog) { clearInterval(watchdog); watchdog = undefined; }
        await stopping;
        if (child.pid && groupAlive(child.pid)) await terminateGroup(child.pid);
        // File-backed stdout may still receive descendant writes after leader close.
        emitActivity(drainOutput());
        if (parseCursorActivity) {
          emitActivity(activity.consumeStdout(stdoutDecoder.end()));
          emitActivity(activity.flushStdout());
        }
        atomicWriteJson(paths.processInfo, { supervisor_pid: process.pid, worker_pgid: null });
        if (status.kind === 'inspect') await locked(store, () => updateInspectReservation(store, jobId, process.pid, null));
        await outputWrites;
        const durationMs = Math.max(0, Math.floor(clock.monotonic() - spawnMono));
        lastDurationMs = durationMs;
        lastRawEvents = rawEvents;
        lastBytes = bytes;
        if (exitCode !== 0 && !forced && !promptTooLarge) {
          await locked(store, () => event(store, store.read(jobId), 'warning', { code: 'worker_crashed', exit_code: exitCode }));
        }
        await locked(store, () => event(store, store.read(jobId), 'worker_output', {
          raw: rawName, bytes, raw_events: rawEvents, exit_code: exitCode, execution, worker_duration_ms: durationMs,
        }, 'worker'));
        const sessionId = providerSessionId(brief.provider, paths.dir);
        if (sessionId) await locked(store, () => {
          const current = store.read(jobId); current.session_id = sessionId; store.write(current);
        });
        // M8 B6: Cursor verdict/structured path — strict candidates; keep extractFinalMessage for prose/inspect.
        let message: string | null = null;
        let structured: StructuredSelection | null = null;
        const structuredOutput = (() => {
          if (schemaOptions?.output !== undefined) return schemaOptions.output;
          if (brief.provider !== 'cursor' || status.kind === 'inspect') return undefined;
          try { return new RoleRegistry(store.paths.config).resolve(brief.role).output; }
          catch { return undefined; } // Legacy/unknown roles retain the tolerant prose path.
        })();
        const useStructured = brief.provider === 'cursor' && status.kind !== 'inspect'
          && (structuredOutput === 'verdict' || structuredOutput === 'change' || structuredOutput === 'report');
        if (useStructured) {
          structured = selectStructuredCursorResult(paths.dir, { output: structuredOutput });
          atomicWriteJson(join(paths.dir, 'result-extraction.json'), {
            selected: structured.selected
              ? { kind: structured.selected.source, event_index: structured.selected.event_index, raw_file: structured.raw_file }
              : null,
            valid: structured.valid,
            recovered_from_assistant: structured.recovered_from_assistant,
            ...(structured.force_invalid ? { force_invalid: structured.force_invalid } : {}),
            candidates: structured.candidates,
          });
          if (structured.selected) {
            message = structured.selected.text;
            writeFileSync(paths.finalMessage, message);
          } else {
            // The legacy extractor preserves terminal error prose without recovering
            // an earlier assistant when a terminal provider failure exists.
            message = adapter.extractFinalMessage(paths.dir);
            if (message !== null) writeFileSync(paths.finalMessage, message);
          }
        } else {
          message = adapter.extractFinalMessage(paths.dir);
          if (message !== null) writeFileSync(paths.finalMessage, message);
        }
        lastHasFinal = !!(message && message.trim());
        const rawText = optionalText(brief.provider === 'cursor' ? paths.rawJson : paths.rawJsonl) ?? '';
        const parseable = jsonObjects(rawText).length;
        let providerFailure: string | null = null;
        try { providerFailure = providerFailureReason(brief.provider, paths.dir); } catch { /* ignore */ }
        // Inspect only this execution's outputs, before empty-exit classification.
        if (providerRateLimit(brief.provider, paths.dir, exitCode)) {
          providerFailure = 'rate_limit';
          reportFailureOverride = providerFailure;
        }
        // Quick workspace side-effect check before auto-retry (job delta, not raw dirty).
        let workspaceBlocked = false;
        try {
          if (!forced && brief.sandbox === 'read-only' && status.kind !== 'inspect' && status.kind !== 'merge_resolution') {
            const baseline = readWorkspaceSnapshot(join(paths.dir, WORKSPACE_BEFORE), { job_id: jobId, phase: 'before_worker' });
            const after = await captureWorkspaceSnapshot(status.worktree, {
              job_id: jobId, phase: 'after_worker', previous_job_id: baseline.previous_job_id,
            }, { signal, deadlineAt: Date.parse(status.deadline_at), cancelled: () => optionalText(paths.cancelRequest) !== null });
            workspaceBlocked = jobFilesChanged(baseline, after).length > 0 || after.head_sha !== baseline.head_sha;
          }
        } catch (error) {
          throw new GbdevError('workspace_snapshot_invalid', 'Could not verify workspace before retry', { detail: String(error) });
        }
        classification = promptTooLarge ? 'prompt_too_large' : classifyLaunchFailure({
          spawned: workerSpawned,
          closed: workerClosed,
          worker_duration_ms: durationMs,
          raw_events: rawEvents,
          parseable_json_events: parseable,
          final_message: message,
          ...(forced ? { forced } : {}),
          ...(providerFailure ? { provider_failure: providerFailure } : { provider_failure: null }),
          prompt_too_large: promptTooLarge,
          threshold_ms: chain.policy.failure_threshold_ms,
          workspace_policy_blocked: workspaceBlocked,
        });
        const facts = {
          execution, worker_duration_ms: durationMs, exit_code: exitCode, raw_events: rawEvents, bytes,
          has_final_message: lastHasFinal, classification, raw_name: rawName,
        };
        archiveLaunchAttempt(store.paths, jobId, facts, brief.provider);

        if (classification === 'launch_failed' && !workspaceBlocked) {
          const scheduled = scheduleLaunchRetry(paths, chain, facts, brief.provider, clock);
          if (scheduled && Object.keys(scheduled.event_data).length) {
            await locked(store, () => event(store, store.read(jobId), 'launch_retry', scheduled.event_data));
            await locked(store, () => {
              const current = store.read(jobId);
              current.launch_retries_used = chain.launch_retries_used;
              current.retry_not_before = scheduled.retry_not_before;
              current.execution_count = execution;
              current.last_classification = classification;
              current.last_worker_duration_ms = durationMs;
              current.chain_id = chain.chain_id;
              store.write(current);
            });
          }
          if (scheduled) {
            child = undefined;
            const ok = await waitLaunchBackoff(scheduled.retry_not_before, clock, signal, Date.parse(status.deadline_at));
            if (!ok || optionalText(paths.cancelRequest) !== null) {
              forced = optionalText(paths.cancelRequest) !== null || signal?.aborted ? 'cancelled' : 'timeout';
              break;
            }
            // Clear outputs for next execution; keep top-level as last attempt until next spawn overwrites.
            resetExecutionOutputs(store.paths, jobId, brief.provider);
            execution = scheduled.chain.pending_execution ?? execution + 1;
            continue;
          }
          // Exhausted or not retryable.
          markLaunchRetriesExhausted(paths, chain, facts);
          reportFailureOverride = 'launch_failed';
          launchSummary = summaryFromChain(chain);
          break;
        }

        if (classification === 'prompt_too_large') {
          reportFailureOverride = 'prompt_too_large';
          markLaunchRetriesExhausted(paths, chain, facts);
          launchSummary = summaryFromChain(chain, { bytes: measureUtf8Bytes(promptText), max: reviewMax });
          break;
        }

        if (classification === 'launch_failed' && workspaceBlocked) {
          // Keep launch_failed fact but do not auto-retry over side effects.
          markLaunchRetriesExhausted(paths, chain, facts);
          reportFailureOverride = 'launch_failed';
          launchSummary = summaryFromChain(chain);
          break;
        }

        // Success or non-launch failure: finalize once.
        markExecutionSuccess(paths, chain, execution);
        launchSummary = summaryFromChain(chain);
        if (classification === 'missing_result') {
          // Keep default worker_result_missing path in finalize.
          reportFailureOverride = undefined;
        }
        break;
      } finally {
        if (watchdog) { clearInterval(watchdog); watchdog = undefined; }
        if (timer) { clearTimeout(timer); timer = undefined; }
        try { if (rawFd >= 0) closeSync(rawFd); }
        finally { if (logFd >= 0) closeSync(logFd); }
      }
    }
    child = undefined;

    if (promptTooLarge && !reportFailureOverride) reportFailureOverride = 'prompt_too_large';
    if (classification === 'launch_failed' && !reportFailureOverride && !forced) reportFailureOverride = 'launch_failed';

    const result = await finalize(store, store.read(jobId), brief, exitCode, forced, workerClosed, reportFailureOverride);
    if (launchSummary) {
      await locked(store, () => {
        const current = store.read(jobId);
        Object.assign(current, {
          chain_id: launchSummary!.chain_id,
          execution_count: launchSummary!.execution_count,
          launch_retries_used: launchSummary!.launch_retries_used,
          auto_retries_exhausted: launchSummary!.auto_retries_exhausted,
          last_execution_index: launchSummary!.last_execution_index,
          last_classification: launchSummary!.last_classification,
          last_worker_duration_ms: launchSummary!.last_worker_duration_ms ?? lastDurationMs,
          retry_not_before: null,
          ...(launchSummary!.prompt_bytes != null ? { prompt_bytes: launchSummary!.prompt_bytes, prompt_max_bytes: launchSummary!.prompt_max_bytes } : {}),
        });
        store.write(current);
        // Mirror onto result file if still present.
        try {
          const resultPath = paths.result;
          if (existsSync(resultPath)) {
            const r = JSON.parse(readFileSync(resultPath, 'utf8'));
            Object.assign(r, {
              chain_id: launchSummary!.chain_id,
              execution_count: launchSummary!.execution_count,
              launch_retries_used: launchSummary!.launch_retries_used,
              auto_retries_exhausted: launchSummary!.auto_retries_exhausted,
              last_execution_index: launchSummary!.last_execution_index,
              last_classification: launchSummary!.last_classification,
              last_worker_duration_ms: launchSummary!.last_worker_duration_ms ?? lastDurationMs,
              ...(launchSummary!.prompt_bytes != null ? { prompt_bytes: launchSummary!.prompt_bytes, prompt_max_bytes: launchSummary!.prompt_max_bytes } : {}),
            });
            // When launch_failed, ensure primary reason and strip derived worker_result_missing as sole driver.
            if (reportFailureOverride === 'launch_failed' && r.state === 'failed') {
              r.failure_reason = 'launch_failed';
              r.failure_reasons = Array.isArray(r.failure_reasons)
                ? [...new Set(['launch_failed', ...r.failure_reasons.filter((x: string) => x !== 'worker_result_missing')])]
                : ['launch_failed'];
            }
            if (reportFailureOverride === 'prompt_too_large' && r.state === 'failed') {
              r.failure_reason = 'prompt_too_large';
              r.worker_exit_code = null;
              r.failure_reasons = ['prompt_too_large'];
            }
            atomicWriteJson(resultPath, r);
          }
        } catch { /* best-effort */ }
        void result;
        void lastRawEvents; void lastBytes; void lastHasFinal;
      });
    }
  } catch (error) {
    if (child?.pid) await terminateGroup(child.pid);
    await locked(store, () => {
      const status = store.read(jobId);
      // A duplicate internal invocation must never fail the real supervisor's job.
      if (status.pid !== process.pid || isTerminal(status.state)) return;
      const result = failureResult(store, status, exitCode, workerClosed);
      event(store, status, 'warning', { code: 'worker_crashed', detail: String(error) });
      result.state = forced === 'worker_stalled' ? 'failed' : forced ?? 'failed';
      result.failure_reason = forced === 'cancelled' ? null : forced ?? `worker_crashed: ${String(error)}`;
      if (status.kind === 'inspect' && forced !== 'cancelled' && optionalText(`${paths.dir}/inspect-output-limit.json`) !== null) {
        result.state = 'failed';
        result.failure_reason = 'inspect_output_too_large';
        result.failure_reasons = [...new Set([...(result.failure_reasons ?? []), result.failure_reason])];
      }
      if (error instanceof GbdevError && error.contract.code === 'prompt_too_large') {
        result.state = 'failed';
        result.failure_reason = 'prompt_too_large';
        result.worker_exit_code = null;
        result.failure_reasons = [...new Set(['prompt_too_large', ...(result.failure_reasons ?? [])])];
      }
      if (error instanceof GbdevError && error.contract.code === 'workspace_snapshot_invalid') {
        // The capture error itself is primary; missing evidence discovered only during recovery is secondary.
        result.state = 'failed';
        result.failure_reason = 'workspace_snapshot_invalid';
        result.failure_reasons = [...new Set([...(result.failure_reasons ?? []), 'workspace_snapshot_invalid'])];
      }
      atomicWriteJson(paths.result, result);
      transition(store, status, result.state, result.state === 'cancelled' ? 'grok-bot' : 'gbdev', result.failure_reason, result.failure_reasons);
      releaseInspectReservation(store, jobId);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (watchdog) clearInterval(watchdog);
    signal?.removeEventListener('abort', abort);
    clearInterval(cancelMonitor);
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
}

export function superviseJob(jobId: string, store = new JobStore(resolvePaths()), signal?: AbortSignal, probes: ActivityProbeOptions = {}): Promise<void> {
  notifySupervisorStarted(store);
  return dashboardSupervision(store, jobId, () => superviseJobWork(jobId, store, signal, probes));
}
