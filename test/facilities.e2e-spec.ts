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

describe('Facilities (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('facilities');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/facilities').expect(401);
  });

  it('returns an empty list when the company has no facilities', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Empty Org`,
      email: `empty-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .get('/api/facilities')
      .set(authHeader(user.accessToken))
      .expect(200)
      .expect([]);
  });

  it('returns only facilities for the current company', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Org A`,
      email: `user-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Org B`,
      email: `user-b-${testRunId}@carbonlite-e2e.test`,
    });

    const facilityA = await request(app.getHttpServer())
      .post('/api/facilities')
      .set(authHeader(userA.accessToken))
      .send({
        name: `${testRunId} Calgary Main Office`,
        city: 'Calgary',
        provinceState: 'AB',
        country: 'Canada',
      })
      .expect(201);

    const facilitiesA = await request(app.getHttpServer())
      .get('/api/facilities')
      .set(authHeader(userA.accessToken))
      .expect(200);
    expect(facilitiesA.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: facilityA.body.id,
          organizationId: userA.user.organizationId,
          name: `${testRunId} Calgary Main Office`,
          city: 'Calgary',
          provinceState: 'Alberta',
          country: 'Canada',
        }),
      ]),
    );

    const facilitiesB = await request(app.getHttpServer())
      .get('/api/facilities')
      .set(authHeader(userB.accessToken))
      .expect(200);
    expect(facilitiesB.body.map((item: { id: string }) => item.id)).not.toContain(
      facilityA.body.id,
    );
  });
});
