import { NextFunction, Request, Response } from 'express';
import {
  DEFAULT_LOCAL_RECOVERY_CONTROL_PATH,
  AnyRecoveryControlRecord,
  LocalFileRecoveryControlStore,
  RecoveryControlRecordV2,
  RecoveryControlStoreError,
  verifyRecoveryControlAuthority,
} from './recovery-control-store';

export const RESTORE_ACCESS_BLOCK_CODE = 'RESTORE_RECONCILIATION_REQUIRED';

export type RecoveryAccessDecision = {
  mode: 'NORMAL' | 'RECOVERY';
  blocked: boolean;
  reason: string;
  session?: AnyRecoveryControlRecord;
};

type RecoveryAccessPolicyOptions = {
  defaultControlPath?: string;
};

/**
 * A2-1 never releases recovery access. Environment variables bind the process
 * to external state but cannot override it or turn a recovery record into an
 * authorization decision.
 */
export class RecoveryAccessPolicy {
  private readonly defaultControlPath: string;

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    options: RecoveryAccessPolicyOptions = {},
  ) {
    this.defaultControlPath = options.defaultControlPath ??
      DEFAULT_LOCAL_RECOVERY_CONTROL_PATH;
  }

  async evaluate(): Promise<RecoveryAccessDecision> {
    const configuredPath = clean(this.environment.RECOVERY_CONTROL_STORE_PATH);
    const controlPath = configuredPath || this.defaultControlPath;
    const recoveryRequested = this.environment.RECOVERY_RESTORE_MODE === 'true' ||
      Boolean(
        configuredPath ||
        clean(this.environment.RECOVERY_SESSION_ID) ||
        clean(this.environment.RECOVERY_PAIR_ID) ||
        clean(this.environment.RECOVERY_EVIDENCE_DIGEST),
      );

    let session: AnyRecoveryControlRecord;
    try {
      session = await new LocalFileRecoveryControlStore(controlPath).read();
    } catch (error) {
      if (
        error instanceof RecoveryControlStoreError &&
        error.code === 'MISSING_EXTERNAL_STATE' &&
        !recoveryRequested
      ) {
        return { mode: 'NORMAL', blocked: false, reason: 'NORMAL_STARTUP' };
      }
      return {
        mode: 'RECOVERY',
        blocked: true,
        reason: error instanceof RecoveryControlStoreError
          ? error.code
          : 'UNREADABLE_EXTERNAL_STATE',
      };
    }

    if (!this.matchesBinding(session)) {
      return {
        mode: 'RECOVERY',
        blocked: true,
        reason: 'RECOVERY_SESSION_BINDING_MISMATCH',
        session,
      };
    }

    if (session.schemaVersion === 1 || session.state !== 'RELEASED') {
      return {
        mode: 'RECOVERY',
        blocked: true,
        reason: session.state,
        session,
      };
    }

    const releaseFailure = this.releaseFailure(session);
    if (releaseFailure) {
      return {
        mode: 'RECOVERY',
        blocked: true,
        reason: releaseFailure,
        session,
      };
    }

    return {
      mode: 'RECOVERY',
      blocked: false,
      reason: 'VALID_EXTERNAL_RELEASE_AUTHORIZATION',
      session,
    };
  }

  async assertBackgroundMutationAllowed() {
    const decision = await this.evaluate();
    if (decision.blocked) throw new RecoveryAccessBlockedError();
  }

  private matchesBinding(session: AnyRecoveryControlRecord) {
    const expectedSessionId = clean(this.environment.RECOVERY_SESSION_ID);
    const expectedPairId = clean(this.environment.RECOVERY_PAIR_ID);
    const expectedEvidenceDigest = clean(this.environment.RECOVERY_EVIDENCE_DIGEST);

    // A discovered external record remains authoritative even if restore mode
    // is changed to false. Supplied bindings, when present, must all match.
    return (!expectedSessionId || expectedSessionId === session.sessionId) &&
      (!expectedPairId || expectedPairId === session.pairId) &&
      (!expectedEvidenceDigest || expectedEvidenceDigest === session.evidenceDigest);
  }

  private releaseFailure(session: RecoveryControlRecordV2) {
    const publicKey = clean(this.environment.RECOVERY_AUTHORITY_PUBLIC_KEY);
    const expectedKeyId = clean(this.environment.RECOVERY_AUTHORITY_KEY_ID);
    const minimumGeneration = Number(this.environment.RECOVERY_MIN_GENERATION ?? '0');
    if (!publicKey || (expectedKeyId && expectedKeyId !== session.authority.keyId)) {
      return 'UNTRUSTED_RELEASE_AUTHORITY';
    }
    if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 1 ||
        session.generation < minimumGeneration) {
      return 'AUTHORITY_GENERATION_ROLLBACK';
    }
    if (!verifyRecoveryControlAuthority(session, publicKey)) {
      return 'INVALID_RELEASE_AUTHORIZATION';
    }
    const approval = session.approval;
    const lease = session.verification;
    const now = Date.now();
    if (!approval || !approval.usedAt ||
        approval.operatorPrincipalId === approval.reviewerPrincipalId ||
        approval.evidenceDigest !== session.evidenceDigest ||
        approval.ledgerDigest !== session.ledgerDigest ||
        approval.restoredStateFingerprint !== session.restoredStateFingerprint ||
        lease.currentEvidenceDigest !== session.evidenceDigest ||
        lease.currentLedgerDigest !== session.ledgerDigest ||
        lease.currentRestoredStateFingerprint !== session.restoredStateFingerprint ||
        lease.unresolvedP0MismatchCount !== 0) {
      return 'RELEASE_BINDING_MISMATCH';
    }
    if (new Date(approval.expiresAt).getTime() <= now ||
        new Date(lease.validUntil).getTime() <= now) {
      return 'RELEASE_AUTHORIZATION_EXPIRED';
    }
    const last = session.history.at(-1);
    if (!last || last.toState !== 'RELEASED' || last.generation !== session.generation) {
      return 'INVALID_RELEASE_TRANSITION';
    }
    return null;
  }
}

export class RecoveryAccessBlockedError extends Error {
  constructor() {
    super(RESTORE_ACCESS_BLOCK_CODE);
    this.name = 'RecoveryAccessBlockedError';
  }
}

export function restoreAccessGate(
  policy = new RecoveryAccessPolicy(process.env),
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let decision: RecoveryAccessDecision;
    try {
      decision = await policy.evaluate();
    } catch {
      decision = {
        mode: 'RECOVERY',
        blocked: true,
        reason: 'RECOVERY_POLICY_ERROR',
      };
    }

    if (!decision.blocked || isRecoveryAllowlisted(req.method, req.path)) {
      next();
      return;
    }

    res.status(503).json({
      statusCode: 503,
      code: RESTORE_ACCESS_BLOCK_CODE,
      message: 'Restored data is unavailable pending recovery reconciliation.',
    });
  };
}

export function isRecoveryAllowlisted(method: string, path: string) {
  const normalizedMethod = method.toUpperCase();
  if (
    (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') &&
    (path === '/health' || path === '/health/live' ||
      path === '/api/health' || path === '/api/health/live')
  ) {
    return true;
  }
  return normalizedMethod === 'POST' &&
    path === '/api/admin/storage-reconciliation/report';
}

function clean(value: string | undefined) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}
