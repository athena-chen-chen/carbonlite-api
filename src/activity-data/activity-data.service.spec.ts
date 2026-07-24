import { Prisma } from '@prisma/client';
import { ActivityDataService } from './activity-data.service';

const canonicalFields = {
  matchingStatus: 'MATCHED',
  reportTreatment: 'INCLUDED',
  scope: 'SCOPE_2',
  matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
  matchedFactorName: 'Electricity - Alberta',
  matchedFactorSourceYear: 2025,
  matchedFactorValue: 0.53,
  matchedFactorUnit: 'kgCO2e/kWh',
  matchedFactorVersion: 'v1.0',
  matchedFactorSourceAuthority: 'CarbonLite',
  matchedFactorSourceDocument: 'CarbonLite MVP Default Factors v1.0',
  matchedFactorVerificationStatus: 'INTERNAL_REVIEW_REQUIRED',
  matchedFactorConfidenceLevel: 'LOW',
  matchedFactorAssumptions: 'Pilot default electricity factor.',
  calculatedEmissionsKgCO2e: 6625,
  calculationStatus: 'CALCULATED',
  calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
};

const basePayload = {
  activityType: 'ELECTRICITY' as const,
  recordDate: '2026-07-20',
  quantity: 12500,
  unit: 'kWh',
  jurisdictionCountry: 'Canada',
  jurisdictionRegion: 'Alberta',
  recordYear: 2026,
  sourceType: 'MANUAL' as const,
  sourceReference: 'manual',
  dateEstimated: false,
};

describe('ActivityDataService canonical calculation persistence', () => {
  const prisma = {
    $transaction: jest.fn(),
    activityData: {
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    document: {
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    documentExtraction: {
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    metricResult: {
      deleteMany: jest.fn(),
    },
    report: {
      updateMany: jest.fn(),
    },
  };
  const auditLog = { log: jest.fn() };
  const activityTracking = { track: jest.fn() };
  let service: ActivityDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    service = new ActivityDataService(
      prisma as never,
      auditLog as never,
      activityTracking as never,
    );
  });

  it('persists canonical calculation fields on create and returns them', async () => {
    prisma.activityData.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'activity-1', ...data }),
    );

    const result = await service.create('org-1', {
      ...basePayload,
      ...canonicalFields,
    });

    expect(prisma.activityData.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ...canonicalFields,
        recordDate: new Date('2026-07-20T00:00:00.000Z'),
        quantity: new Prisma.Decimal(12500),
      }),
    });
    expect(result).toMatchObject(canonicalFields);
  });

  it('persists canonical calculation fields on update', async () => {
    prisma.activityData.findFirst.mockResolvedValue({
      id: 'activity-1',
      organizationId: 'org-1',
    });
    prisma.activityData.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'activity-1', organizationId: 'org-1', ...data }),
    );

    const result = await service.update('org-1', 'activity-1', canonicalFields);

    expect(prisma.activityData.update).toHaveBeenCalledWith({
      where: { id: 'activity-1' },
      data: expect.objectContaining(canonicalFields),
    });
    expect(result).toMatchObject(canonicalFields);
  });

  it('persists canonical calculation fields through bulk import createMany', async () => {
    prisma.activityData.createMany.mockResolvedValue({ count: 1 });

    await service.bulkImport('org-1', {
      items: [
        {
          ...basePayload,
          ...canonicalFields,
        },
      ],
    });

    expect(prisma.activityData.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          ...canonicalFields,
          recordDate: new Date('2026-07-20T00:00:00.000Z'),
          calculatedEmissionsKgCO2e: 6625,
        }),
      ],
    });
  });

  it('keeps existing records without canonical fields valid by persisting nulls on create', async () => {
    prisma.activityData.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'activity-legacy', ...data }),
    );

    const result = await service.create('org-1', {
      activityType: 'DIESEL',
      recordDate: '2026-07-20',
      quantity: 10,
      unit: 'L',
      sourceType: 'MANUAL',
    });

    expect(result).toMatchObject({
      matchingStatus: null,
      matchedFactorId: null,
      matchedFactorValue: null,
      matchedFactorVersion: null,
      calculatedEmissionsKgCO2e: null,
    });
  });

  it('resets demo data for one organization without deleting users, facilities, or factors', async () => {
    prisma.activityData.findMany.mockResolvedValue([
      { id: 'activity-1', importBatchId: 'batch-1' },
      { id: 'activity-2', importBatchId: null },
    ]);
    prisma.document.findMany.mockResolvedValue([
      { id: 'document-1', importBatchId: 'batch-1' },
      { id: 'document-2', importBatchId: 'batch-2' },
    ]);
    prisma.documentExtraction.findMany.mockResolvedValue([
      { extractedRowCount: 3, sourceRowCount: 4 },
      { extractedRowCount: 0, sourceRowCount: 2 },
    ]);
    prisma.metricResult.deleteMany.mockResolvedValue({ count: 2 });
    prisma.activityData.deleteMany.mockResolvedValue({ count: 2 });
    prisma.documentExtraction.deleteMany.mockResolvedValue({ count: 2 });
    prisma.document.deleteMany.mockResolvedValue({ count: 2 });
    prisma.report.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.resetDemoDataForOrganization(
      'org-1',
      'admin-1',
      'RESET DEMO DATA',
    );

    expect(prisma.activityData.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
    });
    expect(prisma.document.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
    });
    expect(prisma.documentExtraction.deleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        documentId: { in: ['document-1', 'document-2'] },
      },
    });
    expect(prisma.metricResult.deleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        activityDataId: { in: ['activity-1', 'activity-2'] },
      },
    });
    expect(prisma.report.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        status: 'DRAFT',
      },
      data: {
        summary: null,
        contentMarkdown: null,
        generatedPdfUrl: null,
      },
    });
    expect((prisma as Record<string, unknown>).user).toBeUndefined();
    expect((prisma as Record<string, unknown>).facility).toBeUndefined();
    expect((prisma as Record<string, unknown>).conversionFactor).toBeUndefined();
    expect(result).toMatchObject({
      activityRecordsDeleted: 2,
      importBatchesDeleted: 2,
      uploadedDocumentsDeleted: 2,
      stagedRowsDeleted: 5,
      stagedExtractionRecordsDeleted: 2,
      metricsCacheCleared: 2,
      resetReports: 1,
    });
  });

  it('rejects demo reset when confirmation text does not match', async () => {
    await expect(
      service.resetDemoDataForOrganization('org-1', 'admin-1', 'CLEAR RECORDS'),
    ).rejects.toThrow('Confirmation text is invalid.');

    expect(prisma.activityData.deleteMany).not.toHaveBeenCalled();
    expect(prisma.document.deleteMany).not.toHaveBeenCalled();
  });
});
