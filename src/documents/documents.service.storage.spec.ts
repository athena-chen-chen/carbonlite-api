import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentsService } from './documents.service';
import { DocumentStorageNotFoundError, type DocumentStorage } from './document-storage';

function storageMock(): jest.Mocked<DocumentStorage> {
  return {
    save: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockResolvedValue(Buffer.from('stored')),
    exists: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue('DELETED'),
    verifyHealth: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DocumentsService storage lifecycle', () => {
  let directory: string;
  let path: string;
  let storage: jest.Mocked<DocumentStorage>;
  let tx: any;
  let prisma: any;
  let service: DocumentsService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'carbonlite-upload-'));
    path = join(directory, 'source.json');
    await writeFile(path, JSON.stringify([{ activityType: 'DIESEL', quantity: 1 }]));
    storage = storageMock();
    tx = {
      document: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'doc-a', ...data })),
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({ id: 'doc-a' }),
      },
      activityData: { count: jest.fn().mockResolvedValue(0) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      userActivityEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      document: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn() },
      $transaction: jest.fn((work) => work(tx)),
    };
    service = new DocumentsService(
      prisma,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { track: jest.fn().mockResolvedValue(undefined) } as never,
      storage,
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const uploadFile = () => ({
    path,
    size: 45,
    originalname: 'source.json',
    mimetype: 'application/json',
  } as Express.Multer.File);

  it('stores validated bytes before committing document metadata', async () => {
    const document = await service.upload('org-a', 'user-a', uploadFile());
    expect(storage.save).toHaveBeenCalledWith(expect.stringMatching(/^org-a\/.+\.json$/), expect.any(Buffer));
    expect(document.fileUrl).toMatch(/^\/uploads\/org-a\/.+\.json$/);
    expect(tx.document.create).toHaveBeenCalledTimes(1);
  });

  it('compensates stored bytes when the database transaction fails', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(service.upload('org-a', 'user-a', uploadFile())).rejects.toThrow('db unavailable');
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(/^org-a\//));
  });

  it('does not create metadata when durable save fails', async () => {
    storage.save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(service.upload('org-a', 'user-a', uploadFile())).rejects.toThrow('storage unavailable');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.document.create).not.toHaveBeenCalled();
  });

  it('authorizes before deleting source evidence and removes both evidence and metadata', async () => {
    const document = { id: 'doc-a', organizationId: 'org-a', fileName: 'source.json', fileUrl: '/uploads/org-a/key.json' };
    prisma.document.findUnique.mockResolvedValue(document);
    tx.document.findUnique.mockResolvedValue(document);
    await expect(service.remove('org-a', 'doc-a', 'user-a')).resolves.toMatchObject({
      deletedDocument: true, sourceEvidence: 'DELETED',
    });
    expect(storage.delete).toHaveBeenCalledWith('org-a/key.json');
    expect(tx.document.delete).toHaveBeenCalledWith({ where: { id: 'doc-a' } });
  });

  it('handles already-missing evidence and safely completes a retry', async () => {
    const document = { id: 'doc-a', organizationId: 'org-a', fileName: 'source.json', fileUrl: '/uploads/org-a/key.json' };
    prisma.document.findUnique.mockResolvedValue(document);
    tx.document.findUnique.mockResolvedValue(document);
    storage.delete.mockResolvedValueOnce('NOT_FOUND');
    await expect(service.remove('org-a', 'doc-a')).resolves.toMatchObject({
      deletedDocument: true, sourceEvidence: 'ALREADY_MISSING',
    });
  });

  it('safely retries when physical deletion succeeds before a database failure', async () => {
    const document = { id: 'doc-a', organizationId: 'org-a', fileName: 'source.json', fileUrl: '/uploads/org-a/key.json' };
    prisma.document.findUnique.mockResolvedValue(document);
    tx.document.findUnique.mockResolvedValue(document);
    prisma.$transaction
      .mockRejectedValueOnce(new Error('database commit failed'))
      .mockImplementationOnce((work: (client: typeof tx) => unknown) => work(tx));
    storage.delete.mockResolvedValueOnce('DELETED').mockResolvedValueOnce('NOT_FOUND');

    await expect(service.remove('org-a', 'doc-a')).rejects.toThrow('database commit failed');
    await expect(service.remove('org-a', 'doc-a')).resolves.toMatchObject({
      deletedDocument: true, sourceEvidence: 'ALREADY_MISSING',
    });
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('retains metadata and reports failure when physical deletion fails', async () => {
    prisma.document.findUnique.mockResolvedValue({
      id: 'doc-a', organizationId: 'org-a', fileName: 'source.json', fileUrl: '/uploads/org-a/key.json',
    });
    storage.delete.mockRejectedValueOnce(new Error('mount read-only'));
    await expect(service.remove('org-a', 'doc-a')).rejects.toThrow('retained for a safe retry');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.document.delete).not.toHaveBeenCalled();
  });

  it('never accesses another tenant storage key for download or deletion', async () => {
    prisma.document.findUnique.mockResolvedValue({
      id: 'doc-b', organizationId: 'org-b', fileName: 'secret.json', fileUrl: '/uploads/org-b/secret.json', mimeType: 'application/json',
    });
    await expect(service.getDownloadFile('org-a', 'doc-b')).rejects.toThrow('cannot view');
    await expect(service.remove('org-a', 'doc-b')).rejects.toThrow('cannot delete');
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('returns controlled behavior when metadata exists but physical evidence is missing', async () => {
    prisma.document.findUnique.mockResolvedValue({
      id: 'doc-a', organizationId: 'org-a', fileName: 'source.json', fileUrl: '/uploads/org-a/key.json', mimeType: 'application/json',
    });
    storage.read.mockRejectedValueOnce(new DocumentStorageNotFoundError('org-a/key.json'));
    await expect(service.getDownloadFile('org-a', 'doc-a')).rejects
      .toThrow('Uploaded file is no longer available');
  });
});
