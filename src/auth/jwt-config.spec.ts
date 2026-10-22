import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthModule } from './auth.module';
import { resolveJwtSecret } from './jwt-config';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { ActivityTrackingModule } from '../activity-tracking/activity-tracking.module';
import { PrismaService } from '../prisma/prisma.service';

const missingMessage = 'JWT_SECRET must be configured with a non-empty value.';
const absentOrBlank = [undefined, null, '', ' \t\n '];
function config(secret: unknown, environment = 'production') {
  return { get: (key: string) => key === 'JWT_SECRET' ? secret : ['NODE_ENV', 'APP_ENV'].includes(key) ? environment : undefined } as ConfigService;
}

describe('explicit JWT configuration in every environment', () => {
  describe.each(['production', 'staging', 'preview', 'pilot', 'test', 'development', 'local', ''])('environment=%s', environment => {
    it.each(absentOrBlank)('rejects absent or blank configuration (case %#)', value => {
      expect(() => resolveJwtSecret(config(value, environment))).toThrow(missingMessage);
    });
    it('uses the explicitly configured value, with consistent whitespace normalization', () => {
      const secret = randomBytes(32).toString('hex');
      // Compare booleans so a failing assertion cannot print signing material.
      expect(resolveJwtSecret(config(` ${secret}\n`, environment)) === secret).toBe(true);
    });
  });
});

describe('real AuthModule startup and JWT strategy', () => {
  const originalEnv = process.env;
  let app: INestApplication | undefined;
  const user = {
    id: 'jwt-config-user', email: 'jwt-config@example.test', organizationId: 'jwt-config-org',
    role: 'USER', accountType: 'CUSTOMER', isActive: true,
    organization: { id: 'jwt-config-org', name: 'Synthetic JWT configuration test' }, memberships: [],
  };
  const prisma = { user: { findFirst: jest.fn().mockResolvedValue(user) } };
  const module = (secret: unknown) => Test.createTestingModule({ imports: [AuthModule, AuditLogModule, ActivityTrackingModule] })
    .overrideProvider(ConfigService).useValue(config(secret))
    .overrideProvider(PrismaService).useValue(prisma);

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'production', APP_ENV: 'production' };
    jest.clearAllMocks();
  });
  afterEach(async () => { if (app) await app.close(); app = undefined; process.env = originalEnv; });

  it.each(absentOrBlank)('fails production module initialization before any server can listen (case %#)', async secret => {
    await expect(module(secret).compile()).rejects.toThrow(missingMessage);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('initializes with explicit configuration, signs/verifies with that key, and rejects the former fallback', async () => {
    const secret = randomBytes(32).toString('hex');
    const compiled = await module(` ${secret}\n`).compile();
    app = compiled.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    const jwt = compiled.get(JwtService);
    const payload = { sub: user.id, email: user.email, organizationId: user.organizationId };
    const token = await jwt.signAsync(payload);
    const decoded = await jwt.verifyAsync(token);
    expect(decoded.sub).toBe(user.id);
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60);
    await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200)
      .expect(response => { expect(response.body.id).toBe(user.id); });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: user.id, organizationId: user.organizationId, isActive: true } }));
    prisma.user.findFirst.mockClear();
    // This public, retired development fallback must never verify here.
    const oldFallbackToken = new JwtService({ secret: 'dev-secret' }).sign(payload);
    await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${oldFallbackToken}`).expect(401);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
