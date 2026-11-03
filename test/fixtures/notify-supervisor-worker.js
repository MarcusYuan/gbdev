// A real in-process gbdev supervisor using only the fake provider and notify launch stub.
import { resolve } from 'node:path';
import { JobStore } from '../../dist/src/core/jobStore.js';
import { resolvePaths } from '../../dist/src/core/paths.js';
import { fake } from '../../dist/src/providers/fake.js';
import { superviseRun } from '../../dist/src/run/supervisor.js';
import { installNotifyTesting } from '../../dist/src/notify/enqueue.js';
const store = new JobStore(resolvePaths());
const build = fake.buildInvocation.bind(fake);
fake.buildInvocation = (...args) => { const result = build(...args); result.args[0] = resolve('test/fixtures/fake-worker.js'); return result; };
const cleanup = installNotifyTesting(store.paths.home, { launch: () => {} });
try { await superviseRun(store, process.argv[2]); } finally { cleanup(); }
