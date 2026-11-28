import { lstat, mkdir, rmdir } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BackupWriteGate, backupWriteGate } from './backup-write-gate';

export async function openBackupLeaseSocket(
  directory: string,
  gate: BackupWriteGate = backupWriteGate,
  report: (result: string) => void = () => {},
  drainMs = 15_000,
  leaseMs = 90_000,
) {
  if (!isAbsolute(directory) || basename(directory) !== 'carbonlite-backup-control') {
    throw new Error('Invalid backup control directory');
  }
  const parent = await lstat(dirname(directory));
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 &&
      !((parent.mode & 0o1000) !== 0 && parent.uid === 0)) {
    throw new Error('Unsafe backup control parent');
  }
  // Exclusive creation refuses stale or substituted directories. This socket
  // is reachable only by the service identity and trusted host operators.
  await mkdir(directory, { mode: 0o700 });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    const drained = gate.acquire(socket);
    if (!drained) {
      socket.end('BUSY\n');
      return;
    }

    const started = performance.now();
    let deadline = started + drainMs;
    let ready = false;
    let retired = false;
    let input = '';
    const finish = (result: string) => {
      if (retired) return;
      retired = true;
      clearTimeout(timer);
      gate.release(socket);
      report(result);
      if (!socket.destroyed) socket.end(result + '\n');
    };
    let timer = setTimeout(() => finish('DRAIN_TIMEOUT'), drainMs);
    socket.once('end', () => finish('INTERRUPTED'));
    socket.once('close', () => finish('INTERRUPTED'));
    socket.on('data', data => {
      input += data.toString('ascii');
      if (input.length > 9 || !'COMPLETE\n'.startsWith(input) || !ready) {
        finish('INVALID_REQUEST');
      } else if (input === 'COMPLETE\n') {
        finish(performance.now() < deadline && gate.ready(socket) ? 'COMPLETE' : 'LEASE_INVALID');
      }
    });

    socket.write('DRAINING\n');
    void drained.then(() => {
      if (retired) return;
      if (performance.now() >= deadline || !gate.ready(socket)) {
        finish('DRAIN_TIMEOUT');
        return;
      }
      ready = true;
      clearTimeout(timer);
      deadline = performance.now() + leaseMs;
      timer = setTimeout(() => finish('LEASE_EXPIRED'), leaseMs);
      report('READY');
      socket.write('READY\n');
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(directory, 'lease.sock'), () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await rmdir(directory);
    throw error;
  }

  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    await rmdir(directory);
  };
}
