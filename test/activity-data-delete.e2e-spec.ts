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

describe('ActivityData delete persistence (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('activity-delete');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  async function createActivity(token: string, sourceReference: string) {
    const response = await request(app.getHttpServer())
      .post('/api/activity-data')
      .set(authHeader(token))
      .send({
        activityType: 'DIESEL',
        recordDate: '2026-05-21',
        quantity: 10,
        unit: 'liters',
        sourceType: 'MANUAL',
        sourceReference,
      })
      .expect(201);

    return response.body;
  }

  it('deletes one record and list refresh confirms it is gone', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Single Delete Org`,
      email: `single-${testRunId}@carbonlite-e2e.test`,
    });
    const activity = await createActivity(user.accessToken, `${testRunId}-single`);

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/api/activity-data/${activity.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(deleteResponse.body.deletedCount).toBe(1);

    const listResponse = await request(app.getHttpServer())
      .get('/api/activity-data')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(listResponse.body.items.map((item: { id: string }) => item.id)).not.toContain(
      activity.id,
    );

    const dbRecord = await prisma.activityData.findUnique({
      where: { id: activity.id },
    });
    expect(dbRecord).toBeNull();
  });

  it('bulk delete persists after reload', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Bulk Delete Org`,
      email: `bulk-${testRunId}@carbonlite-e2e.test`,
    });
    const activityA = await createActivity(user.accessToken, `${testRunId}-bulk-a`);
    const activityB = await createActivity(user.accessToken, `${testRunId}-bulk-b`);

    const deleteResponse = await request(app.getHttpServer())
      .post('/api/activity-data/bulk-delete')
      .set(authHeader(user.accessToken))
      .send({ ids: [activityA.id, activityB.id] })
      .expect(200);

    expect(deleteResponse.body.deletedCount).toBe(2);

    const listResponse = await request(app.getHttpServer())
      .get('/api/activity-data')
      .set(authHeader(user.accessToken))
      .expect(200);

    const ids = listResponse.body.items.map((item: { id: string }) => item.id);
    expect(ids).not.toContain(activityA.id);
    expect(ids).not.toContain(activityB.id);
  });

  it('cannot delete another organization record', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Org A`,
      email: `org-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Org B`,
      email: `org-b-${testRunId}@carbonlite-e2e.test`,
    });
    const activityA = await createActivity(userA.accessToken, `${testRunId}-owned-a`);

    await request(app.getHttpServer())
      .delete(`/api/activity-data/${activityA.id}`)
      .set(authHeader(userB.accessToken))
      .expect(404);

    await request(app.getHttpServer())
      .get(`/api/activity-data/${activityA.id}`)
      .set(authHeader(userA.accessToken))
      .expect(200);
  });

  it('bulk delete cannot remove another organization record', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Bulk Org A`,
      email: `bulk-org-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Bulk Org B`,
      email: `bulk-org-b-${testRunId}@carbonlite-e2e.test`,
    });
    const activityA = await createActivity(userA.accessToken, `${testRunId}-bulk-owned-a`);

    await request(app.getHttpServer())
      .post('/api/activity-data/bulk-delete')
      .set(authHeader(userB.accessToken))
      .send({ ids: [activityA.id] })
      .expect(404);

    await request(app.getHttpServer())
      .get(`/api/activity-data/${activityA.id}`)
      .set(authHeader(userA.accessToken))
      .expect(200);
  });
});
