// Only disk operations and a launch stub; invoked by the eight-process test.
import { JobStore } from '../../dist/src/core/jobStore.js';
import { resolvePaths } from '../../dist/src/core/paths.js';
import { locked } from '../../dist/src/core/runtime.js';
import { notifyEvent, installNotifyTesting } from '../../dist/src/notify/enqueue.js';
const store = new JobStore(resolvePaths());
const cleanup = installNotifyTesting(store.paths.home, { launch: () => {} });
try {
  for (let i = 0; i < 12; i++) await locked(store, () => {
    notifyEvent(store, { kind: 'run', id: 'r_20261029_0930_ab12', state: 'running' }, 'decision_required', { reason: 'task_failed', decision_id: `d_${process.argv[2]}-${i}` }, i + 1, '2026-10-29T10:31:02-07:00');
  });
  // All processes replay the same event too.
  await locked(store, () => notifyEvent(store, { kind: 'run', id: 'r_20261029_0930_ab12', state: 'running' }, 'decision_required', { reason: 'plan_review', decision_id: 'd_shared' }, 99, '2026-10-29T10:31:02-07:00'));
} finally { cleanup(); }
