import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { configuration, RELEASE_SHA, SHUTDOWN_MS } from '../scripts/inert-maintenance.mjs';

const script = fileURLToPath(new URL('../scripts/inert-maintenance.mjs', import.meta.url));
const observer = fileURLToPath(new URL('./helpers/inert-maintenance-observer.mjs', import.meta.url));
const base = {
  APP_ENV: 'test', NODE_ENV: 'test', MAINTENANCE_GATE_MODE: 'disposable-local-v1',
  RENDER_SERVICE_ID: 'srv-disposable-maintenance', RENDER_GIT_BRANCH: 'disposable-maintenance',
  RENDER_GIT_COMMIT: 'a'.repeat(40), MAINTENANCE_APPROVED_DEPLOYMENT_SHA: 'a'.repeat(40),
  MAINTENANCE_RELEASE_SHA: RELEASE_SHA, MAINTENANCE_LIVENESS_PATH: '/api/health/live',
  MAINTENANCE_APPROVAL_REFERENCE: 'synthetic-local-rehearsal',
};
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function launch(t, overrides = {}, cwd) {
  const selected = String(await port());
  // No inherited credentials, URLs, NODE_OPTIONS or application settings.
  const env = { ...base, PORT: selected, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(process.execPath, ['--import', observer, script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = []; let output = ''; let errors = '';
  child.on('message', message => messages.push(message));
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (output.includes('MAINTENANCE_GATE_READY')) resolve(); });
    child.once('exit', () => reject(new Error('Exited before listening')));
  });
  // Invalid-identity tests deliberately await exit rather than readiness.
  ready.catch(() => undefined);
  async function snapshot() {
    const received = new Promise(resolve => { const handler = message => { if (message.kind === 'snapshot') { child.off('message', handler); resolve(message); } }; child.on('message', handler); });
    child.send('snapshot'); return received;
  }
  return { child, exited, ready, port: Number(selected), messages, snapshot, output: () => output, errors: () => errors };
}
function request(portNumber, path, method = 'GET', extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: portNumber, path, method, agent: false, ...extra }, res => {
      let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}
async function stop(run) { run.child.kill('SIGTERM'); const [code, signal] = await run.exited; assert.equal(code, 0); assert.equal(signal, null); }

test('valid disposable identity serves only configured liveness and denies every tested method/route', { timeout: 10000 }, async t => {
  const run = await launch(t); await run.ready;
  for (const method of ['GET', 'HEAD']) assert.equal((await request(run.port, '/api/health/live', method)).status, 200);
  for (const path of ['/', '/api/health/ready', '/api/auth/login', '/api/document-extraction/extract', '/api/document-extraction/confirm', '/api/admin/organizations/synthetic/ai-authorization', '/api/health/live?x=1', '/api/health/live/', '/api/%68ealth/live']) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await request(run.port, path, method);
      assert.equal(response.status, 503, `${method} ${path}`); assert.equal(response.headers['cache-control'], 'no-store');
    }
  }
  assert.equal((await request(run.port, '/api/health/live', 'POST')).status, 503);
  assert.equal((await request(run.port, 'http://private.invalid/api/document-extraction/extract', 'POST', { headers: { host: 'private.internal', authorization: 'synthetic-secret-do-not-log' } })).status, 503);
  assert.equal((await request(run.port, '/api/document-extraction/extract', 'POST', { headers: { host: 'localhost' } })).status, 503);
  for (const raw of ['CONNECT private.internal:443 HTTP/1.1\r\nHost: private.internal\r\n\r\n', 'GET /api/health/live HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n']) {
    const socket = net.connect(run.port, '127.0.0.1'); socket.setEncoding('utf8');
    let received = ''; socket.on('data', chunk => { received += chunk; });
    await once(socket, 'connect'); socket.end(raw); await once(socket, 'close');
    assert.match(received, /^HTTP\/1\.1 503 /);
  }
  assert.deepEqual((await run.snapshot()).violations, []); await stop(run);
  assert.equal(run.output(), 'MAINTENANCE_GATE_READY\n'); assert.equal(run.errors(), '');
});

for (const [label, overrides] of [
  ['missing service', { RENDER_SERVICE_ID: undefined }], ['wrong service', { RENDER_SERVICE_ID: 'srv-other' }],
  ['missing SHA', { RENDER_GIT_COMMIT: undefined }], ['wrong SHA', { RENDER_GIT_COMMIT: 'b'.repeat(40) }],
  ['missing approved SHA', { MAINTENANCE_APPROVED_DEPLOYMENT_SHA: undefined }], ['wrong release', { MAINTENANCE_RELEASE_SHA: 'b'.repeat(40) }],
  ['missing mode', { MAINTENANCE_GATE_MODE: undefined }], ['conflicting Render/local', { RENDER: 'true' }],
  ['wrong liveness', { MAINTENANCE_LIVENESS_PATH: '/api/admin' }], ['missing port', { PORT: undefined }],
  ['wildcard port', { PORT: '0' }], ['invalid port', { PORT: '65536' }],
]) test(`activation rejects ${label} before listen`, { timeout: 5000 }, async t => {
  const run = await launch(t, overrides); const [code] = await run.exited;
  assert.equal(code, 78); assert.equal(run.messages.some(message => message.kind === 'listen'), false);
  assert.equal(run.output(), ''); assert.equal(run.errors(), 'MAINTENANCE_ACTIVATION_REFUSED\n');
});

test('RC binding validates real identity shape without listening or inventing approval', () => {
  const env = { ...base, PORT: '10000', MAINTENANCE_GATE_MODE: 'clean-rc-v1', RENDER: 'true', APP_ENV: 'rc', NODE_ENV: 'production',
    RENDER_SERVICE_ID: 'srv-dbtppde7bikc73fcg2j0', RENDER_GIT_BRANCH: 'release/phase2-real-data-rc', MAINTENANCE_APPROVAL_REFERENCE: 'REHEARSAL-NOT-OPERATOR-APPROVAL' };
  // Pure validation only; this string is not an approval for live activation.
  assert.equal(configuration(env).host, '0.0.0.0');
  for (const patch of [{ RENDER_SERVICE_ID: 'srv-other' }, { APP_ENV: 'production' }, { RENDER_GIT_BRANCH: 'main' }, { RENDER: undefined }, { MAINTENANCE_APPROVAL_REFERENCE: undefined }, { MAINTENANCE_APPROVAL_REFERENCE: 'synthetic-local-rehearsal' }]) assert.throws(() => configuration({ ...env, ...patch }), /refused/);
});

test('minimal import graph, repeated starts and maintenance-only rollback preserve disposable data; no outbound calls', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'carbonlite-inert-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'synthetic-records.json'), '{"users":2,"grants":0}');
  await writeFile(join(directory, 'synthetic-document.bin'), Buffer.from([0, 1, 2, 255]));
  const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, (await readFile(join(directory, name))).toString('hex')])));
  const before = await snapshot();
  const source = await readFile(script, 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';/gm)].map(match => match[1]), ['node:http', 'node:url']);
  assert.doesNotMatch(source, /\brequire\s*\(|\bimport\s*\(|\bfetch\s*\(/);
  for (let attempt = 0; attempt < 3; attempt++) {
    const run = await launch(t, {}, directory); await run.ready;
    assert.equal((await request(run.port, '/api/health/ready')).status, 503);
    assert.deepEqual((await run.snapshot()).violations, []); await stop(run);
    assert.deepEqual(await snapshot(), before);
    if (attempt === 0) {
      // Failed replacement must not touch data; next iteration starts the known-good inert artifact.
      const refused = await launch(t, { RENDER_GIT_COMMIT: 'b'.repeat(40) }, directory);
      assert.equal((await refused.exited)[0], 78); assert.deepEqual(await snapshot(), before);
    }
    const probe = net.createServer(); probe.listen(run.port, '127.0.0.1'); await once(probe, 'listening'); await new Promise(resolve => probe.close(resolve));
  }
});

test('occupied configured port fails without trying an alternative port', { timeout: 5000 }, async t => {
  const blocker = net.createServer(); blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const run = await launch(t, { PORT: String(blocker.address().port) });
  assert.equal((await run.exited)[0], 1); assert.equal(run.errors(), 'MAINTENANCE_LISTEN_FAILED\n');
  assert.equal(run.output(), ''); assert.equal(run.messages.filter(message => message.kind === 'listen').length, 1);
});

test('SIGTERM bounds shutdown with an unfinished HTTP connection', { timeout: 6000 }, async t => {
  const run = await launch(t); await run.ready;
  const connection = new Promise(resolve => { const handler = message => { if (message.kind === 'connection') { run.child.off('message', handler); resolve(); } }; run.child.on('message', handler); });
  const socket = net.connect(run.port, '127.0.0.1'); t.after(() => socket.destroy());
  socket.on('error', () => undefined); await once(socket, 'connect'); socket.write('GET / HTTP/1.1\r\n'); await connection;
  const started = performance.now(); await stop(run);
  assert.ok(performance.now() - started < SHUTDOWN_MS + 1000, 'bounded forced shutdown');
});
