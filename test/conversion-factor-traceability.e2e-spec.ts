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

describe('Conversion factor traceability fields (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('factor-traceability');

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  function factorPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: `${testRunId} Diesel factor`,
      type: 'EMISSION',
      activityType: 'DIESEL',
      jurisdiction: 'Alberta, Canada',
      unit: 'liters',
      factorValue: 2.72,
      resultUnit: 'kgCO2e',
      sourceName: 'CarbonLite Test Source',
      sourceReference: 'Traceability Test Reference',
      sourceAuthority: 'Environment Canada',
      sourceDocument: 'National Inventory Report',
      sourceYear: 2026,
      sourceUrl: 'https://example.com/factors',
      methodology: 'MVP traceability test methodology',
      confidenceLevel: 'high',
      verified: true,
      notes: 'Created by conversion factor traceability e2e test.',
      ...overrides,
    };
  }

  it('creates, lists, and reads traceability fields', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Org`,
      email: `create-${testRunId}@carbonlite-e2e.test`,
    });

    const created = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authHeader(user.accessToken))
      .send(factorPayload())
      .expect(201);

    expect(created.body).toMatchObject({
      sourceAuthority: 'Environment Canada',
      jurisdiction: 'Alberta, Canada',
      sourceDocument: 'National Inventory Report',
      sourceYear: 2026,
      sourceUrl: 'https://example.com/factors',
      methodology: 'MVP traceability test methodology',
      confidenceLevel: 'high',
      verified: true,
      notes: 'Created by conversion factor traceability e2e test.',
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/conversion-factors/${created.body.id}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(detail.body.sourceAuthority).toBe('Environment Canada');
    expect(detail.body.notes).toBe('Created by conversion factor traceability e2e test.');

    const list = await request(app.getHttpServer())
      .get(`/api/conversion-factors?search=${testRunId}`)
      .set(authHeader(user.accessToken))
      .expect(200);

    const listed = list.body.items.find(
      (item: { id: string }) => item.id === created.body.id,
    );
    expect(listed).toMatchObject({
      sourceAuthority: 'Environment Canada',
      jurisdiction: 'Alberta, Canada',
      sourceYear: 2026,
      verified: true,
      notes: 'Created by conversion factor traceability e2e test.',
    });
  });

  it('updates traceability fields', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Update Org`,
      email: `update-${testRunId}@carbonlite-e2e.test`,
    });

    const created = await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authHeader(user.accessToken))
      .send(factorPayload({ name: `${testRunId} Updatable factor` }))
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/api/conversion-factors/${created.body.id}`)
      .set(authHeader(user.accessToken))
      .send({
        jurisdiction: 'British Columbia, Canada',
        sourceAuthority: 'Updated Authority',
        sourceDocument: 'Updated Document',
        sourceYear: 2027,
        sourceUrl: 'https://example.com/updated-factors',
        methodology: 'Updated methodology',
        confidenceLevel: 'medium',
        verified: false,
        notes: 'Updated traceability notes.',
      })
      .expect(200);

    expect(updated.body).toMatchObject({
      jurisdiction: 'British Columbia, Canada',
      sourceAuthority: 'Updated Authority',
      sourceDocument: 'Updated Document',
      sourceYear: 2027,
      sourceUrl: 'https://example.com/updated-factors',
      methodology: 'Updated methodology',
      confidenceLevel: 'medium',
      verified: false,
      notes: 'Updated traceability notes.',
    });
  });

  it('filters multiple electricity factors by jurisdiction and source year', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Electricity Org`,
      email: `electricity-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authHeader(user.accessToken))
      .send(factorPayload({
        name: `${testRunId} Electricity Alberta 2025`,
        activityType: 'ELECTRICITY',
        unit: 'kWh',
        jurisdiction: 'Alberta, Canada',
        sourceYear: 2025,
      }))
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authHeader(user.accessToken))
      .send(factorPayload({
        name: `${testRunId} Electricity BC 2025`,
        activityType: 'ELECTRICITY',
        unit: 'kWh',
        jurisdiction: 'British Columbia, Canada',
        sourceYear: 2025,
      }))
      .expect(201);

    const filtered = await request(app.getHttpServer())
      .get(
        '/api/conversion-factors?activityType=ELECTRICITY&jurisdiction=British%20Columbia&sourceYear=2025',
      )
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(
      filtered.body.items.some(
        (item: { name: string }) =>
          item.name === `${testRunId} Electricity BC 2025`,
      ),
    ).toBe(true);
    expect(
      filtered.body.items.some(
        (item: { name: string }) =>
          item.name === `${testRunId} Electricity Alberta 2025`,
      ),
    ).toBe(false);
  });

  it('still rejects unknown fields', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Unknown Field Org`,
      email: `unknown-${testRunId}@carbonlite-e2e.test`,
    });

    await request(app.getHttpServer())
      .post('/api/conversion-factors')
      .set(authHeader(user.accessToken))
      .send(factorPayload({ unsupportedTraceabilityField: 'nope' }))
      .expect(400);
  });
});
