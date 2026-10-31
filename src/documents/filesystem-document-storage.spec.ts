import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FilesystemDocumentStorage,
  resolveDocumentStorageConfiguration,
} from './filesystem-document-storage';
import { DocumentStorageNotFoundError } from './document-storage';

describe('FilesystemDocumentStorage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'carbonlite-storage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('supports local save/read/exists/delete and idempotent missing deletion', async () => {
    const storage = new FilesystemDocumentStorage({
      NODE_ENV: 'development',
      DOCUMENT_STORAGE_PATH: root,
    });
    await storage.verifyHealth();
    await storage.save('org-a/source.pdf', Buffer.from('evidence'));
    expect(await storage.exists('org-a/source.pdf')).toBe(true);
    expect(await storage.read('/uploads/org-a/source.pdf')).toEqual(Buffer.from('evidence'));
    expect(await readFile(join(root, 'org-a/source.pdf'), 'utf8')).toBe('evidence');
    expect(await storage.delete('org-a/source.pdf')).toBe('DELETED');
    expect(await storage.delete('org-a/source.pdf')).toBe('NOT_FOUND');
    await expect(storage.read('org-a/source.pdf')).rejects.toBeInstanceOf(DocumentStorageNotFoundError);
  });

  it('rejects path traversal', async () => {
    const storage = new FilesystemDocumentStorage({ NODE_ENV: 'test', DOCUMENT_STORAGE_PATH: root });
    await expect(storage.save('../other/evidence', Buffer.from('no'))).rejects.toThrow('Invalid document storage key');
  });

  it('fails closed in production without explicit durable configuration', () => {
    expect(() => resolveDocumentStorageConfiguration({ NODE_ENV: 'production' }))
      .toThrow('Durable document storage is required');
    expect(() => resolveDocumentStorageConfiguration({
      APP_ENV: 'paid-pilot', DOCUMENT_STORAGE_PATH: root,
    })).toThrow('Durable document storage is required');
    expect(resolveDocumentStorageConfiguration({
      NODE_ENV: 'production', DOCUMENT_STORAGE_PATH: root, DOCUMENT_STORAGE_DURABLE: 'true',
    }).rootPath).toBe(root);
  });
});
