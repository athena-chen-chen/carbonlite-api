import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { openai } from '../src/openai/openai.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';
import { assertSafeTestDatabaseTarget } from './helpers/database-safety';

describe('organization AI authorization administration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const run = uniqueTestId('ai-authorization');

  beforeAll(async () => {
    assertSafeTestDatabaseTarget();
    const setup = await createE2eApp();
    app = setup.app;
    prisma = setup.prisma;
  });

  afterAll(async () => {
    if (prisma) await cleanupTestData(prisma, run);
    if (app) await app.close();
  });

  it('defaults to no authorization, isolates tenants, and records platform-admin changes without evidence content in audit values', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${run} customer`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    const otherCustomer = await createTestUser(app, {
      organizationName: `${run} other customer`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
    });
    const platform = await createTestUser(app, {
      organizationName: `${run} platform`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
    });
    await prisma.user.update({
      where: { id: platform.user.id },
      data: { role: 'ADMIN', accountType: 'INTERNAL' },
    });
    await prisma.organization.update({
      where: { id: customer.user.organizationId },
      data: { customerStatus: 'ACTIVE', provisionedAt: new Date() },
    });
    const endpoint = `/api/admin/organizations/${customer.user.organizationId}/ai-authorization`;
    const payload = {
      status: 'ENABLED',
      consentVersion: 'synthetic-consent-v1',
      provider: 'OPENAI',
      processingScope: 'DOCUMENT_EXTRACTION',
      evidenceReference: 'evidence://synthetic/customer-election',
      authorizedRepresentativeReference: 'synthetic-customer-representative',
      effectiveAt: '2026-11-01T00:00:00.000Z',
    };

    await request(app.getHttpServer())
      .get(endpoint)
      .set(authHeader(platform.accessToken))
      .expect(200)
      .expect(({ body, text }) => {
        expect(text).toBe('');
        expect(body).toEqual({});
      });
    await expect(
      prisma.organizationAiAuthorization.findUnique({
        where: { organizationId: customer.user.organizationId },
      }),
    ).resolves.toBeNull();

    await request(app.getHttpServer())
      .put(endpoint)
      .set(authHeader(customer.accessToken))
      .send(payload)
      .expect(403);

    await request(app.getHttpServer())
      .put(endpoint)
      .set(authHeader(otherCustomer.accessToken))
      .send(payload)
      .expect(403);

    await request(app.getHttpServer())
      .put(endpoint)
      .set(authHeader(platform.accessToken))
      .send(payload)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          organizationId: customer.user.organizationId,
          status: 'ENABLED',
          consentVersion: 'synthetic-consent-v1',
          provider: 'OPENAI',
          processingScope: 'DOCUMENT_EXTRACTION',
          verifiedById: platform.user.id,
        }),
      );

    await request(app.getHttpServer())
      .get('/api/ai-authorization/status')
      .set(authHeader(customer.accessToken))
      .expect(200)
      .expect(({ body, text }) => {
        expect(body).toMatchObject({
          enabled: true,
          status: 'ENABLED',
          provider: 'OPENAI',
          processingScope: 'DOCUMENT_EXTRACTION',
        });
        expect(text).not.toContain('evidence://');
        expect(text).not.toContain('authorizedRepresentativeReference');
        expect(text).not.toContain('verifiedById');
      });
    await request(app.getHttpServer())
      .get('/api/ai-authorization/status')
      .set(authHeader(otherCustomer.accessToken))
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ enabled: false, status: 'NOT_CONFIGURED' });
      });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        organizationId: customer.user.organizationId,
        action: 'AI_AUTHORIZATION_RECORDED',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.newValue).toMatchObject({ evidenceReferencePresent: true });
    expect(JSON.stringify(audit.newValue)).not.toContain(
      'evidence://synthetic/customer-election',
    );

    await request(app.getHttpServer())
      .post(`${endpoint}/withdraw`)
      .set(authHeader(platform.accessToken))
      .send({ withdrawalReference: 'evidence://synthetic/customer-withdrawal' })
      .expect(201)
      .expect(({ body }) => expect(body.status).toBe('WITHDRAWN'));

    await expect(
      prisma.organizationAiAuthorization.findUnique({
        where: { organizationId: otherCustomer.user.organizationId },
      }),
    ).resolves.toBeNull();
    expect(openai.responses.create).not.toHaveBeenCalled();
  });

  it('leaves non-AI manual activity entry functional without AI authorization', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${run} manual`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    await request(app.getHttpServer())
        .post('/api/activity-data')
        .set(authHeader(customer.accessToken))
        .send({
          activityType: 'DIESEL',
          quantity: 10,
          unit: 'L',
          recordDate: '2026-11-01',
          jurisdictionCountry: 'Canada',
          sourceType: 'MANUAL',
        })
        .expect(201)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            organizationId: customer.user.organizationId,
            sourceType: 'MANUAL',
          }),
        );
    expect(openai.responses.create).not.toHaveBeenCalled();
  });
});
