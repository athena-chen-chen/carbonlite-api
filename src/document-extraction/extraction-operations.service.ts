import { extractionWorkload } from './extraction-workload';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { OrganizationQuotasService } from '../organization-quotas/organization-quotas.service';
import { RealDataAuthorizationService } from '../real-data-authorization/real-data-authorization.service';
import { AiAuthorizationService } from '../ai-authorization/ai-authorization.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';
import { ExtractionOperationMetadata, extractionProvider, invalidExtractionOperation, readExtractionOperation } from './extraction-operation';

@Injectable()
export class ExtractionOperationsService {
  constructor(
    private readonly quotas: OrganizationQuotasService,
    private readonly realData: RealDataAuthorizationService,
    private readonly ai: AiAuthorizationService,
    private readonly audit: AuditLogService,
    private readonly tracking: ActivityTrackingService,
  ) {}

  async admit(organizationId: string, documentId: string, userId?: string) {
    if ([organizationId, documentId].some(value => typeof value !== 'string' || !value || value !== value.trim() || value.length > 500)) return invalidExtractionOperation();
    let release: (() => void) | undefined;
    try {
      return await this.quotas.withExtractionAdmission(organizationId, async tx => {
        const owned = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Document" WHERE "id" = ${documentId} AND "organizationId" = ${organizationId} FOR UPDATE`;
        if (!owned.length) throw new NotFoundException('Document not found');
        const document = await tx.document.findFirstOrThrow({ where: { id: documentId, organizationId } });
        let realDataDecisionId: string | null = null, approvalRevision: number | null = null;
        if (document.ingestionDataMode === 'REAL_CUSTOMER_DATA') {
          await this.realData.lockProcessingApproval(tx, organizationId, true);
          const approval = await this.realData.assertEffectiveRealDataApproval(organizationId, undefined, tx);
          realDataDecisionId = approval.decisionId; approvalRevision = approval.approvalRevision;
        }
        const provider = extractionProvider(document.fileName);
        const authorization = provider ? await this.ai.assertProviderRequestAllowed(organizationId, provider, 'DOCUMENT_EXTRACTION', document.ingestionDataMode, tx) : null;
        const metadata: ExtractionOperationMetadata = {
          version: 1, phase: 'ADMITTED', operationId: randomUUID(), organizationId, documentId,
          ingestionDataMode: document.ingestionDataMode, realDataDecisionId, approvalRevision,
          provider, processingScope: provider ? 'DOCUMENT_EXTRACTION' : null,
          consentVersion: authorization?.consentVersion ?? null,
        };
        // Validate the server-built record too: there is no permissive legacy fallback.
        readExtractionOperation(metadata);
        const quota = await tx.organizationQuota.findUnique({ where: { organizationId }, select: { enabled: true } });
        const job = await this.quotas.beginExtractionWithinTransaction(tx, { organizationId, documentId, userId }, { id: metadata.operationId, metadata });
        if (!job) return invalidExtractionOperation();
        release = extractionWorkload.reserve(`${organizationId}:${documentId}`, quota?.enabled !== true);
        const evidence = { operationId: job.id, version: metadata.version, phase: metadata.phase, ingestionDataMode: metadata.ingestionDataMode, approvalRevision, provider };
        await this.audit.log({ organizationId, userId, action: 'EXTRACT_DOCUMENT_STARTED', entityType: 'Document', entityId: documentId,
          description: 'Document extraction durably admitted.', newValue: evidence }, tx);
        await this.tracking.track({ organizationId, userId, eventName: 'DOCUMENT_EXTRACT_STARTED', entityType: 'Document', entityId: documentId, metadata: evidence }, tx);
        return { document, operation: job, quotaEnforced: quota?.enabled === true, release };
      });
    } catch (error) { release?.(); throw error; }
  }

  async lockAndValidate(tx: Prisma.TransactionClient, organizationId: string, documentId: string, operationId: string) {
    // Prisma omits undefined filters: reject missing context before issuing any query.
    if ([organizationId, documentId, operationId].some(value => typeof value !== 'string' || !value || value !== value.trim() || value.length > 500)) return invalidExtractionOperation();
    await this.realData.assertProcessingIsolation(tx);
    const job = await tx.aIJob.findFirst({ where: { id: operationId, organizationId, documentId, jobType: 'EXTRACT_ACTIVITY_DATA' } });
    if (!job) return invalidExtractionOperation();
    const metadata = readExtractionOperation(job.inputJson);
    if (metadata.operationId !== job.id || metadata.organizationId !== organizationId || metadata.documentId !== documentId) return invalidExtractionOperation();
    if (job.status !== 'RUNNING' || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) {
      throw new ConflictException({ statusCode: 409, code: 'EXTRACTION_OPERATION_NOT_ACTIVE', message: 'Extraction operation is no longer active.' });
    }
    const document = await tx.document.findFirst({ where: { id: documentId, organizationId }, include: { organization: { select: { isActive: true, customerStatus: true } } } });
    if (!document || document.ingestionDataMode !== metadata.ingestionDataMode || extractionProvider(document.fileName) !== metadata.provider) return invalidExtractionOperation();
    if (!document.organization.isActive || document.organization.customerStatus === 'SUSPENDED') return invalidExtractionOperation();
    if (metadata.ingestionDataMode === 'REAL_CUSTOMER_DATA') {
      await this.realData.lockAndValidateRevision(tx, organizationId, metadata.realDataDecisionId!, metadata.approvalRevision!);
    }
    if (metadata.provider) {
      const authorization = await this.ai.assertProviderRequestAllowed(organizationId, metadata.provider, 'DOCUMENT_EXTRACTION', metadata.ingestionDataMode, tx);
      if (!authorization || authorization.consentVersion !== metadata.consentVersion) return invalidExtractionOperation();
    }
    // Waiting for an authorization fence must not revive an expired/replaced lease.
    const current = await tx.aIJob.findFirst({ where: { id: operationId, organizationId, documentId, jobType: 'EXTRACT_ACTIVITY_DATA' } });
    if (!current) return invalidExtractionOperation();
    const currentMetadata = readExtractionOperation(current.inputJson);
    if ((Object.keys(metadata) as Array<keyof ExtractionOperationMetadata>).some(key => metadata[key] !== currentMetadata[key])) return invalidExtractionOperation();
    if (current.status !== 'RUNNING' || !current.leaseExpiresAt || current.leaseExpiresAt <= new Date()) {
      throw new ConflictException({ statusCode: 409, code: 'EXTRACTION_OPERATION_NOT_ACTIVE', message: 'Extraction operation is no longer active.' });
    }
    return { job: current, metadata: currentMetadata, document };
  }
}
