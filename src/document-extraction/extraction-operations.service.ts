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
        let document = await tx.document.findFirstOrThrow({ where: { id: documentId, organizationId } });
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
        document = await tx.document.update({ where: { id: documentId }, data: { status: 'PROCESSING' } });
        await tx.aIJob.update({ where: { id: job.id }, data: { outputJson: {
          sourceVersion: 1, fileUrl: document.fileUrl, fileName: document.fileName,
          mimeType: document.mimeType, updatedAt: document.updatedAt.toISOString(),
        } } });
        release = extractionWorkload.reserve(`${organizationId}:${documentId}`, quota?.enabled !== true);
        const evidence = { operationId: job.id, version: metadata.version, phase: metadata.phase, ingestionDataMode: metadata.ingestionDataMode, approvalRevision, provider };
        await this.audit.log({ organizationId, userId, action: 'EXTRACT_DOCUMENT_STARTED', entityType: 'Document', entityId: documentId,
          description: 'Document extraction durably admitted.', newValue: evidence }, tx);
        await this.tracking.track({ organizationId, userId, eventName: 'DOCUMENT_EXTRACT_STARTED', entityType: 'Document', entityId: documentId, metadata: evidence }, tx);
        return { document, operation: job, quotaEnforced: quota?.enabled === true, release };
      });
    } catch (error) { release?.(); throw error; }
  }

  async dispatch(tx: Prisma.TransactionClient, organizationId: string, documentId: string, operationId: string, userId?: string) {
    const context = await this.lockSource(tx, organizationId, documentId, operationId);
    if (!context.metadata.provider || context.metadata.phase !== 'ADMITTED') return invalidExtractionOperation();
    await this.lockAndValidate(tx, organizationId, documentId, operationId);
    await tx.aIJob.update({ where: { id: operationId }, data: { inputJson: { ...context.metadata, phase: 'DISPATCH_ADMITTED' } } });
    await this.audit.log({ organizationId, userId, action: 'EXTRACT_PROVIDER_DISPATCH_ADMITTED', entityType: 'Document', entityId: documentId,
      description: 'One provider attempt durably admitted.', newValue: { operationId, provider: context.metadata.provider } }, tx);
  }

  async finalize<T>(tx: Prisma.TransactionClient, organizationId: string, documentId: string, operationId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    const context = await this.lockSource(tx, organizationId, documentId, operationId);
    if (context.metadata.phase !== (context.metadata.provider ? 'DISPATCH_ADMITTED' : 'ADMITTED')) return invalidExtractionOperation();
    // Prepare protected writes first; the authorization fence is deliberately
    // late and all writes roll back if withdrawal/reapproval/expiry wins.
    const result = await work(tx);
    await this.lockAndValidate(tx, organizationId, documentId, operationId);
    await tx.aIJob.update({ where: { id: operationId }, data: { status: 'COMPLETED', completedAt: new Date(), leaseExpiresAt: null } });
    return result;
  }

  async fail(tx: Prisma.TransactionClient, organizationId: string, documentId: string, operationId: string, work: (tx: Prisma.TransactionClient, updateDocument: boolean) => Promise<void>) {
    if ([organizationId, documentId, operationId].some(value => typeof value !== 'string' || !value || value !== value.trim() || value.length > 500)) return invalidExtractionOperation();
    // Cleanup does not authorize processing. It may retire an admitted attempt
    // after withdrawal, but must never overwrite a newer document attempt.
    await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${documentId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AIJob" WHERE "id" = ${operationId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    const job = await tx.aIJob.findFirst({ where: { id: operationId, organizationId, jobType: 'EXTRACT_ACTIVITY_DATA' } });
    if (!job || job.status !== 'RUNNING') return;
    const metadata = readExtractionOperation(job.inputJson);
    if (metadata.operationId !== operationId || metadata.documentId !== documentId || metadata.organizationId !== organizationId || (job.documentId !== null && job.documentId !== documentId)) return invalidExtractionOperation();
    const document = await tx.document.findFirst({ where: { id: documentId, organizationId } });
    const source = job.outputJson;
    const newer = await tx.aIJob.findFirst({ where: { organizationId, documentId, jobType: 'EXTRACT_ACTIVITY_DATA', id: { not: operationId }, createdAt: { gte: job.createdAt } } });
    const updateDocument = !!document && !newer && !!source && typeof source === 'object' && !Array.isArray(source) && source.sourceVersion === 1 &&
      source.fileUrl === document.fileUrl && source.fileName === document.fileName && source.mimeType === document.mimeType && source.updatedAt === document.updatedAt.toISOString();
    await work(tx, updateDocument);
    await tx.aIJob.update({ where: { id: operationId }, data: { status: 'FAILED', completedAt: new Date(), leaseExpiresAt: null, errorMessage: 'Extraction failed.' } });
  }

  async lockSource(tx: Prisma.TransactionClient, organizationId: string, documentId: string, operationId: string) {
    if ([organizationId, documentId, operationId].some(value => typeof value !== 'string' || !value || value !== value.trim() || value.length > 500)) return invalidExtractionOperation();
    const owned = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Document" WHERE "id" = ${documentId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (!owned.length) throw new NotFoundException('Document not found');
    const jobs = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "AIJob" WHERE "id" = ${operationId} AND "organizationId" = ${organizationId} AND "documentId" = ${documentId} FOR UPDATE`;
    if (!jobs.length) return invalidExtractionOperation();
    const job = await tx.aIJob.findUniqueOrThrow({ where: { id: operationId } });
    const metadata = readExtractionOperation(job.inputJson);
    if (metadata.operationId !== operationId || metadata.documentId !== documentId || metadata.organizationId !== organizationId || job.jobType !== 'EXTRACT_ACTIVITY_DATA') return invalidExtractionOperation();
    if (job.status !== 'RUNNING' || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) throw new ConflictException({ statusCode: 409, code: 'EXTRACTION_OPERATION_NOT_ACTIVE', message: 'Extraction operation is no longer active.' });
    const document = await tx.document.findFirstOrThrow({ where: { id: documentId, organizationId } });
    const source = job.outputJson;
    if (!source || typeof source !== 'object' || Array.isArray(source) || source.sourceVersion !== 1 ||
      source.fileUrl !== document.fileUrl || source.fileName !== document.fileName || source.mimeType !== document.mimeType || source.updatedAt !== document.updatedAt.toISOString()) return invalidExtractionOperation();
    return { job, metadata, document };
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
    } else {
      await this.realData.lockProcessingApproval(tx, organizationId, true);
    }
    if (metadata.provider) {
      const authorization = await this.ai.assertProviderRequestAllowed(organizationId, metadata.provider, 'DOCUMENT_EXTRACTION', metadata.ingestionDataMode, tx);
      if (!authorization || authorization.consentVersion !== metadata.consentVersion) return invalidExtractionOperation();
    }
    const fencedDocument = await tx.document.findFirst({ where: { id: documentId, organizationId }, include: { organization: { select: { isActive: true, customerStatus: true } } } });
    if (!fencedDocument || fencedDocument.ingestionDataMode !== metadata.ingestionDataMode || extractionProvider(fencedDocument.fileName) !== metadata.provider ||
      !fencedDocument.organization.isActive || fencedDocument.organization.customerStatus === 'SUSPENDED') return invalidExtractionOperation();
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
