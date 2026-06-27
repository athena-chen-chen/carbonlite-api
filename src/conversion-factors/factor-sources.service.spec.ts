import { BadRequestException } from '@nestjs/common';
import { PublisherType } from '@prisma/client';
import { FactorSourcesService } from './factor-sources.service';

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'source-1',
    sourceAuthority: 'Environment and Climate Change Canada',
    sourceShortName: 'ECCC',
    sourceDocument: 'Emission Factors and Reference Values',
    sourceVersion: '2025',
    sourceYear: 2025,
    sourceUrl: 'https://publications.gc.ca/collections/collection_2025/eccc/En84-294-2025-eng.pdf',
    page: '',
    tableReference: '',
    publishedDate: new Date('2025-01-01T00:00:00.000Z'),
    country: 'Canada',
    jurisdictionRegion: 'Canada',
    publisherType: PublisherType.GOVERNMENT,
    description: 'Official ECCC source fixture',
    notes: 'Seeded source only.',
    isOfficial: true,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    _count: { versions: 0 },
    ...overrides,
  };
}

function service(options: { existing?: unknown; usedByFactors?: number } = {}) {
  const existing = options.existing ?? source({ _count: { versions: options.usedByFactors ?? 0 } });
  const prisma = {
    factorSource: {
      findMany: jest.fn().mockResolvedValue([existing]),
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve(source({ ...data, id: 'created-source', _count: { versions: 0 } })),
      ),
      update: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...(existing as Record<string, unknown>), ...data }),
      ),
      delete: jest.fn().mockResolvedValue(existing),
    },
  } as never;
  const auditLog = { log: jest.fn().mockResolvedValue({ id: 'audit-1' }) } as never;

  return {
    factorSourcesService: new FactorSourcesService(prisma, auditLog),
    prisma: prisma as any,
    auditLog: auditLog as any,
  };
}

describe('FactorSourcesService', () => {
  it('creates an official government source', async () => {
    const { factorSourcesService, prisma, auditLog } = service();

    await expect(
      factorSourcesService.create(
        {
          sourceAuthority: 'Environment and Climate Change Canada',
          sourceShortName: 'ECCC',
          sourceDocument: 'Emission Factors and Reference Values',
          sourceVersion: '2025',
          sourceYear: 2025,
          sourceUrl: 'https://publications.gc.ca/collections/collection_2025/eccc/En84-294-2025-eng.pdf',
          publishedDate: '2025-01-01T00:00:00.000Z',
          publisherType: PublisherType.GOVERNMENT,
          isOfficial: true,
        },
        { userId: 'user-1', organizationId: 'org-1' },
      ),
    ).resolves.toMatchObject({
      sourceAuthority: 'Environment and Climate Change Canada',
      trustLabel: 'Government Official',
      isOfficial: true,
    });

    expect(prisma.factorSource.create).toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE_FACTOR_SOURCE' }));
  });

  it('rejects an official source without a URL', async () => {
    const { factorSourcesService } = service();

    await expect(
      factorSourcesService.create({
        sourceAuthority: 'Environment and Climate Change Canada',
        sourceDocument: 'Emission Factors and Reference Values',
        sourceYear: 2025,
        publisherType: PublisherType.GOVERNMENT,
        isOfficial: true,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('archives a source that is used by factor versions', async () => {
    const { factorSourcesService, prisma, auditLog } = service({ usedByFactors: 3 });

    await expect(factorSourcesService.remove('source-1')).resolves.toMatchObject({
      archived: true,
      deleted: false,
      usedByFactors: 3,
    });

    expect(prisma.factorSource.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
    expect(prisma.factorSource.delete).not.toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ARCHIVE_FACTOR_SOURCE' }));
  });

  it('hard deletes an unused source', async () => {
    const { factorSourcesService, prisma } = service({ usedByFactors: 0 });

    await expect(factorSourcesService.remove('source-1')).resolves.toMatchObject({
      archived: false,
      deleted: true,
      usedByFactors: 0,
    });

    expect(prisma.factorSource.delete).toHaveBeenCalledWith({ where: { id: 'source-1' } });
  });

  it('returns source usage count and trust label', async () => {
    const { factorSourcesService } = service({ usedByFactors: 2 });

    await expect(factorSourcesService.findAll()).resolves.toMatchObject({
      items: [
        {
          usedByFactors: 2,
          trustLabel: 'Government Official',
        },
      ],
      total: 1,
    });
  });
});
