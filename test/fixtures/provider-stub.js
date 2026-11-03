// Copied into an isolated temp directory with a Node shebang by tests.
// This is not a model client and performs no network or credential access.
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.GBDEV_STUB_LOG) appendFileSync(process.env.GBDEV_STUB_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
if (args[0] === '--version') {
  console.log('provider-stub 1.0');
} else if (args[0] === 'login' && args[1] === 'status') {
  console.error('Logged in using ChatGPT');
  console.error('second line should not be included');
  process.exitCode = Number(process.env.GBDEV_STUB_LOGIN_EXIT ?? 0);
} else if (args[0] === 'status') {
  // Ensure diagnostic callers do not leak authentication output into their JSON.
  console.log('private authentication output must be discarded');
  console.error('private authentication stderr must be discarded');
  process.exitCode = Number(process.env.GBDEV_STUB_LOGIN_EXIT ?? 0);
} else {
  if (process.env.GBDEV_STUB_TRUST_ERROR === '1') {
    console.error('⚠ Workspace Trust Required … Pass --trust, --yolo, or -f');
    process.exit(1);
  }
  if (process.env.GBDEV_STUB_TRUST_LOG === '1') console.error('Workspace Trust Required');
  process.exitCode = Number(process.env.GBDEV_STUB_EXIT ?? 0);
  const report = process.env.GBDEV_STUB_REPORT ? JSON.parse(process.env.GBDEV_STUB_REPORT) : { schema: 'gbdev.worker-result.v1', status: 'succeeded', summary: 'Stub completed',
    files_changed: [], commits: [], tests: [], evidence: [], open_questions: [], blockers: [], policy_violations: [] };
  const message = `Stub result.\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`;
  if (args[0] === 'exec') {
    if (process.env.GBDEV_STUB_CODEX_ERROR) {
      console.log(JSON.stringify({ type: 'turn.failed', error: { message: process.env.GBDEV_STUB_CODEX_ERROR } }));
      process.exit(Number(process.env.GBDEV_STUB_EXIT ?? 1));
    }
    const output = args.indexOf('--output-last-message');
    if (output < 0 || !args.includes('--json')) throw new Error('Missing codex output flags');
    writeFileSync(args[output + 1], JSON.stringify(report));
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'stub-thread-id' }));
    console.log(JSON.stringify({ type: 'stub.done' }));
  } else {
    if (args[0] !== '-p' || args[args.indexOf('--sandbox') + 1] !== 'enabled') throw new Error('Missing Cursor sandbox');
    if (process.env.GBDEV_STUB_JSONL === '1') console.log(JSON.stringify({ type: 'system', session_id: 'earlier-session-id' }));
    console.log(JSON.stringify({ type: 'result', subtype: process.env.GBDEV_STUB_OMIT_SUBTYPE === '1' ? undefined : process.env.GBDEV_STUB_SUBTYPE ?? 'success', is_error: process.env.GBDEV_STUB_IS_ERROR === '1', duration_ms: 12, result: message, session_id: 'stub-session-id', request_id: 'stub-request-id', usage: {} }));
    if (process.env.GBDEV_STUB_JSONL === '1') console.log(JSON.stringify({ type: 'done', session_id: ' ' }));
  }
}
