import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
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
      isActive: true,
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
        status: 'Active',
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

  it('uses FRONTEND_URL for production pilot reviewer invite links', async () => {
    process.env.APP_ENV = 'production';
    process.env.FRONTEND_URL = 'https://www.carbonliteapp.ca';
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
      isActive: true,
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
        email: 'reviewer@example.com',
      },
    );

    expect(result.inviteLink).toMatch(
      /^https:\/\/www\.carbonliteapp\.ca\/set-password\?token=.+/,
    );
  });

  it('does not create pilot reviewer accounts in production when frontend URL is missing', async () => {
    process.env.APP_ENV = 'production';
    delete process.env.FRONTEND_URL;
    delete process.env.APP_URL;

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
          email: 'reviewer@example.com',
        },
      ),
    ).rejects.toThrow(
      'Production frontend URL is not configured correctly. Please set FRONTEND_URL to https://www.carbonliteapp.ca.',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not create pilot reviewer accounts in production when frontend URL is localhost', async () => {
    process.env.APP_ENV = 'production';
    process.env.FRONTEND_URL = 'http://localhost:5173';

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
          email: 'reviewer@example.com',
        },
      ),
    ).rejects.toThrow(
      'Production frontend URL is not configured correctly. Please set FRONTEND_URL to https://www.carbonliteapp.ca.',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
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
      'alexander@gamil.com',
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

  it('deactivates pilot reviewer accounts without deleting workspace data', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      firstName: 'Test',
      lastName: 'Reviewer',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      accountExpiresAt: null,
      isActive: true,
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });
    prisma.user.update.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      firstName: 'Test',
      lastName: 'Reviewer',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      accountExpiresAt: null,
      isActive: false,
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });

    await expect(
      service.deactivatePilotReviewer(
        {
          id: 'admin-1',
          email: 'admin@example.com',
          organizationId: 'admin-org',
          organizationName: 'Admin Org',
          role: UserRole.ADMIN,
        },
        { email: ' Reviewer@Example.com ' },
      ),
    ).resolves.toMatchObject({
      success: true,
      message: 'This pilot reviewer account has been deactivated.',
      pilotReviewer: {
        email: 'reviewer@example.com',
        status: 'Deactivated',
      },
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'reviewer@example.com' },
      include: { organization: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'reviewer-1' },
      data: expect.objectContaining({
        isActive: false,
        passwordSetupTokenHash: null,
      }),
      include: { organization: true },
    });
    expect(prisma.activityData.deleteMany).not.toHaveBeenCalled();
    expect(prisma.report.deleteMany).not.toHaveBeenCalled();
  });

  it('regenerates invite links for active pilot reviewers without changing access', async () => {
    process.env.APP_ENV = 'production';
    process.env.FRONTEND_URL = 'https://www.carbonliteapp.ca';
    prisma.user.findUnique.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      firstName: 'Test',
      lastName: 'Reviewer',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      accountExpiresAt: null,
      isActive: true,
      organizationId: 'sample-workspace',
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });
    prisma.user.update.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      firstName: 'Test',
      lastName: 'Reviewer',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      accountExpiresAt: null,
      isActive: true,
      organizationId: 'sample-workspace',
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });

    const result = await service.regeneratePilotReviewerInvite(
      {
        id: 'admin-1',
        email: 'admin@example.com',
        organizationId: 'admin-org',
        organizationName: 'Admin Org',
        role: UserRole.ADMIN,
      },
      { email: ' Reviewer@Example.com ' },
    );

    expect(result).toMatchObject({
      success: true,
      message: 'Invite link regenerated.',
      pilotReviewer: {
        email: 'reviewer@example.com',
        accountType: 'PILOT_REVIEWER',
        role: MembershipRole.VIEWER,
        workspaceName: 'CarbonLite Sample Workspace',
        status: 'Active',
      },
    });
    expect(result.inviteLink).toMatch(
      /^https:\/\/www\.carbonliteapp\.ca\/set-password\?token=.+/,
    );
    expect(result.inviteLink).not.toContain('passwordSetupTokenHash');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'reviewer@example.com' },
      include: { organization: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'reviewer-1' },
      data: expect.objectContaining({
        passwordSetupRequired: true,
        passwordSetupTokenHash: expect.any(String),
        passwordSetupTokenExpiresAt: expect.any(Date),
        passwordSetupTokenUsedAt: null,
      }),
      include: { organization: true },
    });
    const updatedData = prisma.user.update.mock.calls[0][0].data;
    expect(updatedData).not.toHaveProperty('role');
    expect(updatedData).not.toHaveProperty('accountType');
    expect(updatedData).not.toHaveProperty('organizationId');
    expect(updatedData).not.toHaveProperty('passwordHash');
  });

  it('does not regenerate invite links for deactivated pilot reviewers', async () => {
    process.env.FRONTEND_URL = 'http://localhost:5173';
    prisma.user.findUnique.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      accountExpiresAt: null,
      isActive: false,
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });

    await expect(
      service.regeneratePilotReviewerInvite(
        {
          id: 'admin-1',
          email: 'admin@example.com',
          organizationId: 'admin-org',
          organizationName: 'Admin Org',
          role: UserRole.ADMIN,
        },
        { email: 'reviewer@example.com' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does not deactivate admin accounts through the pilot reviewer action', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      role: UserRole.ADMIN,
      accountType: null,
      isActive: true,
      organization: { id: 'admin-org', name: 'Admin Org' },
    });

    await expect(
      service.deactivatePilotReviewer(
        {
          id: 'admin-2',
          email: 'admin2@example.com',
          organizationId: 'admin-org',
          organizationName: 'Admin Org',
          role: UserRole.ADMIN,
        },
        { email: 'admin@example.com' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects deactivate for non pilot reviewer accounts', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'customer-1',
      email: 'customer@example.com',
      role: UserRole.USER,
      accountType: 'CUSTOMER',
      isActive: true,
      organization: { id: 'customer-org', name: 'Customer Org' },
    });

    await expect(
      service.deactivatePilotReviewer(
        {
          id: 'admin-1',
          email: 'admin@example.com',
          organizationId: 'admin-org',
          organizationName: 'Admin Org',
          role: UserRole.ADMIN,
        },
        { email: 'customer@example.com' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('blocks login for deactivated pilot reviewers with a friendly message', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      passwordHash: 'hash',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      isActive: false,
      accountExpiresAt: null,
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });

    await expect(service.login('reviewer@example.com', 'password123')).rejects.toThrow(
      'This account has been deactivated. Please contact hello@carbonliteapp.ca.',
    );
  });

  it('uses production-safe wording for invalid login credentials', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.login('missing@example.com', 'password123')).rejects.toThrow(
      'The email or password is incorrect.',
    );
  });

  it('sets password from a valid invite and clears the active token hash', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      organizationId: 'sample-workspace',
      role: UserRole.USER,
      accountType: 'PILOT_REVIEWER',
      isActive: true,
      passwordSetupTokenUsedAt: null,
      passwordSetupTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      accountExpiresAt: null,
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
      }),
      include: { organization: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'reviewer-1' },
      data: expect.objectContaining({
        passwordHash: expect.any(String),
        passwordSetupRequired: false,
        passwordSetupTokenUsedAt: expect.any(Date),
      }),
      include: { organization: true },
    });
  });

  it('shows a friendly invalid or expired invite message without exposing token details', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.setPasswordFromInvite({
        token: 'missing-token',
        password: 'password123',
      }),
    ).rejects.toThrow(
      'This invite link has expired. Please contact hello@carbonliteapp.ca for a new link.',
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('shows a friendly already-used invite message without exposing token details', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      passwordSetupTokenHash: 'hashed-token',
      passwordSetupTokenUsedAt: new Date('2026-08-01T12:00:00.000Z'),
      passwordSetupTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      isActive: true,
      accountExpiresAt: null,
      organization: {
        id: 'sample-workspace',
        name: 'CarbonLite Sample Workspace',
      },
    });

    await expect(
      service.setPasswordFromInvite({
        token: 'used-token',
        password: 'password123',
      }),
    ).rejects.toThrow(
      'This invite link has already been used. Please log in or contact hello@carbonliteapp.ca.',
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
