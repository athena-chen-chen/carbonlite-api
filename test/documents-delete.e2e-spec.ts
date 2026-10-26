import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('Document delete (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('document-delete');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  async function uploadTestDocument(token: string, name: string) {
    const response = await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(token))
      .field('type', 'SPREADSHEET')
      .attach('file', Buffer.from(`activityType,recordDate,quantity,unit\n# ${name}\n`), {
        filename: name,
        contentType: 'text/csv',
      })
      .expect(201);

    return response.body;
  }

  it('allows the owner to delete their own document', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Owner Org`,
      email: `owner-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-owner.csv`,
    );

    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(user.accessToken))
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          deletedDocument: true,
          deletedActivityRecords: 0,
        });
      });

    const deleted = await prisma.document.findUnique({
      where: { id: document.id },
    });
    expect(deleted).toBeNull();
  });

  it('returns 403 when deleting another organization document', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Org A`,
      email: `org-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Org B`,
      email: `org-b-${testRunId}@carbonlite-e2e.test`,
    });
    const documentA = await uploadTestDocument(
      userA.accessToken,
      `${testRunId}-org-a.csv`,
    );

    await request(app.getHttpServer())
      .delete(`/api/documents/${documentA.id}`)
      .set(authHeader(userB.accessToken))
      .expect(403);

    const stillExists = await prisma.document.findUnique({
      where: { id: documentA.id },
    });
    expect(stillExists).not.toBeNull();
  });

  it('preserves imported IDs, snapshots, metrics, provenance and Golden A totals after source deletion', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Preservation Org`,
      email: `preservation-${testRunId}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    const auth = authHeader(user.accessToken);
    const document = await uploadTestDocument(user.accessToken, `${testRunId}-golden-a.csv`);
    const confirm = await request(app.getHttpServer())
      .post('/api/document-extraction/confirm').set(auth)
      .send({ documentId: document.id, importBatchId: `${testRunId}-batch`, activities: [
        { activityType: 'ELECTRICITY', quantity: 980, unit: 'kWh', jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta' },
        { activityType: 'HOTEL', quantity: 4, unit: 'nights', jurisdictionCountry: 'Canada' },
        { activityType: 'WATER', quantity: 18, unit: 'm3', jurisdictionCountry: 'Canada' },
      ].map((row, index) => ({ ...row, recordDate: '2026-03-07', sourceReference: `${testRunId}-row-${index}`,
        sourceSheetName: 'March', sourceRow: index + 2, sourcePage: 1, sourceTextSnippet: `Original row ${index + 2}`,
        sourceFileName: document.fileName, notes: 'Preserve source evidence' })) })
      .expect(201);
    expect(confirm.body.count).toBe(3);
    const ids: string[] = confirm.body.createdIds;
    await request(app.getHttpServer()).post('/api/metrics/calculate').set(auth)
      .send({ activityDataIds: ids, metricTypes: ['CARBON_EMISSION'] }).expect(201);

    const before = await prisma.activityData.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const metricsBefore = await prisma.metricResult.findMany({ where: { activityDataId: { in: ids } }, orderBy: { id: 'asc' } });
    const historyBefore = await prisma.auditLog.findMany({ where: { entityId: { in: ids } }, orderBy: { id: 'asc' } });
    expect(metricsBefore).toHaveLength(2);
    expect(historyBefore.some(row => row.action === 'RECALCULATE_ACTIVITY_RECORD' && row.oldValue !== null)).toBe(true);
    const electricity = before.find(row => row.activityType === 'ELECTRICITY')!;
    expect(electricity.calculationSnapshot).toMatchObject({ version: 2,
      factor: { value: 0.53 }, result: { value: 519.4, scope: 'SCOPE_2' } });
    expect(electricity.matchedFactorId).toBeTruthy();
    expect(electricity.matchedFactorName).toBeTruthy();
    expect(electricity.matchedFactorSourceAuthority).toBeTruthy();
    expect(electricity.matchedFactorSourceDocument).toBeTruthy();
    const water = before.find(row => row.activityType === 'WATER')!;
    expect(Number(water.quantity)).toBe(18);
    expect(water.calculationStatus).toBe('TRACKED_ONLY');

    const summaryBefore = await request(app.getHttpServer()).get('/api/metrics/summary').set(auth).expect(200);
    const scopedBefore = await request(app.getHttpServer()).get('/api/metrics/calculation-summary')
      .query({ selectedDocumentIds: document.id }).set(auth).expect(200);
    expect(summaryBefore.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(579.4, 2);
    expect(scopedBefore.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(579.4, 2);

    await request(app.getHttpServer()).delete(`/api/documents/${document.id}`).set(auth)
      .expect(200, { deletedDocument: true, deletedActivityRecords: 0 });
    expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();
    const documents = await request(app.getHttpServer()).get('/api/documents').set(auth).expect(200);
    expect(documents.body.items.some((row: { id: string }) => row.id === document.id)).toBe(false);
    await request(app.getHttpServer()).get(`/api/documents/${document.id}/download`).set(auth).expect(404);
    const after = await prisma.activityData.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before.map(row => ({ ...row, documentId: null })));
    expect(await prisma.metricResult.findMany({ where: { activityDataId: { in: ids } }, orderBy: { id: 'asc' } })).toEqual(metricsBefore);
    expect(await prisma.auditLog.findMany({ where: { entityId: { in: ids } }, orderBy: { id: 'asc' } })).toEqual(historyBefore);
    for (const id of ids) await request(app.getHttpServer()).get(`/api/activity-data/${id}`).set(auth).expect(200);
    const summaryAfter = await request(app.getHttpServer()).get('/api/metrics/summary').set(auth).expect(200);
    const scopedAfter = await request(app.getHttpServer()).get('/api/metrics/calculation-summary')
      .query({ selectedDocumentIds: document.id }).set(auth).expect(200);
    expect(summaryAfter.body.totalsByMetric).toEqual(summaryBefore.body.totalsByMetric);
    expect(summaryAfter.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(579.4, 2);
    expect(scopedAfter.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(579.4, 2);
    const detailsById = (rows: Array<{ activityDataId: string }>) =>
      rows.slice().sort((a, b) => a.activityDataId.localeCompare(b.activityDataId));
    expect(detailsById(scopedAfter.body.calculationDetails)).toEqual(detailsById(scopedBefore.body.calculationDetails));
    expect(await prisma.userActivityEvent.findFirst({ where: { entityId: document.id, eventName: 'DOCUMENT_DELETED' } }))
      .toMatchObject({ metadata: { deletedActivityRecords: 0, preservedActivityRecords: 3 } });
    expect(await prisma.auditLog.findFirst({ where: { entityId: document.id, action: 'DELETE_DOCUMENT' } }))
      .toMatchObject({ oldValue: { deletedActivityRecords: 0, preservedActivityRecords: 3 } });
  });

  it('stores source document metadata during document import', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Import Metadata Org`,
      email: `import-metadata-${testRunId}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-import-metadata.csv`,
    );

    const confirmResponse = await request(app.getHttpServer())
      .post('/api/document-extraction/confirm')
      .set(authHeader(user.accessToken))
      .send({
        documentId: document.id,
        activities: [
          {
            activityType: 'DIESEL',
            recordDate: '2026-05-17',
            quantity: 12,
            unit: 'liters',
            sourceReference: `${testRunId}-import-metadata`,
            notes: 'Imported test row',
          },
        ],
      })
      .expect(201);

    const imported = await prisma.activityData.findUnique({
      where: { id: confirmResponse.body.createdIds[0] },
    });

    expect(imported?.sourceDocumentId).toBe(document.id);
    expect(imported?.sourceFileName).toBe(document.fileName);
  });

  it('does not delete unrelated manual records', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Manual Org`,
      email: `manual-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-manual.csv`,
    );

    const manualActivity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(user.accessToken))
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-05-17',
        quantity: 8,
        unit: 'liters',
        sourceType: 'MANUAL',
        sourceReference: `${testRunId}-manual`,
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    const manualAfterDelete = await prisma.activityData.findUnique({
      where: { id: manualActivity.body.id },
    });

    expect(manualAfterDelete).not.toBeNull();
  });

  it('does not delete another organization records with the same sourceDocumentId', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Source Org A`,
      email: `source-org-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Source Org B`,
      email: `source-org-b-${testRunId}@carbonlite-e2e.test`,
    });
    const documentA = await uploadTestDocument(
      userA.accessToken,
      `${testRunId}-source-a.csv`,
    );
    const activityB = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(userB.accessToken))
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-05-17',
        quantity: 9,
        unit: 'liters',
        sourceType: 'DOCUMENT_AI',
        sourceReference: `${testRunId}-org-b`,
        sourceDocumentId: documentA.id,
        sourceFileName: 'other-org.csv',
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/documents/${documentA.id}`)
      .set(authHeader(userA.accessToken))
      .expect(200);

    const otherOrgRecord = await prisma.activityData.findUnique({
      where: { id: activityB.body.id },
    });
    expect(otherOrgRecord).not.toBeNull();
  });

  it('preserves metrics and report calculation totals while removing the report source link', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Metrics Org`,
      email: `metrics-${testRunId}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-metrics.csv`,
    );
    const activity = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(user.accessToken))
      .send({
        documentId: document.id,
        activityType: 'DIESEL',
        recordDate: '2026-05-17',
        quantity: 10,
        unit: 'liters',
        sourceType: 'DOCUMENT_AI',
        sourceReference: `${testRunId}-metrics`,
        sourceDocumentId: document.id,
        sourceFileName: document.fileName,
      })
      .expect(201);

    await prisma.metricResult.create({
      data: {
        organizationId: user.user.organizationId,
        activityDataId: activity.body.id,
        metricType: 'CARBON_EMISSION',
        value: 26.8,
        unit: 'kgCO2e',
      },
    });

    const report = await request(app.getHttpServer())
      .post('/api/reports')
      .set(authHeader(user.accessToken))
      .send({ title: `${testRunId} Report`, reportingYear: 2026 })
      .expect(201);

    await prisma.document.update({
      where: { id: document.id },
      data: { reportId: report.body.id },
    });

    const summaryBeforeDelete = await request(app.getHttpServer())
      .get('/api/metrics/summary')
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(summaryBeforeDelete.body.totalsByMetric).toEqual(
      expect.arrayContaining([expect.objectContaining({ count: 1 })]),
    );

    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    const summaryAfterDelete = await request(app.getHttpServer())
      .get('/api/metrics/summary')
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(summaryAfterDelete.body.totalsByMetric).toEqual(summaryBeforeDelete.body.totalsByMetric);
    expect(summaryAfterDelete.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(26.8, 2);
    expect(await prisma.metricResult.count({ where: { activityDataId: activity.body.id } })).toBe(1);

    const reportAfterDelete = await request(app.getHttpServer())
      .get(`/api/reports/${report.body.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(reportAfterDelete.body.documents).toEqual([]);
  });

  it('removes unimported extraction and staging artifacts without accounting or audit loss', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Draft Org`, email: `draft-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(user.accessToken, `${testRunId}-draft.csv`);
    const extraction = await prisma.documentExtraction.create({ data: {
      organizationId: user.user.organizationId, documentId: document.id,
      status: 'REVIEW_REQUIRED', extractedJson: {}, extractedRows: [{ quantity: null }],
    } });
    const staged = await prisma.spreadsheetImportReviewRow.create({ data: {
      organizationId: user.user.organizationId, sourceDocumentId: document.id, rowId: 'draft',
      idempotencyKey: `${testRunId}-draft`, issues: [], status: 'NEEDS_REVIEW', sourceType: 'EXCEL',
      activityType: 'ELECTRICITY', unit: 'kWh', sourceFileName: document.fileName,
    } });
    const priorAudit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: document.id, action: 'UPLOAD_DOCUMENT' } });
    await request(app.getHttpServer()).delete(`/api/documents/${document.id}`).set(authHeader(user.accessToken)).expect(200);
    expect(await prisma.documentExtraction.findUnique({ where: { id: extraction.id } })).toBeNull();
    expect(await prisma.spreadsheetImportReviewRow.findUnique({ where: { id: staged.id } })).toBeNull();
    expect(await prisma.activityData.count({ where: { organizationId: user.user.organizationId } })).toBe(0);
    expect(await prisma.auditLog.findUnique({ where: { id: priorAudit.id } })).toEqual(priorAudit);
  });

  it('keeps three imported records when a nine-row partially imported source is removed', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Partial Org`, email: `partial-${testRunId}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    const auth = authHeader(user.accessToken);
    const ready = [
      { activityType: 'ELECTRICITY', quantity: 980, unit: 'kWh', jurisdictionRegion: 'Alberta', status: 'READY' },
      { activityType: 'HOTEL', quantity: 4, unit: 'nights', status: 'READY' },
      { activityType: 'WATER', quantity: 18, unit: 'm3', status: 'TRACKED_ONLY', calculationStatus: 'TRACKED_ONLY' },
    ];
    const unresolved = Array.from({ length: 6 }, () => ({ activityType: 'ELECTRICITY', quantity: null, unit: 'kWh', status: 'NEEDS_REVIEW' }));
    const staged = await request(app.getHttpServer()).post('/api/spreadsheet-import/review-rows').set(auth)
      .send({ sourceType: 'EXCEL', sourceFileName: `${testRunId}-partial.xlsx`, importBatchId: `${testRunId}-partial`,
        rows: [...ready, ...unresolved].map((row, index) => ({ ...row, rowId: `partial-${index}`, sourceRow: index + 2,
          issues: [], sourceSheetName: 'March', sourceReference: `partial-${index}`, jurisdictionCountry: 'Canada', recordDate: '2026-03-07' })) })
      .expect(201);
    const documentId: string = staged.body.sourceDocument.id;
    const confirmed = await request(app.getHttpServer()).post('/api/document-extraction/confirm').set(auth)
      .send({ documentId, activities: [] }).expect(201);
    expect(confirmed.body.count).toBe(3);
    expect(await prisma.spreadsheetImportReviewRow.count({ where: { sourceDocumentId: documentId, status: 'NEEDS_REVIEW' } })).toBe(6);
    expect(await prisma.document.findUnique({ where: { id: documentId } })).toMatchObject({ status: 'REVIEW_REQUIRED' });
    const ids: string[] = confirmed.body.createdIds;
    const before = await prisma.activityData.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const summaryBefore = await request(app.getHttpServer()).get('/api/metrics/summary').set(auth).expect(200);
    expect(summaryBefore.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(579.4, 2);
    await request(app.getHttpServer()).delete(`/api/documents/${documentId}`).set(auth).expect(200);
    expect(await prisma.document.findUnique({ where: { id: documentId } })).toBeNull();
    expect(await prisma.activityData.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }))
      .toEqual(before.map(row => ({ ...row, documentId: null })));
    expect(await prisma.spreadsheetImportReviewRow.count({ where: { sourceDocumentId: documentId } })).toBe(0);
    expect(await prisma.documentExtraction.count({ where: { documentId } })).toBe(0);
    const summaryAfter = await request(app.getHttpServer()).get('/api/metrics/summary').set(auth).expect(200);
    expect(summaryAfter.body.totalsByMetric).toEqual(summaryBefore.body.totalsByMetric);
  });

  it('preserves another source, both sources accounting records and the workspace total', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Multi Org`, email: `multi-${testRunId}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    const auth = authHeader(user.accessToken);
    const documents: Array<{ id: string }> = [];
    const ids: string[] = [];
    for (const [index, quantity] of [50, 100].entries()) {
      const document = await uploadTestDocument(user.accessToken, `${testRunId}-multi-${index}.csv`);
      documents.push(document);
      const confirmed = await request(app.getHttpServer()).post('/api/document-extraction/confirm').set(auth)
        .send({ documentId: document.id, activities: [{ activityType: 'DIESEL', quantity, unit: 'liters', recordDate: '2026-03-07',
          sourceRow: 2, sourceReference: `multi-${index}`, jurisdictionCountry: 'Canada' }] }).expect(201);
      ids.push(...confirmed.body.createdIds);
    }
    const before = await prisma.activityData.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const documentBBefore = await prisma.document.findUniqueOrThrow({ where: { id: documents[1].id } });
    const summaryBefore = await request(app.getHttpServer()).get('/api/metrics/summary').set(auth).expect(200);
    expect(summaryBefore.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(402, 2);
    await request(app.getHttpServer()).delete(`/api/documents/${documents[0].id}`).set(auth).expect(200);
    expect(await prisma.document.findUnique({ where: { id: documents[0].id } })).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: documents[1].id } })).toEqual(documentBBefore);
    expect(await prisma.activityData.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }))
      .toEqual(before.map(row => row.documentId === documents[0].id ? { ...row, documentId: null } : row));
    const summaryAfter = await request(app.getHttpServer()).get('/api/metrics/summary').set(auth).expect(200);
    expect(summaryAfter.body.totalsByMetric).toEqual(summaryBefore.body.totalsByMetric);
    expect(summaryAfter.body.totalEstimatedEmissionsKgCO2e).toBeCloseTo(402, 2);
  });

  it('returns 404 for a missing document', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Missing Org`,
      email: `missing-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .delete('/api/documents/missing-document-id')
      .set(authHeader(user.accessToken))
      .expect(404);
  });

  it('returns 401 without authentication', async () => {
    await request(app.getHttpServer())
      .delete('/api/documents/missing-document-id')
      .expect(401);
  });
});
