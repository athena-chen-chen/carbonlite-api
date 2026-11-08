import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export const RECOVERY_CONTROL_SCHEMA_VERSION = 1;
export const RECOVERY_CONTROL_RELEASE_SCHEMA_VERSION = 2;
export const DEFAULT_LOCAL_RECOVERY_CONTROL_PATH =
  '/tmp/carbonlite-recovery-control/active-session.json';

export const A21_RECOVERY_STATES = [
  'RECOVERY_LOCKED',
  'RECONCILIATION_PENDING',
  'APPROVAL_PENDING',
] as const;

export type A21RecoveryState = (typeof A21_RECOVERY_STATES)[number];

export type RecoveryControlRecord = {
  schemaVersion: 1;
  sessionId: string;
  pairId: string;
  state: A21RecoveryState;
  evidenceDigest: string;
  restoredDatabaseIdentity: string;
  restoredStorageIdentity: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
};

export const A22_RECOVERY_STATES = [
  'RECOVERY_LOCKED',
  'RECONCILING',
  'PENDING_APPROVAL',
  'APPROVED_FOR_RELEASE',
  'RELEASED',
  'REJECTED',
] as const;

export type A22RecoveryState = (typeof A22_RECOVERY_STATES)[number];

export type RecoveryTransitionAudit = {
  sequence: number;
  generation: number;
  transitionId: string;
  fromState: A22RecoveryState | 'GENESIS';
  toState: A22RecoveryState;
  actorPrincipalId: string;
  actorRole: 'AUTHORITY' | 'RECOVERY_OPERATOR' | 'RECOVERY_REVIEWER';
  occurredAt: string;
  evidenceDigest: string;
  ledgerDigest: string;
  restoredStateFingerprint: string;
  previousHash: string;
  entryHash: string;
  authoritySignature: string;
};

export type RecoveryReleaseApproval = {
  approvalId: string;
  operatorPrincipalId: string;
  reviewerPrincipalId: string;
  operatorNonce: string;
  reviewerNonce: string;
  operatorSignature: string;
  reviewerSignature: string;
  operatorAuthenticatedAt: string;
  reviewerAuthenticatedAt: string;
  approvedAt: string;
  expiresAt: string;
  usedAt?: string;
  evidenceDigest: string;
  ledgerDigest: string;
  restoredStateFingerprint: string;
};

export type RecoveryEvidenceSubmission = {
  operatorPrincipalId: string;
  operatorNonce: string;
  operatorSignature: string;
  operatorAuthenticatedAt: string;
  evidenceCreatedAt: string;
  evidenceDigest: string;
  ledgerDigest: string;
  restoredStateFingerprint: string;
};

export type RecoveryVerificationLease = {
  verifiedAt: string;
  validUntil: string;
  currentEvidenceDigest: string;
  currentLedgerDigest: string;
  currentRestoredStateFingerprint: string;
  unresolvedP0MismatchCount: number;
};

export type RecoveryControlRecordV2 = {
  schemaVersion: 2;
  sessionId: string;
  pairId: string;
  state: A22RecoveryState;
  evidenceDigest: string;
  ledgerDigest: string;
  restoredStateFingerprint: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
  submission?: RecoveryEvidenceSubmission;
  approval?: RecoveryReleaseApproval;
  verification: RecoveryVerificationLease;
  history: RecoveryTransitionAudit[];
  authority: {
    keyId: string;
    historyHead: string;
    signature: string;
  };
};

export type AnyRecoveryControlRecord = RecoveryControlRecord | RecoveryControlRecordV2;

const SESSION_ID = /^recovery_[A-Za-z0-9_-]{8,120}$/;
const PAIR_ID = /^[A-Za-z0-9_-]{8,160}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTITY = /^[A-Za-z0-9:._/-]{3,200}$/;
const MAX_CONTROL_BYTES = 32 * 1024;

export class RecoveryControlStoreError extends Error {
  constructor(
    readonly code:
      | 'MISSING_EXTERNAL_STATE'
      | 'UNREADABLE_EXTERNAL_STATE'
      | 'CORRUPT_EXTERNAL_STATE',
  ) {
    super(code);
    this.name = 'RecoveryControlStoreError';
  }
}

/**
 * A2-1 local adapter. The application is deliberately read-only: a trusted
 * external process creates and advances the record outside the restored DB and
 * document volume. This adapter is not production-grade recovery authority.
 */
export class LocalFileRecoveryControlStore {
  readonly path: string;

  constructor(path: string) {
    if (!isAbsolute(path)) {
      throw new RecoveryControlStoreError('CORRUPT_EXTERNAL_STATE');
    }
    this.path = resolve(path);
  }

  async read(): Promise<AnyRecoveryControlRecord> {
    let handle;
    try {
      handle = await open(
        this.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        throw new RecoveryControlStoreError('MISSING_EXTERNAL_STATE');
      }
      throw new RecoveryControlStoreError('UNREADABLE_EXTERNAL_STATE');
    }

    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 2 || info.size > MAX_CONTROL_BYTES) {
        throw new RecoveryControlStoreError('CORRUPT_EXTERNAL_STATE');
      }
      if ((info.mode & 0o077) !== 0) {
        throw new RecoveryControlStoreError('UNREADABLE_EXTERNAL_STATE');
      }
      const currentUserId = process.getuid?.();
      if (currentUserId !== undefined && info.uid !== currentUserId) {
        throw new RecoveryControlStoreError('UNREADABLE_EXTERNAL_STATE');
      }
      return parseRecoveryControlRecord(await handle.readFile('utf8'));
    } catch (error) {
      if (error instanceof RecoveryControlStoreError) throw error;
      throw new RecoveryControlStoreError('UNREADABLE_EXTERNAL_STATE');
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

export function parseRecoveryControlRecord(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RecoveryControlStoreError('CORRUPT_EXTERNAL_STATE');
  }
  if (!isRecord(parsed)) {
    throw new RecoveryControlStoreError('CORRUPT_EXTERNAL_STATE');
  }

  if (parsed.schemaVersion === RECOVERY_CONTROL_RELEASE_SCHEMA_VERSION) {
    return parseRecoveryControlRecordV2(parsed);
  }

  const record = parsed as Partial<RecoveryControlRecord>;
  const createdAt = parseDate(record.createdAt);
  const updatedAt = parseDate(record.updatedAt);
  if (
    record.schemaVersion !== RECOVERY_CONTROL_SCHEMA_VERSION ||
    typeof record.sessionId !== 'string' || !SESSION_ID.test(record.sessionId) ||
    typeof record.pairId !== 'string' || !PAIR_ID.test(record.pairId) ||
    !isA21RecoveryState(record.state) ||
    typeof record.evidenceDigest !== 'string' || !SHA256.test(record.evidenceDigest) ||
    typeof record.restoredDatabaseIdentity !== 'string' || !IDENTITY.test(record.restoredDatabaseIdentity) ||
    typeof record.restoredStorageIdentity !== 'string' || !IDENTITY.test(record.restoredStorageIdentity) ||
    !Number.isSafeInteger(record.generation) || Number(record.generation) < 1 ||
    !createdAt || !updatedAt || updatedAt < createdAt
  ) {
    throw new RecoveryControlStoreError('CORRUPT_EXTERNAL_STATE');
  }

  return record as RecoveryControlRecord;
}

export function parseRecoveryControlRecordV2(value: unknown): RecoveryControlRecordV2 {
  if (!isRecord(value)) corrupt();
  const record = value as Partial<RecoveryControlRecordV2>;
  const createdAt = parseDate(record.createdAt);
  const updatedAt = parseDate(record.updatedAt);
  if (
    record.schemaVersion !== RECOVERY_CONTROL_RELEASE_SCHEMA_VERSION ||
    typeof record.sessionId !== 'string' || !SESSION_ID.test(record.sessionId) ||
    typeof record.pairId !== 'string' || !PAIR_ID.test(record.pairId) ||
    !isA22RecoveryState(record.state) ||
    !digest(record.evidenceDigest) || !digest(record.ledgerDigest) ||
    !digest(record.restoredStateFingerprint) ||
    !Number.isSafeInteger(record.generation) || Number(record.generation) < 1 ||
    !createdAt || !updatedAt || updatedAt < createdAt ||
    !isRecord(record.verification) || !Array.isArray(record.history) ||
    !isRecord(record.authority)
  ) corrupt();

  const lease = record.verification as Partial<RecoveryVerificationLease>;
  if (!parseDate(lease.verifiedAt) || !parseDate(lease.validUntil) ||
      new Date(lease.validUntil!).getTime() < new Date(lease.verifiedAt!).getTime() ||
      !digest(lease.currentEvidenceDigest) || !digest(lease.currentLedgerDigest) ||
      !digest(lease.currentRestoredStateFingerprint) ||
      !Number.isSafeInteger(lease.unresolvedP0MismatchCount) ||
      Number(lease.unresolvedP0MismatchCount) < 0) corrupt();

  const authority = record.authority as RecoveryControlRecordV2['authority'];
  if (!opaqueId(authority.keyId) || !digest(authority.historyHead) ||
      typeof authority.signature !== 'string' || !base64(authority.signature)) corrupt();

  let previousHash = '0'.repeat(64);
  let previousGeneration = 0;
  for (let index = 0; index < record.history.length; index += 1) {
    const entry = record.history[index] as Partial<RecoveryTransitionAudit>;
    if (!validAuditEntry(entry, index + 1, previousGeneration, previousHash)) corrupt();
    previousHash = entry.entryHash!;
    previousGeneration = entry.generation!;
  }
  if (!record.history.length || previousHash !== authority.historyHead ||
      previousGeneration !== record.generation) corrupt();

  if (record.submission !== undefined && !validSubmission(record.submission)) corrupt();
  if (record.approval !== undefined && !validApproval(record.approval)) corrupt();
  return record as RecoveryControlRecordV2;
}

export function verifyRecoveryControlAuthority(
  record: RecoveryControlRecordV2,
  authorityPublicKeyPem: string,
) {
  try {
    const envelope = { ...record, authority: { ...record.authority, signature: '' } };
    if (!verify(null, Buffer.from(canonicalJson(envelope)), createPublicKey(authorityPublicKeyPem), Buffer.from(record.authority.signature, 'base64'))) {
      return false;
    }
    return record.history.every((entry) => {
      const unsigned = { ...entry, authoritySignature: '', entryHash: '' };
      const entryHash = sha256(canonicalJson(unsigned));
      return entryHash === entry.entryHash &&
        verify(null, Buffer.from(entry.entryHash), createPublicKey(authorityPublicKeyPem), Buffer.from(entry.authoritySignature, 'base64'));
    });
  } catch {
    return false;
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function isA21RecoveryState(value: unknown): value is A21RecoveryState {
  return typeof value === 'string' &&
    (A21_RECOVERY_STATES as readonly string[]).includes(value);
}

export function isA22RecoveryState(value: unknown): value is A22RecoveryState {
  return typeof value === 'string' &&
    (A22_RECOVERY_STATES as readonly string[]).includes(value);
}

export function isA21TransitionAllowed(
  from: A21RecoveryState,
  to: string,
) {
  const transitions: Record<A21RecoveryState, readonly A21RecoveryState[]> = {
    RECOVERY_LOCKED: ['RECONCILIATION_PENDING'],
    RECONCILIATION_PENDING: ['RECOVERY_LOCKED', 'APPROVAL_PENDING'],
    APPROVAL_PENDING: ['RECOVERY_LOCKED', 'RECONCILIATION_PENDING'],
  };
  return transitions[from].includes(to as A21RecoveryState);
}

function parseDate(value: unknown) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value
    ? null
    : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasCode(error: unknown, code: string) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function validAuditEntry(
  entry: Partial<RecoveryTransitionAudit>,
  expectedSequence: number,
  previousGeneration: number,
  previousHash: string,
) {
  return entry.sequence === expectedSequence && entry.generation === previousGeneration + 1 &&
    opaqueId(entry.transitionId) &&
    (entry.fromState === 'GENESIS' || isA22RecoveryState(entry.fromState)) &&
    isA22RecoveryState(entry.toState) && opaqueId(entry.actorPrincipalId) &&
    ['AUTHORITY', 'RECOVERY_OPERATOR', 'RECOVERY_REVIEWER'].includes(String(entry.actorRole)) &&
    Boolean(parseDate(entry.occurredAt)) && digest(entry.evidenceDigest) &&
    digest(entry.ledgerDigest) && digest(entry.restoredStateFingerprint) &&
    entry.previousHash === previousHash && digest(entry.entryHash) &&
    typeof entry.authoritySignature === 'string' && base64(entry.authoritySignature);
}

function validApproval(value: unknown) {
  if (!isRecord(value)) return false;
  const approval = value as Partial<RecoveryReleaseApproval>;
  return opaqueId(approval.approvalId) && opaqueId(approval.operatorPrincipalId) &&
    opaqueId(approval.reviewerPrincipalId) &&
    approval.operatorPrincipalId !== approval.reviewerPrincipalId &&
    Boolean(parseDate(approval.operatorAuthenticatedAt)) &&
    Boolean(parseDate(approval.reviewerAuthenticatedAt)) &&
    opaqueId(approval.operatorNonce) && opaqueId(approval.reviewerNonce) &&
    typeof approval.operatorSignature === 'string' && base64(approval.operatorSignature) &&
    typeof approval.reviewerSignature === 'string' && base64(approval.reviewerSignature) &&
    Boolean(parseDate(approval.approvedAt)) && Boolean(parseDate(approval.expiresAt)) &&
    (approval.usedAt === undefined || Boolean(parseDate(approval.usedAt))) && digest(approval.evidenceDigest) &&
    digest(approval.ledgerDigest) && digest(approval.restoredStateFingerprint);
}

function validSubmission(value: unknown) {
  if (!isRecord(value)) return false;
  const submission = value as Partial<RecoveryEvidenceSubmission>;
  return opaqueId(submission.operatorPrincipalId) && opaqueId(submission.operatorNonce) &&
    typeof submission.operatorSignature === 'string' && base64(submission.operatorSignature) &&
    Boolean(parseDate(submission.operatorAuthenticatedAt)) &&
    Boolean(parseDate(submission.evidenceCreatedAt)) && digest(submission.evidenceDigest) &&
    digest(submission.ledgerDigest) && digest(submission.restoredStateFingerprint);
}

function opaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:._/-]{8,200}$/.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function base64(value: string) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 40;
}

function corrupt(): never {
  throw new RecoveryControlStoreError('CORRUPT_EXTERNAL_STATE');
}
