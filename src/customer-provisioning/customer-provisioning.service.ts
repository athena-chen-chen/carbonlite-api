import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MembershipRole,
  OrganizationCustomerStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.service';
import { isPlatformAdmin } from '../common/permissions/workspace-permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  getGoldenSampleActivityWhere,
  GOLDEN_SAMPLE_REPORT_TITLE,
} from '../sample-data/golden-sample-data.service';
import { CleanupGoldenSampleDto } from './dto/cleanup-golden-sample.dto';
import { ProvisionPaidPilotDto } from './dto/provision-paid-pilot.dto';
import { LegalHoldsService } from '../legal-holds/legal-holds.service';

const CUSTOMER_ACCOUNT_TYPE = 'CUSTOMER';

@Injectable()
export class CustomerProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly legalHolds?: LegalHoldsService,
  ) {}

  async provisionPaidPilotOrganization(
    actor: AuthenticatedUser,
    command: ProvisionPaidPilotDto,
  ) {
    this.assertAuthorized(actor, command.organizationId);
    this.assertConfirmed(command);

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: command.organizationId },
      });
      if (!organization) throw new NotFoundException('Organization not found.');
      if (organization.slug !== command.confirmationOrganizationSlug) {
        throw new BadRequestException('Exact organization slug confirmation is required.');
      }
      if (organization.customerStatus === OrganizationCustomerStatus.SUSPENDED) {
        throw new ConflictException('A suspended organization cannot be provisioned.');
      }

      const goldenSample = await this.findGoldenSampleArtifacts(
        tx,
        organization.id,
      );
      if (goldenSample.activityIds.length > 0 || goldenSample.reportIds.length > 0) {
        throw new ConflictException({
          code: 'DEMO_DATA_PRESENT',
          message:
            'Known Golden Sample artifacts must be removed with the guarded cleanup operation before provisioning.',
        });
      }

      const primaryAdmin = await tx.user.findFirst({
        where: {
          id: command.primaryAdminUserId,
          organizationId: organization.id,
          isActive: true,
        },
      });
      if (!primaryAdmin) {
        throw new BadRequestException(
          'Primary customer administrator must be an active user in the target organization.',
        );
      }
      if (primaryAdmin.role === UserRole.ADMIN) {
        throw new ConflictException(
          'A platform administrator cannot be assigned as the customer administrator.',
        );
      }

      const membership = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: primaryAdmin.id,
            organizationId: organization.id,
          },
        },
      });
      const correctlyProvisioned =
        organization.customerStatus === OrganizationCustomerStatus.ACTIVE &&
        organization.provisionedAt !== null &&
        organization.allowDemoFactorsForCalculations === false &&
        membership?.role === MembershipRole.OWNER &&
        primaryAdmin.accountType === CUSTOMER_ACCOUNT_TYPE &&
        primaryAdmin.accountExpiresAt === null;

      if (correctlyProvisioned) {
        return this.result(
          organization.id,
          primaryAdmin.id,
          organization.provisionedAt!,
          'ALREADY_PROVISIONED',
          true,
        );
      }
      if (organization.customerStatus === OrganizationCustomerStatus.ACTIVE) {
        throw new ConflictException(
          'Organization is already active with different provisioning state.',
        );
      }

      await tx.membership.upsert({
        where: {
          userId_organizationId: {
            userId: primaryAdmin.id,
            organizationId: organization.id,
          },
        },
        create: {
          userId: primaryAdmin.id,
          organizationId: organization.id,
          role: MembershipRole.OWNER,
        },
        update: { role: MembershipRole.OWNER },
      });
      await tx.user.update({
        where: { id: primaryAdmin.id },
        data: {
          accountType: CUSTOMER_ACCOUNT_TYPE,
          accountExpiresAt: null,
        },
      });

      const provisionedAt = new Date();
      const provisioned = await tx.organization.update({
        where: { id: organization.id },
        data: {
          customerStatus: OrganizationCustomerStatus.ACTIVE,
          provisionedAt,
          allowDemoFactorsForCalculations: false,
          isActive: true,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: organization.id,
          userId: actor.id,
          action: 'CUSTOMER_ORGANIZATION_PROVISIONED',
          entityType: 'Organization',
          entityId: organization.id,
          description: 'Provisioned paid-pilot customer organization.',
          oldValue: {
            customerStatus: organization.customerStatus,
            allowDemoFactorsForCalculations:
              organization.allowDemoFactorsForCalculations,
          },
          newValue: {
            customerStatus: provisioned.customerStatus,
            allowDemoFactorsForCalculations:
              provisioned.allowDemoFactorsForCalculations,
            primaryAdminUserId: primaryAdmin.id,
            result: 'PROVISIONED',
            provisionedAt: provisionedAt.toISOString(),
          },
        },
      });

      return this.result(
        organization.id,
        primaryAdmin.id,
        provisionedAt,
        'PROVISIONED',
        false,
      );
    });
  }

  async cleanupGoldenSampleArtifacts(
    actor: AuthenticatedUser,
    command: CleanupGoldenSampleDto,
  ) {
    this.assertAuthorized(actor, command.organizationId);
    if (
      command.confirmCleanup !== true ||
      command.confirmationOrganizationId !== command.organizationId
    ) {
      throw new BadRequestException('Exact organization confirmation is required.');
    }

    const candidateArtifacts = await this.findGoldenSampleArtifacts(
      this.prisma,
      command.organizationId,
    );
    return this.holdGuard.withDeletionGuard({
      organizationId: command.organizationId,
      operation: 'PROVISIONING_GOLDEN_SAMPLE_CLEANUP',
      actorUserId: actor.id,
      activityIds: candidateArtifacts.activityIds,
      reportIds: candidateArtifacts.reportIds,
    }, async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: command.organizationId },
      });
      if (!organization) throw new NotFoundException('Organization not found.');
      if (organization.slug !== command.confirmationOrganizationSlug) {
        throw new BadRequestException(
          'Exact organization slug confirmation is required.',
        );
      }
      const artifacts = await this.findGoldenSampleArtifacts(
        tx,
        organization.id,
      );
      const metricResults = artifacts.activityIds.length
        ? await tx.metricResult.deleteMany({
            where: {
              organizationId: organization.id,
              activityDataId: { in: artifacts.activityIds },
            },
          })
        : { count: 0 };
      const activities = await tx.activityData.deleteMany({
        where: {
          organizationId: organization.id,
          id: { in: candidateArtifacts.activityIds },
        },
      });
      const reports = await tx.report.deleteMany({
        where: {
          organizationId: organization.id,
          id: { in: candidateArtifacts.reportIds },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: organization.id,
          userId: actor.id,
          action: 'GOLDEN_SAMPLE_ARTIFACTS_CLEANED',
          entityType: 'Organization',
          entityId: organization.id,
          description: 'Removed known Golden Sample artifacts before customer provisioning.',
          newValue: {
            activityRecordsDeleted: activities.count,
            metricResultsDeleted: metricResults.count,
            reportsDeleted: reports.count,
          },
        },
      });

      const removed =
        activities.count + metricResults.count + reports.count;
      return {
        organizationId: organization.id,
        status: removed > 0 ? 'CLEANED' : 'NOTHING_TO_CLEAN',
        activityRecordsDeleted: activities.count,
        metricResultsDeleted: metricResults.count,
        reportsDeleted: reports.count,
      };
    });
  }

  private async findGoldenSampleArtifacts(
    tx: Prisma.TransactionClient | PrismaService,
    organizationId: string,
  ) {
    const [activities, reports] = await Promise.all([
      tx.activityData.findMany({
        where: getGoldenSampleActivityWhere(organizationId),
        select: { id: true },
      }),
      tx.report.findMany({
        where: { organizationId, title: GOLDEN_SAMPLE_REPORT_TITLE },
        select: { id: true },
      }),
    ]);
    return {
      activityIds: activities.map(activity => activity.id),
      reportIds: reports.map(report => report.id),
    };
  }

  private get holdGuard() {
    if (!this.legalHolds) {
      throw new ServiceUnavailableException('Legal hold enforcement is unavailable.');
    }
    return this.legalHolds;
  }

  private assertAuthorized(actor: AuthenticatedUser, organizationId: string) {
    if (!isPlatformAdmin(actor)) {
      throw new ForbiddenException(
        'Only a platform administrator can provision a customer organization.',
      );
    }
    if (actor.organizationId === organizationId) {
      throw new ForbiddenException(
        'A platform administrator cannot provision their active organization.',
      );
    }
  }

  private assertConfirmed(command: ProvisionPaidPilotDto) {
    if (
      command.confirmProvision !== true ||
      command.confirmationOrganizationId !== command.organizationId
    ) {
      throw new BadRequestException('Exact organization confirmation is required.');
    }
  }

  private result(
    organizationId: string,
    primaryAdminUserId: string,
    provisionedAt: Date,
    status: 'PROVISIONED' | 'ALREADY_PROVISIONED',
    alreadyProvisioned: boolean,
  ) {
    return {
      organizationId,
      status,
      primaryAdminUserId,
      provisionedAt: provisionedAt.toISOString(),
      alreadyProvisioned,
      warnings: [],
    };
  }
}
