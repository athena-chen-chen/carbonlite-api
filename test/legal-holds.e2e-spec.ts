import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DOCUMENT_STORAGE, DocumentStorage, documentStorageKey } from '../src/documents/document-storage';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  loginAndGetToken,
  TestUser,
  uniqueTestId,
} from './helpers/factories';

describe('Minimum legal hold enforcement (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: DocumentStorage;
  let target: TestUser;
  let unrelated: TestUser;
  let operator: TestUser;
  let approver: TestUser;
  let releaseOperator: TestUser;
  let targetToken: string;
  let operatorToken: string;
  let approverToken: string;
  let releaseOperatorToken: string;
  let heldDocument: { id: string; fileUrl: string };
  const testRunId = uniqueTestId('legal-hold');
  const password = 'Fictional-Test-Only!2026';

  beforeAll(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
    storage = app.get(DOCUMENT_STORAGE);

    [target, unrelated, operator, approver, releaseOperator] = await Promise.all([
      createTestUser(app, { organizationName: `${testRunId} Target`, email: `target-${testRunId}@carbonlite-e2e.test`, password }),
      createTestUser(app, { organizationName: `${testRunId} Unrelated`, email: `unrelated-${testRunId}@carbonlite-e2e.test`, password }),
      createTestUser(app, { organizationName: `${testRunId} Operator`, email: `operator-${testRunId}@carbonlite-e2e.test`, password }),
      createTestUser(app, { organizationName: `${testRunId} Approver`, email: `approver-${testRunId}@carbonlite-e2e.test`, password }),
      createTestUser(app, { organizationName: `${testRunId} Release Operator`, email: `release-${testRunId}@carbonlite-e2e.test`, password }),
    ]);
    await prisma.membership.create({
      data: { userId: target.user.id, organizationId: target.user.organizationId, role: 'OWNER' },
    });
    await prisma.user.updateMany({
      where: { id: { in: [operator.user.id, approver.user.id, releaseOperator.user.id] } },
      data: { role: 'ADMIN' },
    });
    [targetToken, operatorToken, approverToken, releaseOperatorToken] = await Promise.all([
      loginAndGetToken(app, target.user.email, password),
      loginAndGetToken(app, operator.user.email, password),
      loginAndGetToken(app, approver.user.email, password),
      loginAndGetToken(app, releaseOperator.user.email, password),
    ]);
    heldDocument = await upload(targetToken, `${testRunId}-held.csv`);
    await upload(targetToken, `${testRunId}-free.csv`);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.legalHoldEvent.deleteMany({ where: { caseReference: { contains: testRunId } } });
      await cleanupTestData(prisma, testRunId);
    }
    if (app) await app.close();
  });

  async function upload(token: string, filename: string) {
    const response = await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(token))
      .field('type', 'SPREADSHEET')
      .attach('file', Buffer.from(`activityType,recordDate,quantity,unit\nDIESEL,2026-01-01,1,L\n# ${filename}\n`), {
        filename,
        contentType: 'text/csv',
      })
      .expect(201);
    return response.body;
  }

  async function activate(
    organizationId: string,
    caseReference: string,
    scopeType: 'ORGANIZATION' | 'DOCUMENT',
    documentIds: string[] = [],
  ) {
    return request(app.getHttpServer())
      .post('/api/admin/legal-holds/activate')
      .set(authHeader(approverToken))
      .send({
        organizationId,
        caseReference,
        scopeType,
        documentIds,
        authorityReference: `${testRunId}-authority`,
        evidenceReference: `${testRunId}-evidence`,
        requesterUserId: target.user.id,
        approvedByUserId: approver.user.id,
      })
      .expect(201);
  }

  function expectHoldConflict(response: request.Response) {
    expect(response.body).toMatchObject({
      statusCode: 409,
      code: 'LEGAL_HOLD_ACTIVE',
      message: 'Deletion is temporarily restricted.',
    });
    expect(JSON.stringify(response.body)).not.toContain(testRunId);
  }

  it('requires platform authority and an independent approver', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/legal-holds/activate')
      .set(authHeader(targetToken))
      .send({
        organizationId: target.user.organizationId,
        caseReference: `${testRunId}-unauthorized`,
        scopeType: 'ORGANIZATION',
        authorityReference: 'synthetic',
        requesterUserId: target.user.id,
        approvedByUserId: approver.user.id,
      })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/admin/legal-holds/activate')
      .set(authHeader(operatorToken))
      .send({
        organizationId: target.user.organizationId,
        caseReference: `${testRunId}-forged-approval`,
        scopeType: 'ORGANIZATION',
        authorityReference: 'synthetic',
        requesterUserId: target.user.id,
        approvedByUserId: approver.user.id,
      })
      .expect(403);
  });

  it('blocks an organization hold, preserves file bytes, and release does not delete data', async () => {
    const activated = await activate(
      target.user.organizationId,
      `${testRunId}-organization`,
      'ORGANIZATION',
    );

    const blocked = await request(app.getHttpServer())
      .delete(`/api/documents/${heldDocument.id}`)
      .set(authHeader(targetToken))
      .expect(409);
    expectHoldConflict(blocked);
    await expect(storage.read(documentStorageKey(heldDocument.fileUrl))).resolves.toEqual(expect.any(Buffer));

    await request(app.getHttpServer())
      .post(`/api/admin/legal-holds/${activated.body.id}/release-request`)
      .set(authHeader(targetToken))
      .send({ evidenceReference: `${testRunId}-unauthorized-release` })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/admin/legal-holds/${activated.body.id}/release-request`)
      .set(authHeader(operatorToken))
      .send({ evidenceReference: `${testRunId}-release-request` })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/admin/legal-holds/${activated.body.id}/release`)
      .set(authHeader(targetToken))
      .send({
        evidenceReference: `${testRunId}-unauthorized-release`,
      })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/admin/legal-holds/${activated.body.id}/release`)
      .set(authHeader(releaseOperatorToken))
      .send({ evidenceReference: `${testRunId}-premature-release` })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/api/admin/legal-holds/${activated.body.id}/release-review`)
      .set(authHeader(approverToken))
      .send({
        authorityReference: `${testRunId}-release-authority`,
        evidenceReference: `${testRunId}-release-review`,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/admin/legal-holds/${activated.body.id}/release`)
      .set(authHeader(releaseOperatorToken))
      .send({
        evidenceReference: `${testRunId}-release-evidence`,
      })
      .expect(201);

    expect(await prisma.document.findUnique({ where: { id: heldDocument.id } })).not.toBeNull();
    await expect(storage.read(documentStorageKey(heldDocument.fileUrl))).resolves.toEqual(expect.any(Buffer));
  });

  it('enforces document dependencies across single, bulk, admin, report, factor, and workspace paths', async () => {
    await activate(
      target.user.organizationId,
      `${testRunId}-document`,
      'DOCUMENT',
      [heldDocument.id],
    );
    const [heldActivity, freeActivity] = await Promise.all([
      prisma.activityData.create({
        data: {
          organizationId: target.user.organizationId,
          documentId: heldDocument.id,
          sourceDocumentId: heldDocument.id,
          activityType: 'DIESEL',
          recordDate: new Date('2026-01-01T00:00:00.000Z'),
          quantity: 1,
          unit: 'L',
          sourceType: 'DOCUMENT_AI',
          sourceReference: 'Golden Test Data.xlsx',
          sourceFileName: 'Golden Test Data.xlsx',
        },
      }),
      prisma.activityData.create({
        data: {
          organizationId: target.user.organizationId,
          activityType: 'DIESEL',
          recordDate: new Date('2026-01-02T00:00:00.000Z'),
          quantity: 2,
          unit: 'L',
          sourceType: 'MANUAL',
        },
      }),
    ]);
    const report = await prisma.report.create({
      data: { organizationId: target.user.organizationId, title: `${testRunId} held report` },
    });
    await prisma.document.update({ where: { id: heldDocument.id }, data: { reportId: report.id } });
    const factor = await prisma.conversionFactor.create({
      data: {
        organizationId: target.user.organizationId,
        name: `${testRunId} custom factor`,
        type: 'CUSTOM',
        activityType: 'DIESEL',
        unit: 'L',
        factorValue: 1,
        resultUnit: 'kgCO2e',
      },
    });
    await prisma.metricResult.create({
      data: {
        organizationId: target.user.organizationId,
        activityDataId: heldActivity.id,
        factorId: factor.id,
        metricType: 'CARBON_EMISSION',
        value: 1,
        unit: 'kgCO2e',
      },
    });

    expectHoldConflict(await request(app.getHttpServer())
      .delete(`/api/activity-data/${heldActivity.id}`)
      .set(authHeader(targetToken)).expect(409));
    expectHoldConflict(await request(app.getHttpServer())
      .post('/api/activity-data/bulk-delete')
      .set(authHeader(targetToken)).send({ ids: [heldActivity.id, freeActivity.id] }).expect(409));
    expectHoldConflict(await request(app.getHttpServer())
      .delete('/api/activity-data/bulk-delete')
      .set(authHeader(targetToken)).send({ ids: [heldActivity.id, freeActivity.id] }).expect(409));
    expect(await prisma.activityData.count({ where: { id: { in: [heldActivity.id, freeActivity.id] } } })).toBe(2);

    expectHoldConflict(await request(app.getHttpServer())
      .delete('/api/admin/activity-records/clear')
      .set(authHeader(targetToken)).send({ confirmation: 'CLEAR RECORDS' }).expect(409));
    expectHoldConflict(await request(app.getHttpServer())
      .delete(`/api/reports/${report.id}`)
      .set(authHeader(targetToken)).expect(409));
    expectHoldConflict(await request(app.getHttpServer())
      .delete(`/api/conversion-factors/${factor.id}`)
      .set(authHeader(targetToken)).expect(409));

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: target.user.organizationId },
    });
    expectHoldConflict(await request(app.getHttpServer())
      .post('/api/admin/customer-provisioning/golden-sample-cleanup')
      .set(authHeader(releaseOperatorToken))
      .send({
        organizationId: organization.id,
        confirmationOrganizationId: organization.id,
        confirmationOrganizationSlug: organization.slug,
        confirmCleanup: true,
      }).expect(409));
    expectHoldConflict(await request(app.getHttpServer())
      .post('/api/admin/workspace-erasure/erase')
      .set(authHeader(releaseOperatorToken))
      .send({
        organizationId: organization.id,
        confirmationOrganizationId: organization.id,
        confirmationOrganizationSlug: organization.slug,
        confirmErase: true,
      }).expect(409));
  });

  it('does not affect another organization', async () => {
    const document = await upload(unrelated.accessToken, `${testRunId}-unrelated.csv`);
    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(unrelated.accessToken))
      .expect(200);
    expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();
  });

  it('serializes concurrent activation before a queued deletion', async () => {
    const concurrent = await createTestUser(app, {
      organizationName: `${testRunId} Concurrent`,
      email: `concurrent-${testRunId}@carbonlite-e2e.test`,
      password,
    });
    const document = await upload(concurrent.accessToken, `${testRunId}-concurrent.csv`);
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const lockTransaction = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${concurrent.user.organizationId}, 0))`;
      markLocked();
      await new Promise<void>((resolve) => { releaseLock = resolve; });
    });
    await locked;

    const activation = activate(
      concurrent.user.organizationId,
      `${testRunId}-concurrent`,
      'ORGANIZATION',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deletion = request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(concurrent.accessToken))
      .expect(409)
      .then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLock();
    await lockTransaction;

    await activation;
    expectHoldConflict(await deletion);
    expect(await prisma.document.findUnique({ where: { id: document.id } })).not.toBeNull();
  });
});
