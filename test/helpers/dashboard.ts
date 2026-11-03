import type { TestContext } from 'node:test';
import { activeEnsures } from '../../src/dashboard/trigger.js';
import { until } from './m3.js';
/** Register before temporary-directory cleanup. Only tests using the fake tmux opt in. */
export function reapDashboardChildren(t: TestContext): void {
  t.after(async () => {
    try { await until(() => activeEnsures.size === 0, 18000); }
    catch (error) {
      // A broken ensure must not orphan its fake client when an assertion fails.
      await Promise.all([...activeEnsures].map(child => new Promise<void>(resolve => {
        child.once('close', () => resolve());
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      })));
      throw error;
    }
  });
}
