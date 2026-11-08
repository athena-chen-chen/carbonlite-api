import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import {
  A22RecoveryState,
  LocalFileRecoveryControlStore,
  RecoveryControlRecordV2,
  RecoveryEvidenceSubmission,
  RecoveryReleaseApproval,
  RecoveryTransitionAudit,
  canonicalJson,
  sha256,
} from '../../src/common/security/recovery-control-store';
import {
  RecoveryEvidence,
  assertEvidenceReleaseEligible,
  recoveryEvidenceDigest,
  unresolvedP0Count,
} from '../../src/common/security/recovery-evidence';

const DISPOSABLE_ROOT = resolve('/tmp/carbonlite-recovery-control');

export type RecoveryPrincipal = {
  principalId: string;
  role: 'RECOVERY_OPERATOR' | 'RECOVERY_REVIEWER';
  publicKeyPem: string;
};

export type SignedRecoveryCommand = {
  action: 'SUBMIT_EVIDENCE' | 'APPROVE_RELEASE' | 'REJECT_RELEASE';
  principalId: string;
  sessionId: string;
  pairId: string;
  expectedGeneration: number;
  evidenceDigest: string;
  ledgerDigest: string;
  restoredStateFingerprint: string;
  nonce: string;
  authenticatedAt: string;
  expiresAt: string;
  signature: string;
};

type UnsignedRecoveryCommand = Omit<SignedRecoveryCommand, 'signature'>;

export class LocalRecoveryAuthority {
  private readonly authorityPrivateKey: KeyObject;
  private readonly principals: Map<string, RecoveryPrincipal>;

  constructor(
    readonly controlPath: string,
    private readonly authorityKeyId: string,
    authorityPrivateKeyPem: string,
    principals: RecoveryPrincipal[],
  ) {
    assertDisposablePath(controlPath);
    this.authorityPrivateKey = createPrivateKey(authorityPrivateKeyPem);
    this.principals = new Map(principals.map((principal) => [principal.principalId, principal]));
    if (this.principals.size !== principals.length) throw new Error('DUPLICATE_RECOVERY_PRINCIPAL');
  }

  async initialize(input: {
    sessionId: string;
    pairId: string;
    evidenceDigest: string;
    ledgerDigest: string;
    restoredStateFingerprint: string;
    now?: Date;
  }) {
    const now = (input.now ?? new Date()).toISOString();
    const base = {
      schemaVersion: 2 as const,
      sessionId: input.sessionId,
      pairId: input.pairId,
      state: 'RECOVERY_LOCKED' as const,
      evidenceDigest: input.evidenceDigest,
      ledgerDigest: input.ledgerDigest,
      restoredStateFingerprint: input.restoredStateFingerprint,
      generation: 1,
      createdAt: now,
      updatedAt: now,
      verification: lease(input, 1, input.now),
      history: [] as RecoveryTransitionAudit[],
      authority: { keyId: this.authorityKeyId, historyHead: '0'.repeat(64), signature: '' },
    };
    const record = this.appendTransition(base, {
      fromState: 'GENESIS', toState: 'RECOVERY_LOCKED', actorPrincipalId: this.authorityKeyId,
      actorRole: 'AUTHORITY', occurredAt: now,
    });
    await this.createExclusive(this.signEnvelope(record));
    return record;
  }

  async beginReconciliation(expectedGeneration: number, now = new Date()) {
    return this.update(expectedGeneration, (current) => this.transition(current, 'RECONCILING', {
      actorPrincipalId: this.authorityKeyId, actorRole: 'AUTHORITY', occurredAt: now.toISOString(),
    }));
  }

  async submitEvidence(evidence: RecoveryEvidence, command: SignedRecoveryCommand) {
    assertEvidenceReleaseEligible(evidence);
    const digest = recoveryEvidenceDigest(evidence);
    return this.update(command.expectedGeneration, (current) => {
      this.authenticate(command, 'RECOVERY_OPERATOR', current, 'SUBMIT_EVIDENCE');
      if (current.state !== 'RECONCILING') throw new Error('INVALID_RECOVERY_TRANSITION');
      if (digest !== command.evidenceDigest || digest !== current.evidenceDigest ||
          evidence.independentLedgerSha256 !== command.ledgerDigest ||
          evidence.restoredDatabaseStateFingerprint !== command.restoredStateFingerprint ||
          evidence.recoverySessionId !== current.sessionId || evidence.recoveryPairId !== current.pairId ||
          evidence.operatorPrincipalId !== command.principalId) {
        throw new Error('RECOVERY_EVIDENCE_BINDING_MISMATCH');
      }
      const submission: RecoveryEvidenceSubmission = {
        operatorPrincipalId: command.principalId,
        operatorNonce: command.nonce,
        operatorSignature: command.signature,
        operatorAuthenticatedAt: command.authenticatedAt,
        evidenceCreatedAt: evidence.evidenceCreatedAt,
        evidenceDigest: command.evidenceDigest,
        ledgerDigest: command.ledgerDigest,
        restoredStateFingerprint: command.restoredStateFingerprint,
      };
      return this.transition({ ...current, submission }, 'PENDING_APPROVAL', {
        actorPrincipalId: command.principalId, actorRole: 'RECOVERY_OPERATOR',
        occurredAt: command.authenticatedAt,
      });
    });
  }

  async review(command: SignedRecoveryCommand, approvalLifetimeMs = 15 * 60_000) {
    return this.update(command.expectedGeneration, (current) => {
      this.authenticate(command, 'RECOVERY_REVIEWER', current, command.action);
      if (current.state !== 'PENDING_APPROVAL' || !current.submission) {
        throw new Error('INVALID_RECOVERY_TRANSITION');
      }
      if (current.submission.operatorPrincipalId === command.principalId) {
        throw new Error('INDEPENDENT_REVIEW_REQUIRED');
      }
      if (current.submission.evidenceDigest !== command.evidenceDigest ||
          current.submission.ledgerDigest !== command.ledgerDigest ||
          current.submission.restoredStateFingerprint !== command.restoredStateFingerprint) {
        throw new Error('RECOVERY_EVIDENCE_BINDING_MISMATCH');
      }
      if (command.action === 'REJECT_RELEASE') {
        return this.transition(current, 'REJECTED', {
          actorPrincipalId: command.principalId, actorRole: 'RECOVERY_REVIEWER',
          occurredAt: command.authenticatedAt,
        });
      }
      const approvedAt = command.authenticatedAt;
      const approval: RecoveryReleaseApproval = {
        approvalId: `approval_${randomUUID()}`,
        operatorPrincipalId: current.submission.operatorPrincipalId,
        reviewerPrincipalId: command.principalId,
        operatorNonce: current.submission.operatorNonce,
        reviewerNonce: command.nonce,
        operatorSignature: current.submission.operatorSignature,
        reviewerSignature: command.signature,
        operatorAuthenticatedAt: current.submission.operatorAuthenticatedAt,
        reviewerAuthenticatedAt: command.authenticatedAt,
        approvedAt,
        expiresAt: new Date(new Date(approvedAt).getTime() + approvalLifetimeMs).toISOString(),
        evidenceDigest: command.evidenceDigest,
        ledgerDigest: command.ledgerDigest,
        restoredStateFingerprint: command.restoredStateFingerprint,
      };
      return this.transition({ ...current, approval }, 'APPROVED_FOR_RELEASE', {
        actorPrincipalId: command.principalId, actorRole: 'RECOVERY_REVIEWER', occurredAt: approvedAt,
      });
    });
  }

  async release(expectedGeneration: number, now = new Date(), verificationLifetimeMs = 5 * 60_000) {
    return this.update(expectedGeneration, (current) => {
      if (current.state !== 'APPROVED_FOR_RELEASE' || !current.approval || current.approval.usedAt) {
        throw new Error('RELEASE_APPROVAL_UNAVAILABLE');
      }
      if (new Date(current.approval.expiresAt).getTime() <= now.getTime()) {
        throw new Error('RELEASE_APPROVAL_EXPIRED');
      }
      const approval = { ...current.approval, usedAt: now.toISOString() };
      const verification = lease(current, 0, now, verificationLifetimeMs);
      return this.transition({ ...current, approval, verification }, 'RELEASED', {
        actorPrincipalId: this.authorityKeyId, actorRole: 'AUTHORITY', occurredAt: now.toISOString(),
      });
    });
  }

  async verifyCurrentState(expectedGeneration: number, current: {
    evidenceDigest: string;
    ledgerDigest: string;
    restoredStateFingerprint: string;
    unresolvedP0MismatchCount: number;
  }, now = new Date(), verificationLifetimeMs = 5 * 60_000) {
    return this.update(expectedGeneration, (record) => {
      const matches = current.unresolvedP0MismatchCount === 0 &&
        current.evidenceDigest === record.evidenceDigest &&
        current.ledgerDigest === record.ledgerDigest &&
        current.restoredStateFingerprint === record.restoredStateFingerprint;
      const nextState: A22RecoveryState = matches ? record.state : 'RECOVERY_LOCKED';
      const verification = lease(current, current.unresolvedP0MismatchCount, now, verificationLifetimeMs);
      return this.transition({ ...record, verification }, nextState, {
        actorPrincipalId: this.authorityKeyId, actorRole: 'AUTHORITY', occurredAt: now.toISOString(),
      });
    });
  }

  private authenticate(
    command: SignedRecoveryCommand,
    requiredRole: RecoveryPrincipal['role'],
    current: RecoveryControlRecordV2,
    action: SignedRecoveryCommand['action'],
  ) {
    const principal = this.principals.get(command.principalId);
    if (!principal || principal.role !== requiredRole || command.action !== action) {
      throw new Error('UNAUTHORIZED_RECOVERY_PRINCIPAL');
    }
    if (command.sessionId !== current.sessionId || command.pairId !== current.pairId ||
        command.expectedGeneration !== current.generation ||
        command.evidenceDigest !== current.evidenceDigest ||
        command.ledgerDigest !== current.ledgerDigest ||
        command.restoredStateFingerprint !== current.restoredStateFingerprint ||
        current.history.some(({ transitionId }) => transitionId === command.nonce)) {
      throw new Error('RECOVERY_COMMAND_BINDING_MISMATCH');
    }
    const authenticatedAt = new Date(command.authenticatedAt);
    const expiresAt = new Date(command.expiresAt);
    const now = Date.now();
    if (Number.isNaN(authenticatedAt.getTime()) || Number.isNaN(expiresAt.getTime()) ||
        authenticatedAt.toISOString() !== command.authenticatedAt ||
        expiresAt.toISOString() !== command.expiresAt || expiresAt.getTime() <= now ||
        authenticatedAt.getTime() > now + 30_000) {
      throw new Error('EXPIRED_RECOVERY_COMMAND');
    }
    const unsigned = { ...command, signature: '' };
    if (!verify(null, Buffer.from(canonicalJson(unsigned)), createPublicKey(principal.publicKeyPem), Buffer.from(command.signature, 'base64'))) {
      throw new Error('RECOVERY_PRINCIPAL_AUTHENTICATION_FAILED');
    }
  }

  private transition(
    current: RecoveryControlRecordV2,
    toState: A22RecoveryState,
    actor: Pick<RecoveryTransitionAudit, 'actorPrincipalId' | 'actorRole' | 'occurredAt'>,
  ) {
    return this.appendTransition({ ...current, state: toState }, {
      fromState: current.state, toState, ...actor,
    });
  }

  private appendTransition(
    current: Omit<RecoveryControlRecordV2, 'history'> & { history: RecoveryTransitionAudit[] },
    transition: Pick<RecoveryTransitionAudit, 'fromState' | 'toState' | 'actorPrincipalId' | 'actorRole' | 'occurredAt'>,
  ): RecoveryControlRecordV2 {
    const generation = current.history.length ? current.generation + 1 : current.generation;
    const previousHash = current.history.at(-1)?.entryHash ?? '0'.repeat(64);
    const transitionId = transition.actorRole === 'AUTHORITY'
      ? `transition_${randomUUID()}`
      : this.commandNonceFromActor(current, transition.actorPrincipalId) ?? `transition_${randomUUID()}`;
    const unsigned = {
      sequence: current.history.length + 1, generation, transitionId,
      ...transition,
      evidenceDigest: current.evidenceDigest, ledgerDigest: current.ledgerDigest,
      restoredStateFingerprint: current.restoredStateFingerprint,
      previousHash, entryHash: '', authoritySignature: '',
    };
    const entryHash = sha256(canonicalJson(unsigned));
    const entry: RecoveryTransitionAudit = {
      ...unsigned, entryHash,
      authoritySignature: sign(null, Buffer.from(entryHash), this.authorityPrivateKey).toString('base64'),
    };
    return {
      ...current,
      state: transition.toState,
      generation,
      updatedAt: transition.occurredAt,
      history: [...current.history, entry],
      authority: { ...current.authority, historyHead: entryHash, signature: '' },
    };
  }

  private commandNonceFromActor(record: RecoveryControlRecordV2, principalId: string) {
    if (record.submission?.operatorPrincipalId === principalId) return record.submission.operatorNonce;
    if (record.approval?.reviewerPrincipalId === principalId) return record.approval.reviewerNonce;
    return null;
  }

  private signEnvelope(record: RecoveryControlRecordV2) {
    const unsigned = { ...record, authority: { ...record.authority, signature: '' } };
    return {
      ...record,
      authority: {
        ...record.authority,
        signature: sign(null, Buffer.from(canonicalJson(unsigned)), this.authorityPrivateKey).toString('base64'),
      },
    };
  }

  private async update(
    expectedGeneration: number,
    mutate: (current: RecoveryControlRecordV2) => RecoveryControlRecordV2,
  ) {
    return this.withLock(async () => {
      const current = await new LocalFileRecoveryControlStore(this.controlPath).read();
      if (current.schemaVersion !== 2 || current.generation !== expectedGeneration) {
        throw new Error('RECOVERY_AUTHORITY_COMPARE_AND_SWAP_FAILED');
      }
      const next = this.signEnvelope(mutate(current));
      await atomicReplace(this.controlPath, next);
      return next;
    });
  }

  private async createExclusive(record: RecoveryControlRecordV2) {
    await mkdir(dirname(this.controlPath), { recursive: true, mode: 0o700 });
    const handle = await open(this.controlPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async withLock<T>(operation: () => Promise<T>) {
    const lockPath = `${this.controlPath}.lock`;
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      .catch(() => { throw new Error('RECOVERY_AUTHORITY_CONCURRENT_UPDATE'); });
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

export function signRecoveryCommand(
  command: UnsignedRecoveryCommand,
  principalPrivateKeyPem: string,
): SignedRecoveryCommand {
  const unsigned = { ...command, signature: '' };
  return {
    ...command,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), createPrivateKey(principalPrivateKeyPem)).toString('base64'),
  };
}

export function authorityPublicKeyPem(authorityPrivateKeyPem: string) {
  return createPublicKey(createPrivateKey(authorityPrivateKeyPem))
    .export({ type: 'spki', format: 'pem' }).toString();
}

function lease(
  input: { evidenceDigest: string; ledgerDigest: string; restoredStateFingerprint: string },
  unresolvedP0MismatchCount: number,
  now = new Date(),
  lifetimeMs = 1,
) {
  return {
    verifiedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + lifetimeMs).toISOString(),
    currentEvidenceDigest: input.evidenceDigest,
    currentLedgerDigest: input.ledgerDigest,
    currentRestoredStateFingerprint: input.restoredStateFingerprint,
    unresolvedP0MismatchCount,
  };
}

async function atomicReplace(path: string, value: RecoveryControlRecordV2) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

function assertDisposablePath(path: string) {
  if (!isAbsolute(path)) throw new Error('RECOVERY_CONTROL_PATH_MUST_BE_ABSOLUTE');
  const within = relative(DISPOSABLE_ROOT, resolve(path));
  if (!within || within.startsWith('..') || isAbsolute(within)) {
    throw new Error('RECOVERY_CONTROL_PATH_OUTSIDE_DISPOSABLE_ROOT');
  }
}
