import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { MembershipRole, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

describe('AuthService login resilience', () => {
  const originalEnv = process.env;
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    activityData: {
      count: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    report: {
      count: jest.fn(),
      deleteMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const jwt = {
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
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
    jwt.verifyAsync.mockReset();
    prisma.activityData.count.mockResolvedValue(10);
    prisma.activityData.deleteMany.mockResolvedValue({ count: 0 });
    prisma.activityData.createMany.mockResolvedValue({ count: 10 });
    prisma.report.count.mockResolvedValue(1);
    prisma.report.deleteMany.mockResolvedValue({ count: 0 });
    prisma.report.create.mockResolvedValue({});
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

  it('ensures golden sample data when an existing pilot reviewer logs in', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      organizationId: 'sample-workspace',
      passwordHash: bcrypt.hashSync('password123', 10),
      isActive: true,
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });
    prisma.user.update.mockResolvedValue({});
    prisma.activityData.count.mockResolvedValue(0);
    prisma.report.count.mockResolvedValue(0);

    await expect(
      service.login('reviewer@example.com', 'password123'),
    ).resolves.toMatchObject({
      accessToken: 'local-demo-token',
      user: {
        id: 'reviewer-1',
        organizationId: 'sample-workspace',
        organizationName: 'CarbonLite Sample Workspace',
        accountType: 'PILOT_REVIEWER',
      },
    });

    expect(prisma.activityData.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          organizationId: 'sample-workspace',
          sourceReference: 'Golden Test Data.xlsx',
          sourceFileName: 'Golden Test Data.xlsx',
        }),
      ]),
    });
    expect(prisma.activityData.createMany.mock.calls[0][0].data).toHaveLength(10);
    expect(prisma.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'sample-workspace',
        createdById: 'reviewer-1',
        title: 'CarbonLite Pilot Sample Emissions Data Readiness Report',
      }),
    });
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

  it('creates a read-only pilot reviewer and returns a set-password invite link', async () => {
    process.env.APP_URL = 'http://localhost:5173';
    const workspace = {
      id: 'sample-workspace',
      name: 'CarbonLite Sample Workspace',
    };
    const createdUser = {
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      firstName: 'Test',
      lastName: 'Reviewer',
      accountExpiresAt: null,
    };
    const tx = {
      organization: {
        findFirst: jest.fn().mockResolvedValue(workspace),
        findUnique: jest.fn(),
        create: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(createdUser),
        update: jest.fn(),
      },
      membership: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
      },
      activityData: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 10 }),
      },
      report: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await service.createPilotReviewer(
      {
        id: 'admin-1',
        email: 'admin@example.com',
        organizationId: 'admin-org',
        organizationName: 'Admin Org',
        role: UserRole.ADMIN,
      },
      {
        name: 'Test Reviewer',
        email: '  Reviewer@Example.com  ',
      },
    );

    expect(result).toMatchObject({
      success: true,
      pilotReviewer: {
        name: 'Test Reviewer',
        email: 'reviewer@example.com',
        accountType: 'PILOT_REVIEWER',
        role: MembershipRole.VIEWER,
        workspaceName: 'CarbonLite Sample Workspace',
        expiresAt: null,
      },
    });
    expect(result.inviteLink).toMatch(
      /^http:\/\/localhost:5173\/set-password\?token=.+/,
    );
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'sample-workspace',
        email: 'reviewer@example.com',
        firstName: 'Test',
        lastName: 'Reviewer',
        role: UserRole.USER,
        accountType: 'PILOT_REVIEWER',
        passwordSetupRequired: true,
        passwordSetupTokenHash: expect.any(String),
        passwordSetupTokenExpiresAt: expect.any(Date),
        isActive: true,
      }),
    });
    const createdData = tx.user.create.mock.calls[0][0].data;
    expect(result.inviteLink).not.toContain(createdData.passwordSetupTokenHash);
    expect(tx.membership.create).toHaveBeenCalledWith({
      data: {
        userId: 'reviewer-1',
        organizationId: 'sample-workspace',
        role: MembershipRole.VIEWER,
      },
    });
    expect(tx.activityData.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          organizationId: 'sample-workspace',
          activityType: 'ELECTRICITY',
          jurisdictionRegion: 'Alberta',
          quantity: 12500,
          unit: 'kWh',
          calculatedEmissionsKgCO2e: 6625,
        }),
        expect.objectContaining({
          organizationId: 'sample-workspace',
          activityType: 'WATER',
          reportTreatment: 'TRACKED_ONLY',
          calculationStatus: 'TRACKED_ONLY',
        }),
      ]),
    });
    expect(tx.activityData.createMany.mock.calls[0][0].data).toHaveLength(10);
    expect(tx.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'sample-workspace',
        createdById: 'reviewer-1',
        title: 'CarbonLite Pilot Sample Emissions Data Readiness Report',
        status: 'GENERATED',
      }),
    });
  });

  it('authenticates pilot reviewer creation with ADMIN_SCRIPT_TOKEN', async () => {
    process.env.ADMIN_SCRIPT_TOKEN = 'local-admin-script-token';

    await expect(
      service.authenticatePilotReviewerCreator(
        'Bearer local-admin-script-token',
      ),
    ).resolves.toMatchObject({
      id: 'admin-script',
      role: UserRole.ADMIN,
      organizationName: 'CarbonLite Admin Script',
    });
  });

  it('authenticates pilot reviewer creation with an admin JWT', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'admin-1',
      email: 'admin@example.com',
      organizationId: 'admin-org',
    });
    prisma.user.findFirst.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      organizationId: 'admin-org',
      role: UserRole.ADMIN,
      isActive: true,
      organization: {
        id: 'admin-org',
        name: 'Admin Org',
      },
      memberships: [],
    });

    await expect(
      service.authenticatePilotReviewerCreator('Bearer admin-jwt'),
    ).resolves.toMatchObject({
      id: 'admin-1',
      role: UserRole.ADMIN,
      organizationName: 'Admin Org',
    });
  });

  it('authenticates pilot reviewer creation with an admin membership JWT', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'membership-admin-1',
      email: 'membership-admin@example.com',
      organizationId: 'admin-org',
    });
    prisma.user.findFirst.mockResolvedValue({
      id: 'membership-admin-1',
      email: 'membership-admin@example.com',
      organizationId: 'admin-org',
      role: UserRole.USER,
      isActive: true,
      organization: {
        id: 'admin-org',
        name: 'Admin Org',
      },
      memberships: [
        {
          id: 'membership-1',
          userId: 'membership-admin-1',
          organizationId: 'admin-org',
          role: MembershipRole.ADMIN,
        },
      ],
    });

    await expect(
      service.authenticatePilotReviewerCreator('Bearer admin-membership-jwt'),
    ).resolves.toMatchObject({
      id: 'membership-admin-1',
      role: UserRole.ADMIN,
      organizationName: 'Admin Org',
    });
  });

  it('rejects non-admin pilot reviewer creation', async () => {
    await expect(
      service.createPilotReviewer(
        {
          id: 'user-1',
          email: 'user@example.com',
          organizationId: 'org-1',
          organizationName: 'Org',
          role: UserRole.USER,
        },
        {
          name: 'Test Reviewer',
          email: 'reviewer@example.com',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects markdown mailto pilot reviewer emails before persistence', async () => {
    const invalidEmails = [
      '[mint_pp@hotmail.com](mailto:mint_pp@hotmail.com)',
      'mailto:mint_pp@hotmail.com',
      'mint pp@hotmail.com',
      '"mint_pp@hotmail.com"',
      '(mint_pp@hotmail.com)',
      '[mint_pp@hotmail.com]',
    ];

    for (const invalidEmail of invalidEmails) {
      await expect(
        service.createPilotReviewer(
          {
            id: 'admin-1',
            email: 'admin@example.com',
            organizationId: 'admin-org',
            organizationName: 'Admin Org',
            role: UserRole.ADMIN,
          },
          {
            name: 'Test Reviewer',
            email: invalidEmail,
          },
        ),
      ).rejects.toThrow(
        'Please enter a valid email address, for example name@example.com.',
      );
    }

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('sets password from a valid invite and clears the active token hash', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      organizationId: 'sample-workspace',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      isActive: true,
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });
    prisma.user.update.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      organizationId: 'sample-workspace',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      isActive: true,
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });

    await expect(
      service.setPasswordFromInvite({
        token: 'invite-token',
        password: 'password123',
      }),
    ).resolves.toMatchObject({
      accessToken: 'local-demo-token',
      user: {
        id: 'reviewer-1',
        email: 'reviewer@example.com',
        accountType: 'PILOT_REVIEWER',
      },
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        passwordSetupTokenHash: expect.any(String),
        passwordSetupTokenUsedAt: null,
        passwordSetupTokenExpiresAt: { gt: expect.any(Date) },
        isActive: true,
      }),
      include: { organization: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'reviewer-1' },
      data: expect.objectContaining({
        passwordHash: expect.any(String),
        passwordSetupRequired: false,
        passwordSetupTokenHash: null,
        passwordSetupTokenUsedAt: expect.any(Date),
      }),
      include: { organization: true },
    });
  });
});
