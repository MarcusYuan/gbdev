#!/usr/bin/env node
// Test-only executable. Sidecar control keeps production's strict env whitelist intact.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
let config = {};
try { config = JSON.parse(readFileSync(process.argv[1] + '.json', 'utf8')); } catch {}
const stateFile = process.env.FAKE_TMUX_STATE || config.state;
const logFile = process.env.FAKE_TMUX_LOG || config.log;
const mode = process.env.FAKE_TMUX_MODE || config.mode;
// Node on macOS creates this CoreFoundation bookkeeping variable at startup;
// it was not in spawn's environment (also checked via a native env probe).
const runtimeAdded = process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];
const argv = process.argv.slice(2);
if (logFile) appendFileSync(logFile, JSON.stringify({ argv, env: Object.keys(process.env).filter(k => !runtimeAdded.includes(k)).sort(), runtime_added_env: runtimeAdded.filter(k => process.env[k] !== undefined) }) + '\n');
if (mode === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (mode === 'missing' || mode === 'fail') { process.stderr.write('fake tmux unavailable\n'); process.exit(1); }
if (argv[0] === '-V') { console.log(mode === 'old-version' ? 'tmux 3.1c' : config.version || 'tmux 3.6a'); process.exit(0); }
let fd;
const lock = stateFile + '.lock';
for (let n = 0; ; n++) {
  try { fd = openSync(lock, 'wx'); break; } catch (e) { if (e.code !== 'EEXIST' || n >= 1000) throw e; await delay(5); }
}
let state = { sessions: {}, nextWindow: 1, nextPane: 1, splits: 0 }, exit = 0;
const outputs = [];
try {
  if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const commands = [[]]; for (const a of argv) { if (a === ';') commands.push([]); else commands.at(-1).push(a); }
  const fail = message => { throw new Error(message); };
  const allWindows = () => Object.values(state.sessions).flatMap(s => s.windows);
  const allPanes = () => allWindows().flatMap(w => w.panes);
  for (const args of commands) {
    const cmd = args[0], before = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
    const value = flag => before[before.indexOf(flag) + 1];
    const target = before.includes('-t') ? value('-t') : '';
    // tmux 3.6a: session targets accept =S, but option commands resolve a
    // target-pane (even session options), where the session part needs ':'.
    const paneTarget = ['set-option', 'show-options'].includes(cmd);
    if (paneTarget && /^=[^:]+$/.test(target)) fail('no such session: ' + target);
    const requested = target.replace(/^=/, '').replace(/:$/, '');
    const matches = Object.keys(state.sessions).filter(name => name.startsWith(requested));
    const name = !target.startsWith('=') && !state.sessions[requested] && matches.length === 1 ? matches[0] : requested;
    if (mode === 'foreign' && !state.sessions[name] && name) state.sessions[name] = { owner: '', options: {}, windows: [] };
    const session = state.sessions[name];
    const findWindow = () => allWindows().find(w => w.id === target || w.panes.some(p => p.id === target)) || session?.windows[0];
    const findPane = () => allPanes().find(p => p.id === target) || (paneTarget ? findWindow()?.panes[0] : undefined);
    const newPane = () => ({ id: '%' + state.nextPane++, key: '', dead: false, title: '', options: {}, argv: args.slice(args.indexOf('--') + 1), capture: config.capture || 'fake pane\n' });
    const newWindow = () => ({ id: '@' + state.nextWindow++, name: value('-n'), key: '', options: {}, panes: [newPane()] });
    if (cmd === 'has-session') { if (!session) fail("can't find session: " + name); }
    else if (cmd === 'new-session') {
      const name = value('-s'); if (state.sessions[name]) fail('duplicate session: ' + name);
      const w = newWindow(); state.sessions[name] = { owner: config.duplicateForeign ? '' : '', options: {}, windows: [w] };
      if (config.duplicateForeign) fail('duplicate session: ' + name);
      if (before.includes('-P')) outputs.push(w.id + '\t' + w.panes[0].id);
    } else if (cmd === 'new-window') { if (!session) fail('no session'); const w = newWindow(); session.windows.push(w); outputs.push(w.id + '\t' + w.panes[0].id); }
    else if (cmd === 'split-window') {
      state.splits++; if (config.noSpace === 'always' || (config.noSpace || []).includes(state.splits)) fail('no space for new pane');
      const w = findWindow(); if (!w || !findPane()) fail('no pane'); const p = newPane(); w.panes.push(p); outputs.push(p.id);
    } else if (cmd === 'respawn-pane') { const p = findPane(); if (!p) fail('no pane'); p.dead = false; p.argv = args.slice(args.indexOf('--') + 1); }
    else if (cmd === 'list-panes') {
      if (!session) fail('no session');
      for (const w of session.windows) for (const p of w.panes) outputs.push([w.id, p.id, p.key, p.dead ? '1' : '0'].join('\t'));
    } else if (cmd === 'set-option') {
      const [key, val] = args.slice(-2);
      if (config.failSetOption === key) fail('injected set-option failure: ' + key);
      // Fault injection, not normal tmux behavior: verify readback even if a
      // broken client reports success without applying one of the options.
      if (config.skipSetOption === key) continue;
      const item = before.includes('-p') ? findPane() : before.includes('-w') ? findWindow() : session || Object.values(state.sessions).find(s => s.windows.includes(findWindow()));
      if (!item) fail('no target'); item.options[key] = val;
      if (key === '@gbdev_owner') item.owner = val;
      if (key === '@gbdev_key') item.key = val;
    } else if (cmd === 'show-options') {
      const item = before.includes('-p') ? findPane() : before.includes('-w') ? findWindow() : session || Object.values(state.sessions).find(s => s.windows.includes(findWindow()));
      const option = args.at(-1), val = option === '@gbdev_owner' ? item?.owner : item?.options[option];
      if (!val) fail('invalid option'); outputs.push(val);
    }
    else if (cmd === 'select-pane') { const p = findPane(); if (!p) fail('no pane'); p.title = value('-T'); }
    else if (cmd === 'select-layout') { const w = findWindow(); if (!w) fail('no window'); w.layout = args.at(-1); }
    else if (cmd === 'kill-window') {
      if (!findWindow()) fail('no window');
      for (const [name, s] of Object.entries(state.sessions)) {
        if (!s.windows.some(w => w.id === target)) continue;
        s.windows = s.windows.filter(w => w.id !== target);
        // Like tmux, removing the last window also removes its session.
        if (!s.windows.length) delete state.sessions[name];
      }
    }
    else if (cmd === 'kill-session') { if (!session) fail('no session'); delete state.sessions[name]; }
    else if (cmd === 'capture-pane') { const p = findPane(); if (!p) fail('no pane'); outputs.push(p.capture); }
    else fail('unsupported command: ' + cmd);
  }
} catch (e) { process.stderr.write(e.message + '\n'); exit = 1; }
finally {
  writeFileSync(stateFile + '.tmp', JSON.stringify(state)); renameSync(stateFile + '.tmp', stateFile);
  closeSync(fd); unlinkSync(lock);
}
if (outputs.length) process.stdout.write(outputs.join('\n') + '\n');
process.exitCode = exit;
