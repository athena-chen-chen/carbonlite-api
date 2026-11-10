import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FilesystemDocumentStorage,
  resolveDocumentStorageConfiguration,
} from './filesystem-document-storage';
import {
  DocumentStorageNotFoundError,
  isVirtualSpreadsheetSourceUrl,
} from './document-storage';

describe('FilesystemDocumentStorage', () => {
  it('distinguishes virtual spreadsheet sources from managed storage URLs', () => {
    expect(isVirtualSpreadsheetSourceUrl('spreadsheet-import://batch-1')).toBe(true);
    expect(isVirtualSpreadsheetSourceUrl('/uploads/org-a/source.xlsx')).toBe(false);
  });

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

  it('moves evidence to private same-root quarantine idempotently', async () => {
    const storage = new FilesystemDocumentStorage({ NODE_ENV: 'test', DOCUMENT_STORAGE_PATH: root });
    await storage.verifyHealth();
    await storage.save('org-a/source.pdf', Buffer.from('evidence'));
    const first = await storage.quarantine('org-a/source.pdf', 'intent_1');
    expect(first).toEqual({ result: 'MOVED', quarantineKey: '.quarantine/intent_1/source.pdf' });
    expect(await storage.exists('org-a/source.pdf')).toBe(false);
    expect(await storage.quarantineExists(first.quarantineKey)).toBe(true);
    await expect(storage.read(first.quarantineKey)).rejects.toThrow('Quarantine storage is not available');
    await expect(storage.quarantine('org-a/source.pdf', 'intent_1')).resolves.toMatchObject({
      result: 'ALREADY_QUARANTINED',
    });
    expect(await storage.purgeQuarantine(first.quarantineKey)).toBe('DELETED');
  });

  it('rejects path traversal', async () => {
    const storage = new FilesystemDocumentStorage({ NODE_ENV: 'test', DOCUMENT_STORAGE_PATH: root });
    await expect(storage.save('../other/evidence', Buffer.from('no'))).rejects.toThrow('Invalid document storage key');
  });

  it('rejects symlink escapes for active and quarantine operations', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'carbonlite-outside-'));
    const storage = new FilesystemDocumentStorage({ NODE_ENV: 'test', DOCUMENT_STORAGE_PATH: root });
    await storage.verifyHealth();
    await symlink(outside, join(root, 'escape'));
    await expect(storage.save('escape/evidence.pdf', Buffer.from('no'))).rejects.toThrow('Symbolic links');
    await rm(outside, { recursive: true, force: true });
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

  it.each([
    [{ APP_ENV: 'staging', NODE_ENV: 'production' }],
    [{ APP_ENV: 'production', NODE_ENV: 'development' }],
    [{}],
    [{ APP_ENV: 'prodution' }],
    [{ APP_ENV: 'staging' }],
  ])('requires durable storage for non-local runtime %p', environment => {
    expect(() => resolveDocumentStorageConfiguration(environment)).toThrow(
      'Durable document storage is required',
    );
  });

  it('accepts explicit durable storage in staging', () => {
    expect(
      resolveDocumentStorageConfiguration({
        APP_ENV: 'staging',
        DOCUMENT_STORAGE_PATH: root,
        DOCUMENT_STORAGE_DURABLE: 'true',
      }),
    ).toMatchObject({ rootPath: root, durable: true, runtime: 'staging' });
  });

  it('preserves the explicit local development storage default', () => {
    expect(
      resolveDocumentStorageConfiguration({ APP_ENV: 'local' }),
    ).toMatchObject({ durable: false, runtime: 'local' });
  });
});
