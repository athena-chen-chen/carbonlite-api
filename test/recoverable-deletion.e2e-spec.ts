import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import request from 'supertest';
import {
  DOCUMENT_STORAGE,
  DocumentStorage,
  documentStorageKey,
} from '../src/documents/document-storage';
import { DeletionRecoveryService } from '../src/deletion-recovery/deletion-recovery.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  loginAndGetToken,
  TestUser,
  uniqueTestId,
} from './helpers/factories';

describe('Recoverable document deletion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: DocumentStorage;
  let recovery: DeletionRecoveryService;
  let tenant: TestUser;
  let unrelated: TestUser;
  let approver: TestUser;
  let operator: TestUser;
  let tenantToken: string;
  let unrelatedToken: string;
  let approverToken: string;
  let operatorToken: string;
  const testRunId = uniqueTestId('recoverable-delete');
  const password = 'Synthetic-Recovery-Only!2026';
  const createdIntentIds: string[] = [];
  const createdReviewIds: string[] = [];
  const orphanKeys: string[] = [];

  beforeAll(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
    storage = app.get(DOCUMENT_STORAGE);
    recovery = app.get(DeletionRecoveryService);
    [tenant, unrelated, approver, operator] = await Promise.all([
      createTestUser(app, { organizationName: `${testRunId} Tenant`, email: `tenant-${testRunId}@example.test`, password }),
      createTestUser(app, { organizationName: `${testRunId} Unrelated`, email: `unrelated-${testRunId}@example.test`, password }),
      createTestUser(app, { organizationName: `${testRunId} Approver`, email: `approver-${testRunId}@example.test`, password }),
      createTestUser(app, { organizationName: `${testRunId} Operator`, email: `operator-${testRunId}@example.test`, password }),
    ]);
    await prisma.user.updateMany({
      where: { id: { in: [approver.user.id, operator.user.id] } },
      data: { role: 'ADMIN' },
    });
    [tenantToken, unrelatedToken, approverToken, operatorToken] = await Promise.all([
      loginAndGetToken(app, tenant.user.email, password),
      loginAndGetToken(app, unrelated.user.email, password),
      loginAndGetToken(app, approver.user.email, password),
      loginAndGetToken(app, operator.user.email, password),
    ]);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "E2EDeletionBlock"');
    const intents = await prisma.documentDeletionIntent.findMany({
      where: { id: { in: createdIntentIds } },
    });
    for (const intent of intents) {
      if (await storage.quarantineExists(intent.quarantineKey)) {
        await storage.purgeQuarantine(intent.quarantineKey);
      }
      if (await storage.exists(intent.storageKey)) await storage.delete(intent.storageKey);
    }
    for (const key of orphanKeys) {
      if (await storage.quarantineExists(key)) await storage.purgeQuarantine(key);
    }
    await prisma.legalHoldEvent.deleteMany({ where: { caseReference: { contains: testRunId } } });
    await prisma.legalHold.deleteMany({ where: { caseReference: { contains: testRunId } } });
    await prisma.documentDeletionPurgeReview.deleteMany({ where: { id: { in: createdReviewIds } } });
    await prisma.documentDeletionIntent.deleteMany({ where: { id: { in: createdIntentIds } } });
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  async function upload(token: string, name: string) {
    return (await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(token))
      .field('type', 'SPREADSHEET')
      .attach('file', Buffer.from(`activityType,recordDate,quantity,unit\nDIESEL,2026-01-01,1,L\n# ${name}\n`), {
        filename: name,
        contentType: 'text/csv',
      })
      .expect(201)).body as { id: string; fileUrl: string; fileName: string };
  }

  async function remove(token: string, documentId: string) {
    const response = await request(app.getHttpServer())
      .delete(`/api/documents/${documentId}`)
      .set(authHeader(token))
      .expect(200);
    createdIntentIds.push(response.body.deletionIntentId);
    return response.body;
  }

  it('quarantines source bytes, preserves confirmed records and append-only quota, and cascades drafts', async () => {
    await prisma.organizationQuota.upsert({
      where: { organizationId: tenant.user.organizationId },
      create: { organizationId: tenant.user.organizationId, enabled: true, uploadLimit: 100, dailyUploadLimit: 100 },
      update: { enabled: true, uploadLimit: 100, dailyUploadLimit: 100 },
    });
    const document = await upload(tenantToken, `${testRunId}-complete.csv`);
    await prisma.documentExtraction.create({
      data: {
        organizationId: tenant.user.organizationId,
        documentId: document.id,
        status: 'REVIEW_REQUIRED',
        extractedJson: { synthetic: true },
        extractedRows: [{ synthetic: true }],
      },
    });
    await prisma.spreadsheetImportReviewRow.create({
      data: {
        organizationId: tenant.user.organizationId,
        sourceDocumentId: document.id,
        rowId: `${testRunId}-row`,
        idempotencyKey: `${testRunId}-idempotency`,
        status: 'NEEDS_REVIEW',
        sourceType: 'CSV',
        issues: [],
      },
    });
    const activity = await prisma.activityData.create({
      data: {
        organizationId: tenant.user.organizationId,
        documentId: document.id,
        sourceDocumentId: document.id,
        activityType: 'DIESEL',
        recordDate: new Date('2026-01-01T00:00:00.000Z'),
        quantity: 1,
        unit: 'L',
        sourceType: 'DOCUMENT_AI',
        sourceReference: `${testRunId}-confirmed`,
      },
    });
    const usageBefore = await prisma.organizationQuotaUsage.count({
      where: { organizationId: tenant.user.organizationId },
    });

    const deleted = await remove(tenantToken, document.id);
    expect(deleted).toMatchObject({
      sourceEvidence: 'QUARANTINED',
      storageLifecycle: 'PENDING_PURGE',
      preservedActivityRecords: 1,
      idempotent: false,
    });
    const intent = await prisma.documentDeletionIntent.findUniqueOrThrow({ where: { id: deleted.deletionIntentId } });
    expect(await storage.exists(documentStorageKey(document.fileUrl))).toBe(false);
    expect(await storage.quarantineExists(intent.quarantineKey)).toBe(true);
    expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();
    expect(await prisma.documentExtraction.count({ where: { documentId: document.id } })).toBe(0);
    expect(await prisma.spreadsheetImportReviewRow.count({ where: { sourceDocumentId: document.id } })).toBe(0);
    expect(await prisma.activityData.findUnique({ where: { id: activity.id } })).toMatchObject({
      documentId: null,
      sourceDocumentId: document.id,
    });
    expect(await prisma.organizationQuotaUsage.count({ where: { organizationId: tenant.user.organizationId } }))
      .toBe(usageBefore);

    const duplicate = await remove(tenantToken, document.id);
    expect(duplicate).toMatchObject({ deletionIntentId: intent.id, idempotent: true });
  });

  it('survives DB rollback after movement and safely retries the prepared intent', async () => {
    const document = await upload(tenantToken, `${testRunId}-rollback.csv`);
    await prisma.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "E2EDeletionBlock" ("documentId" TEXT PRIMARY KEY REFERENCES "Document"("id") ON DELETE RESTRICT)',
    );
    await prisma.$executeRawUnsafe('INSERT INTO "E2EDeletionBlock" ("documentId") VALUES ($1)', document.id);

    await request(app.getHttpServer())
      .delete(`/api/documents/${document.id}`)
      .set(authHeader(tenantToken))
      .expect(500);
    const prepared = await prisma.documentDeletionIntent.findFirstOrThrow({
      where: { documentId: document.id },
    });
    createdIntentIds.push(prepared.id);
    expect(prepared.status).toBe('PREPARED');
    expect(await prisma.document.findUnique({ where: { id: document.id } })).not.toBeNull();
    expect(await storage.exists(prepared.storageKey)).toBe(false);
    expect(await storage.quarantineExists(prepared.quarantineKey)).toBe(true);

    await prisma.$executeRawUnsafe('DELETE FROM "E2EDeletionBlock" WHERE "documentId" = $1', document.id);
    const retry = await remove(tenantToken, document.id);
    expect(retry).toMatchObject({ deletionIntentId: prepared.id, storageLifecycle: 'PENDING_PURGE' });
  });

  it('uses the same recoverable protocol for managed report artifacts and blocks external artifacts', async () => {
    const storageKey = `${tenant.user.organizationId}/${testRunId}-report.pdf`;
    await storage.save(storageKey, Buffer.from('synthetic report'));
    const report = await prisma.report.create({
      data: {
        organizationId: tenant.user.organizationId,
        title: `${testRunId} managed report`,
        generatedPdfUrl: `/uploads/${storageKey}`,
      },
    });
    const deleted = await request(app.getHttpServer())
      .delete(`/api/reports/${report.id}`)
      .set(authHeader(tenantToken))
      .expect(200);
    createdIntentIds.push(deleted.body.deletionIntentId);
    expect(deleted.body).toMatchObject({ deleted: true, sourceEvidence: 'QUARANTINED' });
    const intent = await prisma.documentDeletionIntent.findUniqueOrThrow({
      where: { id: deleted.body.deletionIntentId },
    });
    expect(await storage.exists(storageKey)).toBe(false);
    expect(await storage.quarantineExists(intent.quarantineKey)).toBe(true);

    const external = await prisma.report.create({
      data: {
        organizationId: tenant.user.organizationId,
        title: `${testRunId} external report`,
        generatedPdfUrl: 'https://example.invalid/synthetic.pdf',
      },
    });
    await request(app.getHttpServer())
      .delete(`/api/reports/${external.id}`)
      .set(authHeader(tenantToken))
      .expect(409);
    expect(await prisma.report.findUnique({ where: { id: external.id } })).not.toBeNull();
  });

  it('reports missing bytes, orphan quarantine, and restore mismatch without mutation', async () => {
    const missing = await upload(tenantToken, `${testRunId}-missing.csv`);
    await storage.delete(documentStorageKey(missing.fileUrl));

    const orphanActive = `${tenant.user.organizationId}/${testRunId}-orphan.csv`;
    await storage.save(orphanActive, Buffer.from('synthetic orphan'));
    const orphan = await storage.quarantine(orphanActive, `orphan_${testRunId.replaceAll('-', '_')}`);
    orphanKeys.push(orphan.quarantineKey);

    const pending = await prisma.documentDeletionIntent.findFirstOrThrow({
      where: { organizationId: tenant.user.organizationId, status: 'PENDING_PURGE' },
    });
    await storage.save(pending.storageKey, Buffer.from('synthetic restored copy'));
    const before = await prisma.documentDeletionIntent.count();
    const report = await recovery.reconcile({
      ...operator.user,
      role: 'ADMIN',
      platformRole: 'ADMIN',
      accountType: 'CUSTOMER',
    }, tenant.user.organizationId);
    const after = await prisma.documentDeletionIntent.count();

    expect(report.mutated).toBe(false);
    expect(after).toBe(before);
    expect(report.databaseReferencesMissingBytes).toContainEqual(expect.objectContaining({ documentId: missing.id }));
    expect(report.quarantineEntriesWithoutIntent).toContainEqual(expect.objectContaining({
      storageKeyHash: createHash('sha256').update(orphan.quarantineKey).digest('hex'),
    }));
    expect(report.restoreMismatches).toContainEqual(expect.objectContaining({ deletionIntentId: pending.id }));
  });

  it('requires platform authority and blocks purge when a later document hold applies', async () => {
    const document = await upload(tenantToken, `${testRunId}-held-purge.csv`);
    const deleted = await remove(tenantToken, document.id);
    const hold = await request(app.getHttpServer())
      .post('/api/admin/legal-holds/activate')
      .set(authHeader(approverToken))
      .send({
        organizationId: tenant.user.organizationId,
        caseReference: `${testRunId}-pending-purge-hold`,
        scopeType: 'DOCUMENT',
        documentIds: [document.id],
        authorityReference: `${testRunId}-authority`,
        requesterUserId: tenant.user.id,
        approvedByUserId: approver.user.id,
      })
      .expect(201);
    expect(hold.body.documents).toEqual([{ documentId: document.id }]);

    await request(app.getHttpServer())
      .post('/api/admin/storage-reconciliation/purge/dry-run')
      .set(authHeader(tenantToken))
      .send({ candidateIds: [deleted.deletionIntentId] })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/admin/storage-reconciliation/purge/dry-run')
      .set(authHeader(operatorToken))
      .send({ candidateIds: [deleted.deletionIntentId] })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'LEGAL_HOLD_ACTIVE' }));
    expect(await storage.quarantineExists(
      (await prisma.documentDeletionIntent.findUniqueOrThrow({ where: { id: deleted.deletionIntentId } })).quarantineKey,
    )).toBe(true);
  });

  it('purges only the exact unheld dry-run set and leaves another organization unaffected', async () => {
    const document = await upload(unrelatedToken, `${testRunId}-unrelated-purge.csv`);
    const deleted = await remove(unrelatedToken, document.id);
    const dryRun = await request(app.getHttpServer())
      .post('/api/admin/storage-reconciliation/purge/dry-run')
      .set(authHeader(operatorToken))
      .send({ candidateIds: [deleted.deletionIntentId] })
      .expect(201);
    createdReviewIds.push(dryRun.body.reviewId);
    expect(dryRun.body).toMatchObject({ status: 'DRY_RUN', dataDeleted: false, filesToPurge: 1 });

    await request(app.getHttpServer())
      .post('/api/admin/storage-reconciliation/purge')
      .set(authHeader(operatorToken))
      .send({
        candidateIds: [deleted.deletionIntentId],
        reviewToken: dryRun.body.reviewToken,
        confirmPurge: true,
      })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'PURGED', purgedFiles: 1 }));
    expect(await prisma.documentDeletionIntent.findUniqueOrThrow({ where: { id: deleted.deletionIntentId } }))
      .toMatchObject({ status: 'PURGED' });
    expect(await prisma.organization.findUnique({ where: { id: tenant.user.organizationId } })).not.toBeNull();
  });

  it('can activate a hold against surviving recovery bytes after workspace rows are gone', async () => {
    const victim = await createTestUser(app, {
      organizationName: `${testRunId} Erased Victim`,
      email: `erased-${testRunId}@example.test`,
      password,
    });
    const victimToken = await loginAndGetToken(app, victim.user.email, password);
    const document = await upload(victimToken, `${testRunId}-post-erasure-hold.csv`);
    const deleted = await remove(victimToken, document.id);
    const victimOrganization = await prisma.organization.findUniqueOrThrow({
      where: { id: victim.user.organizationId },
      select: { slug: true },
    });
    await request(app.getHttpServer())
      .post('/api/admin/workspace-erasure/erase')
      .set(authHeader(operatorToken))
      .send({
        organizationId: victim.user.organizationId,
        confirmationOrganizationId: victim.user.organizationId,
        confirmationOrganizationSlug: victimOrganization.slug,
        confirmErase: true,
      })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'ERASED' }));
    expect(await prisma.documentDeletionIntent.findUnique({ where: { id: deleted.deletionIntentId } }))
      .toMatchObject({ status: 'PENDING_PURGE' });

    await request(app.getHttpServer())
      .post('/api/admin/legal-holds/activate')
      .set(authHeader(approverToken))
      .send({
        organizationId: victim.user.organizationId,
        caseReference: `${testRunId}-post-erasure-organization-hold`,
        scopeType: 'ORGANIZATION',
        authorityReference: `${testRunId}-post-erasure-authority`,
        requesterUserId: operator.user.id,
        approvedByUserId: approver.user.id,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/admin/storage-reconciliation/purge/dry-run')
      .set(authHeader(operatorToken))
      .send({ candidateIds: [deleted.deletionIntentId] })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'LEGAL_HOLD_ACTIVE' }));
  });
});
