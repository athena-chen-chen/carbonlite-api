import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { openai } from '../../src/openai/openai.client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { assertSafeTestDatabaseTarget } from './database-safety';
import { authHeader, createTestUser, TestUser, uniqueTestId } from './factories';

/** Explicit opt-in for provider-success fixtures; never called by createTestUser. */
export async function authorizeSyntheticDocumentExtraction(app: INestApplication, customer: TestUser) {
  assertSafeTestDatabaseTarget();
  if (!jest.isMockFunction(openai.responses.create)) {
    throw new Error('Synthetic authorization fixtures require a mocked provider.');
  }
  const prisma = app.get(PrismaService);
  const platform = await createTestUser(app, {
    organizationName: `${customer.user.organizationName} synthetic AI fixture admin`,
    email: `${uniqueTestId('synthetic-ai-admin')}@carbonlite-e2e.test`,
  });
  await prisma.user.update({ where: { id: platform.user.id }, data: { role: 'ADMIN', accountType: 'INTERNAL' } });
  await prisma.organization.update({
    where: { id: customer.user.organizationId },
    data: { customerStatus: 'ACTIVE', provisionedAt: new Date() },
  });
  await request(app.getHttpServer())
    .put(`/api/admin/organizations/${customer.user.organizationId}/ai-authorization`)
    .set(authHeader(platform.accessToken))
    .send({
      status: 'ENABLED', provider: 'OPENAI', processingScope: 'DOCUMENT_EXTRACTION',
      authorizedDataMode: 'SYNTHETIC_TEST_ONLY', consentVersion: 'e2e-synthetic-consent-v1',
      evidenceReference: 'evidence://synthetic/e2e/provider-success',
      authorizedRepresentativeReference: 'synthetic-e2e-representative',
      effectiveAt: new Date(Date.now() - 60_000).toISOString(),
    })
    .expect(200)
    .expect(({ body }) => expect(body).toMatchObject({
      organizationId: customer.user.organizationId, status: 'ENABLED',
      provider: 'OPENAI', processingScope: 'DOCUMENT_EXTRACTION',
      authorizedDataMode: 'SYNTHETIC_TEST_ONLY', withdrawnAt: null,
    }));
  await request(app.getHttpServer())
    .get('/api/ai-authorization/status').set(authHeader(customer.accessToken))
    .expect(200).expect(({ body }) => expect(body.enabled).toBe(true));
}
