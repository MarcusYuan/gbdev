import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
/** Loopback only. The request log deliberately contains credentials, and lives OUTSIDE GBDEV_HOME. */
export async function startNotifyServer({ responses = [], log, onRequest } = {}) {
  const requests = [], sockets = new Set(), timers = new Set(); let queue = [...responses];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = { headers: req.headers, body: JSON.parse(body), path: req.url };
    requests.push(request); if (log) writeFileSync(log, JSON.stringify(requests)); onRequest?.(request);
    const action = queue.shift() ?? { status: 200 };
    if (action.mode === 'disconnect') { req.socket.destroy(); return; }
    if (action.mode === 'hang') return;
    const respond = () => {
      res.writeHead(action.status ?? 200, { ...(action.retryAfter !== undefined ? { 'Retry-After': String(action.retryAfter) } : {}), ...(action.location ? { Location: action.location } : {}), ...(action.headers ?? {}) });
      if (action.mode === 'body-hang') { res.write('x'); return; }
      if (action.mode === 'body-disconnect') { res.write('x'); req.socket.destroy(); return; }
      res.end(action.body ?? 'ok');
    };
    if (action.mode === 'slow') { const timer = setTimeout(() => { timers.delete(timer); respond(); }, action.delay ?? 25); timers.add(timer); }
    else respond();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/webhook`, requests,
    program(actions) { queue = [...actions]; },
    async close() { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = await startNotifyServer({ log: process.argv[2], onRequest: request => process.send?.({ request }) });
  process.on('message', message => { if (message.responses) { stub.program(message.responses); process.send?.({ programmed: true }); } });
  process.once('SIGTERM', async () => { await stub.close(); process.exit(0); });
  process.send?.({ url: stub.url });
}
