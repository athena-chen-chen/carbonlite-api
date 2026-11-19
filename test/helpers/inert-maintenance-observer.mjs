// Disposable subprocess instrumentation only; never used by the Render command.
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import Module from 'node:module';
const violations = [];
function block(label) {
  return () => { violations.push(label); throw new Error('Forbidden rehearsal operation'); };
}
for (const name of ['writeFile', 'appendFile', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir', 'rename', 'copyFile', 'cp', 'chmod', 'chown', 'link', 'symlink', 'utimes', 'write', 'writev', 'createWriteStream']) {
  if (fs[name]) fs[name] = block(`fs.${name}`);
  if (fs[`${name}Sync`]) fs[`${name}Sync`] = block(`fs.${name}Sync`);
  if (fs.promises[name]) fs.promises[name] = block(`fs.promises.${name}`);
}
const open = fs.open;
const openSync = fs.openSync;
const promiseOpen = fs.promises.open;
const writable = flags => typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : flags !== 'r';
fs.open = function(path, flags, ...args) { if (writable(flags)) return block('fs.open-write')(); return open.call(this, path, flags, ...args); };
fs.openSync = function(path, flags, ...args) { if (writable(flags)) return block('fs.openSync-write')(); return openSync.call(this, path, flags, ...args); };
fs.promises.open = function(path, flags, ...args) { if (writable(flags)) return block('fs.promises.open-write')(); return promiseOpen.call(this, path, flags, ...args); };
net.Socket.prototype.connect = block('outbound-connect');
tls.connect = block('tls-connect');
dns.resolve = block('dns-resolve');
globalThis.fetch = block('fetch');
const load = Module._load;
Module._load = function(request, ...args) {
  if (/prisma|openai|dist\/main|src\/app\.module/.test(request)) return block('application-or-provider-import')();
  return load.call(this, request, ...args);
};
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  process.send?.({ kind: 'listen' });
  this.on('connection', () => process.send?.({ kind: 'connection' }));
  return originalListen.apply(this, args);
};
process.on('message', message => {
  if (message === 'snapshot') process.send?.({ kind: 'snapshot', violations });
});
Module.syncBuiltinESMExports();
