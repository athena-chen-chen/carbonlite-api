import { ControlDatabaseService, runControlOperation } from '../prisma/control-database.service';
import { cancelExtractionAttempts } from '../document-extraction/extraction-cancellation';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
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
    @Optional() private readonly control?: ControlDatabaseService,
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
    ) && (
      authorization?.authorizedDataMode !== AiAuthorizedDataMode.REAL_CUSTOMER_DATA ||
      this.realDataRuntimeGateSatisfied(authorization.consentVersion)
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

    let prepared = false;
    try { return await this.prisma.$transaction(async (tx) => {
      // Same ordering point as extraction dispatch/finalization. Never acquire
      // document/job locks while holding this authorization fence.
      await this.realDataAuthorization.lockProcessingApproval(tx, organizationId, false);
      const currentOrganization = await tx.organization.findUnique({ where: { id: organizationId }, select: { isActive: true, customerStatus: true } });
      if (!currentOrganization || (dto.status === 'ENABLED' && (!currentOrganization.isActive || currentOrganization.customerStatus !== 'ACTIVE'))) {
        throw new ConflictException('AI authorization requires a current active organization.');
      }
      if (authorizedDataMode === AiAuthorizedDataMode.REAL_CUSTOMER_DATA) {
        await this.realDataAuthorization.assertEffectiveRealDataApproval(organizationId, realDataApprovalRevision!, tx);
      }
      const previous = await tx.organizationAiAuthorization.findUnique({
        where: { organizationId },
      });
      const previousGeneration = previous ? previous.grantGeneration : 0;
      if (!Number.isInteger(previousGeneration) || previousGeneration < 0 || previousGeneration > 2147483647) {
        throw new ServiceUnavailableException('AI grant generation is invalid.');
      }
      if (dto.status === 'ENABLED' && previousGeneration === 2147483647) {
        throw new ConflictException({ statusCode: 409, code: 'AI_GRANT_GENERATION_EXHAUSTED', message: 'AI grant generation is exhausted; no grant was issued.' });
      }
      const grantGeneration = previousGeneration + (dto.status === 'ENABLED' ? 1 : 0);
      const authorization = await tx.organizationAiAuthorization.upsert({
        where: { organizationId },
        create: {
          organizationId,
          grantGeneration,
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
          grantGeneration,
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
                grantGeneration: previous.grantGeneration,
                status: previous.status,
                consentVersion: previous.consentVersion,
                provider: previous.provider,
                processingScope: previous.processingScope,
              }
            : null,
          newValue: {
            grantGeneration: authorization.grantGeneration,
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

      prepared = true;
      return authorization;
    }); } catch (error) {
      if (!prepared) throw error;
      throw new ServiceUnavailableException({ statusCode: 503, code: 'AI_GRANT_OUTCOME_UNCERTAIN', outcome: 'UNKNOWN',
        reconciliationRequired: true, automaticRetry: false, message: 'AI grant commit outcome is uncertain. Reconcile authoritative state before resubmission.' });
    }
  }

  async withdraw(
    organizationId: string,
    verifiedById: string,
    withdrawalReference: string,
  ) {
    const result = await runControlOperation(this.control, this.prisma, 'AI_WITHDRAWAL', async (tx) => {
      // Same ordering point as extraction dispatch/finalization. Never acquire
      // document/job locks while holding this authorization fence.
      await this.realDataAuthorization.lockProcessingApproval(tx, organizationId, false);
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
            grantGeneration: previous.grantGeneration,
            status: previous.status,
            consentVersion: previous.consentVersion,
            provider: previous.provider,
            processingScope: previous.processingScope,
          },
          newValue: {
            grantGeneration: authorization.grantGeneration,
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
    cancelExtractionAttempts(organizationId, false);
    return result;
  }

  async assertProviderRequestAllowed(
    organizationId: string,
    provider = AI_PROVIDER_OPENAI,
    processingScope = AI_SCOPE_DOCUMENT_EXTRACTION,
    ingestionDataMode: DeclaredIngestionDataMode = INGESTION_MODE_SYNTHETIC,
    client: Pick<Prisma.TransactionClient, 'organizationAiAuthorization' | 'organizationRealDataAuthorization'> = this.prisma,
  ) {
    const runtimeConsentVersion = ingestionDataMode === INGESTION_MODE_REAL
      ? this.assertRealDataRuntimeGate()
      : null;
    const authorization = await this.findAuthorization(organizationId, client);
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
      if (authorization.consentVersion !== runtimeConsentVersion) {
        this.deny('AI_RUNTIME_CONSENT_VERSION_MISMATCH');
      }
      await this.realDataAuthorization.assertEffectiveRealDataApproval(
        organizationId,
        authorization.realDataApprovalRevision,
        client,
      );
    }

    return authorization;
  }

  private assertRealDataRuntimeGate() {
    if (process.env.REAL_DATA_AI_PROCESSING_ENABLED !== 'true') {
      this.deny('AI_REAL_DATA_PROCESSING_DISABLED');
    }
    const consentVersion = process.env.CARBONLITE_AI_CONSENT_VERSION;
    if (!consentVersion?.trim()) {
      this.deny('AI_RUNTIME_CONSENT_VERSION_REQUIRED');
    }
    return consentVersion;
  }

  private realDataRuntimeGateSatisfied(storedConsentVersion: string) {
    const runtimeConsentVersion = process.env.CARBONLITE_AI_CONSENT_VERSION;
    return process.env.REAL_DATA_AI_PROCESSING_ENABLED === 'true' &&
      Boolean(runtimeConsentVersion?.trim()) &&
      storedConsentVersion === runtimeConsentVersion;
  }

  private deny(code = 'AI_AUTHORIZATION_REQUIRED'): never {
    throw new ForbiddenException({
      statusCode: 403,
      code,
      message: AI_UNAVAILABLE_MESSAGE,
      error: 'Forbidden',
    });
  }

  private findAuthorization(organizationId: string, client: Pick<Prisma.TransactionClient, 'organizationAiAuthorization'> = this.prisma) {
    return client.organizationAiAuthorization.findUnique({
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
      Number.isInteger(authorization.grantGeneration) && authorization.grantGeneration > 0 &&
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
