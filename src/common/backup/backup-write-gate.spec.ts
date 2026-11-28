import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BackupWriteGate } from './backup-write-gate';
import { openBackupLeaseSocket } from './backup-lease-socket';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('private backup capture lease', () => {
  let root: string;
  let directory: string;
  let gate: BackupWriteGate;
  let close: () => Promise<void>;

  beforeEach(async () => {
    root = await mkdtemp('/tmp/cl-bkg-');
    directory = join(root, 'carbonlite-backup-control');
    gate = new BackupWriteGate();
    close = await openBackupLeaseSocket(directory, gate, undefined, 200, 300);
  });

  afterEach(async () => {
    await close?.();
    await rm(root, { recursive: true });
  });

  function client() {
    const socket = connect(join(directory, 'lease.sock'));
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
    return { socket, line: async () => (await lines.next()).value };
  }

  it('drains overlapping writes and quarantine, excludes a second lease and reopens after capture', async () => {
    const uploadPath = join(root, 'upload');
    const source = join(root, 'existing');
    const quarantine = join(root, 'quarantine');
    await writeFile(source, 'before');
    const upload = deferred();
    const deletion = deferred();
    const writes = Promise.all([
      gate.run(async () => { await upload.promise; await writeFile(uploadPath, 'after'); }),
      gate.run(async () => { await deletion.promise; await gate.run(() => rename(source, quarantine)); }),
    ]);
    const capture = client();
    expect(await capture.line()).toBe('DRAINING');
    const ready = capture.line();
    await expect(gate.run(() => writeFile(source, 'unexpected'))).rejects.toThrow();
    const competitor = client();
    expect(await competitor.line()).toBe('BUSY');
    upload.resolve();
    deletion.resolve();
    await writes;
    expect(await ready).toBe('READY');
    expect(await readFile(uploadPath, 'utf8')).toBe('after');
    expect(await readFile(quarantine, 'utf8')).toBe('before');
    await expect(gate.run(() => rm(quarantine))).rejects.toThrow();
    capture.socket.write('COMPLETE\n');
    expect(await capture.line()).toBe('COMPLETE');
    await gate.run(() => rm(quarantine));
  });

  it('invalidates interrupted and expired leases and permits subsequent writes', async () => {
    const lost = client();
    expect(await lost.line()).toBe('DRAINING');
    expect(await lost.line()).toBe('READY');
    lost.socket.end();
    expect(await lost.line()).toBe('INTERRUPTED');
    await expect(gate.run(() => mkdir(join(root, 'reopened')))).resolves.toBeUndefined();
    const expired = client();
    expect(await expired.line()).toBe('DRAINING');
    expect(await expired.line()).toBe('READY');
    expect(await expired.line()).toBe('LEASE_EXPIRED');
    await expect(gate.run(() => mkdir(join(root, 'expired')))).resolves.toBeUndefined();
  });

  it('does not permit capture if an admitted operation has not finished draining', async () => {
    const pending = deferred();
    const write = gate.run(() => pending.promise);
    const capture = client();
    expect(await capture.line()).toBe('DRAINING');
    expect(await capture.line()).toBe('DRAIN_TIMEOUT');
    pending.resolve();
    await write;
    await expect(gate.run(() => mkdir(join(root, 'resumed')))).resolves.toBeUndefined();
  });
});
