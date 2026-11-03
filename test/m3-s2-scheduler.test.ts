import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireSlot, canAcquireSlot, chooseLane, coolDown, isRateLimited, readyQueue, releaseSlot, schedule, scopesOverlap, type SchedulingTask, type Slots } from '../src/run/scheduler.js';
import { DEFAULT_PARALLEL } from '../src/core/runConfig.js';
const task = (id: string, patch: Partial<SchedulingTask> = {}): SchedulingTask => ({ id, depends_on: [], file_scope: [`src/${id}/**`], state: 'ready', provider: 'codex', lane: null, ...patch });
const lane = (n: number, tasks_done = 0, state: 'idle' | 'busy' | 'broken' = 'idle') => ({ lane: `lane-${n}`, tasks_done, state });
const slots = (patch: Partial<Slots> = {}): Slots => ({ max_workers: 3, in_use: 0, by_provider: { codex: 0, cursor: 0 }, cooldown_until: {}, ...patch });
const now = Date.parse('2026-10-26T12:00:00Z');
const cases: [string, () => unknown, unknown][] = [
  ['no dependencies ready', () => readyQueue([task('a')]).map(t => t.id), ['a']],
  ['pending promotes when dependencies integrated', () => readyQueue([task('a', { state: 'integrated' }), task('b', { state: 'pending', depends_on: ['a'] })]).map(t => t.id), ['b']],
  ['running dependency blocks', () => readyQueue([task('a', { state: 'running' }), task('b', { depends_on: ['a'] })]).length, 0],
  ['merge queued dependency blocks', () => readyQueue([task('a', { state: 'merge_queued' }), task('b', { depends_on: ['a'] })]).length, 0],
  ['dropped dependency blocks', () => readyQueue([task('a', { state: 'dropped' }), task('b', { depends_on: ['a'] })]).length, 0],
  ['missing dependency blocks', () => readyQueue([task('b', { depends_on: ['missing'] })]).length, 0],
  ['all dependencies required', () => readyQueue([task('a', { state: 'integrated' }), task('b', { state: 'paused' }), task('c', { depends_on: ['a', 'b'] })]).length, 0],
  ['paused without resume excluded', () => readyQueue([task('a', { state: 'paused' })]).length, 0],
  ['resume priority before new critical path', () => readyQueue([task('a'), task('b', { depends_on: ['a'] }), task('c', { state: 'paused', resume_ready: true })]).map(t => t.id), ['c', 'a']],
  ['integration fix priority', () => readyQueue([task('a'), task('b', { integration_fix: true })]).map(t => t.id), ['b', 'a']],
  ['longest downstream chain priority', () => readyQueue([task('a'), task('b'), task('c', { depends_on: ['b'] }), task('d', { depends_on: ['c'] })]).map(t => t.id), ['b', 'a']],
  ['declaration order tie break', () => readyQueue([task('z'), task('a')]).map(t => t.id), ['z', 'a']],
  ['parent scope overlaps exact child', () => scopesOverlap(['src/**'], ['src/server.ts']), true],
  ['distinct exact files do not overlap', () => scopesOverlap(['src/routes/health.ts'], ['src/routes/version.ts']), false],
  ['segment boundary not string prefix', () => scopesOverlap(['src/a/**'], ['src/ab/**']), false],
  ['root wildcard overlaps everything', () => scopesOverlap(['**/*.ts'], ['test/x']), true],
  ['question mark wildcard prefix', () => scopesOverlap(['src/a?.ts'], ['src/b.ts']), true],
  ['brackets wildcard prefix', () => scopesOverlap(['src/[ab]/**'], ['src/c/file']), true],
  ['brace wildcard prefix', () => scopesOverlap(['src/{a,b}/**'], ['src/c/file']), true],
  ['multiple scope entries', () => scopesOverlap(['lib/**', 'src/**'], ['test/**', 'lib/a']), true],
  ['affinity beats least load', () => chooseLane(task('b', { depends_on: ['a'] }), [task('a', { lane: 'lane-2' })], [lane(1), lane(2, 9)])?.lane, 'lane-2'],
  ['least loaded beats number', () => chooseLane(task('a'), [], [lane(1, 4), lane(3, 0)])?.lane, 'lane-3'],
  ['lane number tie break', () => chooseLane(task('a'), [], [lane(3), lane(1)])?.lane, 'lane-1'],
  ['busy affinity excluded', () => chooseLane(task('b', { depends_on: ['a'] }), [task('a', { lane: 'lane-2' })], [lane(1), lane(2, 0, 'busy')])?.lane, 'lane-1'],
  ['broken lane excluded', () => chooseLane(task('a'), [], [lane(1, 0, 'broken')]), undefined],
  ['global slots exhausted', () => canAcquireSlot(slots({ in_use: 3 }), DEFAULT_PARALLEL, 'codex', now), false],
  ['provider limit exhausted', () => canAcquireSlot(slots({ in_use: 2, by_provider: { codex: 0, cursor: 2 } }), DEFAULT_PARALLEL, 'cursor', now), false],
  ['other provider still available', () => canAcquireSlot(slots({ in_use: 2, by_provider: { codex: 0, cursor: 2 } }), DEFAULT_PARALLEL, 'codex', now), true],
  ['active cooldown', () => canAcquireSlot(coolDown(slots(), 'codex', now, 600), DEFAULT_PARALLEL, 'codex', now + 599999), false],
  ['cooldown exact expiry', () => canAcquireSlot(coolDown(slots(), 'codex', now, 600), DEFAULT_PARALLEL, 'codex', now + 600000), true],
  ['cooldown does not block other provider', () => canAcquireSlot(coolDown(slots(), 'codex', now, 600), DEFAULT_PARALLEL, 'cursor', now), true],
  ['failure reason rate limit', () => isRateLimited(true, 'HTTP 429', ''), true],
  ['log quota case insensitive', () => isRateLimited(true, null, 'QUOTA exceeded'), true],
  ['successful worker not cooled', () => isRateLimited(false, null, '429'), false],
  ['only last eighty log lines', () => ['ok', ''].map(line => isRateLimited(true, null, '429\n' + Array(80).fill(line).join('\n') + '\n')), [false, false]],
  ['eighty line boundary included', () => isRateLimited(true, null, 'rate-limit\n' + Array(79).fill('ok').join('\n')), true],
  ['unrelated failure', () => isRateLimited(true, 'exit 1', 'test failed'), false],
];
for (const [name, compute, expected] of cases) test(`AC-S2.1 table: ${name}`, () => assert.deepEqual(compute(), expected));
test('AC-S2.1 overlap skip does not block queue; running and merging block, queued does not', () => {
  for (const state of ['running', 'merging', 'merge_queued'] as const) {
    const result = schedule([task('a', { state }), task('b', { file_scope: ['src/a/new.ts'] }), task('c')], [lane(1), lane(2)], slots(), DEFAULT_PARALLEL, now);
    assert.deepEqual(result.assignments.map(a => a.task_id), state === 'merge_queued' ? ['b', 'c'] : ['c']);
    assert.deepEqual(result.warnings, state === 'merge_queued' ? [] : [{ task_id: 'b', warning: 'waiting_overlap:a' }]);
  }
});
test('AC-S2.1 serialize/allow and intra-tick slot reservations are deterministic and pure', () => {
  const tasks = [task('a'), task('b', { file_scope: ['src/a/**'] }), task('c'), task('d')], lanes = [lane(1), lane(2), lane(3), lane(4)], initial = slots();
  const before = JSON.stringify({ tasks, lanes, initial });
  assert.deepEqual(schedule(tasks, lanes, initial, DEFAULT_PARALLEL, now).assignments.map(a => a.task_id), ['a', 'c', 'd']);
  assert.deepEqual(schedule(tasks, lanes, initial, DEFAULT_PARALLEL, now, 'allow').assignments.map(a => a.task_id), ['a', 'b', 'c']);
  assert.equal(JSON.stringify({ tasks, lanes, initial }), before);
  const acquired = acquireSlot(initial, DEFAULT_PARALLEL, 'fake', now)!;
  assert.deepEqual(releaseSlot(acquired, 'fake'), { ...initial, by_provider: { ...initial.by_provider, fake: 0 } });
  assert.throws(() => releaseSlot(initial, 'fake'));
  assert.throws(() => readyQueue([task('a', { depends_on: ['b'] }), task('b', { depends_on: ['a'] })]));
});
