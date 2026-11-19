import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const RELEASE_SHA = 'e3d2c608f805f1065eb0f944efd07c3003e1d2cb';
const SERVICE = 'srv-dbtppde7bikc73fcg2j0';
const LIVE_PATH = '/api/health/live';
export const SHUTDOWN_MS = 1000;
const refuse = () => { throw new Error('Maintenance activation refused.'); };

// Configuration assertions are operator bindings, not cryptographic approval.
// No application, dotenv, filesystem, database or provider module is loaded.
export function configuration(env) {
  if (env.MAINTENANCE_RELEASE_SHA !== RELEASE_SHA ||
      env.MAINTENANCE_LIVENESS_PATH !== LIVE_PATH ||
      !/^[1-9][0-9]{0,4}$/.test(env.PORT || '') || Number(env.PORT) > 65535) refuse();
  const approved = env.MAINTENANCE_APPROVED_DEPLOYMENT_SHA;
  if (!/^[a-f0-9]{40}$/.test(approved || '') || approved !== env.RENDER_GIT_COMMIT) refuse();
  let host;
  if (env.MAINTENANCE_GATE_MODE === 'clean-rc-v1') {
    if (env.APP_ENV !== 'rc' || env.NODE_ENV !== 'production' || env.RENDER !== 'true' ||
        env.RENDER_SERVICE_ID !== SERVICE ||
        env.RENDER_GIT_BRANCH !== 'release/phase2-real-data-rc' ||
        !/^[A-Za-z0-9][A-Za-z0-9:/.@_-]{7,159}$/.test(env.MAINTENANCE_APPROVAL_REFERENCE || '') ||
        /synthetic|fixture|example|test-only/i.test(env.MAINTENANCE_APPROVAL_REFERENCE)) refuse();
    host = '0.0.0.0';
  } else if (env.MAINTENANCE_GATE_MODE === 'disposable-local-v1') {
    if (env.APP_ENV !== 'test' || env.NODE_ENV !== 'test' || env.RENDER !== undefined ||
        env.RENDER_SERVICE_ID !== 'srv-disposable-maintenance' ||
        env.RENDER_GIT_BRANCH !== 'disposable-maintenance' ||
        approved !== 'a'.repeat(40) ||
        env.MAINTENANCE_APPROVAL_REFERENCE !== 'synthetic-local-rehearsal') refuse();
    host = '127.0.0.1';
  } else refuse();
  return { port: Number(env.PORT), host, livePath: LIVE_PATH };
}

export function start(env = process.env) {
  let config;
  try { config = configuration(env); }
  catch { console.error('MAINTENANCE_ACTIVATION_REFUSED'); process.exit(78); }
  const sockets = new Set();
  const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const live = (request.method === 'GET' || request.method === 'HEAD') && request.url === config.livePath;
    response.writeHead(live ? 200 : 503, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close',
    });
    response.end(live ? '{"status":"maintenance-live","applicationReady":false}' : '{"status":"maintenance","applicationReady":false}');
    request.resume();
  });
  server.requestTimeout = 1000;
  server.headersTimeout = 1000;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(1000, socket => socket.destroy());
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const denyProtocolSwitch = (_request, socket) => {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  };
  server.on('connect', denyProtocolSwitch);
  server.on('upgrade', denyProtocolSwitch);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      process.exit(0);
    }, SHUTDOWN_MS);
    server.close(() => { clearTimeout(deadline); process.exit(0); });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('error', () => {
    console.error('MAINTENANCE_LISTEN_FAILED');
    for (const socket of sockets) socket.destroy();
    process.exit(1);
  });
  server.listen(config.port, config.host, () => console.log('MAINTENANCE_GATE_READY'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
