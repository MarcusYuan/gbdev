import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver } from '../../dist/src/notify/deliver.js';
import { JobStore } from '../../dist/src/core/jobStore.js';
import { resolvePaths } from '../../dist/src/core/paths.js';
if (process.argv.includes('--after-parent') && process.connected) await new Promise(resolve => process.once('disconnect', resolve));
// Test-only fake sleep keeps detached lifecycle tests deterministic and fast.
let now = Date.now(), elapsed = 0;
await deliver(new JobStore(resolvePaths()), { now: () => now, monotonic: () => elapsed, random: () => .5, sleep: async ms => { now += ms; elapsed += ms; } });
writeFileSync(join(resolvePaths().home, 'notify', 'test-delivery-done.json'), JSON.stringify({ pid: process.pid }));
if (process.connected) process.send?.({ done: true });
