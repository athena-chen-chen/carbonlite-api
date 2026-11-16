import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { isOpenAiConfigured, openai } from '../src/openai/openai.client';
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
    (isOpenAiConfigured as jest.Mock).mockReturnValue(false);
    const setup = await createE2eApp();
    app = setup.app;
    prisma = setup.prisma;
    (isOpenAiConfigured as jest.Mock).mockReturnValue(true);
  });

  afterAll(async () => {
    if (prisma) await cleanupTestData(prisma, run);
    if (app) await app.close();
  });

  afterEach(() => {
    (isOpenAiConfigured as jest.Mock).mockReturnValue(true);
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

  it('boots without provider configuration and rejects an authorized provider extraction before execution side effects', async () => {
    const customer = await createTestUser(app, {
      organizationName: `${run} optional provider customer`,
      email: `${uniqueTestId(run)}@carbonlite-e2e.test`,
      factorProfile: 'reviewed',
    });
    const platform = await createTestUser(app, {
      organizationName: `${run} optional provider platform`,
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
    await request(app.getHttpServer())
      .put(`/api/admin/organizations/${customer.user.organizationId}/ai-authorization`)
      .set(authHeader(platform.accessToken))
      .send({
        status: 'ENABLED',
        consentVersion: 'synthetic-provider-optional-v1',
        provider: 'OPENAI',
        processingScope: 'DOCUMENT_EXTRACTION',
        authorizedDataMode: 'SYNTHETIC_TEST_ONLY',
        evidenceReference: 'evidence://synthetic/provider-optional',
        authorizedRepresentativeReference: 'synthetic-provider-optional-representative',
        effectiveAt: '2026-11-01T00:00:00.000Z',
      })
      .expect(200);

    const upload = await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(customer.accessToken))
      .set('X-CarbonLite-Data-Mode', 'SYNTHETIC_TEST')
      .field('type', 'PDF')
      .attach(
        'file',
        Buffer.from('%PDF-1.4\n% Synthetic optional-provider fixture\n%%EOF\n'),
        {
          filename: `${run}-optional-provider.pdf`,
          contentType: 'application/pdf',
        },
      )
      .expect(201);

    const baseline = {
      jobs: await prisma.aIJob.count({
        where: { organizationId: customer.user.organizationId },
      }),
      starts: await prisma.userActivityEvent.count({
        where: {
          organizationId: customer.user.organizationId,
          eventName: 'DOCUMENT_EXTRACT_STARTED',
        },
      }),
      results: await prisma.documentExtraction.count({
        where: { organizationId: customer.user.organizationId },
      }),
    };
    (isOpenAiConfigured as jest.Mock).mockReturnValue(false);
    (openai.responses.create as jest.Mock).mockClear();

    await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(customer.accessToken))
      .send({ documentId: upload.body.id })
      .expect(503)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          statusCode: 503,
          code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: 'AI document extraction is temporarily unavailable.',
        }),
      );

    expect(openai.responses.create).not.toHaveBeenCalled();
    await expect(
      prisma.document.findUniqueOrThrow({ where: { id: upload.body.id } }),
    ).resolves.toMatchObject({ status: 'UPLOADED' });
    await expect(
      prisma.aIJob.count({ where: { organizationId: customer.user.organizationId } }),
    ).resolves.toBe(baseline.jobs);
    await expect(
      prisma.userActivityEvent.count({
        where: {
          organizationId: customer.user.organizationId,
          eventName: 'DOCUMENT_EXTRACT_STARTED',
        },
      }),
    ).resolves.toBe(baseline.starts);
    await expect(
      prisma.documentExtraction.count({
        where: { organizationId: customer.user.organizationId },
      }),
    ).resolves.toBe(baseline.results);
  });
});
