import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NotifyLastDelivery, NotifyLastTest, NotifyPaused, NotifyStatus, SecretProblem } from '../contracts/notify.js';
import { atomicWriteJson, type JobStore } from '../core/jobStore.js';
import { locked } from '../core/runtime.js';
import { deliveryLog } from './log.js';
export interface DeliveryState {
  paused?: NotifyPaused | null; paused_secret_gen?: string | null;
  blocked_reason?: 'secret_missing' | 'secret_unsafe' | 'secret_unsupported' | 'url_invalid' | null;
  secret_problem?: SecretProblem | null;
  last_success_at?: string | null; last_attempt_at?: string | null; deliverer_pid?: number | null;
  last_error?: NotifyStatus['last_error']; last_delivery?: NotifyLastDelivery | null; last_test?: NotifyLastTest | null;
  /** Internal attribution; the public last_error contract remains unchanged. */
  last_error_notice_id?: string | null;
  last_test_secret_gen?: string | null;
  keychain_setup_at?: string | null;
  verified_at?: string | null; verified_notice_id?: string | null; verified_by_bot?: string | null; verified_secret_gen?: string | null;
}
class InvalidDeliveryState extends Error {}
export function readDeliveryState(home: string): DeliveryState {
  let content: string;
  try { content = readFileSync(join(home, 'notify', 'state.json'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Invalid notify state'); }
  try { const value: unknown = JSON.parse(content); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as DeliveryState; }
  catch { throw new InvalidDeliveryState('Invalid notify state'); }
}
/** Caller holds the global lock. I/O failures are not evidence of corrupt JSON. */
function recoverState(home: string): DeliveryState {
  try { return readDeliveryState(home); }
  catch (e) {
    if (!(e instanceof InvalidDeliveryState)) throw e;
    atomicWriteJson(join(home, 'notify', 'state.json'), {});
    deliveryLog(home, 'state_reset');
    return {};
  }
}
export async function readDeliveryStateForDelivery(store: JobStore): Promise<DeliveryState> {
  return locked(store, () => recoverState(store.paths.home));
}
/** Shared with setup and notify CLI: merge under the global lock, never over a stale snapshot. */
export async function updateDeliveryState(store: JobStore, patch: Partial<DeliveryState>, recoverInvalid = false): Promise<void> {
  await locked(store, () => atomicWriteJson(join(store.paths.home, 'notify', 'state.json'), { ...(recoverInvalid ? recoverState(store.paths.home) : readDeliveryState(store.paths.home)), ...patch }));
}
/** Internal flush --retry-auth interface; preserves the existing verified generation. */
export async function retryAuth(store: JobStore): Promise<void> {
  await locked(store, () => {
    const state = readDeliveryState(store.paths.home);
    if (state.paused && ['paused_auth_rejected', 'paused_endpoint_gone', 'paused_redirect_refused'].includes(state.paused.reason)) {
      atomicWriteJson(join(store.paths.home, 'notify', 'state.json'), { ...state, paused: null, paused_secret_gen: null });
    }
  });
}
