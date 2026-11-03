import type { Run } from '../contracts/run.js';
import { GbdevError } from '../contracts/error.js';
import { worktreeAsync, assertRunWorktreeAsync, dirtyAsync, headAsync, gitGuardedAsync, addDetachedWorktree, assertRunWorktree, cleanUntracked, git, head, isDirty, resetHard, switchExisting, switchCreate, switchDetach, type GitGuardContext } from '../core/git.js';
import { runWorkspacePath, setupWorkspace, type RunWorkspaceOptions } from './workspace.js';

export type Lane = Run['lanes'][number];
/** Owns only lane lifecycle; task/run transitions and persistence belong to S3. */
export class LaneManager {
  readonly lanes: Lane[] = [];
  constructor(readonly options: RunWorkspaceOptions, lanes: Lane[] = []) { this.lanes.push(...lanes); }
  private context(lane: Lane): GitGuardContext {
    const sha = lane.verified_sha;
    return { ...this.options, worktree: lane.worktree, branch: lane.branch ?? `gbdev/${this.options.run_id}/integration`, ...(sha ? { detached_sha: sha } : {}) };
  }
  private broken(lane: Lane, error: unknown): never {
    lane.state = 'broken';
    throw new GbdevError('worktree_failed', 'lane_broken', { lane: lane.lane, reason: 'lane_broken', detail: String(error) });
  }
  async create(number: number, verifiedSha: string): Promise<Lane> {
    const name = `lane-${number}`, worktree = runWorkspacePath(this.options, name);
    if (this.lanes.some(l => l.lane === name)) throw new GbdevError('run_state_conflict', 'Lane already exists');
    const lane: Lane = { lane: name, host: 'local', state: 'preparing', worktree, task_id: null, branch: null, pipeline_id: null, tasks_done: 0 };
    this.lanes.push(lane);
    try {
      if (this.options.signal) await worktreeAsync(this.options.repo, worktree, verifiedSha, this.options.signal);
      else addDetachedWorktree(this.options.repo, worktree, verifiedSha);
      lane.verified_sha = verifiedSha;
      await setupWorkspace(this.options, name, worktree);
      lane.state = 'idle';
      if (!await this.inspectAsync(lane)) throw new Error('Setup left an unhealthy lane');
      return lane;
    } catch (error) { lane.state = 'broken'; throw error; }
  }
  /** Called again immediately before allocation; never discards dirty evidence. */
  inspect(lane: Lane): boolean {
    if (lane.state === 'broken' || lane.state === 'preparing') return false;
    try {
      assertRunWorktree(this.context(lane));
      if (isDirty(lane.worktree) || git(lane.worktree, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim() !== head(lane.worktree)) throw new Error('Dirty or invalid HEAD');
      return true;
    } catch { lane.state = 'broken'; return false; }
  }
  available(): Lane[] { return this.lanes.filter(l => l.state === 'idle' && this.inspect(l)); }
  start(lane: Lane, taskId: string, verifiedSha: string, rebuild = 1): { branch: string; base_sha: string } {
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(taskId) || !Number.isSafeInteger(rebuild) || rebuild < 1) throw new GbdevError('run_invalid', 'Invalid task/rebuild');
    if (lane.state !== 'idle' || !this.inspect(lane)) throw new GbdevError('run_state_conflict', 'Lane is not healthy and idle');
    const branch = `gbdev/${this.options.run_id}/t/${taskId}${rebuild > 1 ? `-r${rebuild}` : ''}`;
    try {
      switchCreate(this.context(lane), branch, verifiedSha);
      delete lane.verified_sha;
      Object.assign(lane, { branch, task_id: taskId, state: 'busy' });
      return { branch, base_sha: head(lane.worktree) };
    } catch (error) { return this.broken(lane, error); }
  }
  resume(lane: Lane, taskId: string, branch: string, expectedHead: string): void {
    if (lane.state !== 'idle' || !this.inspect(lane)) throw new GbdevError('run_state_conflict', 'Lane is not idle');
    try {
      switchExisting(this.context(lane), branch);
      if (head(lane.worktree) !== expectedHead) throw new Error('Task head moved');
      delete lane.verified_sha;
      Object.assign(lane, { branch, task_id: taskId, state: 'busy' });
    } catch (e) { this.broken(lane, e); }
  }
  park(lane: Lane, verifiedSha: string): { head_sha: string; branch: string } {
    if (lane.state !== 'busy' || !this.inspect(lane)) return this.broken(lane, 'Cannot park unhealthy/busy lane');
    const evidence = { head_sha: head(lane.worktree), branch: lane.branch! };
    try {
      switchDetach(this.context(lane), verifiedSha);
      lane.verified_sha = verifiedSha;
      resetHard(this.context(lane), verifiedSha);
      cleanUntracked(this.context(lane));
      Object.assign(lane, { state: 'idle', task_id: null, branch: null, pipeline_id: null, tasks_done: lane.tasks_done + 1 });
      return evidence;
    } catch (error) { return this.broken(lane, error); }
  }
  async inspectAsync(lane: Lane): Promise<boolean> {
    if (lane.state === 'broken' || lane.state === 'preparing') return false;
    try { await assertRunWorktreeAsync(this.context(lane), true, 120_000, this.options.signal); if (await dirtyAsync(lane.worktree, this.options.signal)) throw new Error('Dirty lane'); return true; }
    catch (e) { if (this.options.signal?.aborted) throw e; lane.state = 'broken'; return false; }
  }
  async startAsync(lane: Lane, taskId: string, sha: string, generation = 1): Promise<void> {
    if (lane.state !== 'idle' || !await this.inspectAsync(lane)) throw new Error('lane_broken');
    const branch = `gbdev/${this.options.run_id}/t/${taskId}${generation > 1 ? `-r${generation}` : ''}`;
    await gitGuardedAsync(this.context(lane), { operation: 'switchCreate', branch, sha }, 120_000, this.options.signal);
    delete lane.verified_sha; Object.assign(lane, { branch, task_id: taskId, state: 'busy' });
  }
  async resumeAsync(lane: Lane, taskId: string, branch: string, sha: string): Promise<void> {
    if (lane.state !== 'idle' || !await this.inspectAsync(lane)) throw new Error('lane_broken');
    await gitGuardedAsync(this.context(lane), { operation: 'switchExisting', branch }, 120_000, this.options.signal);
    if (await headAsync(lane.worktree, this.options.signal) !== sha) return this.broken(lane, 'Task head moved');
    delete lane.verified_sha; Object.assign(lane, { branch, task_id: taskId, state: 'busy' });
  }
  async parkAsync(lane: Lane, sha: string): Promise<{ head_sha: string; branch: string }> {
    if (lane.state !== 'busy' || !await this.inspectAsync(lane)) return this.broken(lane, 'Cannot park unhealthy lane');
    const evidence = { head_sha: await headAsync(lane.worktree, this.options.signal), branch: lane.branch! };
    await gitGuardedAsync(this.context(lane), { operation: 'switchDetach', sha }, 120_000, this.options.signal);
    lane.verified_sha = sha;
    Object.assign(lane, { state: 'idle', task_id: null, branch: null, pipeline_id: null, tasks_done: lane.tasks_done + 1 }); return evidence;
  }

}
