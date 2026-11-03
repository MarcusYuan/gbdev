import assert from 'node:assert/strict';
import test from 'node:test';
import crypto, { randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createJobId } from '../src/core/ids.js';
import { uniqueJobIds } from './helpers/run.js';

for (const firstToFinish of [0, 1]) test(`run helper concurrent ID scopes restore only after last user (first=${firstToFinish})`, { concurrency: true }, async t => {
  const original = crypto.randomBytes;
  const calls: number[] = [];
  const delegate = ((size: number, callback?: (error: Error | null, buffer: Buffer) => void) => {
    calls.push(size);
    const bytes = Buffer.alloc(size, 0xa5);
    if (callback) { queueMicrotask(() => callback(null, bytes)); return; }
    return bytes;
  }) as typeof crypto.randomBytes;
  crypto.randomBytes = delegate; syncBuiltinESMExports();
  t.after(() => { crypto.randomBytes = original; syncBuiltinESMExports(); });
  const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const finish = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const ids: string[] = [], finalIds: string[] = [];
  const date = new Date(2026, 9, 29, 12, 34);
  const scopes = [0, 1].map(i => t.test(`scope ${i}`, async child => {
    if (i === 1) await ready[0]!.promise;
    // Exercise runFixture's ID helper alone: no unrelated Git/env globals.
    uniqueJobIds(child);
    ids[i] = createJobId(date);
    ready[i]!.resolve();
    await finish[i]!.promise;
    finalIds[i] = createJobId(date);
  }));
  try {
    await ready[1]!.promise;
    const installed = crypto.randomBytes;
    assert.notEqual(installed, delegate); assert.equal(randomBytes, installed);
    assert.deepEqual(ids, ['j_20261029_1234_0000', 'j_20261029_1234_0001']);
    assert.deepEqual(randomBytes(3), Buffer.from([0xa5, 0xa5, 0xa5]));
    const asyncBytes = await new Promise<Buffer>((resolve, reject) => {
      crypto.randomBytes(2, (error, bytes) => error ? reject(error) : resolve(bytes));
    });
    assert.deepEqual(asyncBytes, Buffer.from([0xa5, 0xa5]));
    assert.deepEqual(calls, [3, 2], 'only other sizes and callback calls reach the original');
    finish[firstToFinish]!.resolve(); await scopes[firstToFinish];
    assert.equal(finalIds[firstToFinish], 'j_20261029_1234_0002');
    assert.equal(crypto.randomBytes, installed); assert.equal(randomBytes, installed);
    const last = 1 - firstToFinish;
    finish[last]!.resolve(); await scopes[last];
    assert.equal(finalIds[last], 'j_20261029_1234_0003');
    assert.equal(new Set([...ids, ...finalIds]).size, 4);
    assert.equal(crypto.randomBytes, delegate); assert.equal(randomBytes, delegate);
    assert.equal(createJobId(date), 'j_20261029_1234_a5a5');
    assert.deepEqual(calls, [3, 2, 2], '2-byte ID entropy delegates again after final cleanup');
    await t.test('fresh scope restarts and restores', child => {
      uniqueJobIds(child);
      assert.equal(createJobId(date), 'j_20261029_1234_0000');
    });
    assert.equal(crypto.randomBytes, delegate); assert.equal(randomBytes, delegate);
  } finally {
    for (const gate of finish) gate.resolve();
    await Promise.all(scopes);
  }
});
