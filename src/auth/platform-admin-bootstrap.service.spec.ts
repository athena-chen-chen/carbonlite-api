import { UserRole } from '@prisma/client';
import {
  PLATFORM_ADMIN_ACCOUNT_TYPE,
  PLATFORM_ADMIN_BOOTSTRAP_ACTION,
  PlatformAdminBootstrapService,
} from './platform-admin-bootstrap.service';

type StoredUser = {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
  accountType: string | null;
  passwordHash: string | null;
  passwordSetupRequired: boolean;
  passwordSetupTokenHash: string | null;
  passwordSetupTokenExpiresAt: Date | null;
  passwordSetupTokenUsedAt: Date | null;
  isActive: boolean;
  firstName: string | null;
  lastName: string | null;
};

const validInput = {
  email: 'RC-Platform-Admin@carbonlite.invalid',
  name: 'RC Platform Administrator',
  anchorOrganizationId: 'demo-org-id',
  confirmEnvironment: 'carbonlite-phase2-real-data-rc',
};
const enabledEnvironment = {
  ALLOW_PLATFORM_ADMIN_BOOTSTRAP: 'true',
  PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT:
    'carbonlite-phase2-real-data-rc',
};

function createHarness(options?: {
  users?: StoredUser[];
  failAudit?: boolean;
}) {
  const state = {
    users: [...(options?.users ?? [])],
    audits: [] as Array<Record<string, unknown>>,
    organizations: [
      {
        id: 'demo-org-id',
        isActive: true,
        customerStatus: 'PENDING',
      },
    ],
    memberships: [] as unknown[],
    invitations: [] as unknown[],
    realDataAuthorizations: [] as unknown[],
    aiAuthorizations: [] as unknown[],
    evidence: [] as unknown[],
  };

  let sequence = 0;
  const prisma = {
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => {
      const stagedUsers = state.users.map((user) => ({ ...user }));
      const stagedAudits = state.audits.map((audit) => ({ ...audit }));
      const tx = {
        user: {
          count: jest.fn(async () =>
            stagedUsers.filter(
              (user) =>
                user.role === UserRole.ADMIN &&
                user.accountType !== 'PILOT_REVIEWER',
            ).length,
          ),
          findUnique: jest.fn(async ({ where }: { where: { email: string } }) =>
            stagedUsers.find((user) => user.email === where.email) ?? null,
          ),
          create: jest.fn(async ({ data }: { data: Omit<StoredUser, 'id'> }) => {
            sequence += 1;
            const created = { id: `bootstrap-user-${sequence}`, ...data };
            stagedUsers.push(created);
            return created;
          }),
        },
        organization: {
          findUnique: jest.fn(
            async ({ where }: { where: { id: string } }) =>
              state.organizations.find((org) => org.id === where.id) ?? null,
          ),
        },
        auditLog: {
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            if (options?.failAudit) throw new Error('controlled audit failure');
            stagedAudits.push(data);
            return data;
          }),
        },
      };
      const result = await callback(tx);
      state.users = stagedUsers;
      state.audits = stagedAudits;
      return result;
    }),
  };
  const auditLog = {
    log: jest.fn(
      async (
        input: Record<string, unknown>,
        tx: {
          auditLog: {
            create: (args: {
              data: Record<string, unknown>;
            }) => Promise<Record<string, unknown>>;
          };
        },
      ) =>
        tx.auditLog.create({ data: input }),
    ),
  };
  const service = new PlatformAdminBootstrapService(
    prisma as never,
    auditLog as never,
  );
  return { service, state, prisma, auditLog };
}

describe('PlatformAdminBootstrapService', () => {
  it('fails closed when bootstrap is disabled without starting a transaction', async () => {
    const { service, state, prisma } = createHarness();
    await expect(service.bootstrap(validInput, {})).rejects.toMatchObject({
      code: 'PLATFORM_ADMIN_BOOTSTRAP_DISABLED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.users).toHaveLength(0);
  });

  it('rejects the wrong environment confirmation without mutation', async () => {
    const { service, state, prisma } = createHarness();
    await expect(
      service.bootstrap(
        { ...validInput, confirmEnvironment: 'wrong-environment' },
        enabledEnvironment,
      ),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT_MISMATCH',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.users).toHaveLength(0);
  });

  it('refuses when a platform admin already exists', async () => {
    const existing = existingUser({
      email: 'existing-admin@carbonlite.invalid',
      role: UserRole.ADMIN,
      accountType: PLATFORM_ADMIN_ACCOUNT_TYPE,
    });
    const { service, state } = createHarness({ users: [existing] });
    await expect(
      service.bootstrap(validInput, enabledEnvironment),
    ).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_ALREADY_EXISTS' });
    expect(state.users).toEqual([existing]);
    expect(state.audits).toHaveLength(0);
  });

  it('refuses an existing target email and never promotes it', async () => {
    const existing = existingUser({
      email: 'rc-platform-admin@carbonlite.invalid',
      role: UserRole.USER,
      accountType: 'CUSTOMER',
    });
    const { service, state } = createHarness({ users: [existing] });
    await expect(
      service.bootstrap(validInput, enabledEnvironment),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_TARGET_ALREADY_EXISTS' });
    expect(state.users).toEqual([existing]);
    expect(state.audits).toHaveLength(0);
  });

  it('creates exactly one setup-required admin and no customer side effects', async () => {
    const { service, state } = createHarness();
    const beforeOrganizationCount = state.organizations.length;
    const before = Date.now();
    const result = await service.bootstrap(validInput, enabledEnvironment);

    expect(result).toMatchObject({
      email: 'rc-platform-admin@carbonlite.invalid',
      platformRole: UserRole.ADMIN,
      accountType: PLATFORM_ADMIN_ACCOUNT_TYPE,
      anchorOrganizationId: 'demo-org-id',
    });
    expect(result.setupToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.setupExpiresAt.getTime()).toBeGreaterThan(before);
    expect(result.setupExpiresAt.getTime()).toBeLessThanOrEqual(
      before + 49 * 60 * 60 * 1000,
    );
    expect(state.users).toHaveLength(1);
    expect(state.users[0]).toMatchObject({
      role: UserRole.ADMIN,
      accountType: PLATFORM_ADMIN_ACCOUNT_TYPE,
      passwordHash: null,
      passwordSetupRequired: true,
      passwordSetupTokenUsedAt: null,
      isActive: true,
    });
    expect(state.users[0].passwordSetupTokenHash).not.toBe(result.setupToken);
    expect(state.organizations).toHaveLength(beforeOrganizationCount);
    expect(state.memberships).toHaveLength(0);
    expect(state.invitations).toHaveLength(0);
    expect(state.realDataAuthorizations).toHaveLength(0);
    expect(state.aiAuthorizations).toHaveLength(0);
    expect(state.evidence).toHaveLength(0);
  });

  it('records one minimized audit without credentials or JWT material', async () => {
    const { service, state } = createHarness();
    const result = await service.bootstrap(validInput, enabledEnvironment);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: PLATFORM_ADMIN_BOOTSTRAP_ACTION,
      entityType: 'User',
      entityId: result.userId,
    });
    const serialized = JSON.stringify(state.audits[0]);
    expect(serialized).not.toContain(result.setupToken);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('JWT');
  });

  it('refuses a second execution without creating another user or audit', async () => {
    const { service, state } = createHarness();
    await service.bootstrap(validInput, enabledEnvironment);
    await expect(
      service.bootstrap(
        { ...validInput, email: 'second-admin@carbonlite.invalid' },
        enabledEnvironment,
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_ALREADY_EXISTS' });
    expect(state.users).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('rolls back user creation when audit recording fails', async () => {
    const { service, state } = createHarness({ failAudit: true });
    await expect(
      service.bootstrap(validInput, enabledEnvironment),
    ).rejects.toThrow('controlled audit failure');
    expect(state.users).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
});

function existingUser(
  overrides: Partial<StoredUser> & Pick<StoredUser, 'email'>,
): StoredUser {
  const { email, ...optionalOverrides } = overrides;
  return {
    id: 'existing-user',
    organizationId: 'demo-org-id',
    email,
    role: UserRole.USER,
    accountType: null,
    passwordHash: null,
    passwordSetupRequired: false,
    passwordSetupTokenHash: null,
    passwordSetupTokenExpiresAt: null,
    passwordSetupTokenUsedAt: null,
    isActive: true,
    firstName: 'Existing',
    lastName: 'User',
    ...optionalOverrides,
  };
}
