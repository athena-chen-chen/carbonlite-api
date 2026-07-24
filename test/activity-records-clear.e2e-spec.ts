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

describe('Clear activity records (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('clear-activity-records');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('requires confirmation', async () => {
    const admin = await createAdminUser('requires-confirmation');

    await request(app.getHttpServer())
      .delete('/api/admin/activity-records/clear')
      .set(authHeader(admin.accessToken))
      .send({ confirmation: 'CLEAR' })
      .expect(400);
  });

  it('clears only current organization activity records and dependent metric results', async () => {
    const admin = await createAdminUser('admin');
    const other = await createAdminUser('other');

    const adminFacility = await prisma.facility.create({
      data: {
        organizationId: admin.user.organizationId,
        name: `${testRunId} Admin Facility`,
      },
    });
    const otherFacility = await prisma.facility.create({
      data: {
        organizationId: other.user.organizationId,
        name: `${testRunId} Other Facility`,
      },
    });
    const adminFactor = await createFactor(admin.user.organizationId, `${testRunId} Admin factor`);
    const otherFactor = await createFactor(other.user.organizationId, `${testRunId} Other factor`);

    const adminActivity = await createActivity(admin.user.organizationId, adminFacility.id);
    const otherActivity = await createActivity(other.user.organizationId, otherFacility.id);
    await createMetricResult(admin.user.organizationId, adminFacility.id, adminActivity.id, adminFactor.id);
    await createMetricResult(other.user.organizationId, otherFacility.id, otherActivity.id, otherFactor.id);

    const response = await request(app.getHttpServer())
      .delete('/api/admin/activity-records/clear')
      .set(authHeader(admin.accessToken))
      .send({ confirmation: 'CLEAR RECORDS' })
      .expect(200);

    expect(response.body).toMatchObject({
      deletedActivityRecords: 1,
      deletedCalculationResults: 1,
      deletedCalculationDetails: 1,
      clearedMetricsCache: 0,
      deletedImportBatches: 0,
      resetReports: 0,
      message: 'Activity records cleared successfully.',
    });

    await expectTenantCounts(admin.user.organizationId, {
      activityData: 0,
      metricResult: 0,
      facility: 1,
      factor: 1,
      user: 1,
    });
    await expectTenantCounts(other.user.organizationId, {
      activityData: 1,
      metricResult: 1,
      facility: 1,
      factor: 1,
      user: 1,
    });
  });

  it('returns 403 for non-admin users', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} User Org`,
      email: `user-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .delete('/api/admin/activity-records/clear')
      .set(authHeader(user.accessToken))
      .send({ confirmation: 'CLEAR RECORDS' })
      .expect(403);
  });

  async function createAdminUser(label: string) {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} ${label} Org`,
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@carbonlite-e2e.test`,
    });

    await prisma.user.update({
      where: { id: user.user.id },
      data: { role: 'ADMIN' },
    });

    return user;
  }

  function createFactor(organizationId: string, name: string) {
    return prisma.conversionFactor.create({
      data: {
        organizationId,
        name,
        type: 'EMISSION',
        activityType: 'ELECTRICITY',
        unit: 'kWh',
        factorValue: new Prisma.Decimal('0.53'),
        resultUnit: 'kgCO2e/kWh',
      },
    });
  }

  function createActivity(organizationId: string, facilityId: string) {
    return prisma.activityData.create({
      data: {
        organizationId,
        facilityId,
        activityType: 'ELECTRICITY',
        recordDate: new Date('2026-07-20T00:00:00.000Z'),
        quantity: new Prisma.Decimal('100'),
        unit: 'kWh',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
      },
    });
  }

  function createMetricResult(
    organizationId: string,
    facilityId: string,
    activityDataId: string,
    factorId: string,
  ) {
    return prisma.metricResult.create({
      data: {
        organizationId,
        facilityId,
        activityDataId,
        factorId,
        metricType: 'CARBON_EMISSION',
        value: new Prisma.Decimal('53'),
        unit: 'kgCO2e',
      },
    });
  }

  async function expectTenantCounts(
    organizationId: string,
    expected: {
      activityData: number;
      metricResult: number;
      facility: number;
      factor: number;
      user: number;
    },
  ) {
    await expect(prisma.activityData.count({ where: { organizationId } })).resolves.toBe(
      expected.activityData,
    );
    await expect(prisma.metricResult.count({ where: { organizationId } })).resolves.toBe(
      expected.metricResult,
    );
    await expect(prisma.facility.count({ where: { organizationId } })).resolves.toBe(
      expected.facility,
    );
    await expect(prisma.conversionFactor.count({ where: { organizationId } })).resolves.toBe(
      expected.factor,
    );
    await expect(prisma.user.count({ where: { organizationId } })).resolves.toBe(
      expected.user,
    );
  }
});
