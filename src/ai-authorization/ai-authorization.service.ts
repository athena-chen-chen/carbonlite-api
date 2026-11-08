import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AiAuthorizationStatus, Prisma } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AI_CONSENT_VERSION_ENV,
  AI_GLOBAL_ACTIVATION_ENV,
  AI_PROVIDER_OPENAI,
  AI_SCOPE_DOCUMENT_EXTRACTION,
  AI_UNAVAILABLE_MESSAGE,
} from './ai-authorization.constants';
import { RecordAiAuthorizationDto } from './dto/record-ai-authorization.dto';

@Injectable()
export class AiAuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  getForAdmin(organizationId: string) {
    return this.prisma.organizationAiAuthorization.findUnique({
      where: { organizationId },
    });
  }

  async recordDecision(
    organizationId: string,
    verifiedById: string,
    dto: RecordAiAuthorizationDto,
  ) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');

    const effectiveAt = new Date(dto.effectiveAt);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= effectiveAt) {
      throw new BadRequestException('Authorization expiry must be after its effective time.');
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
  ) {
    if (process.env[AI_GLOBAL_ACTIVATION_ENV] !== 'true') this.deny();
    const currentConsentVersion = process.env[AI_CONSENT_VERSION_ENV]?.trim();
    if (!currentConsentVersion) this.deny();

    const authorization = await this.prisma.organizationAiAuthorization.findUnique({
      where: { organizationId },
      include: {
        organization: {
          select: { isActive: true, customerStatus: true },
        },
      },
    });
    const now = new Date();
    if (
      !authorization ||
      !authorization.organization.isActive ||
      authorization.organization.customerStatus === 'SUSPENDED' ||
      authorization.status !== AiAuthorizationStatus.ENABLED ||
      authorization.provider !== provider ||
      authorization.processingScope !== processingScope ||
      authorization.consentVersion !== currentConsentVersion ||
      !authorization.evidenceReference.trim() ||
      !authorization.authorizedRepresentativeReference.trim() ||
      !authorization.verifiedById.trim() ||
      authorization.verifiedAt > now ||
      authorization.effectiveAt > now ||
      (authorization.expiresAt !== null && authorization.expiresAt <= now) ||
      authorization.withdrawnAt !== null
    ) {
      this.deny();
    }

    return authorization;
  }

  private deny(): never {
    throw new ForbiddenException(AI_UNAVAILABLE_MESSAGE);
  }
}
