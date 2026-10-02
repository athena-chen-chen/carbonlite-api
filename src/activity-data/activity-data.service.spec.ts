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
      updateMany: jest.fn(),
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

  it('bulk updates province for selected electricity records in the organization', async () => {
    const eligibleRecords = [
      {
        id: 'activity-electricity-missing-province',
        organizationId: 'org-1',
        activityType: 'ELECTRICITY',
        jurisdictionRegion: '',
      },
      {
        id: 'activity-existing-different-province',
        organizationId: 'org-1',
        activityType: 'ELECTRICITY',
        jurisdictionRegion: 'Alberta',
        ...canonicalFields,
      },
      {
        id: 'activity-existing-same-province',
        organizationId: 'org-1',
        activityType: 'ELECTRICITY',
        jurisdictionRegion: 'BC',
      },
    ];
    const updatedRecords = eligibleRecords.map((record) => ({
      ...record,
      jurisdictionRegion: 'BC',
      matchingStatus: null,
      matchedFactorId: null,
      calculatedEmissionsKgCO2e: null,
      calculationStatus: 'PENDING_RECALCULATION',
    }));

    prisma.activityData.findMany
      .mockResolvedValueOnce(eligibleRecords)
      .mockResolvedValueOnce(updatedRecords);
    prisma.activityData.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.bulkUpdateProvince(
      'org-1',
      [
        'activity-electricity-missing-province',
        'activity-electricity-missing-province',
        'activity-existing-different-province',
        'activity-existing-same-province',
      ],
      'BC',
      'user-1',
    );

    expect(prisma.activityData.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: {
          in: [
            'activity-electricity-missing-province',
            'activity-existing-different-province',
            'activity-existing-same-province',
          ],
        },
        organizationId: 'org-1',
        activityType: 'ELECTRICITY',
      },
    });
    expect(prisma.activityData.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            'activity-electricity-missing-province',
            'activity-existing-different-province',
            'activity-existing-same-province',
          ],
        },
        organizationId: 'org-1',
      },
      data: expect.objectContaining({
        jurisdictionRegion: 'BC',
        matchingStatus: null,
        matchedFactorId: null,
        matchedFactorName: null,
        calculatedEmissionsKgCO2e: null,
        calculationStatus: 'PENDING_RECALCULATION',
        calculationMessage:
          'Province changed. Recalculate to refresh factor matching and emissions.',
      }),
    });
    expect(result).toMatchObject({
      ids: [
        'activity-electricity-missing-province',
        'activity-existing-different-province',
        'activity-existing-same-province',
      ],
      province: 'BC',
      updatedCount: 3,
      updatedRecords,
    });
    expect(activityTracking.track).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'ACTIVITY_RECORDS_PROVINCE_UPDATED',
        metadata: expect.objectContaining({
          requestedCount: 3,
          updatedCount: 3,
          province: 'BC',
        }),
      }),
    );
  });

  it('ignores selected non-electricity and wrong-organization records safely', async () => {
    const eligibleRecords = [
      {
        id: 'activity-electricity-org-1',
        organizationId: 'org-1',
        activityType: 'ELECTRICITY',
        jurisdictionRegion: null,
      },
    ];
    const updatedRecords = [
      {
        ...eligibleRecords[0],
        jurisdictionRegion: 'ON',
      },
    ];

    prisma.activityData.findMany
      .mockResolvedValueOnce(eligibleRecords)
      .mockResolvedValueOnce(updatedRecords);
    prisma.activityData.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.bulkUpdateProvince(
      'org-1',
      [
        'activity-electricity-org-1',
        'activity-gasoline-org-1',
        'activity-electricity-other-org',
      ],
      'ON',
      'user-1',
    );

    expect(prisma.activityData.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: {
          in: [
            'activity-electricity-org-1',
            'activity-gasoline-org-1',
            'activity-electricity-other-org',
          ],
        },
        organizationId: 'org-1',
        activityType: 'ELECTRICITY',
      },
    });
    expect(prisma.activityData.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['activity-electricity-org-1'] },
        organizationId: 'org-1',
      },
      data: expect.objectContaining({
        jurisdictionRegion: 'ON',
      }),
    });
    expect(result).toMatchObject({
      ids: ['activity-electricity-org-1'],
      province: 'ON',
      updatedCount: 1,
    });
  });

  it('rejects unsupported bulk province codes with an actionable message', async () => {
    await expect(
      service.bulkUpdateProvince('org-1', ['activity-1'], 'XX', 'user-1'),
    ).rejects.toThrow('Unsupported province code: XX');

    expect(prisma.activityData.findMany).not.toHaveBeenCalled();
    expect(prisma.activityData.updateMany).not.toHaveBeenCalled();
  });

  it('rejects bulk province updates when no selected electricity records match', async () => {
    prisma.activityData.findMany.mockResolvedValue([]);

    await expect(
      service.bulkUpdateProvince('org-1', ['activity-1'], 'AB', 'user-1'),
    ).rejects.toThrow('No selected electricity records.');

    expect(prisma.activityData.updateMany).not.toHaveBeenCalled();
  });

  it('bulk updates facility for selected records across activity types in the organization', async () => {
    const eligibleRecords = [
      {
        id: 'activity-missing-facility',
        organizationId: 'org-1',
        activityType: 'ELECTRICITY',
        facilityName: null,
      },
      {
        id: 'activity-existing-different-facility',
        organizationId: 'org-1',
        activityType: 'NATURAL_GAS',
        facilityId: 'facility-vancouver',
        facilityName: 'Vancouver Office',
      },
      {
        id: 'activity-existing-same-facility',
        organizationId: 'org-1',
        activityType: 'GASOLINE',
        facilityName: 'Calgary Office',
      },
    ];
    const updatedRecords = eligibleRecords.map((record) => ({
      ...record,
      facilityId: null,
      facilityName: 'Calgary Office',
    }));

    prisma.activityData.findMany
      .mockResolvedValueOnce(eligibleRecords)
      .mockResolvedValueOnce(updatedRecords);
    prisma.activityData.updateMany.mockResolvedValue({ count: 3 });

    const result = await service.bulkUpdateFacility(
      'org-1',
      [
        'activity-missing-facility',
        'activity-existing-different-facility',
        'activity-existing-same-facility',
        'activity-existing-same-facility',
      ],
      ' Calgary Office ',
      'user-1',
    );

    expect(prisma.activityData.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: {
          in: [
            'activity-missing-facility',
            'activity-existing-different-facility',
            'activity-existing-same-facility',
          ],
        },
        organizationId: 'org-1',
      },
    });
    expect(prisma.activityData.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            'activity-missing-facility',
            'activity-existing-different-facility',
            'activity-existing-same-facility',
          ],
        },
        organizationId: 'org-1',
      },
      data: {
        facilityId: null,
        facilityName: 'Calgary Office',
      },
    });
    expect(result).toMatchObject({
      ids: [
        'activity-missing-facility',
        'activity-existing-different-facility',
        'activity-existing-same-facility',
      ],
      facilityName: 'Calgary Office',
      updatedCount: 3,
      updatedRecords,
    });
    expect(activityTracking.track).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'ACTIVITY_RECORDS_FACILITY_UPDATED',
        metadata: expect.objectContaining({
          requestedCount: 3,
          updatedCount: 3,
          facilityName: 'Calgary Office',
        }),
      }),
    );
  });

  it('ignores selected wrong-organization records when bulk updating facility', async () => {
    const eligibleRecords = [
      {
        id: 'activity-org-1',
        organizationId: 'org-1',
        activityType: 'HOTEL',
        facilityName: null,
      },
    ];
    const updatedRecords = [
      {
        ...eligibleRecords[0],
        facilityId: null,
        facilityName: 'Calgary Office',
      },
    ];

    prisma.activityData.findMany
      .mockResolvedValueOnce(eligibleRecords)
      .mockResolvedValueOnce(updatedRecords);
    prisma.activityData.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.bulkUpdateFacility(
      'org-1',
      ['activity-org-1', 'activity-other-org'],
      'Calgary Office',
      'user-1',
    );

    expect(prisma.activityData.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { in: ['activity-org-1', 'activity-other-org'] },
        organizationId: 'org-1',
      },
    });
    expect(prisma.activityData.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['activity-org-1'] },
        organizationId: 'org-1',
      },
      data: {
        facilityId: null,
        facilityName: 'Calgary Office',
      },
    });
    expect(result).toMatchObject({
      ids: ['activity-org-1'],
      facilityName: 'Calgary Office',
      updatedCount: 1,
    });
  });

  it('rejects bulk facility updates when facility name is empty', async () => {
    await expect(
      service.bulkUpdateFacility('org-1', ['activity-1'], '   ', 'user-1'),
    ).rejects.toThrow('Facility name is required.');

    expect(prisma.activityData.findMany).not.toHaveBeenCalled();
    expect(prisma.activityData.updateMany).not.toHaveBeenCalled();
  });

  it('rejects bulk facility updates when no selected records match the organization', async () => {
    prisma.activityData.findMany.mockResolvedValue([]);

    await expect(
      service.bulkUpdateFacility('org-1', ['activity-1'], 'Calgary Office', 'user-1'),
    ).rejects.toThrow('No selected activity records.');

    expect(prisma.activityData.updateMany).not.toHaveBeenCalled();
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
