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

describe('ActivityData bulk province updates (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('bulk-province');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('updates selected electricity records to canonical province code BC, including overwrites', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `user-${testRunId}@carbonlite-e2e.test`,
    });
    const otherUser = await createTestUser(app, {
      organizationName: `${testRunId} Other Org`,
      email: `other-${testRunId}@carbonlite-e2e.test`,
    });

    const missingProvince = await createActivity(user.user.organizationId, {
      activityType: 'ELECTRICITY',
      jurisdictionRegion: null,
    });
    const existingDifferentProvince = await createActivity(user.user.organizationId, {
      activityType: 'ELECTRICITY',
      jurisdictionRegion: 'Alberta',
      matchingStatus: 'MATCHED',
      matchedFactorId: 'electricity-ab-2025',
      matchedFactorName: 'Electricity - Alberta',
      calculatedEmissionsKgCO2e: 53,
      calculationStatus: 'CALCULATED',
    });
    const existingSameProvince = await createActivity(user.user.organizationId, {
      activityType: 'ELECTRICITY',
      jurisdictionRegion: 'BC',
    });
    const gasoline = await createActivity(user.user.organizationId, {
      activityType: 'GASOLINE',
      jurisdictionRegion: null,
      unit: 'L',
    });
    const otherOrgElectricity = await createActivity(otherUser.user.organizationId, {
      activityType: 'ELECTRICITY',
      jurisdictionRegion: 'Alberta',
    });

    const response = await request(app.getHttpServer())
      .patch('/api/activity-data/bulk-province')
      .set(authHeader(user.accessToken))
      .send({
        ids: [
          missingProvince.id,
          existingDifferentProvince.id,
          existingSameProvince.id,
          gasoline.id,
          otherOrgElectricity.id,
        ],
        province: 'BC',
      })
      .expect(200);

    expect(response.body).toMatchObject({
      ids: [missingProvince.id, existingDifferentProvince.id, existingSameProvince.id],
      province: 'BC',
      updatedCount: 3,
    });

    await expect(
      prisma.activityData.findMany({
        where: {
          id: {
            in: [
              missingProvince.id,
              existingDifferentProvince.id,
              existingSameProvince.id,
            ],
          },
        },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: missingProvince.id,
          organizationId: user.user.organizationId,
          activityType: 'ELECTRICITY',
          jurisdictionRegion: 'BC',
        }),
        expect.objectContaining({
          id: existingDifferentProvince.id,
          organizationId: user.user.organizationId,
          activityType: 'ELECTRICITY',
          jurisdictionRegion: 'BC',
          matchedFactorId: null,
          matchedFactorName: null,
          calculatedEmissionsKgCO2e: null,
          calculationStatus: 'PENDING_RECALCULATION',
        }),
        expect.objectContaining({
          id: existingSameProvince.id,
          organizationId: user.user.organizationId,
          activityType: 'ELECTRICITY',
          jurisdictionRegion: 'BC',
        }),
      ]),
    );

    await expect(
      prisma.activityData.findUniqueOrThrow({ where: { id: gasoline.id } }),
    ).resolves.toMatchObject({
      activityType: 'GASOLINE',
      jurisdictionRegion: null,
    });
    await expect(
      prisma.activityData.findUniqueOrThrow({
        where: { id: otherOrgElectricity.id },
      }),
    ).resolves.toMatchObject({
      organizationId: otherUser.user.organizationId,
      activityType: 'ELECTRICITY',
      jurisdictionRegion: 'Alberta',
    });
  });

  it('rejects invalid province codes at the API boundary', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Invalid Province Org`,
      email: `invalid-province-${testRunId}@carbonlite-e2e.test`,
    });
    const electricity = await createActivity(user.user.organizationId, {
      activityType: 'ELECTRICITY',
      jurisdictionRegion: null,
    });

    const response = await request(app.getHttpServer())
      .patch('/api/activity-data/bulk-province')
      .set(authHeader(user.accessToken))
      .send({
        ids: [electricity.id],
        province: 'XX',
      })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain('Unsupported province code: XX');
    await expect(
      prisma.activityData.findUniqueOrThrow({ where: { id: electricity.id } }),
    ).resolves.toMatchObject({
      jurisdictionRegion: null,
    });
  });

  it('keeps viewer and pilot reviewer accounts read-only', async () => {
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
    const viewerElectricity = await createActivity(viewer.user.organizationId, {
      activityType: 'ELECTRICITY',
      jurisdictionRegion: null,
    });

    await request(app.getHttpServer())
      .patch('/api/activity-data/bulk-province')
      .set(authHeader(viewer.accessToken))
      .send({
        ids: [viewerElectricity.id],
        province: 'BC',
      })
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
    const reviewerElectricity = await createActivity(
      pilotReviewer.user.organizationId,
      {
        activityType: 'ELECTRICITY',
        jurisdictionRegion: null,
      },
    );

    await request(app.getHttpServer())
      .patch('/api/activity-data/bulk-province')
      .set(authHeader(pilotReviewer.accessToken))
      .send({
        ids: [reviewerElectricity.id],
        province: 'BC',
      })
      .expect(403);
  });

  function createActivity(
    organizationId: string,
    overrides: {
      activityType: 'ELECTRICITY' | 'GASOLINE';
      jurisdictionRegion?: string | null;
      unit?: string;
      matchingStatus?: string;
      matchedFactorId?: string;
      matchedFactorName?: string;
      calculatedEmissionsKgCO2e?: number;
      calculationStatus?: string;
    },
  ) {
    return prisma.activityData.create({
      data: {
        organizationId,
        activityType: overrides.activityType,
        recordDate: new Date('2026-07-20T00:00:00.000Z'),
        quantity: new Prisma.Decimal('100'),
        unit: overrides.unit ?? 'kWh',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: overrides.jurisdictionRegion ?? null,
        sourceType: 'MANUAL',
        sourceReference: testRunId,
        matchingStatus: overrides.matchingStatus,
        matchedFactorId: overrides.matchedFactorId,
        matchedFactorName: overrides.matchedFactorName,
        calculatedEmissionsKgCO2e: overrides.calculatedEmissionsKgCO2e,
        calculationStatus: overrides.calculationStatus,
      },
    });
  }
});
