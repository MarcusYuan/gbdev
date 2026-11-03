import './helpers/notifyGuard.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from './helpers.js';
import { testEnv } from './helpers/run.js';
import { JobStore } from '../src/core/jobStore.js';
import { resolvePaths } from '../src/core/paths.js';
import { localIso } from '../src/core/time.js';
import { runCli } from '../src/cli.js';
import { updateDeliveryState } from '../src/notify/state.js';
import { notifyHintText } from '../src/notify/status.js';
import type { NotifyActionOptions } from '../src/commands/notifyActions.js';

const stamp = (n: number) => localIso(new Date(n));
function bytes(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [key, value] of Object.entries(bytes(path))) result[`${entry.name}/${key}`] = value;
    else result[entry.name] = readFileSync(path).toString('base64');
  }
  return result;
}
function setup(t: TestContext) {
  const root = temporary(t), paths = resolvePaths({ GBDEV_HOME: join(root, 'home'), GBDEV_CONFIG: join(root, 'config.json') });
  mkdirSync(paths.home); const secrets = join(root, 'secrets'); mkdirSync(secrets, { mode: 0o700 });
  const key = 'GBDEVTESTKEY-s5-human-hints', file = join(secrets, 'secret.json');
  writeFileSync(file, JSON.stringify({ schema: 'gbdev.notify-secret.v1', url: 'https://example.invalid/webhook', key }), { mode: 0o600 });
  writeFileSync(paths.config, JSON.stringify({ version: 1, notify: { enabled: true, secret_file: file, key_name: 'X-Example-Key' } }));
  testEnv(t, { GBDEV_HOME: paths.home, GBDEV_CONFIG: paths.config });
  const options: NotifyActionOptions = { env: { NODE_TEST_CONTEXT: 'child', GBDEV_NOTIFY_TEST: '1' }, launch: () => assert.fail('empty queue must not launch'), delivery: { post: async () => { throw new Error('No network permitted'); } } };
  const cli = async (args: string[]) => {
    let output = '';
    const code = await runCli(['notify', ...args, '--json'], { stdout: s => { output += s; }, stderr: s => assert.fail(s), notifyActions: options });
    return { code, output, result: JSON.parse(output).result };
  };
  return { paths, key, options, cli, store: new JobStore(paths), now: () => Date.now() };
}

for (const [reason, http_status, recovery] of [
  ['paused_auth_rejected', 401, '复制新密钥'],
  ['paused_endpoint_gone', 404, '重新创建 routine'],
  ['paused_redirect_refused', 302, '核对 routine URL'],
] as const) for (const sub of ['status', 'flush']) test(`S5 nit ${sub} ${reason} has recovery text, unchanged JSON`, async t => {
  const f = setup(t); mkdirSync(join(f.paths.home, 'notify'));
  await updateDeliveryState(f.store, { paused: { reason, at: stamp(f.now()), http_status } });
  const before = await f.cli([sub]); assert.equal(before.code, 0);
  assert.equal(before.result.enabled, true); assert.equal(before.result.reason, reason);
  assert.equal(before.result.init.state, 'paused');
  const disk = bytes(f.paths.home); let output = '';
  const code = await runCli(['notify', sub], { stdout: s => { output += s; }, stderr: s => assert.fail(s), notifyActions: f.options });
  assert.equal(code, 0); assert.match(output, /通知状态：paused/); assert.match(output, /通知已暂停/);
  assert.ok(output.includes(recovery)); assert.match(output, /gbdev notify setup/); assert.match(output, /gbdev notify flush --retry-auth/);
  assert.doesNotMatch(output, /通知未开启/); assert.ok(!output.includes(f.key));
  assert.deepEqual(bytes(f.paths.home), disk); assert.equal((await f.cli([sub])).output, before.output);
});
test('S5 nit enabled secret failures are unavailable, only disabled hints say not enabled', () => {
  for (const reason of ['secret_missing', 'secret_unsafe', 'secret_unsupported', 'key_name_missing', 'url_invalid'] as const) {
    const text = notifyHintText({ notify: { enabled: true, reason, endpoint_host: null } });
    assert.match(text, /通知暂不可用/); assert.doesNotMatch(text, /通知未开启/);
  }
  assert.equal(notifyHintText({ notify: { enabled: false, reason: 'disabled_by_config', endpoint_host: null } }), '通知未开启（disabled_by_config）\n');
  assert.equal(notifyHintText({}), '');
});
