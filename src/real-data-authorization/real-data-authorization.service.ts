import { createHmac, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AiAuthorizedDataMode,
  AiAuthorizationStatus,
  OrganizationCustomerStatus,
  Prisma,
  RealDataAuthorizationStatus,
} from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { getGoldenSampleActivityWhere, GOLDEN_SAMPLE_REPORT_TITLE } from '../sample-data/golden-sample-data.service';
import { ApproveRealDataAuthorizationDto } from './dto/approve-real-data-authorization.dto';
import { WithdrawRealDataAuthorizationDto } from './dto/withdraw-real-data-authorization.dto';
import {
  codedBadRequest,
  codedForbidden,
  codedServiceUnavailable,
  DeclaredIngestionDataMode,
  INGESTION_MODE_REAL,
  INGESTION_MODE_SYNTHETIC,
  REAL_DATA_ALLOWED_SCOPE_CODE,
  REAL_DATA_EVIDENCE_HMAC_KEY_ENV,
  REAL_DATA_POLICY_VERSION,
  RealDataEffectiveReason,
} from './real-data-authorization.constants';

@Injectable()
export class RealDataAuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async getCustomerStatus(organizationId: string) {
    try {
      const authorization = await this.prisma.organizationRealDataAuthorization.findUnique({
        where: { organizationId },
        include: { organization: { select: { isActive: true, customerStatus: true } } },
      });
      const status = this.toCustomerStatus(authorization, new Date());
      return {
        effectiveMode: status.effectiveMode,
        configuredStatus: status.configuredStatus,
        policyVersion: status.policyVersion,
        effectiveAt: status.effectiveAt,
        expiresAt: status.expiresAt,
        reviewDueAt: status.reviewDueAt,
        reason: status.reason,
      };
    } catch {
      const status = this.syntheticStatus('STATUS_LOOKUP_FAILED');
      return {
        effectiveMode: status.effectiveMode,
        configuredStatus: status.configuredStatus,
        policyVersion: status.policyVersion,
        effectiveAt: status.effectiveAt,
        expiresAt: status.expiresAt,
        reviewDueAt: status.reviewDueAt,
        reason: status.reason,
      };
    }
  }

  getForAdmin(organizationId: string) {
    return this.prisma.organizationRealDataAuthorization.findUnique({
      where: { organizationId },
    });
  }

  async approve(
    organizationId: string,
    actorId: string,
    dto: ApproveRealDataAuthorizationDto,
  ) {
    this.assertExactTarget(organizationId, dto);
    if (dto.policyVersion.trim() !== REAL_DATA_POLICY_VERSION) {
      throw new BadRequestException(
        codedBadRequest('UNSUPPORTED_REAL_DATA_POLICY_VERSION', `Policy version must be ${REAL_DATA_POLICY_VERSION}.`),
      );
    }
    const effectiveAt = new Date(dto.effectiveAt);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const reviewDueAt = dto.reviewDueAt ? new Date(dto.reviewDueAt) : null;
    if (expiresAt && expiresAt <= effectiveAt) {
      throw new BadRequestException(codedBadRequest('INVALID_REAL_DATA_DATE_RANGE', 'Expiry must be after the effective time.'));
    }
    if (reviewDueAt && reviewDueAt <= effectiveAt) {
      throw new BadRequestException(codedBadRequest('INVALID_REAL_DATA_DATE_RANGE', 'Review date must be after the effective time.'));
    }

    return this.prisma.$transaction(async tx => {
      await this.assertApprovalPrerequisites(tx, organizationId, dto.confirmationOrganizationSlug);
      const previous = await tx.organizationRealDataAuthorization.findUnique({ where: { organizationId } });
      const normalized = {
        policyVersion: dto.policyVersion.trim(),
        agreementEvidenceReference: dto.agreementEvidenceReference.trim(),
        allowedDataScopeReference: dto.allowedDataScopeReference.trim(),
        privacySecurityReadinessReference: dto.privacySecurityReadinessReference.trim(),
      };
      if (previous?.status === RealDataAuthorizationStatus.REAL_DATA_APPROVED) {
        if (this.isIdenticalApproval(previous, normalized, effectiveAt, expiresAt, reviewDueAt)) {
          return { result: 'ALREADY_APPROVED' as const, authorization: previous };
        }
        throw new ConflictException(
          'A different real-data authorization is already active. Withdraw it before recording a new decision.',
        );
      }

      const approvedAt = new Date();
      const approvalRevision = (previous?.approvalRevision ?? 0) + 1;
      const decisionId = randomUUID();
      const authorization = await tx.organizationRealDataAuthorization.upsert({
        where: { organizationId },
        create: {
          organizationId,
          decisionId,
          status: RealDataAuthorizationStatus.REAL_DATA_APPROVED,
          approvalRevision,
          ...normalized,
          approvedById: actorId,
          approvedAt,
          effectiveAt,
          expiresAt,
          reviewDueAt,
        },
        update: {
          decisionId,
          status: RealDataAuthorizationStatus.REAL_DATA_APPROVED,
          approvalRevision,
          ...normalized,
          approvedById: actorId,
          approvedAt,
          effectiveAt,
          expiresAt,
          reviewDueAt,
          withdrawnById: null,
          withdrawnAt: null,
          withdrawalReason: null,
        },
      });
      await this.writeEvidence(tx, authorization);
      await this.auditLog.log({
        organizationId,
        userId: actorId,
        action: 'REAL_DATA_AUTHORIZATION_APPROVED',
        entityType: 'OrganizationRealDataAuthorization',
        entityId: organizationId,
        description: 'Organization real-data pilot authorization approved.',
        oldValue: previous ? { status: previous.status, approvalRevision: previous.approvalRevision } : null,
        newValue: {
          status: authorization.status,
          approvalRevision,
          policyVersion: authorization.policyVersion,
          evidenceReferencesPresent: true,
          effectiveAt,
          expiresAt,
          reviewDueAt,
        },
      }, tx);
      return { result: 'APPROVED' as const, authorization };
    });
  }

  async withdraw(
    organizationId: string,
    actorId: string,
    dto: WithdrawRealDataAuthorizationDto,
  ) {
    this.assertExactTarget(organizationId, dto);
    return this.prisma.$transaction(tx => this.withdrawWithinTransaction(
      tx,
      organizationId,
      actorId,
      dto.withdrawalReason.trim(),
    ));
  }

  async withdrawWithinTransaction(
    tx: Prisma.TransactionClient,
    organizationId: string,
    actorId: string,
    withdrawalReason: string,
  ) {
    const previous = await tx.organizationRealDataAuthorization.findUnique({ where: { organizationId } });
    if (!previous) throw new NotFoundException('Real-data authorization record not found.');
    if (previous.status === RealDataAuthorizationStatus.WITHDRAWN) {
      return { result: 'ALREADY_WITHDRAWN' as const, authorization: previous };
    }
    const withdrawnAt = new Date();
    const authorization = await tx.organizationRealDataAuthorization.update({
      where: { organizationId },
      data: {
        status: RealDataAuthorizationStatus.WITHDRAWN,
        withdrawnById: actorId,
        withdrawnAt,
        withdrawalReason,
      },
    });
    const realDataAi = await tx.organizationAiAuthorization.findUnique({ where: { organizationId } });
    if (
      realDataAi?.status === AiAuthorizationStatus.ENABLED &&
      realDataAi.authorizedDataMode === AiAuthorizedDataMode.REAL_CUSTOMER_DATA
    ) {
      await tx.organizationAiAuthorization.update({
        where: { organizationId },
        data: {
          status: AiAuthorizationStatus.WITHDRAWN,
          withdrawnAt,
          withdrawalReference: `REAL_DATA_AUTHORIZATION_WITHDRAWN:${withdrawalReason}`,
        },
      });
      await this.auditLog.log({
        organizationId,
        userId: actorId,
        action: 'AI_AUTHORIZATION_WITHDRAWN',
        entityType: 'OrganizationAiAuthorization',
        entityId: organizationId,
        description: 'Real-customer-data AI authorization withdrawn with real-data authorization.',
        oldValue: { status: realDataAi.status, authorizedDataMode: realDataAi.authorizedDataMode },
        newValue: { status: AiAuthorizationStatus.WITHDRAWN, authorizedDataMode: realDataAi.authorizedDataMode },
      }, tx);
    }
    await this.writeEvidence(tx, authorization);
    await this.auditLog.log({
      organizationId,
      userId: actorId,
      action: 'REAL_DATA_AUTHORIZATION_WITHDRAWN',
      entityType: 'OrganizationRealDataAuthorization',
      entityId: organizationId,
      description: 'Organization real-data pilot authorization withdrawn.',
      oldValue: { status: previous.status, approvalRevision: previous.approvalRevision },
      newValue: { status: authorization.status, approvalRevision: authorization.approvalRevision },
    }, tx);
    return { result: 'WITHDRAWN' as const, authorization };
  }

  async resolveIngestionMode(
    organizationId: string,
    rawMode: string | undefined,
    actorId?: string,
  ): Promise<DeclaredIngestionDataMode> {
    const normalized = rawMode?.trim().toUpperCase();
    if (normalized && normalized !== INGESTION_MODE_SYNTHETIC && normalized !== INGESTION_MODE_REAL) {
      throw new BadRequestException(codedBadRequest('INVALID_DATA_MODE', 'Ingestion data mode is invalid.'));
    }
    let status;
    try {
      const authorization = await this.prisma.organizationRealDataAuthorization.findUnique({
        where: { organizationId },
        include: { organization: { select: { isActive: true, customerStatus: true } } },
      });
      status = this.toCustomerStatus(authorization, new Date());
    } catch {
      throw new ServiceUnavailableException(
        codedServiceUnavailable('REAL_DATA_AUTHORIZATION_UNAVAILABLE', 'Real-data authorization could not be verified.'),
      );
    }
    if (!normalized) {
      if (status.effective || process.env.REQUIRE_EXPLICIT_INGESTION_DATA_MODE === 'true') {
        throw new BadRequestException(codedBadRequest('DATA_MODE_REQUIRED', 'Ingestion data mode is required.'));
      }
      await this.auditLog.log({
        organizationId,
        userId: actorId,
        action: 'INGESTION_DATA_MODE_DEFAULTED',
        entityType: 'Organization',
        entityId: organizationId,
        description: 'Missing ingestion data mode temporarily defaulted to synthetic/test.',
        newValue: { mode: INGESTION_MODE_SYNTHETIC, deprecatedCompatibility: true },
      });
      return INGESTION_MODE_SYNTHETIC;
    }
    if (normalized === INGESTION_MODE_REAL && !status.effective) {
      throw new ForbiddenException(
        codedForbidden('REAL_DATA_NOT_AUTHORIZED', 'This organization is not authorized to submit real customer data.'),
      );
    }
    await this.auditLog.log({
      organizationId,
      userId: actorId,
      action: 'INGESTION_DATA_MODE_DECLARED',
      entityType: 'Organization',
      entityId: organizationId,
      description: 'Ingestion data mode declared for an intake operation.',
      newValue: { mode: normalized },
    });
    return normalized as DeclaredIngestionDataMode;
  }

  async assertEffectiveRealDataApproval(organizationId: string, expectedRevision?: number) {
    let authorization;
    try {
      authorization = await this.prisma.organizationRealDataAuthorization.findUnique({
        where: { organizationId },
        include: { organization: { select: { isActive: true, customerStatus: true } } },
      });
    } catch {
      throw new ServiceUnavailableException(
        codedServiceUnavailable(
          'REAL_DATA_AUTHORIZATION_UNAVAILABLE',
          'Real-data authorization could not be verified.',
        ),
      );
    }
    const status = this.toCustomerStatus(authorization, new Date());
    if (!status.effective || !authorization) {
      throw new ForbiddenException(codedForbidden('REAL_DATA_NOT_AUTHORIZED', 'Real-data authorization is not effective.'));
    }
    if (expectedRevision !== undefined && authorization.approvalRevision !== expectedRevision) {
      throw new ForbiddenException(
        codedForbidden('REAL_DATA_APPROVAL_REVISION_MISMATCH', 'Real-data authorization revision does not match.'),
      );
    }
    return authorization;
  }

  async markWorkspaceErased(
    tx: Prisma.TransactionClient,
    organizationId: string,
    erasedAt: Date,
  ) {
    const authorization = await tx.organizationRealDataAuthorization.findUnique({
      where: { organizationId },
      select: { decisionId: true },
    });
    if (!authorization) return { count: 0 };

    return tx.realDataAuthorizationEvidence.updateMany({
      where: { organizationIdHash: this.digestEvidenceValue(organizationId) },
      data: { workspaceErasedAt: erasedAt },
    });
  }

  private async assertApprovalPrerequisites(
    tx: Prisma.TransactionClient,
    organizationId: string,
    expectedSlug: string,
  ) {
    const [organization, owner, goldenActivities, goldenReports] = await Promise.all([
      tx.organization.findUnique({
        where: { id: organizationId },
        include: { quotaPolicy: true },
      }),
      tx.membership.findFirst({
        where: {
          organizationId,
          role: 'OWNER',
          user: { accountType: 'CUSTOMER', isActive: true },
        },
      }),
      tx.activityData.count({ where: getGoldenSampleActivityWhere(organizationId) }),
      tx.report.count({ where: { organizationId, title: GOLDEN_SAMPLE_REPORT_TITLE } }),
    ]);
    if (!organization) throw new NotFoundException('Organization not found.');
    if (organization.slug !== expectedSlug) throw new BadRequestException('Exact organization slug confirmation is required.');
    if (!organization.isActive || organization.customerStatus !== OrganizationCustomerStatus.ACTIVE || !organization.provisionedAt) {
      throw new ConflictException('Real-data approval requires a provisioned active customer organization.');
    }
    if (!owner) throw new ConflictException('Real-data approval requires an active CUSTOMER owner.');
    if (organization.allowDemoFactorsForCalculations || goldenActivities + goldenReports > 0) {
      throw new ConflictException('Real-data approval requires zero demo or Golden Sample contamination.');
    }
    if (!organization.quotaPolicy?.enabled) {
      throw new ConflictException('Real-data approval requires an enabled organization quota policy.');
    }
  }

  private assertExactTarget(
    organizationId: string,
    dto: { organizationId: string; confirmationOrganizationId: string },
  ) {
    if (dto.organizationId !== organizationId || dto.confirmationOrganizationId !== organizationId) {
      throw new BadRequestException('Exact organization ID confirmation is required.');
    }
  }

  private toCustomerStatus(authorization: any, now: Date) {
    if (!authorization) return this.syntheticStatus('NOT_CONFIGURED');
    let reason: RealDataEffectiveReason = 'REAL_DATA_APPROVED';
    if (!authorization.organization?.isActive || authorization.organization.customerStatus !== OrganizationCustomerStatus.ACTIVE) {
      reason = 'ORGANIZATION_NOT_ACTIVE';
    } else if (authorization.status === RealDataAuthorizationStatus.WITHDRAWN) {
      reason = 'WITHDRAWN';
    } else if (authorization.status !== RealDataAuthorizationStatus.REAL_DATA_APPROVED) {
      reason = 'NOT_CONFIGURED';
    } else if (authorization.effectiveAt > now) {
      reason = 'PENDING_EFFECTIVE_DATE';
    } else if (authorization.expiresAt && authorization.expiresAt <= now) {
      reason = 'EXPIRED';
    } else if (authorization.reviewDueAt && authorization.reviewDueAt <= now) {
      reason = 'REVIEW_OVERDUE';
    }
    const effective = reason === 'REAL_DATA_APPROVED';
    return {
      effectiveMode: effective ? INGESTION_MODE_REAL : 'SYNTHETIC_ONLY',
      configuredStatus: authorization.status,
      effective,
      policyVersion: authorization.policyVersion,
      approvalRevision: authorization.approvalRevision,
      effectiveAt: authorization.effectiveAt,
      expiresAt: authorization.expiresAt,
      reviewDueAt: authorization.reviewDueAt,
      withdrawnAt: authorization.withdrawnAt,
      reason,
    };
  }

  private syntheticStatus(reason: RealDataEffectiveReason) {
    return {
      effectiveMode: 'SYNTHETIC_ONLY' as const,
      configuredStatus: 'NOT_CONFIGURED' as const,
      effective: false,
      policyVersion: null,
      approvalRevision: null,
      effectiveAt: null,
      expiresAt: null,
      reviewDueAt: null,
      withdrawnAt: null,
      reason,
    };
  }

  private isIdenticalApproval(
    previous: any,
    normalized: Record<string, string>,
    effectiveAt: Date,
    expiresAt: Date | null,
    reviewDueAt: Date | null,
  ) {
    return Object.entries(normalized).every(([key, value]) => previous[key] === value)
      && previous.effectiveAt.getTime() === effectiveAt.getTime()
      && (previous.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null)
      && (previous.reviewDueAt?.getTime() ?? null) === (reviewDueAt?.getTime() ?? null);
  }

  private writeEvidence(tx: Prisma.TransactionClient, authorization: any) {
    return tx.realDataAuthorizationEvidence.create({
      data: {
        organizationIdHash: this.digestEvidenceValue(authorization.organizationId),
        authorizationDecisionId: authorization.decisionId,
        approvalRevision: authorization.approvalRevision,
        decision: authorization.status,
        policyVersion: authorization.policyVersion,
        allowedDataScopeCode: REAL_DATA_ALLOWED_SCOPE_CODE,
        agreementEvidenceReferenceHash: this.digestEvidenceValue(authorization.agreementEvidenceReference),
        readinessEvidenceReferenceHash: this.digestEvidenceValue(authorization.privacySecurityReadinessReference),
        approvedByIdHash: this.digestEvidenceValue(authorization.approvedById),
        approvedAt: authorization.approvedAt,
        effectiveAt: authorization.effectiveAt,
        expiresAt: authorization.expiresAt,
        reviewDueAt: authorization.reviewDueAt,
        withdrawnByIdHash: authorization.withdrawnById
          ? this.digestEvidenceValue(authorization.withdrawnById)
          : null,
        withdrawnAt: authorization.withdrawnAt,
        withdrawalReasonCode: authorization.withdrawnAt ? 'WITHDRAWN' : null,
      },
    });
  }

  private digestEvidenceValue(value: string) {
    const key = process.env[REAL_DATA_EVIDENCE_HMAC_KEY_ENV];
    if (!key || key.length < 32) {
      throw new ServiceUnavailableException(
        codedServiceUnavailable('REAL_DATA_EVIDENCE_KEY_UNAVAILABLE', 'Real-data evidence protection is unavailable.'),
      );
    }
    return createHmac('sha256', key).update(value).digest('hex');
  }
}
