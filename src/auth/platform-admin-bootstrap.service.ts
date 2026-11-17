import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { createPasswordSetupCredential } from './password-setup-credential';

export const PLATFORM_ADMIN_ACCOUNT_TYPE = 'PLATFORM_ADMIN';
export const PLATFORM_ADMIN_BOOTSTRAP_ACTION = 'PLATFORM_ADMIN_BOOTSTRAPPED';

export type PlatformAdminBootstrapInput = {
  email: string;
  name: string;
  anchorOrganizationId: string;
  confirmEnvironment: string;
};

export type PlatformAdminBootstrapEnvironment = Record<
  string,
  string | undefined
>;

export class PlatformAdminBootstrapError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PlatformAdminBootstrapError';
  }
}

export function assertPlatformAdminBootstrapOperatorGuards(
  input: Pick<
    PlatformAdminBootstrapInput,
    'anchorOrganizationId' | 'confirmEnvironment'
  >,
  environment: PlatformAdminBootstrapEnvironment,
) {
  if (environment.ALLOW_PLATFORM_ADMIN_BOOTSTRAP !== 'true') {
    throw new PlatformAdminBootstrapError('PLATFORM_ADMIN_BOOTSTRAP_DISABLED');
  }

  const expected = String(
    environment.PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT ?? '',
  ).trim();
  const confirmed = String(input.confirmEnvironment ?? '').trim();
  if (!expected || !confirmed || expected !== confirmed) {
    throw new PlatformAdminBootstrapError(
      'PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT_MISMATCH',
    );
  }

  if (!String(input.anchorOrganizationId ?? '').trim()) {
    throw new PlatformAdminBootstrapError(
      'BOOTSTRAP_ANCHOR_ORGANIZATION_REQUIRED',
    );
  }
}

@Injectable()
export class PlatformAdminBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async bootstrap(
    input: PlatformAdminBootstrapInput,
    environment: PlatformAdminBootstrapEnvironment = process.env,
  ) {
    assertPlatformAdminBootstrapOperatorGuards(input, environment);
    const email = this.normalizeEmail(input.email);
    const { firstName, lastName } = this.splitName(input.name);
    const credential = createPasswordSetupCredential();

    return this.prisma.$transaction(
      async (tx) => {
        const platformAdminCount = await tx.user.count({
          where: {
            role: UserRole.ADMIN,
            OR: [
              { accountType: null },
              { accountType: { not: 'PILOT_REVIEWER' } },
            ],
          },
        });
        if (platformAdminCount !== 0) {
          throw new PlatformAdminBootstrapError(
            'PLATFORM_ADMIN_ALREADY_EXISTS',
          );
        }

        if (await tx.user.findUnique({ where: { email } })) {
          throw new PlatformAdminBootstrapError(
            'BOOTSTRAP_TARGET_ALREADY_EXISTS',
          );
        }

        const anchorOrganization = await tx.organization.findUnique({
          where: { id: input.anchorOrganizationId.trim() },
          select: { id: true, isActive: true, customerStatus: true },
        });
        if (
          !anchorOrganization ||
          !anchorOrganization.isActive ||
          anchorOrganization.customerStatus === 'SUSPENDED'
        ) {
          throw new PlatformAdminBootstrapError(
            'BOOTSTRAP_ANCHOR_ORGANIZATION_INVALID',
          );
        }

        // User.organizationId is required by the existing schema. A platform
        // admin is anchored to an explicitly confirmed existing infrastructure
        // organization without receiving a customer membership.
        const user = await tx.user.create({
          data: {
            organizationId: anchorOrganization.id,
            email,
            firstName,
            lastName,
            role: UserRole.ADMIN,
            accountType: PLATFORM_ADMIN_ACCOUNT_TYPE,
            isActive: true,
            passwordHash: null,
            passwordSetupRequired: true,
            passwordSetupTokenHash: credential.tokenHash,
            passwordSetupTokenExpiresAt: credential.expiresAt,
            passwordSetupTokenUsedAt: null,
          },
        });

        await this.auditLog.log(
          {
            organizationId: anchorOrganization.id,
            userId: user.id,
            action: PLATFORM_ADMIN_BOOTSTRAP_ACTION,
            entityType: 'User',
            entityId: user.id,
            description: 'First platform administrator bootstrapped.',
            newValue: {
              platformRole: UserRole.ADMIN,
              accountType: PLATFORM_ADMIN_ACCOUNT_TYPE,
              environment: input.confirmEnvironment.trim(),
              setupRequired: true,
              setupExpiresAt: credential.expiresAt.toISOString(),
            },
          },
          tx,
        );

        return {
          userId: user.id,
          email: user.email,
          platformRole: user.role,
          accountType: user.accountType,
          anchorOrganizationId: anchorOrganization.id,
          setupToken: credential.token,
          setupExpiresAt: credential.expiresAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private normalizeEmail(value: string) {
    const email = String(value ?? '').trim().toLowerCase();
    if (
      /[[\]()"']|mailto:/i.test(email) ||
      !/^[^\s@()[\]"']+@[^\s@()[\]"']+\.[^\s@()[\]"']+$/.test(email)
    ) {
      throw new PlatformAdminBootstrapError(
        'PLATFORM_ADMIN_BOOTSTRAP_EMAIL_INVALID',
      );
    }
    return email;
  }

  private splitName(value: string) {
    const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!normalized) {
      throw new PlatformAdminBootstrapError(
        'PLATFORM_ADMIN_BOOTSTRAP_NAME_REQUIRED',
      );
    }
    const [firstName, ...rest] = normalized.split(' ');
    return { firstName, lastName: rest.length ? rest.join(' ') : null };
  }
}
