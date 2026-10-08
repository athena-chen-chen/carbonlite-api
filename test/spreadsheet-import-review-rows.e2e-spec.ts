import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('Spreadsheet import review rows (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('spreadsheet-review');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('persists READY, NEEDS_REVIEW, invalid-quantity, and TRACKED_ONLY rows without creating ActivityData', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `user-${testRunId}@carbonlite-e2e.test`,
    });

    const payload = buildPayload(`${testRunId}.xlsx`);
    const response = await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send(payload)
      .expect(201);

    expect(response.body).toMatchObject({
      savedCount: 4,
      readyCount: 1,
      needsReviewCount: 2,
      trackedOnlyCount: 1,
      sourceDocument: expect.objectContaining({
        fileName: `${testRunId}.xlsx`,
        type: 'SPREADSHEET',
        status: 'REVIEW_REQUIRED',
      }),
      failedRows: [],
    });

    const sourceDocument = await prisma.document.findFirstOrThrow({
      where: {
        organizationId: user.user.organizationId,
        fileName: `${testRunId}.xlsx`,
        type: 'SPREADSHEET',
      },
      include: { extractions: true },
    });
    expect(sourceDocument.status).toBe('REVIEW_REQUIRED');
    expect(sourceDocument.extractions).toHaveLength(1);
    expect(sourceDocument.extractions[0]).toMatchObject({
      sourceRowCount: 4,
      extractedRowCount: 4,
      possibleMissingRows: true,
    });

    const rows = await prisma.spreadsheetImportReviewRow.findMany({
      where: { organizationId: user.user.organizationId },
      orderBy: { sourceRow: 'asc' },
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.sourceDocumentId === sourceDocument.id)).toBe(true);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'READY',
          activityType: 'DIESEL',
          quantity: new Prisma.Decimal('42'),
          sourceFileName: `${testRunId}.xlsx`,
          sourceSheetName: 'January',
          sourceRow: '2',
        }),
        expect.objectContaining({
          status: 'NEEDS_REVIEW',
          activityType: 'ELECTRICITY',
          jurisdictionRegion: null,
          sourceRow: '3',
        }),
        expect.objectContaining({
          status: 'NEEDS_REVIEW',
          activityType: 'GASOLINE',
          quantity: null,
          rawQuantity: 'approx 500',
          sourceRow: '4',
        }),
        expect.objectContaining({
          status: 'TRACKED_ONLY',
          activityType: 'WATER',
          reportTreatment: 'TRACKED_ONLY',
          sourceRow: '5',
        }),
      ]),
    );
    expect(rows.find((row) => row.sourceRow === '4')?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_QUANTITY',
          field: 'quantity',
        }),
      ]),
    );
    expect(rows.find((row) => row.sourceRow === '2')?.rawSourceRow).toMatchObject({
      Fuel: 'Diesel',
      Quantity: 42,
    });
    await expect(
      prisma.activityData.count({
        where: {
          organizationId: user.user.organizationId,
          sourceFileName: `${testRunId}.xlsx`,
        },
      }),
    ).resolves.toBe(0);
  });

  it('partially confirms spreadsheet rows including TRACKED_ONLY without marking the document fully imported', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Partial Confirm Org`,
      email: `partial-confirm-${testRunId}@carbonlite-e2e.test`,
    });
    const sourceFileName = `${testRunId}-needs-review.xlsx`;
    const payload = buildNeedsReviewWorkbookPayload(sourceFileName);

    const reviewResponse = await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send(payload);

    expect(reviewResponse.body).toEqual(
      expect.objectContaining({ savedCount: 9 }),
    );
    expect(reviewResponse.status).toBe(201);

    expect(reviewResponse.body).toMatchObject({
      savedCount: 9,
      readyCount: 2,
      needsReviewCount: 6,
      trackedOnlyCount: 1,
      sourceDocument: expect.objectContaining({
        status: 'REVIEW_REQUIRED',
      }),
    });

    const sourceDocumentId = reviewResponse.body.sourceDocument.id;
    const extractionBeforeConfirm = await prisma.documentExtraction.findUniqueOrThrow({
      where: { documentId: sourceDocumentId },
    });
    const extractedRowsBeforeConfirm = extractionBeforeConfirm.extractedRows as Array<Record<string, any>>;
    const extractedWaterBeforeConfirm = extractedRowsBeforeConfirm.find(
      (row) => row.sourceReference === 'MARCH-WATER-007',
    );
    expect(extractedWaterBeforeConfirm).toMatchObject({
      rowId: 'march-water-007',
      status: 'TRACKED_ONLY',
      activityType: 'WATER',
      recordDate: '2026-03-07',
      quantity: 18,
      unit: 'm3',
      sourceReference: 'MARCH-WATER-007',
      matchingStatus: 'TRACKED_ONLY',
      reportTreatment: 'TRACKED_ONLY',
      scope: 'TRACKED_METRIC',
      matchedFactorId: 'tracked-water-usage',
      matchedFactorName: 'Water usage tracked metric',
      matchedFactorSourceYear: 2026,
      matchedFactorValue: 0,
      matchedFactorUnit: 'kgCO2e/m3',
      matchedFactorVersion: 'v1',
      matchedFactorSourceAuthority: 'CarbonLite',
      matchedFactorSourceDocument: 'Tracked metrics policy',
      matchedFactorVerificationStatus: 'Not Applicable',
      matchedFactorConfidenceLevel: 'Tracked Only',
      matchedFactorAssumptions: 'Water usage is tracked as an operational metric only.',
      calculatedEmissionsKgCO2e: 0,
      calculationStatus: 'TRACKED_ONLY',
      issues: [],
    });

    const firstConfirm = await request(app.getHttpServer())
      .post('/api/document-extraction/confirm')
      .set(authHeader(user.accessToken))
      .send({
        documentId: sourceDocumentId,
        importBatchId: `document-${sourceDocumentId}`,
        activities: [
          {
            activityType: 'ELECTRICITY',
            recordDate: '2026-03-01',
            quantity: 980,
            unit: 'kWh',
            jurisdictionCountry: 'Canada',
            jurisdictionRegion: 'Alberta',
            sourceReference: 'MARCH-ELEC-001',
            sourceDocumentId,
            sourceFileName,
            sourceRow: 2,
            matchingStatus: 'MATCHED',
            reportTreatment: 'INCLUDED',
            scope: 'SCOPE_2',
            calculationStatus: 'CALCULATED',
          },
          {
            activityType: 'HOTEL',
            recordDate: '2026-03-10',
            quantity: 4,
            unit: 'nights',
            sourceReference: 'MARCH-HOTEL-010',
            sourceDocumentId,
            sourceFileName,
            sourceRow: 11,
            matchingStatus: 'MATCHED',
            reportTreatment: 'INCLUDED',
            scope: 'SCOPE_3',
            calculationStatus: 'CALCULATED',
          },
        ],
      })
      .expect(201);

    expect(firstConfirm.body).toMatchObject({
      count: 3,
      importBatchId: `document-${sourceDocumentId}`,
    });
    expect(firstConfirm.body.createdIds).toHaveLength(3);

    const importedRows = await prisma.activityData.findMany({
      where: {
        organizationId: user.user.organizationId,
        sourceDocumentId,
      },
      orderBy: { sourceReference: 'asc' },
    });
    expect(importedRows.map((row) => row.sourceReference).sort()).toEqual([
      'MARCH-ELEC-001',
      'MARCH-HOTEL-010',
      'MARCH-WATER-007',
    ]);

    expect(importedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceReference: 'MARCH-ELEC-001',
          sourceSheetName: 'March',
          costCurrency: 'CAD',
        }),
        expect.objectContaining({
          sourceReference: 'MARCH-WATER-007',
          sourceSheetName: 'March',
          costCurrency: 'CAD',
        }),
        expect.objectContaining({
          sourceReference: 'MARCH-HOTEL-010',
          sourceSheetName: 'March',
          costCurrency: 'CAD',
        }),
      ]),
    );
    expect(Number(importedRows.find((row) => row.sourceReference === 'MARCH-ELEC-001')?.costCad)).toBe(214.55);
    expect(Number(importedRows.find((row) => row.sourceReference === 'MARCH-WATER-007')?.costCad)).toBe(64);
    expect(Number(importedRows.find((row) => row.sourceReference === 'MARCH-HOTEL-010')?.costCad)).toBe(720);
    expect(importedRows.find((row) => row.sourceReference === 'MARCH-WATER-007')).toMatchObject({
      activityType: 'WATER',
      unit: 'm3',
      reportTreatment: 'TRACKED_ONLY',
      calculationStatus: 'TRACKED_ONLY',
      scope: 'TRACKED_METRIC',
      matchedFactorId: 'tracked-water-usage',
      matchedFactorName: 'Water usage tracked metric',
      matchedFactorSourceYear: 2026,
      matchedFactorValue: 0,
      matchedFactorUnit: 'kgCO2e/m3',
      matchedFactorVersion: 'v1',
      matchedFactorSourceAuthority: 'CarbonLite',
      matchedFactorSourceDocument: 'Tracked metrics policy',
      matchedFactorVerificationStatus: 'Not Applicable',
      matchedFactorConfidenceLevel: 'Tracked Only',
      matchedFactorAssumptions: 'Water usage is tracked as an operational metric only.',
      calculatedEmissionsKgCO2e: 0,
    });
    expect(Number(importedRows.find((row) => row.sourceReference === 'MARCH-WATER-007')?.quantity)).toBe(18);
    expect(importedRows.find((row) => row.sourceReference === 'MARCH-HOTEL-010')).toMatchObject({
      activityType: 'HOTEL',
      facilityName: 'Toronto Client Visit',
      jurisdictionRegion: 'Ontario',
      jurisdictionCountry: 'Canada',
      sourceDocumentId,
      importBatchId: `document-${sourceDocumentId}`,
    });

    const reviewRowsResponse = await request(app.getHttpServer())
      .get(`/api/spreadsheet-import/review-rows?sourceDocumentIds=${sourceDocumentId}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(reviewRowsResponse.body.items).toHaveLength(9);
    expect(
      reviewRowsResponse.body.items
        .filter((row: { status: string }) => row.status === 'NEEDS_REVIEW')
        .map((row: { sourceReference: string }) => row.sourceReference)
        .sort(),
    ).toEqual([
      'MARCH-AIR-008',
      'MARCH-DIESEL-006',
      'MARCH-ELEC-002',
      'MARCH-FUEL-004',
      'MARCH-GAS-003',
      'MARCH-OTHER-005',
    ]);
    expect(reviewRowsResponse.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceDocumentId,
          sourceReference: 'MARCH-ELEC-002',
          status: 'NEEDS_REVIEW',
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'MISSING_PROVINCE',
              message: 'Province is required for electricity rows.',
            }),
          ]),
        }),
        expect.objectContaining({
          sourceDocumentId,
          sourceReference: 'MARCH-WATER-007',
          status: 'TRACKED_ONLY',
          reportTreatment: 'TRACKED_ONLY',
        }),
      ]),
    );

    const partiallyImportedDocument = await prisma.document.findUniqueOrThrow({
      where: { id: sourceDocumentId },
      include: {
        _count: {
          select: {
            activityData: true,
            spreadsheetReviewRows: true,
          },
        },
        extractions: true,
        spreadsheetReviewRows: true,
      },
    });
    expect(partiallyImportedDocument.status).toBe('REVIEW_REQUIRED');
    expect(partiallyImportedDocument.importedAt).toBeNull();
    expect(partiallyImportedDocument._count.activityData).toBe(3);
    expect(partiallyImportedDocument._count.spreadsheetReviewRows).toBe(9);
    expect(partiallyImportedDocument.extractions[0]).toMatchObject({
      extractedRowCount: 9,
      sourceRowCount: 9,
    });
    expect(
      partiallyImportedDocument.spreadsheetReviewRows.filter((row) => row.status === 'NEEDS_REVIEW'),
    ).toHaveLength(6);

    const secondConfirm = await request(app.getHttpServer())
      .post('/api/document-extraction/confirm')
      .set(authHeader(user.accessToken))
      .send({
        documentId: sourceDocumentId,
        importBatchId: `document-${sourceDocumentId}`,
        activities: [],
      })
      .expect(201);

    expect(secondConfirm.body).toMatchObject({
      count: 0,
      createdIds: [],
    });
    await expect(
      prisma.activityData.count({
        where: {
          organizationId: user.user.organizationId,
          sourceDocumentId,
        },
      }),
    ).resolves.toBe(3);

    const fixedPayload: any = buildNeedsReviewWorkbookPayload(sourceFileName);
    fixedPayload.rows = fixedPayload.rows.map((row: any) =>
      row.sourceReference === 'MARCH-GAS-003'
        ? {
            ...row,
            status: 'READY',
            unit: 'm3',
            issues: [],
            matchingStatus: 'MATCHED',
            reportTreatment: 'INCLUDED',
            calculationStatus: 'CALCULATED',
            calculatedEmissionsKgCO2e: 189,
          }
        : row,
    );

    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send(fixedPayload)
      .expect(201);

    const thirdConfirm = await request(app.getHttpServer())
      .post('/api/document-extraction/confirm')
      .set(authHeader(user.accessToken))
      .send({
        documentId: sourceDocumentId,
        importBatchId: `document-${sourceDocumentId}`,
        activities: [],
      })
      .expect(201);

    expect(thirdConfirm.body.createdIds).toHaveLength(1);
    const allImportedRows = await prisma.activityData.findMany({
      where: {
        organizationId: user.user.organizationId,
        sourceDocumentId,
      },
      orderBy: { sourceReference: 'asc' },
    });
    expect(allImportedRows.map((row) => row.sourceReference).sort()).toEqual([
      'MARCH-ELEC-001',
      'MARCH-GAS-003',
      'MARCH-HOTEL-010',
      'MARCH-WATER-007',
    ]);
  });

  it('upserts duplicate submissions by source row identity', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Idempotent Org`,
      email: `idempotent-${testRunId}@carbonlite-e2e.test`,
    });
    const payload = buildPayload(`${testRunId}-retry.xlsx`);

    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send(payload)
      .expect(201);

    await expect(
      prisma.spreadsheetImportReviewRow.count({
        where: { organizationId: user.user.organizationId },
      }),
    ).resolves.toBe(4);
    await expect(
      prisma.document.count({
        where: {
          organizationId: user.user.organizationId,
          type: 'SPREADSHEET',
          fileName: `${testRunId}-retry.xlsx`,
        },
      }),
    ).resolves.toBe(1);
  });

  it('uses the authenticated organization and keeps other organizations isolated', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Tenant A`,
      email: `tenant-a-${testRunId}@carbonlite-e2e.test`,
    });
    const other = await createTestUser(app, {
      organizationName: `${testRunId} Tenant B`,
      email: `tenant-b-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send(buildPayload(`${testRunId}-tenant.xlsx`))
      .expect(201);

    await expect(
      prisma.spreadsheetImportReviewRow.count({
        where: { organizationId: user.user.organizationId },
      }),
    ).resolves.toBe(4);
    await expect(
      prisma.spreadsheetImportReviewRow.count({
        where: { organizationId: other.user.organizationId },
      }),
    ).resolves.toBe(0);
  });

  it('denies viewer and pilot reviewer writes', async () => {
    const viewer = await createTestUser(app, {
      organizationName: `${testRunId} Viewer Org`,
      email: `viewer-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.membership.create({
      data: {
        userId: viewer.user.id,
        organizationId: viewer.user.organizationId,
        role: 'VIEWER',
      },
    });

    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(viewer.accessToken))
      .send(buildPayload(`${testRunId}-viewer.xlsx`))
      .expect(403);

    const pilotReviewer = await createTestUser(app, {
      organizationName: `${testRunId} Pilot Reviewer Org`,
      email: `pilot-reviewer-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: pilotReviewer.user.id },
      data: {
        accountType: 'PILOT_REVIEWER',
        role: 'USER',
      },
    });

    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(pilotReviewer.accessToken))
      .send(buildPayload(`${testRunId}-pilot.xlsx`))
      .expect(403);
  });

  it('returns 400 for structurally invalid requests', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Invalid Org`,
      email: `invalid-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send({
        sourceType: 'EXCEL',
        rows: [
          {
            rowId: 'bad-row',
            status: 'READY',
            activityType: 'DIESEL',
            recordDate: 'not-a-date',
            quantity: 5,
            unit: 'L',
            issues: [],
          },
        ],
      })
      .expect(400);
  });
});

function buildPayload(sourceFileName: string) {
  return {
    sourceType: 'EXCEL',
    sourceFileName,
    importBatchId: `test-batch-${sourceFileName}`,
    rows: [
      {
        rowId: 'ready-row',
        status: 'READY',
        activityType: 'DIESEL',
        rawActivityType: 'Diesel',
        recordDate: '2026-01-15',
        rawRecordDate: 46037,
        quantity: 42,
        rawQuantity: '42',
        unit: 'L',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'AB',
        facilityName: 'Calgary Shop',
        sourceFileName,
        sourceSheetName: 'January',
        sourceRow: 2,
        rawSourceRow: { Fuel: 'Diesel', Quantity: 42 },
        issues: [],
        matchingStatus: 'MATCHED',
        reportTreatment: 'INCLUDE',
        calculationStatus: 'CALCULATED',
      },
      {
        rowId: 'missing-province-row',
        status: 'NEEDS_REVIEW',
        activityType: 'ELECTRICITY',
        recordDate: '2026-01-16',
        quantity: 10,
        rawQuantity: '10',
        unit: 'kWh',
        jurisdictionCountry: 'Canada',
        sourceFileName,
        sourceSheetName: 'January',
        sourceRow: 3,
        issues: [
          {
            code: 'MISSING_PROVINCE',
            field: 'jurisdictionRegion',
            message: 'Province is required for electricity rows.',
          },
        ],
        calculationStatus: 'MISSING_JURISDICTION',
      },
      {
        rowId: 'invalid-quantity-row',
        status: 'NEEDS_REVIEW',
        activityType: 'GASOLINE',
        recordDate: '2026-01-17',
        quantity: null,
        rawQuantity: 'approx 500',
        unit: 'L',
        sourceFileName,
        sourceSheetName: 'January',
        sourceRow: 4,
        issues: [
          {
            code: 'INVALID_QUANTITY',
            field: 'quantity',
            message: 'Quantity must be a number greater than 0.',
          },
        ],
      },
      {
        rowId: 'tracked-only-row',
        status: 'TRACKED_ONLY',
        activityType: 'WATER',
        recordDate: '2026-01-18',
        quantity: 25,
        rawQuantity: '25',
        unit: 'm3',
        sourceFileName,
        sourceSheetName: 'January',
        sourceRow: 5,
        issues: [],
        reportTreatment: 'TRACKED_ONLY',
        calculationStatus: 'TRACKED_ONLY',
      },
    ],
  };
}

function buildNeedsReviewWorkbookPayload(sourceFileName: string) {
  return {
    sourceType: 'EXCEL',
    sourceFileName,
    importBatchId: `test-batch-${sourceFileName}`,
    rows: [
      {
        rowId: 'march-elec-001',
        status: 'READY',
        activityType: 'ELECTRICITY',
        recordDate: '2026-03-01',
        quantity: 980,
        rawQuantity: '980',
        unit: 'kWh',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        facilityName: 'Calgary HQ',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 2,
        sourceReference: 'MARCH-ELEC-001',
        costCad: 214.55,
        costCurrency: 'CAD',
        issues: [],
        matchingStatus: 'MATCHED',
        reportTreatment: 'INCLUDED',
        calculationStatus: 'CALCULATED',
        calculatedEmissionsKgCO2e: 519.4,
      },
      {
        rowId: 'march-elec-002',
        status: 'NEEDS_REVIEW',
        activityType: 'ELECTRICITY',
        recordDate: '2026-03-02',
        quantity: 760,
        rawQuantity: '760',
        unit: 'kWh',
        jurisdictionCountry: 'Canada',
        facilityName: 'Calgary Warehouse',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 3,
        sourceReference: 'MARCH-ELEC-002',
        issues: [
          {
            code: 'MISSING_PROVINCE',
            field: 'jurisdictionRegion',
            message: 'Province is required for electricity rows.',
          },
        ],
        calculationStatus: 'MISSING_PROVINCE',
        reportTreatment: 'EXCLUDED',
      },
      {
        rowId: 'march-gas-003',
        status: 'NEEDS_REVIEW',
        activityType: 'NATURAL_GAS',
        recordDate: '2026-03-03',
        quantity: 100,
        rawQuantity: '100',
        unit: '',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 4,
        sourceReference: 'MARCH-GAS-003',
        issues: [
          {
            code: 'MISSING_UNIT',
            field: 'unit',
            message: 'Unit is required.',
          },
        ],
        calculationStatus: 'REQUIRES_REVIEW',
        reportTreatment: 'EXCLUDED',
      },
      {
        rowId: 'march-fuel-004',
        status: 'NEEDS_REVIEW',
        activityType: 'GASOLINE',
        recordDate: '2026-03-04',
        quantity: null,
        rawQuantity: 'approx 500',
        unit: 'L',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 5,
        sourceReference: 'MARCH-FUEL-004',
        issues: [
          {
            code: 'INVALID_QUANTITY',
            field: 'quantity',
            message: 'Quantity must be a number greater than 0.',
          },
        ],
        matchingStatus: 'MATCHED',
        calculationStatus: 'INVALID_QUANTITY',
        reportTreatment: 'EXCLUDED',
      },
      {
        rowId: 'march-other-005',
        status: 'NEEDS_REVIEW',
        activityType: '',
        rawActivityType: 'Other',
        recordDate: '2026-03-05',
        quantity: 1,
        rawQuantity: '1',
        unit: 'each',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 6,
        sourceReference: 'MARCH-OTHER-005',
        issues: [
          {
            code: 'MISSING_ACTIVITY_TYPE',
            field: 'activityType',
            message: 'Activity type is required.',
          },
        ],
        calculationStatus: 'MISSING_ACTIVITY_TYPE',
        reportTreatment: 'EXCLUDED',
      },
      {
        rowId: 'march-diesel-006',
        status: 'NEEDS_REVIEW',
        activityType: 'DIESEL',
        recordDate: '2026-03-06',
        quantity: 240,
        rawQuantity: '240',
        unit: 'kg',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 7,
        sourceReference: 'MARCH-DIESEL-006',
        issues: [
          {
            code: 'UNIT_MISMATCH',
            field: 'unit',
            message: 'Diesel requires liters.',
          },
        ],
        matchingStatus: 'UNIT_MISMATCH',
        calculationStatus: 'UNIT_MISMATCH',
        reportTreatment: 'EXCLUDED',
      },
      {
        rowId: 'march-water-007',
        status: 'TRACKED_ONLY',
        activityType: 'WATER',
        recordDate: '2026-03-07',
        quantity: 18,
        rawQuantity: '18',
        unit: 'm3',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 8,
        sourceReference: 'MARCH-WATER-007',
        costCad: 64,
        costCurrency: 'CAD',
        issues: [],
        matchingStatus: 'TRACKED_ONLY',
        reportTreatment: 'TRACKED_ONLY',
        scope: 'TRACKED_METRIC',
        matchedFactorId: 'tracked-water-usage',
        matchedFactorName: 'Water usage tracked metric',
        matchedFactorSourceYear: 2026,
        matchedFactorValue: 0,
        matchedFactorUnit: 'kgCO2e/m3',
        matchedFactorVersion: 'v1',
        matchedFactorSourceAuthority: 'CarbonLite',
        matchedFactorSourceDocument: 'Tracked metrics policy',
        matchedFactorVerificationStatus: 'Not Applicable',
        matchedFactorConfidenceLevel: 'Tracked Only',
        matchedFactorAssumptions: 'Water usage is tracked as an operational metric only.',
        calculatedEmissionsKgCO2e: 0,
        calculationStatus: 'TRACKED_ONLY',
      },
      {
        rowId: 'march-air-008',
        status: 'NEEDS_REVIEW',
        activityType: 'AIR_TRAVEL',
        recordDate: '2026-03-08',
        quantity: null,
        rawQuantity: '',
        unit: 'km',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 9,
        sourceReference: 'MARCH-AIR-008',
        issues: [
          {
            code: 'MISSING_QUANTITY',
            field: 'quantity',
            message: 'Quantity is required.',
          },
        ],
        matchingStatus: 'MATCHED',
        calculationStatus: 'MISSING_QUANTITY',
        reportTreatment: 'EXCLUDED',
      },
      {
        rowId: 'march-hotel-010',
        status: 'READY',
        activityType: 'HOTEL',
        recordDate: '2026-03-10',
        quantity: 4,
        rawQuantity: '4',
        unit: 'nights',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Ontario',
        facilityName: 'Toronto Client Visit',
        sourceFileName,
        sourceSheetName: 'March',
        sourceRow: 11,
        sourceReference: 'MARCH-HOTEL-010',
        costCad: 720,
        costCurrency: 'CAD',
        issues: [],
        matchingStatus: 'MATCHED',
        reportTreatment: 'INCLUDED',
        calculationStatus: 'CALCULATED',
        calculatedEmissionsKgCO2e: 72,
      },
    ],
  };
}
