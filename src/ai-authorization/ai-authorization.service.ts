import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AiAuthorizedDataMode, AiAuthorizationStatus, Prisma } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AI_PROVIDER_OPENAI,
  AI_SCOPE_DOCUMENT_EXTRACTION,
  AI_UNAVAILABLE_MESSAGE,
} from './ai-authorization.constants';
import { RecordAiAuthorizationDto } from './dto/record-ai-authorization.dto';
import { RealDataAuthorizationService } from '../real-data-authorization/real-data-authorization.service';
import {
  type DeclaredIngestionDataMode,
  INGESTION_MODE_REAL,
  INGESTION_MODE_SYNTHETIC,
} from '../real-data-authorization/real-data-authorization.constants';

type AuthorizationWithOrganization =
  Prisma.OrganizationAiAuthorizationGetPayload<{
    include: {
      organization: {
        select: { isActive: true; customerStatus: true };
      };
    };
  }>;

@Injectable()
export class AiAuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly realDataAuthorization: RealDataAuthorizationService,
  ) {}

  getForAdmin(organizationId: string) {
    return this.prisma.organizationAiAuthorization.findUnique({
      where: { organizationId },
    });
  }

  async getCustomerStatus(organizationId: string) {
    const authorization = await this.findAuthorization(organizationId);
    const enabled = this.isValidAuthorization(
      authorization,
      new Date(),
      AI_PROVIDER_OPENAI,
      AI_SCOPE_DOCUMENT_EXTRACTION,
    );
    return {
      enabled,
      status: authorization?.status ?? 'NOT_CONFIGURED',
      provider: authorization?.provider ?? AI_PROVIDER_OPENAI,
      processingScope:
        authorization?.processingScope ?? AI_SCOPE_DOCUMENT_EXTRACTION,
      effectiveAt: authorization?.effectiveAt ?? null,
      expiresAt: authorization?.expiresAt ?? null,
      withdrawnAt: authorization?.withdrawnAt ?? null,
      authorizedDataMode:
        authorization?.authorizedDataMode ?? AiAuthorizedDataMode.SYNTHETIC_TEST_ONLY,
      realDataApprovalRevision: authorization?.realDataApprovalRevision ?? null,
    };
  }

  async recordDecision(
    organizationId: string,
    verifiedById: string,
    dto: RecordAiAuthorizationDto,
  ) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, isActive: true, customerStatus: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    if (
      dto.status === AiAuthorizationStatus.ENABLED &&
      (!organization.isActive || organization.customerStatus !== 'ACTIVE')
    ) {
      throw new ConflictException(
        'AI document extraction can only be authorized for an active customer organization.',
      );
    }

    const effectiveAt = new Date(dto.effectiveAt);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= effectiveAt) {
      throw new BadRequestException('Authorization expiry must be after its effective time.');
    }
    const authorizedDataMode = dto.authorizedDataMode ?? AiAuthorizedDataMode.SYNTHETIC_TEST_ONLY;
    let realDataApprovalRevision: number | null = null;
    if (authorizedDataMode === AiAuthorizedDataMode.REAL_CUSTOMER_DATA) {
      if (!dto.realDataApprovalRevision) {
        throw new BadRequestException(
          'Real-customer-data AI authorization requires a real-data approval revision.',
        );
      }
      await this.realDataAuthorization.assertEffectiveRealDataApproval(
        organizationId,
        dto.realDataApprovalRevision,
      );
      realDataApprovalRevision = dto.realDataApprovalRevision;
    } else if (dto.realDataApprovalRevision !== undefined) {
      throw new BadRequestException(
        'Synthetic-only AI authorization cannot reference a real-data approval revision.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.organizationAiAuthorization.findUnique({
        where: { organizationId },
      });
      const authorization = await tx.organizationAiAuthorization.upsert({
        where: { organizationId },
        create: {
          organizationId,
          status: dto.status,
          consentVersion: dto.consentVersion.trim(),
          provider: dto.provider,
          processingScope: dto.processingScope,
          evidenceReference: dto.evidenceReference.trim(),
          authorizedRepresentativeReference:
            dto.authorizedRepresentativeReference.trim(),
          verifiedById,
          verifiedAt: new Date(),
          effectiveAt,
          expiresAt,
          authorizedDataMode,
          realDataApprovalRevision,
        },
        update: {
          status: dto.status,
          consentVersion: dto.consentVersion.trim(),
          provider: dto.provider,
          processingScope: dto.processingScope,
          evidenceReference: dto.evidenceReference.trim(),
          authorizedRepresentativeReference:
            dto.authorizedRepresentativeReference.trim(),
          verifiedById,
          verifiedAt: new Date(),
          effectiveAt,
          expiresAt,
          authorizedDataMode,
          realDataApprovalRevision,
          withdrawnAt: null,
          withdrawalReference: null,
        },
      });

      await this.auditLog.log(
        {
          organizationId,
          userId: verifiedById,
          action: 'AI_AUTHORIZATION_RECORDED',
          entityType: 'OrganizationAiAuthorization',
          entityId: organizationId,
          description: 'Organization AI processing election recorded by a platform administrator.',
          oldValue: previous
            ? {
                status: previous.status,
                consentVersion: previous.consentVersion,
                provider: previous.provider,
                processingScope: previous.processingScope,
              }
            : null,
          newValue: {
            status: authorization.status,
            consentVersion: authorization.consentVersion,
            provider: authorization.provider,
            processingScope: authorization.processingScope,
            authorizedDataMode: authorization.authorizedDataMode,
            realDataApprovalRevision: authorization.realDataApprovalRevision,
            evidenceReferencePresent: Boolean(authorization.evidenceReference),
            authorizedRepresentativeReferencePresent: Boolean(
              authorization.authorizedRepresentativeReference,
            ),
          },
        },
        tx,
      );

      return authorization;
    });
  }

  async withdraw(
    organizationId: string,
    verifiedById: string,
    withdrawalReference: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.organizationAiAuthorization.findUnique({
        where: { organizationId },
      });
      if (!previous) throw new NotFoundException('AI authorization record not found.');
      if (previous.status === AiAuthorizationStatus.WITHDRAWN) return previous;

      const authorization = await tx.organizationAiAuthorization.update({
        where: { organizationId },
        data: {
          status: AiAuthorizationStatus.WITHDRAWN,
          withdrawnAt: new Date(),
          withdrawalReference: withdrawalReference.trim(),
        },
      });

      await this.auditLog.log(
        {
          organizationId,
          userId: verifiedById,
          action: 'AI_AUTHORIZATION_WITHDRAWN',
          entityType: 'OrganizationAiAuthorization',
          entityId: organizationId,
          description: 'Organization AI processing authorization withdrawn.',
          oldValue: {
            status: previous.status,
            consentVersion: previous.consentVersion,
            provider: previous.provider,
            processingScope: previous.processingScope,
          },
          newValue: {
            status: authorization.status,
            consentVersion: authorization.consentVersion,
            provider: authorization.provider,
            processingScope: authorization.processingScope,
            withdrawalReferencePresent: Boolean(authorization.withdrawalReference),
          },
        },
        tx,
      );

      return authorization;
    });
  }

  async assertProviderRequestAllowed(
    organizationId: string,
    provider = AI_PROVIDER_OPENAI,
    processingScope = AI_SCOPE_DOCUMENT_EXTRACTION,
    ingestionDataMode: DeclaredIngestionDataMode = INGESTION_MODE_SYNTHETIC,
  ) {
    const authorization = await this.findAuthorization(organizationId);
    const now = new Date();
    if (!this.isValidAuthorization(authorization, now, provider, processingScope)) {
      this.deny();
    }

    if (ingestionDataMode === INGESTION_MODE_REAL) {
      if (
        authorization?.authorizedDataMode !== AiAuthorizedDataMode.REAL_CUSTOMER_DATA ||
        !authorization.realDataApprovalRevision
      ) {
        this.deny('AI_REAL_DATA_CONSENT_REQUIRED');
      }
      await this.realDataAuthorization.assertEffectiveRealDataApproval(
        organizationId,
        authorization.realDataApprovalRevision,
      );
    }

    return authorization;
  }

  private deny(code = 'AI_AUTHORIZATION_REQUIRED'): never {
    throw new ForbiddenException({
      statusCode: 403,
      code,
      message: AI_UNAVAILABLE_MESSAGE,
      error: 'Forbidden',
    });
  }

  private findAuthorization(organizationId: string) {
    return this.prisma.organizationAiAuthorization.findUnique({
      where: { organizationId },
      include: {
        organization: {
          select: { isActive: true, customerStatus: true },
        },
      },
    });
  }

  private isValidAuthorization(
    authorization: AuthorizationWithOrganization | null,
    now: Date,
    provider: string,
    processingScope: string,
  ) {
    return Boolean(
      authorization &&
      authorization.organization.isActive &&
      authorization.organization.customerStatus === 'ACTIVE' &&
      authorization.status === AiAuthorizationStatus.ENABLED &&
      authorization.provider === provider &&
      authorization.processingScope === processingScope &&
      authorization.consentVersion.trim() &&
      authorization.evidenceReference.trim() &&
      authorization.authorizedRepresentativeReference.trim() &&
      authorization.verifiedById.trim() &&
      authorization.verifiedAt <= now &&
      authorization.effectiveAt <= now &&
      (authorization.expiresAt === null || authorization.expiresAt > now) &&
      authorization.withdrawnAt === null,
    );
  }
}
