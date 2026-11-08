import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
  RecoveryAccessPolicy,
  restoreAccessGate,
} from '../src/common/security/restore-access-gate';
import { RecoveryEvidence, recoveryEvidenceDigest } from '../src/common/security/recovery-evidence';
import {
  LocalRecoveryAuthority,
  signRecoveryCommand,
} from '../scripts/recovery-control/local-recovery-authority';

@Controller('api')
class RecoveryProbeController {
  @Get('documents/:id/download')
  documentDownload() { return { exposed: true }; }

  @Get('reports/:id')
  report() { return { exposed: true }; }

  @Get('health/live')
  health() { return { status: 'ok' }; }
}

@Module({ controllers: [RecoveryProbeController] })
class RecoveryProbeModule {}

describe('A2-1 recovery access gate (e2e)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('blocks document and report access despite COMPLETE and restore-mode false', async () => {
    const path = await externalState();
    const moduleRef = await Test.createTestingModule({
      imports: [RecoveryProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(restoreAccessGate(new RecoveryAccessPolicy({
      RECOVERY_RESTORE_MODE: 'false',
      RECOVERY_RECONCILIATION_STATUS: 'COMPLETE',
      RECOVERY_CONTROL_STORE_PATH: path,
    })));
    await app.init();

    await request(app.getHttpServer())
      .get('/api/documents/synthetic/download')
      .expect(503)
      .expect(({ body }) => expect(body.code).toBe('RESTORE_RECONCILIATION_REQUIRED'));
    await request(app.getHttpServer())
      .get('/api/reports/synthetic')
      .expect(503);
    await request(app.getHttpServer())
      .get('/api/health/live')
      .expect(200, { status: 'ok' });
  });

  it('opens customer routes only for a valid independently approved release and re-locks on change', async () => {
    const release = await approvedRelease();
    const moduleRef = await Test.createTestingModule({ imports: [RecoveryProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(restoreAccessGate(release.policy));
    await app.init();

    await request(app.getHttpServer()).get('/api/documents/synthetic/download').expect(200);
    await request(app.getHttpServer()).get('/api/reports/synthetic').expect(200);

    const relocked = await release.authority.verifyCurrentState(release.record.generation, {
      evidenceDigest: release.record.evidenceDigest,
      ledgerDigest: 'f'.repeat(64),
      restoredStateFingerprint: release.record.restoredStateFingerprint,
      unresolvedP0MismatchCount: 1,
    });
    release.environment.RECOVERY_MIN_GENERATION = String(relocked.generation);
    await request(app.getHttpServer()).get('/api/documents/synthetic/download').expect(503);
    await request(app.getHttpServer()).get('/api/reports/synthetic').expect(503);
  });
});

async function externalState() {
  const directory = await mkdtemp(join(tmpdir(), 'carbonlite-a2-1-e2e-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'active-session.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    sessionId: 'recovery_synthetic_e2e',
    pairId: 'PAIR_SYNTHETIC_E2E',
    state: 'RECOVERY_LOCKED',
    evidenceDigest: 'b'.repeat(64),
    restoredDatabaseIdentity: 'db:synthetic-e2e',
    restoredStorageIdentity: 'storage:synthetic-e2e',
    generation: 1,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  }), { flag: 'wx', mode: 0o600 });
  return path;
}

async function approvedRelease() {
  const directory = await mkdtemp('/tmp/carbonlite-recovery-control/a2-2-e2e-');
  const path = join(directory, 'active-session.json');
  const authorityKeys = generateKeyPairSync('ed25519');
  const operatorKeys = generateKeyPairSync('ed25519');
  const reviewerKeys = generateKeyPairSync('ed25519');
  const privatePem = (key: any) => key.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = (key: any) => key.export({ type: 'spki', format: 'pem' }).toString();
  const sessionId = `recovery_${randomUUID().replaceAll('-', '_')}`;
  const pairId = `PAIR_A22_${randomUUID().replaceAll('-', '_')}`;
  const operatorPrincipalId = 'recovery_operator_e2e';
  const reviewerPrincipalId = 'recovery_reviewer_e2e';
  const ledgerDigest = 'b'.repeat(64);
  const restoredStateFingerprint = 'c'.repeat(64);
  const check = { ok: true, count: 1, digest: 'd'.repeat(64) };
  const evidence: RecoveryEvidence = {
    schemaVersion: 1, recoverySessionId: sessionId, recoveryPairId: pairId,
    databaseDumpSha256: '1'.repeat(64), storageArchiveSha256: '2'.repeat(64),
    pairManifestSha256: '3'.repeat(64), independentLedgerSha256: ledgerDigest,
    restoredDatabaseStateFingerprint: restoredStateFingerprint,
    activeDocumentHashInventory: check, quarantineHashInventory: check,
    legalHoldReconciliation: check, deletionIntentReconciliation: check,
    erasureTombstoneReconciliation: check, tenantIsolationChecks: check,
    confirmedActivityDataConsistency: check, emissionsFactorProvenance: check,
    reportConsistency: check, migrationManifestSha256: '4'.repeat(64),
    applicationRevision: 'revision_synthetic_e2e', outstandingMismatches: [],
    operatorPrincipalId, evidenceCreatedAt: new Date().toISOString(),
  };
  const evidenceDigest = recoveryEvidenceDigest(evidence);
  const authorityKeyId = 'authority_synthetic_e2e';
  const authority = new LocalRecoveryAuthority(path, authorityKeyId, privatePem(authorityKeys.privateKey), [
    { principalId: operatorPrincipalId, role: 'RECOVERY_OPERATOR', publicKeyPem: publicPem(operatorKeys.publicKey) },
    { principalId: reviewerPrincipalId, role: 'RECOVERY_REVIEWER', publicKeyPem: publicPem(reviewerKeys.publicKey) },
  ]);
  let record = await authority.initialize({ sessionId, pairId, evidenceDigest, ledgerDigest, restoredStateFingerprint });
  record = await authority.beginReconciliation(record.generation);
  const command = (action: 'SUBMIT_EVIDENCE' | 'APPROVE_RELEASE', principalId: string, key: any) => {
    const now = new Date();
    return signRecoveryCommand({
      action, principalId, sessionId, pairId, expectedGeneration: record.generation,
      evidenceDigest, ledgerDigest, restoredStateFingerprint,
      nonce: `nonce_${randomUUID()}`, authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }, privatePem(key));
  };
  record = await authority.submitEvidence(evidence, command('SUBMIT_EVIDENCE', operatorPrincipalId, operatorKeys.privateKey));
  record = await authority.review(command('APPROVE_RELEASE', reviewerPrincipalId, reviewerKeys.privateKey));
  record = await authority.release(record.generation, new Date(), 60_000);
  const environment: NodeJS.ProcessEnv = {
    RECOVERY_CONTROL_STORE_PATH: path,
    RECOVERY_SESSION_ID: sessionId,
    RECOVERY_PAIR_ID: pairId,
    RECOVERY_EVIDENCE_DIGEST: evidenceDigest,
    RECOVERY_AUTHORITY_PUBLIC_KEY: publicPem(authorityKeys.publicKey),
    RECOVERY_AUTHORITY_KEY_ID: authorityKeyId,
    RECOVERY_MIN_GENERATION: String(record.generation),
  };
  return { authority, record, environment, policy: new RecoveryAccessPolicy(environment) };
}
