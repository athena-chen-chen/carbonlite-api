import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrganizationQuotasService } from '../src/organization-quotas/organization-quotas.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);

describe('organization upload quotas', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let quotas: OrganizationQuotasService;
  const run = uniqueTestId('organization-upload-quota');

  beforeAll(async () => {
    ({ app, prisma } = await createE2eApp());
    quotas = app.get(OrganizationQuotasService);
  });

  afterAll(async () => {
    if (prisma) await cleanupTestData(prisma, run);
    if (app) await app.close();
  });

  it('atomically isolates tenants, retains deletion usage, and rolls expired periods', async () => {
    const [userA, userB] = await Promise.all([
      createTestUser(app, { organizationName: `${run}-a`, email: `${run}-a@carbonlite-e2e.test` }),
      createTestUser(app, { organizationName: `${run}-b`, email: `${run}-b@carbonlite-e2e.test` }),
    ]);
    for (const organizationId of [userA.user.organizationId, userB.user.organizationId]) {
      await prisma.organizationQuota.create({
        data: {
          organizationId,
          enabled: true,
          uploadLimit: 1,
          dailyUploadLimit: 10,
        },
      });
    }
    const upload = (token: string, body: Buffer, name: string) =>
      request(app.getHttpServer())
        .post('/api/documents/upload')
        .set(authHeader(token))
        .field('type', 'PDF')
        .field('allowDuplicate', 'true')
        .attach('file', body, { filename: name, contentType: 'application/pdf' });

    await upload(userA.accessToken, Buffer.from('not a pdf'), 'invalid.pdf').expect(400);
    expect(await prisma.organizationQuotaUsage.count({
      where: { organizationId: userA.user.organizationId },
    })).toBe(0);

    const concurrent = await Promise.all([
      upload(userA.accessToken, pdf('concurrent-a'), 'concurrent-a.pdf'),
      upload(userA.accessToken, pdf('concurrent-b'), 'concurrent-b.pdf'),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 429]);
    const accepted = concurrent.find((response) => response.status === 201)!;
    const rejected = concurrent.find((response) => response.status === 429)!;
    expect(rejected.body).toMatchObject({
      code: 'UPLOAD_PERIOD_QUOTA_EXCEEDED', limit: 1, remaining: 0,
    });
    expect(await prisma.document.count({
      where: { organizationId: userA.user.organizationId },
    })).toBe(1);
    expect(await prisma.organizationQuotaUsage.count({
      where: { organizationId: userA.user.organizationId },
    })).toBe(1);

    await request(app.getHttpServer())
      .delete(`/api/documents/${accepted.body.id}`)
      .set(authHeader(userA.accessToken))
      .expect(200);
    await upload(userA.accessToken, pdf('after-delete'), 'after-delete.pdf').expect(429);
    expect(await prisma.organizationQuotaUsage.count({
      where: { organizationId: userA.user.organizationId },
    })).toBe(1);

    const period = await prisma.organizationQuotaPeriod.findFirstOrThrow({
      where: { organizationId: userA.user.organizationId, closedAt: null },
    });
    const now = new Date();
    await prisma.organizationQuotaPeriod.update({
      where: { id: period.id },
      data: {
        startsAt: new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000),
        endsAt: new Date(now.getTime() - 1000),
      },
    });
    const afterRollover = await upload(
      userA.accessToken,
      pdf('after-rollover'),
      'after-rollover.pdf',
    ).expect(201);
    expect(await prisma.organizationQuotaUsage.count({
      where: { organizationId: userA.user.organizationId },
    })).toBe(2);

    const tenantB = await upload(
      userB.accessToken,
      pdf('tenant-b'),
      'tenant-b.pdf',
    ).expect(201);
    expect(await prisma.organizationQuotaUsage.count({
      where: { organizationId: userB.user.organizationId },
    })).toBe(1);

    await Promise.all([
      request(app.getHttpServer()).delete(`/api/documents/${afterRollover.body.id}`).set(authHeader(userA.accessToken)).expect(200),
      request(app.getHttpServer()).delete(`/api/documents/${tenantB.body.id}`).set(authHeader(userB.accessToken)).expect(200),
    ]);
  });

  it('enforces configured row limits at spreadsheet staging and bulk import', async () => {
    const user = await createTestUser(app, {
      organizationName: `${run}-rows`,
      email: `${run}-rows@carbonlite-e2e.test`,
    });
    await prisma.organizationQuota.create({
      data: {
        organizationId: user.user.organizationId,
        enabled: true,
        maxImportRows: 500,
      },
    });
    const rows = Array.from({ length: 501 }, (_, index) => ({
      rowId: `row-${index + 1}`,
      status: 'READY',
      activityType: 'DIESEL',
      recordDate: '2026-01-01',
      quantity: 1,
      unit: 'liters',
      issues: [],
    }));

    const acceptedRows = rows.slice(0, 500);
    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send({ sourceType: 'CSV', sourceFileName: 'at-limit.csv', rows: acceptedRows })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/activity-data/bulk-import')
      .set(authHeader(user.accessToken))
      .send({
        items: acceptedRows.map(({ activityType, recordDate, quantity, unit }) => ({
          activityType, recordDate, quantity, unit, sourceType: 'IMPORT',
        })),
      })
      .expect(201);

    const beforeRejectedRequests = {
      documents: await prisma.document.count({
        where: { organizationId: user.user.organizationId },
      }),
      activities: await prisma.activityData.count({
        where: { organizationId: user.user.organizationId },
      }),
    };

    await request(app.getHttpServer())
      .post('/api/spreadsheet-import/review-rows')
      .set(authHeader(user.accessToken))
      .send({ sourceType: 'CSV', sourceFileName: 'too-many.csv', rows })
      .expect(429)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'IMPORT_ROW_QUOTA_EXCEEDED', limit: 500 });
      });

    await request(app.getHttpServer())
      .post('/api/activity-data/bulk-import')
      .set(authHeader(user.accessToken))
      .send({
        items: rows.map(({ activityType, recordDate, quantity, unit }) => ({
          activityType, recordDate, quantity, unit, sourceType: 'IMPORT',
        })),
      })
      .expect(429)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'IMPORT_ROW_QUOTA_EXCEEDED', limit: 500 });
      });

    expect(await prisma.document.count({
      where: { organizationId: user.user.organizationId },
    })).toBe(beforeRejectedRequests.documents);
    expect(await prisma.activityData.count({
      where: { organizationId: user.user.organizationId },
    })).toBe(beforeRejectedRequests.activities);
  });

  it('isolates extraction leases by tenant and recovers expired capacity', async () => {
    const [userA, userB] = await Promise.all([
      createTestUser(app, { organizationName: `${run}-lease-a`, email: `${run}-lease-a@carbonlite-e2e.test` }),
      createTestUser(app, { organizationName: `${run}-lease-b`, email: `${run}-lease-b@carbonlite-e2e.test` }),
    ]);
    for (const organizationId of [userA.user.organizationId, userB.user.organizationId]) {
      await prisma.organizationQuota.create({
        data: { organizationId, enabled: true, maxConcurrentExtractions: 2 },
      });
    }
    const documentsA = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      prisma.document.create({
        data: {
          organizationId: userA.user.organizationId,
          uploadedById: userA.user.id,
          fileName: `lease-a-${index}.pdf`,
          fileUrl: `test://lease-a-${index}`,
          type: 'PDF',
        },
      })));
    const documentB = await prisma.document.create({
      data: {
        organizationId: userB.user.organizationId,
        uploadedById: userB.user.id,
        fileName: 'lease-b.pdf',
        fileUrl: 'test://lease-b',
        type: 'PDF',
      },
    });

    const first = await quotas.beginExtraction({
      organizationId: userA.user.organizationId,
      documentId: documentsA[0].id,
      userId: userA.user.id,
    });
    const second = await quotas.beginExtraction({
      organizationId: userA.user.organizationId,
      documentId: documentsA[1].id,
      userId: userA.user.id,
    });
    await expect(quotas.beginExtraction({
      organizationId: userA.user.organizationId,
      documentId: documentsA[2].id,
      userId: userA.user.id,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EXTRACTION_CONCURRENCY_EXCEEDED' }),
    });

    const otherTenant = await quotas.beginExtraction({
      organizationId: userB.user.organizationId,
      documentId: documentB.id,
      userId: userB.user.id,
    });
    expect(otherTenant).toBeTruthy();

    await prisma.aIJob.update({
      where: { id: first!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const recovered = await quotas.beginExtraction({
      organizationId: userA.user.organizationId,
      documentId: documentsA[2].id,
      userId: userA.user.id,
    });
    expect(recovered).toBeTruthy();
    expect(await prisma.aIJob.findUnique({ where: { id: first!.id } })).toMatchObject({
      status: 'FAILED',
      errorMessage: 'Extraction lease expired before completion.',
    });

    await Promise.all([
      quotas.finishExtraction(userA.user.organizationId, second!.id, 'COMPLETED'),
      quotas.finishExtraction(userA.user.organizationId, recovered!.id, 'COMPLETED'),
      quotas.finishExtraction(userB.user.organizationId, otherTenant!.id, 'COMPLETED'),
    ]);
  });

  it('leaves organizations without an enabled quota policy unchanged', async () => {
    const user = await createTestUser(app, {
      organizationName: `${run}-disabled`,
      email: `${run}-disabled@carbonlite-e2e.test`,
    });
    expect(await prisma.organizationQuota.findUnique({
      where: { organizationId: user.user.organizationId },
    })).toBeNull();

    const uploaded = await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(user.accessToken))
      .field('type', 'PDF')
      .attach('file', pdf('quota-disabled'), {
        filename: 'quota-disabled.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(await quotas.getStatus(user.user.organizationId)).toMatchObject({ enabled: false });
    await expect(quotas.assertImportRows(user.user.organizationId, 501)).resolves.toBeUndefined();
    await expect(quotas.beginExtraction({
      organizationId: user.user.organizationId,
      documentId: uploaded.body.id,
      userId: user.user.id,
    })).resolves.toBeNull();
    expect(await prisma.organizationQuotaPeriod.count({
      where: { organizationId: user.user.organizationId },
    })).toBe(0);
    expect(await prisma.organizationQuotaUsage.count({
      where: { organizationId: user.user.organizationId },
    })).toBe(0);
    expect(await prisma.aIJob.count({
      where: { organizationId: user.user.organizationId },
    })).toBe(0);

    await request(app.getHttpServer())
      .delete(`/api/documents/${uploaded.body.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);
  });
});
