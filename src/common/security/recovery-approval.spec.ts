import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LocalRecoveryAuthority,
  authorityPublicKeyPem,
  signRecoveryCommand,
} from '../../../scripts/recovery-control/local-recovery-authority';
import { RecoveryAccessPolicy } from './restore-access-gate';
import { RecoveryEvidence, recoveryEvidenceDigest } from './recovery-evidence';

describe('A2-2 independent recovery approval authority', () => {
  it('requires complete evidence and two authenticated independent principals', async () => {
    const fixture = await authorityFixture();
    let record = await fixture.authority.initialize(fixture.binding);
    await expect(fixture.policy(record.generation).evaluate())
      .resolves.toMatchObject({ blocked: true, reason: 'RECOVERY_LOCKED' });
    record = await fixture.authority.beginReconciliation(record.generation);

    const incomplete = { ...fixture.evidence, outstandingMismatches: [{ code: 'MISSING_HOLD', severity: 'P0' as const }] };
    await expect(fixture.authority.submitEvidence(incomplete, fixture.command('operator', 'SUBMIT_EVIDENCE', record.generation)))
      .rejects.toThrow('RECOVERY_RECONCILIATION_INCOMPLETE');

    record = await fixture.authority.submitEvidence(
      fixture.evidence,
      fixture.command('operator', 'SUBMIT_EVIDENCE', record.generation),
    );
    await expect(fixture.authority.review(
      fixture.command('operator', 'APPROVE_RELEASE', record.generation),
    )).rejects.toThrow('UNAUTHORIZED_RECOVERY_PRINCIPAL');
    await expect(fixture.authority.review(
      fixture.command('unknown', 'APPROVE_RELEASE', record.generation),
    )).rejects.toThrow('UNAUTHORIZED_RECOVERY_PRINCIPAL');

    record = await fixture.authority.review(
      fixture.command('reviewer', 'APPROVE_RELEASE', record.generation),
    );
    record = await fixture.authority.release(record.generation, new Date(), 60_000);
    await expect(fixture.policy(record.generation).evaluate())
      .resolves.toMatchObject({ blocked: false, reason: 'VALID_EXTERNAL_RELEASE_AUTHORIZATION' });
    expect(record.approval).toMatchObject({
      operatorPrincipalId: fixture.operator.id,
      reviewerPrincipalId: fixture.reviewer.id,
    });
    expect(record.approval?.operatorPrincipalId).not.toBe(record.approval?.reviewerPrincipalId);
    await expect(fixture.authority.release(record.generation))
      .rejects.toThrow('RELEASE_APPROVAL_UNAVAILABLE');
  });

  it('serializes concurrent release and invalidates a release after ledger change', async () => {
    const fixture = await releasedFixture();
    const approved = fixture.approved;
    const outcomes = await Promise.allSettled([
      fixture.authority.release(approved.generation, new Date(), 60_000),
      fixture.authority.release(approved.generation, new Date(), 60_000),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const released = outcomes.find(({ status }) => status === 'fulfilled')!;
    const record = (released as PromiseFulfilledResult<any>).value;
    await expect(fixture.policy(record.generation).evaluate()).resolves.toMatchObject({ blocked: false });

    const relocked = await fixture.authority.verifyCurrentState(record.generation, {
      evidenceDigest: record.evidenceDigest,
      ledgerDigest: 'f'.repeat(64),
      restoredStateFingerprint: record.restoredStateFingerprint,
      unresolvedP0MismatchCount: 1,
    });
    await expect(fixture.policy(relocked.generation).evaluate())
      .resolves.toMatchObject({ blocked: true, reason: 'RECOVERY_LOCKED' });

    await writeFile(fixture.path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await expect(fixture.policy(relocked.generation).evaluate())
      .resolves.toMatchObject({ blocked: true, reason: 'AUTHORITY_GENERATION_ROLLBACK' });
  });

  it('keeps rejection locked and binds approval to exact evidence', async () => {
    const fixture = await authorityFixture();
    let record = await fixture.authority.initialize(fixture.binding);
    record = await fixture.authority.beginReconciliation(record.generation);
    await expect(fixture.authority.submitEvidence(
      fixture.evidence,
      { ...fixture.command('operator', 'SUBMIT_EVIDENCE', record.generation), evidenceDigest: '0'.repeat(64) },
    )).rejects.toThrow();
    record = await fixture.authority.submitEvidence(
      fixture.evidence,
      fixture.command('operator', 'SUBMIT_EVIDENCE', record.generation),
    );
    record = await fixture.authority.review(
      fixture.command('reviewer', 'REJECT_RELEASE', record.generation),
    );
    await expect(fixture.policy(record.generation).evaluate())
      .resolves.toMatchObject({ blocked: true, reason: 'REJECTED' });
    await expect(fixture.authority.release(record.generation)).rejects.toThrow('RELEASE_APPROVAL_UNAVAILABLE');
    expect(JSON.stringify(record)).not.toMatch(/password|customer source|raw extracted/i);
  });

  it.each([
    ['evidence/file/hold inventory', 'evidenceDigest'],
    ['independent ledger', 'ledgerDigest'],
    ['restored database state', 'restoredStateFingerprint'],
  ] as const)('re-locks when the current %s binding changes', async (_name, field) => {
    const fixture = await releasedFixture();
    const released = await fixture.authority.release(fixture.approved.generation, new Date(), 60_000);
    const current = {
      evidenceDigest: released.evidenceDigest,
      ledgerDigest: released.ledgerDigest,
      restoredStateFingerprint: released.restoredStateFingerprint,
      unresolvedP0MismatchCount: 0,
    };
    current[field] = 'e'.repeat(64);
    const relocked = await fixture.authority.verifyCurrentState(released.generation, current);
    await expect(fixture.policy(relocked.generation).evaluate())
      .resolves.toMatchObject({ blocked: true, reason: 'RECOVERY_LOCKED' });
  });
});

async function releasedFixture() {
  const fixture = await authorityFixture();
  let record = await fixture.authority.initialize(fixture.binding);
  record = await fixture.authority.beginReconciliation(record.generation);
  record = await fixture.authority.submitEvidence(
    fixture.evidence,
    fixture.command('operator', 'SUBMIT_EVIDENCE', record.generation),
  );
  const approved = await fixture.authority.review(
    fixture.command('reviewer', 'APPROVE_RELEASE', record.generation),
  );
  return { ...fixture, approved };
}

async function authorityFixture() {
  const directory = await mkdtemp(join('/tmp/carbonlite-recovery-control/', 'a2-2-test-'));
  const path = join(directory, 'active-session.json');
  const authorityKeys = keys();
  const operatorKeys = keys();
  const reviewerKeys = keys();
  const unknownKeys = keys();
  const operator = { id: 'recovery_operator_synthetic', ...operatorKeys };
  const reviewer = { id: 'recovery_reviewer_synthetic', ...reviewerKeys };
  const sessionId = `recovery_${randomUUID().replaceAll('-', '_')}`;
  const pairId = `PAIR_A22_${randomUUID().replaceAll('-', '_')}`;
  const ledgerDigest = 'b'.repeat(64);
  const restoredStateFingerprint = 'c'.repeat(64);
  const evidence = evidenceFixture(sessionId, pairId, operator.id, ledgerDigest, restoredStateFingerprint);
  const evidenceDigest = recoveryEvidenceDigest(evidence);
  const binding = { sessionId, pairId, evidenceDigest, ledgerDigest, restoredStateFingerprint };
  const authority = new LocalRecoveryAuthority(path, 'authority_local_a22', authorityKeys.privateKey, [
    { principalId: operator.id, role: 'RECOVERY_OPERATOR', publicKeyPem: operator.publicKey },
    { principalId: reviewer.id, role: 'RECOVERY_REVIEWER', publicKeyPem: reviewer.publicKey },
  ]);
  const keyFor = (kind: 'operator' | 'reviewer' | 'unknown') =>
    kind === 'operator' ? operator : kind === 'reviewer' ? reviewer : { id: 'unknown_reviewer_synthetic', ...unknownKeys };
  const command = (kind: 'operator' | 'reviewer' | 'unknown', action: 'SUBMIT_EVIDENCE' | 'APPROVE_RELEASE' | 'REJECT_RELEASE', expectedGeneration: number) => {
    const principal = keyFor(kind);
    const now = new Date();
    return signRecoveryCommand({
      action, principalId: principal.id, sessionId, pairId, expectedGeneration,
      evidenceDigest, ledgerDigest, restoredStateFingerprint,
      nonce: `nonce_${randomUUID()}`, authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }, principal.privateKey);
  };
  const policy = (minimumGeneration: number) => new RecoveryAccessPolicy({
    RECOVERY_RESTORE_MODE: 'false',
    RECOVERY_RECONCILIATION_STATUS: 'COMPLETE',
    RECOVERY_CONTROL_STORE_PATH: path,
    RECOVERY_AUTHORITY_PUBLIC_KEY: authorityPublicKeyPem(authorityKeys.privateKey),
    RECOVERY_AUTHORITY_KEY_ID: 'authority_local_a22',
    RECOVERY_MIN_GENERATION: String(minimumGeneration),
  });
  return { path, authority, operator, reviewer, evidence, binding, command, policy };
}

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function evidenceFixture(
  recoverySessionId: string,
  recoveryPairId: string,
  operatorPrincipalId: string,
  independentLedgerSha256: string,
  restoredDatabaseStateFingerprint: string,
): RecoveryEvidence {
  const check = { ok: true, count: 1, digest: 'd'.repeat(64) };
  return {
    schemaVersion: 1, recoverySessionId, recoveryPairId,
    databaseDumpSha256: '1'.repeat(64), storageArchiveSha256: '2'.repeat(64),
    pairManifestSha256: '3'.repeat(64), independentLedgerSha256,
    restoredDatabaseStateFingerprint,
    activeDocumentHashInventory: check, quarantineHashInventory: check,
    legalHoldReconciliation: check, deletionIntentReconciliation: check,
    erasureTombstoneReconciliation: check, tenantIsolationChecks: check,
    confirmedActivityDataConsistency: check, emissionsFactorProvenance: check,
    reportConsistency: check, migrationManifestSha256: '4'.repeat(64),
    applicationRevision: 'revision_synthetic_a22', outstandingMismatches: [],
    operatorPrincipalId, evidenceCreatedAt: new Date().toISOString(),
  };
}
