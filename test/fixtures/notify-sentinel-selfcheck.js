// Explicit negative control, run separately from the zero-call default suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const moduleUrl = new URL('../../dist/src/notify/http.js', import.meta.url).href;
const script = `const { notifyFetchSentinelCalls } = await import(${JSON.stringify(moduleUrl)}); let threw = false; try { await fetch('http://127.0.0.1:0/sentinel-negative-control'); } catch { threw = true; } if (!threw || notifyFetchSentinelCalls() !== 1) process.stderr.write('sentinel invariant failed');`;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '' }, encoding: 'utf8' });
assert.equal(child.status, 1); // The exit listener also fails a caught forbidden call.
assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
console.log('fetch sentinel negative control passed (no network request)');
