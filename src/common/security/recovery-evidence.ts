import { canonicalJson, sha256 } from './recovery-control-store';

export type RecoveryCheck = {
  ok: boolean;
  count: number;
  digest: string;
};

export type RecoveryMismatch = {
  code: string;
  severity: 'P0' | 'P1' | 'P2';
};

export type RecoveryEvidence = {
  schemaVersion: 1;
  recoverySessionId: string;
  recoveryPairId: string;
  databaseDumpSha256: string;
  storageArchiveSha256: string;
  pairManifestSha256: string;
  independentLedgerSha256: string;
  restoredDatabaseStateFingerprint: string;
  activeDocumentHashInventory: RecoveryCheck;
  quarantineHashInventory: RecoveryCheck;
  legalHoldReconciliation: RecoveryCheck;
  deletionIntentReconciliation: RecoveryCheck;
  erasureTombstoneReconciliation: RecoveryCheck;
  tenantIsolationChecks: RecoveryCheck;
  confirmedActivityDataConsistency: RecoveryCheck;
  emissionsFactorProvenance: RecoveryCheck;
  reportConsistency: RecoveryCheck;
  migrationManifestSha256: string;
  applicationRevision: string;
  outstandingMismatches: RecoveryMismatch[];
  operatorPrincipalId: string;
  evidenceCreatedAt: string;
};

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9:._/-]{8,200}$/;

export function recoveryEvidenceDigest(evidence: RecoveryEvidence) {
  assertRecoveryEvidence(evidence);
  return sha256(canonicalJson(evidence));
}

export function assertRecoveryEvidence(evidence: RecoveryEvidence) {
  if (evidence.schemaVersion !== 1 ||
      !/^recovery_[A-Za-z0-9_-]{8,120}$/.test(evidence.recoverySessionId) ||
      !OPAQUE.test(evidence.recoveryPairId) ||
      !OPAQUE.test(evidence.operatorPrincipalId) ||
      !OPAQUE.test(evidence.applicationRevision) ||
      !canonicalDate(evidence.evidenceCreatedAt)) {
    throw new Error('INVALID_RECOVERY_EVIDENCE');
  }
  for (const digest of [
    evidence.databaseDumpSha256,
    evidence.storageArchiveSha256,
    evidence.pairManifestSha256,
    evidence.independentLedgerSha256,
    evidence.restoredDatabaseStateFingerprint,
    evidence.migrationManifestSha256,
  ]) {
    if (!SHA256.test(digest)) throw new Error('INVALID_RECOVERY_EVIDENCE');
  }
  for (const check of recoveryChecks(evidence)) {
    if (typeof check.ok !== 'boolean' || !Number.isSafeInteger(check.count) ||
        check.count < 0 || !SHA256.test(check.digest)) {
      throw new Error('INVALID_RECOVERY_EVIDENCE');
    }
  }
  if (!Array.isArray(evidence.outstandingMismatches) ||
      evidence.outstandingMismatches.some((mismatch) =>
        !/^[A-Z0-9_]{3,100}$/.test(mismatch.code) ||
        !['P0', 'P1', 'P2'].includes(mismatch.severity))) {
    throw new Error('INVALID_RECOVERY_EVIDENCE');
  }
  if (canonicalJson(evidence).match(/password|secret|sourceContent|rawExtracted/i)) {
    throw new Error('SENSITIVE_RECOVERY_EVIDENCE_FIELD');
  }
}

export function assertEvidenceReleaseEligible(evidence: RecoveryEvidence) {
  assertRecoveryEvidence(evidence);
  if (evidence.outstandingMismatches.some(({ severity }) => severity === 'P0') ||
      recoveryChecks(evidence).some(({ ok }) => !ok)) {
    throw new Error('RECOVERY_RECONCILIATION_INCOMPLETE');
  }
}

export function unresolvedP0Count(evidence: RecoveryEvidence) {
  return evidence.outstandingMismatches.filter(({ severity }) => severity === 'P0').length;
}

function recoveryChecks(evidence: RecoveryEvidence) {
  return [
    evidence.activeDocumentHashInventory,
    evidence.quarantineHashInventory,
    evidence.legalHoldReconciliation,
    evidence.deletionIntentReconciliation,
    evidence.erasureTombstoneReconciliation,
    evidence.tenantIsolationChecks,
    evidence.confirmedActivityDataConsistency,
    evidence.emissionsFactorProvenance,
    evidence.reportConsistency,
  ];
}

function canonicalDate(value: string) {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
