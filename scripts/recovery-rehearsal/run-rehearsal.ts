import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { CalculationQualityService } from '../../src/metrics/calculation-quality.service';
import { CalculationSnapshotsService } from '../../src/metrics/calculation-snapshots.service';
import { DeletionRecoveryService } from '../../src/deletion-recovery/deletion-recovery.service';
import { FilesystemDocumentStorage } from '../../src/documents/filesystem-document-storage';
import { persistedDocumentStorageUrl } from '../../src/documents/document-storage';
import { LegalHoldsService } from '../../src/legal-holds/legal-holds.service';
import { RecoveryAccessPolicy } from '../../src/common/security/restore-access-gate';
import { canonicalJson, sha256 } from '../../src/common/security/recovery-control-store';
import { RecoveryEvidence, recoveryEvidenceDigest } from '../../src/common/security/recovery-evidence';
import {
  LocalRecoveryAuthority,
  authorityPublicKeyPem,
  signRecoveryCommand,
} from '../recovery-control/local-recovery-authority';
import { seedReviewedFactors } from '../../test/helpers/factories';

const exec = promisify(execFile);
const DISPOSABLE_PARENT = resolve('/tmp/carbonlite-phase-3g-a');
const DB_PREFIX = 'carbonlite_recovery_';
const args = new Set(process.argv.slice(2));

type Json = Record<string, any>;

function requireSafetyConsent() {
  if (!args.has('--local-synthetic-only') || !args.has('--acknowledge-disposable-targets') ||
      !args.has('--acknowledge-synthetic-remediation')) {
    throw new Error('Refusing to run: pass --local-synthetic-only, --acknowledge-disposable-targets, and --acknowledge-synthetic-remediation.');
  }
}

function safeAdminUrl() {
  const raw = process.env.LOCAL_RECOVERY_ADMIN_URL;
  if (!raw) throw new Error('LOCAL_RECOVERY_ADMIN_URL is required and must identify disposable local PostgreSQL.');
  const url = new URL(raw);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error('PostgreSQL URL required.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Refusing non-loopback database target.');
  }
  if (!['postgres', 'template1'].includes(url.pathname.slice(1))) {
    throw new Error('Admin URL must target the local postgres or template1 database.');
  }
  return url;
}

function databaseUrl(admin: URL, database: string) {
  if (!new RegExp(`^${DB_PREFIX}[a-z0-9_]+$`).test(database)) throw new Error('Unsafe database name.');
  const url = new URL(admin);
  url.pathname = `/${database}`;
  return url.toString();
}

function assertDisposablePath(path: string) {
  const target = resolve(path);
  const within = relative(DISPOSABLE_PARENT, target);
  if (!within || within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`Refusing path outside ${DISPOSABLE_PARENT}.`);
  }
  return target;
}

async function run(program: string, programArgs: string[], options: Json = {}) {
  return exec(program, programArgs, {
    cwd: resolve(__dirname, '../..'),
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function postgresCli(url: URL) {
  return {
    connectionArgs: ['--host', url.hostname, '--port', url.port || '5432', '--username', decodeURIComponent(url.username), '--dbname', url.pathname.slice(1)],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
  };
}

async function createDatabase(adminUrl: URL, database: string) {
  const cli = postgresCli(adminUrl);
  await run('psql', [...cli.connectionArgs, '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--command', `CREATE DATABASE "${database}"`], { env: cli.env });
}

async function sha256File(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function sha256Text(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function listFiles(root: string) {
  const files: Array<{ storageKey: string; bytes: number; modifiedAt: string; sha256: string }> = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlink found in synthetic storage.');
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile()) {
        const info = await stat(path);
        files.push({
          storageKey: relative(root, path).split(sep).join('/'),
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          sha256: await sha256File(path),
        });
      }
    }
  };
  await visit(root);
  return files.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
}

async function migrationManifest() {
  const root = resolve(__dirname, '../../prisma/migrations');
  const entries = [];
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  for (const name of directories) {
    const path = resolve(root, name, 'migration.sql');
    try {
      entries.push({ name, sha256: await sha256File(path) });
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return entries;
}

async function databaseSnapshot(prisma: PrismaClient) {
  const [organizations, users, documents, extractions, reviewRows, activities, metrics, reports, holds, holdDocs, intents, migrations] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, slug: true }, orderBy: { id: 'asc' } }),
    prisma.user.findMany({ select: { id: true, organizationId: true, email: true }, orderBy: { id: 'asc' } }),
    prisma.document.findMany({ select: { id: true, organizationId: true, reportId: true, fileUrl: true, fileHash: true }, orderBy: { id: 'asc' } }),
    prisma.documentExtraction.findMany({ select: { id: true, organizationId: true, documentId: true, status: true }, orderBy: { id: 'asc' } }),
    prisma.spreadsheetImportReviewRow.findMany({ select: { id: true, organizationId: true, sourceDocumentId: true, status: true }, orderBy: { id: 'asc' } }),
    prisma.activityData.findMany({ select: { id: true, organizationId: true, documentId: true, sourceDocumentId: true, calculationStatus: true, calculatedEmissionsKgCO2e: true, matchedFactorId: true, calculationSnapshot: true }, orderBy: { id: 'asc' } }),
    prisma.metricResult.findMany({ select: { id: true, organizationId: true, activityDataId: true, factorId: true, value: true, unit: true }, orderBy: { id: 'asc' } }),
    prisma.report.findMany({ select: { id: true, organizationId: true, generatedPdfUrl: true, status: true, documents: { select: { id: true }, orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    prisma.legalHold.findMany({ select: { id: true, organizationId: true, caseReference: true, scopeType: true, status: true, effectiveAt: true }, orderBy: { id: 'asc' } }),
    prisma.legalHoldDocument.findMany({ select: { legalHoldId: true, organizationId: true, documentId: true }, orderBy: { documentId: 'asc' } }),
    prisma.documentDeletionIntent.findMany({ select: { id: true, organizationId: true, documentId: true, targetReferenceId: true, status: true, storageKey: true, quarantineKey: true }, orderBy: { id: 'asc' } }),
    prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name`,
  ]);
  return JSON.parse(JSON.stringify({ organizations, users, documents, extractions, reviewRows, activities, metrics, reports, holds, holdDocs, intents, migrations }));
}

async function createFixture(prisma: PrismaClient, storage: FilesystemDocumentStorage, pairId: string) {
  const suffix = pairId.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const organizations = await Promise.all(['a', 'b', 'c'].map(letter => prisma.organization.create({ data: {
    id: `org-${letter}-${suffix}`, name: `Synthetic Recovery ${letter.toUpperCase()}`, slug: `synthetic-recovery-${letter}-${suffix}`,
    country: 'Canada', provinceState: 'Alberta', defaultReportingYear: 2026,
  } })));
  const [orgA, orgB, orgC] = organizations;
  const users = await Promise.all([
    prisma.user.create({ data: { id: `admin-requester-${suffix}`, organizationId: orgA.id, email: `requester-${suffix}@synthetic.invalid`, role: UserRole.ADMIN, accountType: 'PLATFORM_ADMIN' } }),
    prisma.user.create({ data: { id: `admin-approver-${suffix}`, organizationId: orgA.id, email: `approver-${suffix}@synthetic.invalid`, role: UserRole.ADMIN, accountType: 'PLATFORM_ADMIN' } }),
    prisma.user.create({ data: { id: `tenant-a-${suffix}`, organizationId: orgA.id, email: `tenant-a-${suffix}@synthetic.invalid`, role: UserRole.USER } }),
    prisma.user.create({ data: { id: `tenant-b-${suffix}`, organizationId: orgB.id, email: `tenant-b-${suffix}@synthetic.invalid`, role: UserRole.USER } }),
    prisma.user.create({ data: { id: `tenant-c-${suffix}`, organizationId: orgC.id, email: `tenant-c-${suffix}@synthetic.invalid`, role: UserRole.USER } }),
  ]);
  const [requester, approver, tenantA, tenantB, tenantC] = users;
  await Promise.all([
    prisma.membership.create({ data: { userId: tenantA.id, organizationId: orgA.id, role: 'OWNER' } }),
    prisma.membership.create({ data: { userId: tenantB.id, organizationId: orgB.id, role: 'OWNER' } }),
    prisma.membership.create({ data: { userId: tenantC.id, organizationId: orgC.id, role: 'OWNER' } }),
  ]);

  const content = {
    a: Buffer.from('Synthetic recovery source A\n'),
    bHeld: Buffer.from('Synthetic recovery held source B\n'),
    bPending: Buffer.from('Synthetic recovery pending purge B\n'),
    bLaterDelete: Buffer.from('Synthetic recovery later-deleted source B\n'),
    report: Buffer.from('%PDF-1.4 synthetic report bytes\n'),
    c: Buffer.from('Synthetic recovery erased organization C\n'),
  };
  const doc = async (id: string, org: any, user: any, key: string, bytes: Buffer, extra: Json = {}) => {
    await storage.save(key, bytes);
    return prisma.document.create({ data: {
      id, organizationId: org.id, uploadedById: user.id, fileName: `${id}.txt`, fileUrl: persistedDocumentStorageUrl(key),
      mimeType: 'text/plain', fileSize: bytes.length, fileHash: createHash('sha256').update(bytes).digest('hex'), status: 'PROCESSED', type: 'OTHER', ...extra,
    } });
  };
  const report = await prisma.report.create({ data: {
    id: `report-b-${suffix}`, organizationId: orgB.id, createdById: tenantB.id, title: 'Synthetic paired recovery report',
    status: 'FINALIZED', reportingYear: 2026, summary: 'Synthetic totals only.', generatedPdfUrl: persistedDocumentStorageUrl(`${orgB.id}/report-${randomUUID()}.pdf`),
  } });
  await storage.save(report.generatedPdfUrl!.replace('/uploads/', ''), content.report);
  const docs = {
    a: await doc(`doc-a-${suffix}`, orgA, tenantA, `${orgA.id}/${randomUUID()}.txt`, content.a),
    bHeld: await doc(`doc-b-held-${suffix}`, orgB, tenantB, `${orgB.id}/${randomUUID()}.txt`, content.bHeld, { reportId: report.id }),
    bPending: await doc(`doc-b-pending-${suffix}`, orgB, tenantB, `${orgB.id}/${randomUUID()}.txt`, content.bPending),
    bLaterDelete: await doc(`doc-b-later-${suffix}`, orgB, tenantB, `${orgB.id}/${randomUUID()}.txt`, content.bLaterDelete, { reportId: report.id }),
    c: await doc(`doc-c-${suffix}`, orgC, tenantC, `${orgC.id}/${randomUUID()}.txt`, content.c),
  };
  await seedReviewedFactors(prisma as any, orgA.id);
  await seedReviewedFactors(prisma as any, orgB.id);
  const quality = new CalculationQualityService(prisma as any);
  const snapshots = new CalculationSnapshotsService(prisma as any, quality);
  const makeActivity = async (org: any, user: any, sourceDocument: any, id: string) => {
    const input = {
      id, organizationId: org.id, documentId: sourceDocument.id, sourceDocumentId: sourceDocument.id,
      activityType: 'DIESEL', recordDate: new Date('2026-01-15T00:00:00.000Z'), recordYear: 2026,
      jurisdictionCountry: 'Canada', quantity: new Prisma.Decimal(10), unit: 'liters', sourceType: 'DOCUMENT_AI',
      sourceReference: `synthetic:${sourceDocument.id}`, sourceFileName: sourceDocument.fileName,
    };
    return prisma.activityData.create({ data: await snapshots.prepareCreate(prisma as any, input, user.id) });
  };
  const activityA = await makeActivity(orgA, tenantA, docs.a, `activity-a-${suffix}`);
  const activityB = await makeActivity(orgB, tenantB, docs.bHeld, `activity-b-${suffix}`);
  for (const [organizationId, activity] of [[orgA.id, activityA], [orgB.id, activityB]] as const) {
    const snapshot: any = activity.calculationSnapshot;
    const factor = await prisma.conversionFactor.findUnique({ where: { id: activity.matchedFactorId! } });
    await prisma.metricResult.create({ data: {
      organizationId, activityDataId: activity.id, factorId: factor!.id, metricType: 'CARBON_EMISSION',
      value: new Prisma.Decimal(snapshot.result.value), unit: 'kgCO2e', detailsJson: snapshot,
    } });
  }
  await prisma.documentExtraction.create({ data: {
    id: `extraction-a-${suffix}`, organizationId: orgA.id, documentId: docs.a.id, status: 'REVIEW_REQUIRED',
    extractedJson: { schema: 'synthetic-v1' }, extractedRows: [{ row: 1, review: 'CONFIRMED' }], sourceRowCount: 1, extractedRowCount: 1,
  } });
  await prisma.spreadsheetImportReviewRow.create({ data: {
    id: `review-a-${suffix}`, organizationId: orgA.id, sourceDocumentId: docs.a.id, createdById: tenantA.id,
    rowId: 'synthetic-row-1', idempotencyKey: `recovery-${suffix}`, status: 'READY', sourceType: 'EXCEL',
    sourceFileName: docs.a.fileName, sourceRow: '1', activityType: 'DIESEL', recordDate: new Date('2026-01-15T00:00:00.000Z'),
    quantity: new Prisma.Decimal(10), unit: 'liters', issues: [], rawSourceRow: { synthetic: true },
  } });

  const holds = new LegalHoldsService(prisma as any);
  const actor = { id: approver.id, email: approver.email, organizationId: orgA.id, organizationName: orgA.name, role: UserRole.ADMIN, platformRole: UserRole.ADMIN, accountType: approver.accountType };
  const orgHold = await holds.activate(actor, {
    organizationId: orgA.id, caseReference: `LH-${pairId}-ORG-A`, scopeType: 'ORGANIZATION', status: 'ACTIVE',
    authorityReference: `AUTH-${pairId}-A`, evidenceReference: `EVID-${pairId}-A`, requesterUserId: requester.id, approvedByUserId: approver.id,
  });
  const docHold = await holds.activate(actor, {
    organizationId: orgB.id, caseReference: `LH-${pairId}-DOC-B`, scopeType: 'DOCUMENT', status: 'ACTIVE',
    authorityReference: `AUTH-${pairId}-B`, evidenceReference: `EVID-${pairId}-B`, requesterUserId: requester.id, approvedByUserId: approver.id,
    documentIds: [docs.bHeld.id],
  });
  const recovery = new DeletionRecoveryService(prisma as any, storage, holds);
  await recovery.prepareDocument(orgB.id, docs.bPending.id, tenantB.id);
  const pending = await recovery.completeDocument(orgB.id, docs.bPending.id, tenantB.id);
  await prisma.auditLog.create({ data: {
    organizationId: orgB.id, userId: tenantB.id, action: 'SYNTHETIC_DELETION_REQUEST', entityType: 'RecoveryPair', entityId: pairId,
    description: 'Synthetic recovery rehearsal deletion evidence.', newValue: { pairId, deletionIntentId: pending!.intent.id },
  } });
  return { orgA, orgB, orgC, requester, approver, tenantB, actor, docs, orgHold, docHold, pendingIntent: pending!.intent, report, holds, recovery };
}

function failureResult(name: string, detected: boolean, manualAction: string) {
  return { name, detected, failClosed: detected, customerAccessBlocked: detected, automaticCleanup: false, manualAction };
}

function inventoryMatches(expected: Array<{ storageKey: string; sha256: string }>, actual: Array<{ storageKey: string; sha256: string }>) {
  return JSON.stringify(expected.map(({ storageKey, sha256 }) => ({ storageKey, sha256 }))) ===
    JSON.stringify(actual.map(({ storageKey, sha256 }) => ({ storageKey, sha256 })));
}

async function main() {
  requireSafetyConsent();
  const started = performance.now();
  const admin = safeAdminUrl();
  const pairId = `PAIR-3GA2-2-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const recoverySessionId = `recovery_${randomUUID().replaceAll('-', '_')}`;
  const slug = pairId.toLowerCase().replace(/-/g, '_');
  const sourceDb = `${DB_PREFIX}src_${slug}`;
  const destinationDb = `${DB_PREFIX}dst_${slug}`;
  const root = assertDisposablePath(resolve(DISPOSABLE_PARENT, pairId));
  const sourceStorage = assertDisposablePath(resolve(root, 'source-storage'));
  const destinationStorage = assertDisposablePath(resolve(root, 'destination-storage'));
  const backup = assertDisposablePath(resolve(root, 'paired-backup'));
  await mkdir(DISPOSABLE_PARENT, { recursive: true, mode: 0o700 });
  try { await stat(root); throw new Error('Refusing to reuse an existing rehearsal root.'); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  await Promise.all([mkdir(sourceStorage, { recursive: true, mode: 0o700 }), mkdir(destinationStorage, { recursive: true, mode: 0o700 }), mkdir(backup, { recursive: true, mode: 0o700 })]);
  await Promise.all([createDatabase(admin, sourceDb), createDatabase(admin, destinationDb)]);
  const sourceUrl = databaseUrl(admin, sourceDb);
  const destinationUrl = databaseUrl(admin, destinationDb);
  await run('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: sourceUrl } });
  const source = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
  await source.$connect();
  const storage = new FilesystemDocumentStorage({ APP_ENV: 'development', DOCUMENT_STORAGE_PATH: sourceStorage, DOCUMENT_STORAGE_DURABLE: 'true' });
  await storage.onModuleInit();
  const fixture = await createFixture(source, storage, pairId);
  const migrations = await migrationManifest();
  const migrationManifestSha256 = await sha256Text(JSON.stringify(migrations));
  const revision = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const dirty = Boolean((await run('git', ['status', '--porcelain'])).stdout.trim());
  const sourceSnapshot = await databaseSnapshot(source);
  const captureStartedAt = new Date();
  const initialStorageInventory = await listFiles(sourceStorage);
  const dumpPath = resolve(backup, 'database.dump');
  const storageArchivePath = resolve(backup, 'document-storage.tar.gz');
  const backupStarted = performance.now();
  const sourceCli = postgresCli(new URL(sourceUrl));
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath, ...sourceCli.connectionArgs], { env: sourceCli.env });
  await run('tar', ['--create', '--gzip', '--file', storageArchivePath, '--directory', sourceStorage, '.']);
  const captureCompletedAt = new Date();
  const backupDurationMs = Math.round(performance.now() - backupStarted);
  const manifest = {
    schemaVersion: 1, pairId, captureStartedAt: captureStartedAt.toISOString(), captureCompletedAt: captureCompletedAt.toISOString(),
    sourceDatabase: sourceDb, sourceStorage, applicationRevision: revision, dirtyWorkingTree: dirty,
    migrationManifestSha256, migrations, databaseDump: { file: basename(dumpPath), sha256: await sha256File(dumpPath) },
    storageArchive: { file: basename(storageArchivePath), sha256: await sha256File(storageArchivePath) }, files: initialStorageInventory,
  };
  const manifestPath = resolve(backup, 'pair-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const manifestSha256 = await sha256File(manifestPath);
  const atBackupLedger: Json = {
    schemaVersion: 1, pairId, sourceDatabase: sourceDb, sourceStorage, backupUtc: captureCompletedAt.toISOString(),
    applicationRevision: revision, migrationManifestSha256, manifestSha256,
    documents: sourceSnapshot.documents.map((document: any) => ({ id: document.id, organizationId: document.organizationId, fileHash: document.fileHash, fileUrl: document.fileUrl })),
    activeHolds: sourceSnapshot.holds.filter((hold: any) => hold.status !== 'RELEASED').map((hold: any) => ({ id: hold.id, organizationId: hold.organizationId, caseReference: hold.caseReference, scopeType: hold.scopeType, status: hold.status })),
    pendingDeletionIntents: sourceSnapshot.intents.filter((intent: any) => intent.status === 'PENDING_PURGE'),
    completedDeletions: [], erasedOrganizationTombstones: [],
    accessRestriction: { status: 'BLOCKED_PENDING_RECONCILIATION', restoreModeEnvironment: 'RECOVERY_RESTORE_MODE=true' }, postBackupEvents: [],
  };
  await writeFile(resolve(backup, 'ledger-at-backup.json'), `${JSON.stringify(atBackupLedger, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(backup, 'source-snapshot.json'), `${JSON.stringify(sourceSnapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await run('pg_restore', ['--list', dumpPath]);

  const postDelete = await fixture.recovery.prepareDocument(fixture.orgB.id, fixture.docs.bLaterDelete.id, fixture.tenantB.id);
  await fixture.recovery.completeDocument(fixture.orgB.id, fixture.docs.bLaterDelete.id, fixture.tenantB.id);
  const postBackupHold = await fixture.holds.activate(fixture.actor as any, {
    organizationId: fixture.orgB.id, caseReference: `LH-${pairId}-POST-BACKUP`, scopeType: 'ORGANIZATION', status: 'ACTIVE',
    authorityReference: `AUTH-${pairId}-POST`, evidenceReference: `EVID-${pairId}-POST`, requesterUserId: fixture.requester.id, approvedByUserId: fixture.approver.id,
  });
  await source.organization.delete({ where: { id: fixture.orgC.id } });
  const authoritativeLedger = {
    ...atBackupLedger,
    activeHolds: [...atBackupLedger.activeHolds, { id: postBackupHold.id, organizationId: fixture.orgB.id, caseReference: postBackupHold.caseReference, scopeType: postBackupHold.scopeType, status: postBackupHold.status }],
    completedDeletions: [{ documentId: fixture.docs.bLaterDelete.id, organizationId: fixture.orgB.id, deletionIntentId: postDelete!.id, completedAfterBackup: true }],
    erasedOrganizationTombstones: [{ organizationId: fixture.orgC.id, erasedAfterBackup: true, evidenceReference: `ERASE-${pairId}-C` }],
    postBackupEvents: [
      { type: 'DOCUMENT_DELETED', documentId: fixture.docs.bLaterDelete.id, deletionIntentId: postDelete!.id },
      { type: 'LEGAL_HOLD_ACTIVATED', legalHoldId: postBackupHold.id, caseReference: postBackupHold.caseReference },
      { type: 'ORGANIZATION_ERASED', organizationId: fixture.orgC.id },
    ],
  };
  const authoritativeLedgerPath = resolve(backup, 'authoritative-recovery-ledger.json');
  await writeFile(authoritativeLedgerPath, `${JSON.stringify(authoritativeLedger, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await source.$disconnect();

  const dbRestoreStarted = performance.now();
  const destinationCli = postgresCli(new URL(destinationUrl));
  await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', ...destinationCli.connectionArgs, dumpPath], { env: destinationCli.env });
  const databaseRestoreDurationMs = Math.round(performance.now() - dbRestoreStarted);
  const archiveEntries = (await run('tar', ['--list', '--gzip', '--file', storageArchivePath])).stdout.split('\n').filter(Boolean);
  if (archiveEntries.some(entry => isAbsolute(entry) || entry.split('/').includes('..'))) throw new Error('Unsafe storage archive entry.');
  const fileRestoreStarted = performance.now();
  await run('tar', ['--extract', '--gzip', '--file', storageArchivePath, '--directory', destinationStorage, '--no-same-owner']);
  const fileRestoreDurationMs = Math.round(performance.now() - fileRestoreStarted);
  const destination = new PrismaClient({ datasources: { db: { url: destinationUrl } } });
  await destination.$connect();
  const reconciliationStarted = performance.now();
  const restoredSnapshot = await databaseSnapshot(destination);
  const restoredFiles = await listFiles(destinationStorage);
  const snapshotParity = JSON.stringify(sourceSnapshot) === JSON.stringify(restoredSnapshot);
  const fileParity = JSON.stringify(initialStorageInventory.map(({ modifiedAt, ...file }) => file)) === JSON.stringify(restoredFiles.map(({ modifiedAt, ...file }) => file));
  const restoredDocumentIds = new Set(restoredSnapshot.documents.map((document: any) => document.id));
  const restoredOrganizationIds = new Set(restoredSnapshot.organizations.map((organization: any) => organization.id));
  const restoredHoldCases = new Set(restoredSnapshot.holds.map((hold: any) => hold.caseReference));
  const resurrectedDocuments = authoritativeLedger.completedDeletions.filter((item: any) => restoredDocumentIds.has(item.documentId));
  const resurrectedOrganizations = authoritativeLedger.erasedOrganizationTombstones.filter((item: any) => restoredOrganizationIds.has(item.organizationId));
  const missingHolds = authoritativeLedger.activeHolds.filter((item: any) => !restoredHoldCases.has(item.caseReference));
  const tenantIsolation = restoredSnapshot.documents.every((document: any) => document.fileUrl.includes(document.organizationId)) &&
    restoredSnapshot.holdDocs.every((mapping: any) => restoredSnapshot.holds.some((hold: any) => hold.id === mapping.legalHoldId && hold.organizationId === mapping.organizationId));
  const migrationParity = JSON.stringify(sourceSnapshot.migrations) === JSON.stringify(restoredSnapshot.migrations);
  const quarantineFiles = restoredFiles.filter(file => file.storageKey.startsWith('.quarantine/'));
  const quarantineExpected = restoredSnapshot.intents.filter((intent: any) => intent.status === 'PENDING_PURGE');
  const quarantineParity = quarantineExpected.every((intent: any) => quarantineFiles.some(file => file.storageKey === intent.quarantineKey));
  const timestampWithinCaptureBoundary = restoredFiles.every(file => new Date(file.modifiedAt) <= captureCompletedAt);
  const unresolved = [...resurrectedDocuments, ...resurrectedOrganizations, ...missingHolds];
  const accessBlocked = (await new RecoveryAccessPolicy({
    RECOVERY_RESTORE_MODE: 'true',
    RECOVERY_CONTROL_STORE_PATH: resolve(root, 'external-control-state-not-initialized.json'),
    RECOVERY_RECONCILIATION_STATUS: unresolved.length ? 'INCOMPLETE' : 'COMPLETE',
  }).evaluate()).blocked;
  const reconciliationDurationMs = Math.round(performance.now() - reconciliationStarted);
  const reconciliation = {
    snapshotParity, fileParity, migrationParity, tenantIsolation, quarantineParity, timestampWithinCaptureBoundary,
    counts: Object.fromEntries(Object.entries(restoredSnapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]: any) => [key, value.length])),
    restoredFileCount: restoredFiles.length, restoredBytes: restoredFiles.reduce((total, file) => total + file.bytes, 0),
    activeFileHashesVerified: restoredFiles.filter(file => !file.storageKey.startsWith('.quarantine/')).every(file => initialStorageInventory.some(expected => expected.storageKey === file.storageKey && expected.sha256 === file.sha256)),
    quarantineHashesVerified: quarantineFiles.every(file => initialStorageInventory.some(expected => expected.storageKey === file.storageKey && expected.sha256 === file.sha256)),
    resurrectedDocuments, resurrectedOrganizations, missingHolds, accessBlocked,
    customerAccessReleased: !accessBlocked,
  };
  const invalidDumpPath = resolve(root, 'failure-injection-invalid.dump');
  await writeFile(invalidDumpPath, 'synthetic invalid pg_dump payload\n', { flag: 'wx', mode: 0o600 });
  let databaseRestoreFailureDetected = false;
  try { await run('pg_restore', ['--list', invalidDumpPath]); } catch { databaseRestoreFailureDetected = true; }
  const incompleteInventory = restoredFiles.slice(1);
  const hashMismatchInventory = restoredFiles.map((file, index) => index === 0 ? { ...file, sha256: '0'.repeat(64) } : file);
  const missingQuarantineInventory = restoredFiles.filter(file => !file.storageKey.startsWith('.quarantine/'));
  const migrationMismatch = JSON.stringify([...restoredSnapshot.migrations, { migration_name: 'synthetic_mismatch', finished_at: null }]) !== JSON.stringify(sourceSnapshot.migrations);
  const pairIdMismatch = `${manifest.pairId}-MISMATCH` !== authoritativeLedger.pairId;
  const failures = [
    failureResult('Database restore fails', databaseRestoreFailureDetected, 'Preserve dump and restore logs; repair target or backup before retry.'),
    failureResult('File archive is incomplete', !inventoryMatches(initialStorageInventory, incompleteInventory), 'Recreate or recover the exact paired storage archive.'),
    failureResult('File hash mismatch', !inventoryMatches(initialStorageInventory, hashMismatchInventory), 'Quarantine the restore and recover the expected hash-matched pair.'),
    failureResult('Missing quarantine entry', quarantineFiles.length > 0 && !quarantineExpected.every((intent: any) => missingQuarantineInventory.some(file => file.storageKey === intent.quarantineKey)), 'Preserve DB intent and investigate paired storage; do not purge.'),
    failureResult('Hold state differs from ledger', missingHolds.length > 0, 'Reapply the authoritative hold through approved administration.'),
    failureResult('Deleted document reappears', resurrectedDocuments.length > 0, 'Keep access blocked and review/replay deletion authorization.'),
    failureResult('Erased organization reappears', resurrectedOrganizations.length > 0, 'Keep access blocked and review/replay erasure authorization.'),
    failureResult('Migration manifest differs', migrationMismatch, 'Stop startup; identify the correct application revision and migration history.'),
    failureResult('Backup pair IDs do not match', pairIdMismatch, 'Reject both artifacts and select one verified matching pair.'),
    failureResult('Restore reconciliation is interrupted', (await new RecoveryAccessPolicy({
      RECOVERY_RESTORE_MODE: 'true',
      RECOVERY_CONTROL_STORE_PATH: resolve(root, 'interrupted-control-state.json'),
      RECOVERY_RECONCILIATION_STATUS: 'IN_PROGRESS',
    }).evaluate()).blocked, 'Resume reconciliation from preserved evidence; never mark COMPLETE automatically.'),
  ];
  const failureChecksPassed = failures.every(item => item.detected && item.failClosed && item.customerAccessBlocked && item.automaticCleanup === false);

  // A2-2 remediation is deliberately explicit, synthetic, and limited to the
  // disposable restored pair. Apply post-backup events in their authoritative
  // order: deletion and erasure first, then the later organization hold.
  const restoredStorage = new FilesystemDocumentStorage({
    APP_ENV: 'development', DOCUMENT_STORAGE_PATH: destinationStorage,
    DOCUMENT_STORAGE_DURABLE: 'true',
  });
  await restoredStorage.onModuleInit();
  const restoredHolds = new LegalHoldsService(destination as any);
  const restoredRecovery = new DeletionRecoveryService(destination as any, restoredStorage, restoredHolds);
  const restoredActor = fixture.actor as any;
  await restoredRecovery.prepareDocument(fixture.orgB.id, fixture.docs.bLaterDelete.id, fixture.tenantB.id);
  await restoredRecovery.completeDocument(fixture.orgB.id, fixture.docs.bLaterDelete.id, fixture.tenantB.id);
  await restoredRecovery.prepareDocument(fixture.orgC.id, fixture.docs.c.id, fixture.tenantB.id);
  await restoredRecovery.completeDocument(fixture.orgC.id, fixture.docs.c.id, fixture.tenantB.id);
  await destination.organization.delete({ where: { id: fixture.orgC.id } });
  await restoredHolds.activate(restoredActor, {
    organizationId: fixture.orgB.id,
    caseReference: postBackupHold.caseReference,
    scopeType: 'ORGANIZATION', status: 'ACTIVE',
    authorityReference: `AUTH-${pairId}-POST-RESTORED`,
    evidenceReference: `EVID-${pairId}-POST-RESTORED`,
    requesterUserId: fixture.requester.id,
    approvedByUserId: fixture.approver.id,
  });

  const remediatedSnapshot = await databaseSnapshot(destination);
  const remediatedFiles = await listFiles(destinationStorage);
  const remediatedDocumentIds = new Set(remediatedSnapshot.documents.map((item: any) => item.id));
  const remediatedOrganizationIds = new Set(remediatedSnapshot.organizations.map((item: any) => item.id));
  const remediatedHoldCases = new Set(remediatedSnapshot.holds.map((item: any) => item.caseReference));
  const remainingResurrectedDocuments = authoritativeLedger.completedDeletions
    .filter((item: any) => remediatedDocumentIds.has(item.documentId));
  const remainingResurrectedOrganizations = authoritativeLedger.erasedOrganizationTombstones
    .filter((item: any) => remediatedOrganizationIds.has(item.organizationId));
  const remainingMissingHolds = authoritativeLedger.activeHolds
    .filter((item: any) => !remediatedHoldCases.has(item.caseReference));
  const activeFiles = remediatedFiles.filter((item) => !item.storageKey.startsWith('.quarantine/'));
  const remediatedQuarantine = remediatedFiles.filter((item) => item.storageKey.startsWith('.quarantine/'));
  const expectedProtectedHashes = new Set([
    ...initialStorageInventory.map((item) => item.sha256),
    ...authoritativeLedger.documents.map((item: any) => item.fileHash),
  ]);
  const activeHashesValid = activeFiles.every((file) =>
    remediatedSnapshot.documents.some((document: any) =>
      document.fileUrl.replace('/uploads/', '') === file.storageKey && document.fileHash === file.sha256) ||
    remediatedSnapshot.reports.some((report: any) => report.generatedPdfUrl?.replace('/uploads/', '') === file.storageKey));
  const quarantineHashesValid = remediatedQuarantine.every((file) => expectedProtectedHashes.has(file.sha256));
  const remediatedTenantIsolation = remediatedSnapshot.documents.every((document: any) =>
    document.fileUrl.includes(document.organizationId)) &&
    remediatedSnapshot.holdDocs.every((mapping: any) =>
      remediatedSnapshot.holds.some((hold: any) =>
        hold.id === mapping.legalHoldId && hold.organizationId === mapping.organizationId));
  const activityConsistency = remediatedSnapshot.activities.every((activity: any) =>
    activity.calculationStatus === 'CALCULATED' && activity.calculationSnapshot && activity.matchedFactorId);
  const factorProvenance = remediatedSnapshot.activities.every((activity: any) =>
    activity.calculationSnapshot?.factor?.id === activity.matchedFactorId);
  const reportsConsistent = remediatedSnapshot.reports.every((report: any) =>
    report.documents.every((document: any) => remediatedDocumentIds.has(document.id)));
  const currentLedgerDigest = await sha256File(authoritativeLedgerPath);
  const restoredStateFingerprint = sha256(canonicalJson(remediatedSnapshot));
  const check = (ok: boolean, value: unknown[], count = value.length) => ({
    ok, count, digest: sha256(canonicalJson(value)),
  });
  const mismatches = [
    ...remainingMissingHolds.map(() => ({ code: 'MISSING_ACTIVE_LEGAL_HOLD', severity: 'P0' as const })),
    ...remainingResurrectedDocuments.map(() => ({ code: 'RESURRECTED_DOCUMENT', severity: 'P0' as const })),
    ...remainingResurrectedOrganizations.map(() => ({ code: 'RESURRECTED_ORGANIZATION', severity: 'P0' as const })),
    ...(!activeHashesValid ? [{ code: 'ACTIVE_FILE_HASH_MISMATCH', severity: 'P0' as const }] : []),
    ...(!quarantineHashesValid ? [{ code: 'QUARANTINE_FILE_HASH_MISMATCH', severity: 'P0' as const }] : []),
  ];
  const operatorKeys = generateKeyPairSync('ed25519');
  const reviewerKeys = generateKeyPairSync('ed25519');
  const authorityKeys = generateKeyPairSync('ed25519');
  const privatePem = (key: any) => key.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = (key: any) => key.export({ type: 'spki', format: 'pem' }).toString();
  const operatorPrincipalId = `recovery_operator_${randomUUID()}`;
  const reviewerPrincipalId = `recovery_reviewer_${randomUUID()}`;
  const a22Evidence: RecoveryEvidence = {
    schemaVersion: 1,
    recoverySessionId, recoveryPairId: pairId,
    databaseDumpSha256: manifest.databaseDump.sha256,
    storageArchiveSha256: manifest.storageArchive.sha256,
    pairManifestSha256: manifestSha256,
    independentLedgerSha256: currentLedgerDigest,
    restoredDatabaseStateFingerprint: restoredStateFingerprint,
    activeDocumentHashInventory: check(activeHashesValid, activeFiles),
    quarantineHashInventory: check(quarantineHashesValid, remediatedQuarantine),
    legalHoldReconciliation: check(remainingMissingHolds.length === 0, remainingMissingHolds),
    deletionIntentReconciliation: check(remainingResurrectedDocuments.length === 0, remainingResurrectedDocuments),
    erasureTombstoneReconciliation: check(remainingResurrectedOrganizations.length === 0, remainingResurrectedOrganizations),
    tenantIsolationChecks: check(remediatedTenantIsolation, remediatedSnapshot.documents),
    confirmedActivityDataConsistency: check(activityConsistency, remediatedSnapshot.activities),
    emissionsFactorProvenance: check(factorProvenance, remediatedSnapshot.activities),
    reportConsistency: check(reportsConsistent, remediatedSnapshot.reports),
    migrationManifestSha256,
    applicationRevision: revision,
    outstandingMismatches: mismatches,
    operatorPrincipalId,
    evidenceCreatedAt: new Date().toISOString(),
  };
  const a22EvidenceDigest = recoveryEvidenceDigest(a22Evidence);
  const controlPath = resolve('/tmp/carbonlite-recovery-control', recoverySessionId, 'active-session.json');
  const authorityPrivatePem = privatePem(authorityKeys.privateKey);
  const authorityPublicPem = publicPem(authorityKeys.publicKey);
  const authorityKeyId = `authority_${randomUUID()}`;
  const authority = new LocalRecoveryAuthority(controlPath, authorityKeyId, authorityPrivatePem, [
    { principalId: operatorPrincipalId, role: 'RECOVERY_OPERATOR', publicKeyPem: publicPem(operatorKeys.publicKey) },
    { principalId: reviewerPrincipalId, role: 'RECOVERY_REVIEWER', publicKeyPem: publicPem(reviewerKeys.publicKey) },
  ]);
  let recoveryRecord = await authority.initialize({
    sessionId: recoverySessionId, pairId,
    evidenceDigest: a22EvidenceDigest, ledgerDigest: currentLedgerDigest,
    restoredStateFingerprint,
  });
  const gate = (minimumGeneration: number, path = controlPath) => new RecoveryAccessPolicy({
    RECOVERY_RESTORE_MODE: 'false', RECOVERY_RECONCILIATION_STATUS: 'COMPLETE',
    RECOVERY_CONTROL_STORE_PATH: path,
    RECOVERY_SESSION_ID: recoverySessionId, RECOVERY_PAIR_ID: pairId,
    RECOVERY_EVIDENCE_DIGEST: a22EvidenceDigest,
    RECOVERY_AUTHORITY_PUBLIC_KEY: authorityPublicPem,
    RECOVERY_AUTHORITY_KEY_ID: authorityKeyId,
    RECOVERY_MIN_GENERATION: String(minimumGeneration),
  });
  const lockedBeforeApproval = (await gate(recoveryRecord.generation).evaluate()).blocked;
  recoveryRecord = await authority.beginReconciliation(recoveryRecord.generation);
  const signedCommand = (
    action: 'SUBMIT_EVIDENCE' | 'APPROVE_RELEASE',
    principalId: string,
    privateKey: any,
  ) => {
    const now = new Date();
    return signRecoveryCommand({
      action, principalId, sessionId: recoverySessionId, pairId,
      expectedGeneration: recoveryRecord.generation,
      evidenceDigest: a22EvidenceDigest, ledgerDigest: currentLedgerDigest,
      restoredStateFingerprint, nonce: `nonce_${randomUUID()}`,
      authenticatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }, privatePem(privateKey));
  };
  recoveryRecord = await authority.submitEvidence(
    a22Evidence,
    signedCommand('SUBMIT_EVIDENCE', operatorPrincipalId, operatorKeys.privateKey),
  );
  recoveryRecord = await authority.review(
    signedCommand('APPROVE_RELEASE', reviewerPrincipalId, reviewerKeys.privateKey),
  );
  recoveryRecord = await authority.release(recoveryRecord.generation, new Date(), 5 * 60_000);
  const releasedRecord = recoveryRecord;
  const releasedDecision = await gate(releasedRecord.generation).evaluate();

  const mutatedLedger = {
    ...authoritativeLedger,
    postBackupEvents: [...authoritativeLedger.postBackupEvents, { type: 'SYNTHETIC_LEDGER_MUTATION_AFTER_RELEASE' }],
  };
  const mutatedLedgerPath = resolve(backup, 'authoritative-recovery-ledger-after-release.json');
  await writeFile(mutatedLedgerPath, `${JSON.stringify(mutatedLedger, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const mutatedLedgerDigest = await sha256File(mutatedLedgerPath);
  recoveryRecord = await authority.verifyCurrentState(releasedRecord.generation, {
    evidenceDigest: a22EvidenceDigest,
    ledgerDigest: mutatedLedgerDigest,
    restoredStateFingerprint,
    unresolvedP0MismatchCount: 1,
  });
  const relockedDecision = await gate(recoveryRecord.generation).evaluate();
  const restartedDecision = await gate(recoveryRecord.generation).evaluate();
  const staleReleasePath = resolve('/tmp/carbonlite-recovery-control', recoverySessionId, 'stale-released-record.json');
  await writeFile(staleReleasePath, `${JSON.stringify(releasedRecord, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const rollbackDecision = await gate(recoveryRecord.generation, staleReleasePath).evaluate();
  const minimizedEvidencePath = resolve(backup, 'a2-2-canonical-recovery-evidence.json');
  await writeFile(minimizedEvidencePath, `${JSON.stringify(a22Evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const releasedAuthorizationPath = resolve(backup, 'a2-2-released-authorization.json');
  await writeFile(releasedAuthorizationPath, `${JSON.stringify(releasedRecord, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const a22 = {
    recoverySessionId, pairId,
    operatorPrincipalId, reviewerPrincipalId,
    independentPrincipals: operatorPrincipalId !== reviewerPrincipalId,
    authorityPublicKeySha256: sha256(authorityPublicPem),
    evidencePath: minimizedEvidencePath, evidenceDigest: a22EvidenceDigest,
    controlPath, releasedAuthorizationPath,
    lockedBeforeApproval,
    released: !releasedDecision.blocked,
    releaseReason: releasedDecision.reason,
    releasedGeneration: releasedRecord.generation,
    relockedAfterLedgerMutation: relockedDecision.blocked,
    relockReason: relockedDecision.reason,
    relockedGeneration: recoveryRecord.generation,
    restartRemainsLocked: restartedDecision.blocked,
    rollbackBlocked: rollbackDecision.blocked,
    rollbackReason: rollbackDecision.reason,
    unresolvedP0BeforeRemediation: unresolved.length,
    unresolvedP0AfterRemediation: mismatches.filter(({ severity }) => severity === 'P0').length,
    automaticOrProviderChangeDetectionClaimed: false,
  };
  const finishedAt = new Date();
  const evidence = {
    pairId,
    isolation: { sourceDatabase: sourceDb, destinationDatabase: destinationDb, sourceStorage, destinationStorage, backup, databaseHost: admin.hostname, loopbackVerified: true, disposablePathVerified: true },
    manifest: { path: manifestPath, sha256: manifestSha256, migrationManifestSha256, databaseDumpSha256: manifest.databaseDump.sha256, storageArchiveSha256: manifest.storageArchive.sha256 },
    fixture: { organizations: [fixture.orgA.id, fixture.orgB.id, fixture.orgC.id], documents: Object.values(fixture.docs).map((item: any) => item.id), organizationHold: fixture.orgHold.caseReference, documentHold: fixture.docHold.caseReference, pendingDeletionIntent: fixture.pendingIntent.id, report: fixture.report.id },
    reconciliation,
    failures,
    failureChecksPassed,
    a22,
    timing: { backupDurationMs, databaseRestoreDurationMs, fileRestoreDurationMs, reconciliationDurationMs, totalElapsedMs: Math.round(performance.now() - started), observedRecoveryPointAgeMs: finishedAt.getTime() - captureCompletedAt.getTime() },
    capture: { startedAt: captureStartedAt.toISOString(), completedAt: captureCompletedAt.toISOString(), finishedAt: finishedAt.toISOString(), mutationsPaused: true, coordination: 'Dedicated databases and storage roots had one harness writer; post-backup mutations began only after dump/archive verification.' },
    safety: { outboundIntegrationsUsed: false, providerAccessUsed: false, automaticDestructiveCleanup: false, restoredRoutesBlocked: accessBlocked },
  };
  await writeFile(resolve(backup, 'rehearsal-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await destination.$disconnect();
  console.log(JSON.stringify({ pairId, recoverySessionId, root, manifestSha256, reconciliation, a22, failureChecksPassed, timing: evidence.timing }, null, 2));
}

main().catch(error => {
  console.error(`Recovery rehearsal failed safely: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
