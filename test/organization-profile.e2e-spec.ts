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

describe('Organization profile routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('organization-profile');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('requires auth for GET /api/organization-profile instead of returning 404', async () => {
    await request(app.getHttpServer())
      .get('/api/organization-profile')
      .expect(401);
  });

  it('allows authenticated customer users to load their organization profile defaults', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${testRunId} Customer Org`,
      email: `customer-${testRunId}@carbonlite-e2e.test`,
    });

    const response = await request(app.getHttpServer())
      .get('/api/organization-profile')
      .set(authHeader(customer.accessToken))
      .expect(200);

    expect(response.body).toMatchObject({
      organizationName: `${testRunId} Customer Org`,
      country: 'Canada',
      reportingPeriodStart: '2026-01-01',
      reportingPeriodEnd: '2026-12-31',
    });
  });

  it('allows customer admins to PATCH only their current organization profile', async () => {
    const admin = await createTestUser(app, {
      organizationName: `${testRunId} Editable Org`,
      email: `admin-${testRunId}@carbonlite-e2e.test`,
    });
    const other = await createTestUser(app, {
      organizationName: `${testRunId} Other Org`,
      email: `other-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { role: 'ADMIN' },
    });

    await request(app.getHttpServer())
      .patch('/api/organization-profile')
      .set(authHeader(admin.accessToken))
      .send({
        organizationName: `${testRunId} Updated Editable Org`,
        industry: 'Technology',
        country: 'Canada',
        provinceOrState: 'Alberta',
        city: 'Calgary',
        primaryContactName: 'Boundary Admin',
        primaryContactEmail: 'Admin@Example.com',
        reportingPeriodStart: '2026-01-01',
        reportingPeriodEnd: '2026-12-31',
        geographicBoundary: 'Canadian operations',
        includedFacilitiesOrLocations: 'Calgary office',
        excludedFacilitiesOrLocations: '',
        includedScopes: 'Scope 1 and Scope 2',
        scope3CoverageNote: 'Selected Scope 3 only.',
        exclusionsAndLimitations: 'Pilot workflow only.',
        boundaryNotes: 'Saved through route test.',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          organizationName: `${testRunId} Updated Editable Org`,
          primaryContactEmail: 'admin@example.com',
          city: 'Calgary',
        });
      });

    await expect(
      prisma.organization.findUniqueOrThrow({
        where: { id: admin.user.organizationId },
      }),
    ).resolves.toMatchObject({
      name: `${testRunId} Updated Editable Org`,
      primaryContactEmail: 'admin@example.com',
    });
    await expect(
      prisma.organization.findUniqueOrThrow({
        where: { id: other.user.organizationId },
      }),
    ).resolves.toMatchObject({
      name: `${testRunId} Other Org`,
      primaryContactEmail: null,
    });
  });

  it('allows pilot reviewers to view but not update organization profile', async () => {
    const reviewer = await createTestUser(app, {
      organizationName: `${testRunId} Reviewer Org`,
      email: `reviewer-${testRunId}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: reviewer.user.id },
      data: {
        accountType: 'PILOT_REVIEWER',
        role: 'USER',
      },
    });

    await request(app.getHttpServer())
      .get('/api/organization-profile')
      .set(authHeader(reviewer.accessToken))
      .expect(200);

    await request(app.getHttpServer())
      .patch('/api/organization-profile')
      .set(authHeader(reviewer.accessToken))
      .send({
        organizationName: `${testRunId} Reviewer Edit`,
        industry: 'Technology',
        country: 'Canada',
        provinceOrState: 'Alberta',
      })
      .expect(403);
  });
});
