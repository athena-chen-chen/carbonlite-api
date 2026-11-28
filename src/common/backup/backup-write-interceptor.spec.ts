import { Controller, Delete, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { FilesystemDocumentStorage } from '../../documents/filesystem-document-storage';
import { BackupWriteInterceptor } from './backup-write-interceptor';
import { backupWriteGate } from './backup-write-gate';

function latch() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { open, wait };
}

it('keeps disconnected HTTP writes in the drain until actual storage work settles', async () => {
  const root = await mkdtemp('/tmp/cl-bkh-');
  const storage = new FilesystemDocumentStorage({ NODE_ENV: 'test', DOCUMENT_STORAGE_PATH: root });
  const uploadEntered = latch();
  const deleteEntered = latch();
  const uploadFinish = latch();
  const deleteFinish = latch();
  const lease = {};
  let app: INestApplication | undefined;
  let paused = false;
  const existing = 'documents/old.txt';
  const newFile = 'documents/new.txt';
  const intent = '5c6fcd76-8aee-4f80-808e-8b0a00edb1be';

  @Controller('documents')
  class FixtureController {
    @Post()
    async upload() {
      uploadEntered.open();
      await uploadFinish.wait;
      await storage.save(newFile, Buffer.from('synthetic'));
    }

    @Delete()
    async quarantine() {
      deleteEntered.open();
      await deleteFinish.wait;
      return storage.quarantine(existing, intent);
    }
  }

  try {
    await storage.verifyHealth();
    await storage.save(existing, Buffer.from('historical'));
    const module = await Test.createTestingModule({ controllers: [FixtureController] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new BackupWriteInterceptor());
    await app.listen(0, '127.0.0.1');
    const url = (await app.getUrl()) + '/documents';
    const client = new AbortController();
    const disconnected = fetch(url, { method: 'POST', signal: client.signal }).catch(() => undefined);
    const deletion = fetch(url, { method: 'DELETE' });
    await Promise.all([uploadEntered.wait, deleteEntered.wait]);
    client.abort();
    await disconnected;

    const drained = backupWriteGate.acquire(lease);
    expect(drained).toBeDefined();
    paused = true;
    expect((await fetch(url, { method: 'POST' })).status).toBe(503);
    expect(backupWriteGate.ready(lease)).toBe(false);
    deleteFinish.open();
    const response = await deletion;
    expect(response.status).toBe(200);
    const result = await response.json() as { quarantineKey: string };
    expect(await storage.quarantineExists(result.quarantineKey)).toBe(true);
    expect(backupWriteGate.ready(lease)).toBe(false);
    uploadFinish.open();
    await drained;
    expect(backupWriteGate.ready(lease)).toBe(true);
    expect(await storage.read(newFile)).toEqual(Buffer.from('synthetic'));
    expect(backupWriteGate.release(lease)).toBe(true);
    paused = false;
    expect((await fetch(url, { method: 'POST' })).status).toBe(201);
  } finally {
    uploadFinish.open();
    deleteFinish.open();
    if (paused) backupWriteGate.release(lease);
    await app?.close();
    await rm(root, { recursive: true });
  }
});
