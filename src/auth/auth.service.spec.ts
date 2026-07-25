import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

describe('AuthService login resilience', () => {
  const originalEnv = process.env;
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const jwt = {
    signAsync: jest.fn(),
  };
  const auditLog = {
    log: jest.fn(),
  };
  const activityTracking = {
    track: jest.fn(),
  };
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      LOCAL_DEMO_AUTH_ENABLED: 'true',
      LOCAL_DEMO_EMAILS: 'pilot@carbonliteapp.ca,carbonliteai@gmail.com',
      LOCAL_DEMO_PASSWORD: 'password123',
      LOCAL_DEMO_USER_ID: 'local-demo-user',
      LOCAL_DEMO_ORGANIZATION_ID: 'local-demo-organization',
      LOCAL_DEMO_ORGANIZATION_NAME: 'CarbonLite Pilot Demo Workspace',
    };
    jwt.signAsync.mockResolvedValue('local-demo-token');
    auditLog.log.mockResolvedValue({});
    activityTracking.track.mockResolvedValue({});
    service = new AuthService(
      prisma as never,
      jwt as never,
      auditLog as never,
      activityTracking as never,
    );
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses configured local demo auth when the database is unavailable', async () => {
    prisma.user.findUnique.mockRejectedValue(
      new Error("Can't reach database server at example.neon.tech:5432"),
    );

    await expect(
      service.login('pilot@carbonliteapp.ca', 'password123'),
    ).resolves.toMatchObject({
      accessToken: 'local-demo-token',
      user: {
        id: 'local-demo-user',
        email: 'pilot@carbonliteapp.ca',
        organizationId: 'local-demo-organization',
        organizationName: 'CarbonLite Pilot Demo Workspace',
        role: UserRole.ADMIN,
      },
    });
  });

  it('returns 401 for wrong local demo credentials when the database is unavailable', async () => {
    prisma.user.findUnique.mockRejectedValue(
      new Error("Can't reach database server at example.neon.tech:5432"),
    );

    await expect(
      service.login('pilot@carbonliteapp.ca', 'wrong-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 401 for a missing user when the database is reachable', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.login('missing@example.com', 'password123'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not block login if audit or activity tracking fails', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      organizationId: 'org-1',
      passwordHash: bcrypt.hashSync('password123', 10),
      isActive: true,
      role: UserRole.USER,
      organization: {
        id: 'org-1',
        name: 'Demo Organization',
      },
    });
    prisma.user.update.mockResolvedValue({});
    auditLog.log.mockRejectedValue(new Error('audit table unavailable'));
    activityTracking.track.mockRejectedValue(
      new Error('activity table unavailable'),
    );

    await expect(
      service.login('user@example.com', 'password123'),
    ).resolves.toMatchObject({
      accessToken: 'local-demo-token',
      user: {
        id: 'user-1',
        email: 'user@example.com',
        organizationId: 'org-1',
      },
    });
  });
});
