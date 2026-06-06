import { INestApplication } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';

export type TestUser = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    organizationId: string;
    organizationName: string;
    role: 'ADMIN' | 'USER';
  };
  password: string;
};

export function uniqueTestId(prefix = 'carbonlite-e2e') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createTestOrganization(
  prisma: PrismaService,
  name = uniqueTestId('CarbonLite E2E Org'),
): Promise<Organization> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return prisma.organization.create({
    data: {
      name,
      slug,
    },
  });
}

export async function createTestUser(
  app: INestApplication,
  options: {
    organizationName?: string;
    email?: string;
    password?: string;
  } = {},
): Promise<TestUser> {
  const password = options.password ?? 'password123';
  const email =
    options.email ?? `${uniqueTestId('user')}@carbonlite-e2e.test`;
  const organizationName =
    options.organizationName ?? uniqueTestId('CarbonLite E2E Org');

  const response = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send({ organizationName, email, password })
    .expect(201);

  return {
    accessToken: response.body.accessToken,
    user: response.body.user,
    password,
  };
}

export async function loginAndGetToken(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password })
    .expect(201);

  return response.body.accessToken;
}

export async function cleanupTestData(
  prisma: PrismaService,
  testRunId: string,
) {
  // Deleting organizations cascades to users and tenant-owned records.
  await prisma.organization.deleteMany({
    where: {
      name: {
        contains: testRunId,
      },
    },
  });

  await prisma.user.deleteMany({
    where: {
      email: {
        contains: testRunId,
      },
    },
  });
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export type TestOrganization = Organization;
export type TestUserModel = User;
