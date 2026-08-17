import {
  GOLDEN_SAMPLE_RECORDS,
  GOLDEN_SAMPLE_SOURCE_FILE,
  ensureGoldenSampleDataForWorkspace,
  getGoldenSampleActivityWhere,
} from './golden-sample-data.service';

describe('ensureGoldenSampleDataForWorkspace', () => {
  function createClient(existingSampleCount = 0, existingReportCount = 0) {
    return {
      activityData: {
        count: jest.fn().mockResolvedValue(existingSampleCount),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 10 }),
      },
      report: {
        count: jest.fn().mockResolvedValue(existingReportCount),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
  }

  it('seeds the golden dataset into an empty workspace', async () => {
    const client = createClient();

    const result = await ensureGoldenSampleDataForWorkspace(
      client as never,
      'sample-workspace',
      { createdById: 'reviewer-1' },
    );

    expect(result).toMatchObject({
      recordsSeeded: 10,
      totalSampleRecords: 10,
      includedGhgRecords: 9,
      trackedOperationalMetrics: 1,
      recordsRequiringReview: 0,
      totalCalculatedEmissions: 37285,
      scope1: 3313,
      scope2: 33247,
      scope3: 725,
      reportCreated: true,
    });
    expect(client.activityData.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          organizationId: 'sample-workspace',
          activityType: 'ELECTRICITY',
          quantity: 50,
          unit: 'MWh',
          calculatedEmissionsKgCO2e: 26500,
          calculationMessage:
            '50 MWh × 1,000 = 50,000 kWh; 50,000 kWh × 0.53 kgCO2e/kWh = 26,500 kgCO2e.',
          sourceReference: GOLDEN_SAMPLE_SOURCE_FILE,
          sourceFileName: GOLDEN_SAMPLE_SOURCE_FILE,
        }),
        expect.objectContaining({
          organizationId: 'sample-workspace',
          activityType: 'WATER',
          scope: 'TRACKED_METRIC',
          reportTreatment: 'TRACKED_ONLY',
          calculationStatus: 'TRACKED_ONLY',
          calculatedEmissionsKgCO2e: 0,
          sourceReference: GOLDEN_SAMPLE_SOURCE_FILE,
          sourceFileName: GOLDEN_SAMPLE_SOURCE_FILE,
        }),
      ]),
    });
    expect(client.activityData.createMany.mock.calls[0][0].data).toHaveLength(
      GOLDEN_SAMPLE_RECORDS.length,
    );
    expect(client.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'sample-workspace',
        createdById: 'reviewer-1',
        status: 'GENERATED',
      }),
    });
  });

  it('does not duplicate records when the golden dataset already exists', async () => {
    const client = createClient(10, 1);

    const result = await ensureGoldenSampleDataForWorkspace(
      client as never,
      'sample-workspace',
    );

    expect(result.alreadySeeded).toBe(true);
    expect(result.recordsSeeded).toBe(0);
    expect(client.activityData.deleteMany).not.toHaveBeenCalled();
    expect(client.activityData.createMany).not.toHaveBeenCalled();
    expect(client.report.create).not.toHaveBeenCalled();
  });

  it('repairs partial sample-owned data without deleting non-sample data', async () => {
    const client = createClient(4, 1);

    await ensureGoldenSampleDataForWorkspace(
      client as never,
      'sample-workspace',
    );

    expect(client.activityData.deleteMany).toHaveBeenCalledWith({
      where: getGoldenSampleActivityWhere('sample-workspace'),
    });
    expect(client.activityData.createMany).toHaveBeenCalledTimes(1);
  });
});
