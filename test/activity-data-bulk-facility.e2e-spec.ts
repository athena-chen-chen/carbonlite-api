import { INestApplication } from '@nestjs/common';
import { ActivityType, Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('ActivityData bulk facility updates (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('bulk-facility');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  it('sets facility on selected records across activity types, including overwrites', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `user-${testRunId}@carbonlite-e2e.test`,
    });
    const otherUser = await createTestUser(app, {
      organizationName: `${testRunId} Other Org`,
      email: `other-${testRunId}@carbonlite-e2e.test`,
    });
    const linkedFacility = await prisma.facility.create({
      data: {
        organizationId: user.user.organizationId,
        name: `${testRunId} Linked Facility`,
      },
    });

    const missingFacility = await createActivity(user.user.organizationId, {
      activityType: 'ELECTRICITY',
      facilityName: null,
    });
    const existingDifferentFacility = await createActivity(user.user.organizationId, {
      activityType: 'NATURAL_GAS',
      unit: 'GJ',
      facilityId: linkedFacility.id,
      facilityName: 'Vancouver Office',
    });
    const existingSameFacility = await createActivity(user.user.organizationId, {
      activityType: 'GASOLINE',
      unit: 'L',
      facilityName: 'Calgary Office',
    });
    const hotel = await createActivity(user.user.organizationId, {
      activityType: 'HOTEL',
      unit: 'nights',
      facilityName: null,
    });
    const otherOrgActivity = await createActivity(otherUser.user.organizationId, {
      activityType: 'AIR_TRAVEL',
      unit: 'km',
      facilityName: null,
    });

    const response = await request(app.getHttpServer())
      .patch('/api/activity-data/bulk-facility')
      .set(authHeader(user.accessToken))
      .send({
        ids: [
          missingFacility.id,
          existingDifferentFacility.id,
          existingSameFacility.id,
          hotel.id,
          otherOrgActivity.id,
        ],
        facilityName: ' Calgary Office ',
      })
      .expect(200);

    expect(response.body).toMatchObject({
      ids: [
        missingFacility.id,
        existingDifferentFacility.id,
        existingSameFacility.id,
        hotel.id,
      ],
      facilityName: 'Calgary Office',
      updatedCount: 4,
    });

    await expect(
      prisma.activityData.findMany({
        where: {
          id: {
            in: [
              missingFacility.id,
              existingDifferentFacility.id,
              existingSameFacility.id,
              hotel.id,
            ],
          },
        },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: missingFacility.id,
          organizationId: user.user.organizationId,
          facilityId: null,
          facilityName: 'Calgary Office',
        }),
        expect.objectContaining({
          id: existingDifferentFacility.id,
          organizationId: user.user.organizationId,
          facilityId: null,
          facilityName: 'Calgary Office',
        }),
        expect.objectContaining({
          id: existingSameFacility.id,
          organizationId: user.user.organizationId,
          facilityId: null,
          facilityName: 'Calgary Office',
        }),
        expect.objectContaining({
          id: hotel.id,
          organizationId: user.user.organizationId,
          facilityId: null,
          facilityName: 'Calgary Office',
        }),
      ]),
    );

    await expect(
      prisma.activityData.findUniqueOrThrow({ where: { id: otherOrgActivity.id } }),
    ).resolves.toMatchObject({
      organizationId: otherUser.user.organizationId,
      facilityName: null,
    });
  });

  it('rejects empty facility names at the API boundary', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Empty Facility Org`,
      email: `empty-facility-${testRunId}@carbonlite-e2e.test`,
    });
    const activity = await createActivity(user.user.organizationId, {
      activityType: 'ELECTRICITY',
      facilityName: null,
    });

    const response = await request(app.getHttpServer())
      .patch('/api/activity-data/bulk-facility')
      .set(authHeader(user.accessToken))
      .send({
        ids: [activity.id],
        facilityName: '   ',
      })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain('Facility name is required.');
    await expect(
      prisma.activityData.findUniqueOrThrow({ where: { id: activity.id } }),
    ).resolves.toMatchObject({
      facilityName: null,
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
    const viewerActivity = await createActivity(viewer.user.organizationId, {
      activityType: 'ELECTRICITY',
      facilityName: null,
    });

    await request(app.getHttpServer())
      .patch('/api/activity-data/bulk-facility')
      .set(authHeader(viewer.accessToken))
      .send({
        ids: [viewerActivity.id],
        facilityName: 'Calgary Office',
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
    const reviewerActivity = await createActivity(pilotReviewer.user.organizationId, {
      activityType: 'ELECTRICITY',
      facilityName: null,
    });

    await request(app.getHttpServer())
      .patch('/api/activity-data/bulk-facility')
      .set(authHeader(pilotReviewer.accessToken))
      .send({
        ids: [reviewerActivity.id],
        facilityName: 'Calgary Office',
      })
      .expect(403);
  });

  function createActivity(
    organizationId: string,
    overrides: {
      activityType: keyof typeof ActivityType;
      facilityId?: string | null;
      facilityName?: string | null;
      unit?: string;
    },
  ) {
    return prisma.activityData.create({
      data: {
        organizationId,
        facilityId: overrides.facilityId ?? null,
        facilityName: overrides.facilityName ?? null,
        activityType: overrides.activityType,
        recordDate: new Date('2026-07-20T00:00:00.000Z'),
        quantity: new Prisma.Decimal('100'),
        unit: overrides.unit ?? 'kWh',
        jurisdictionCountry: 'Canada',
        sourceType: 'MANUAL',
        sourceReference: testRunId,
      },
    });
  }
});
