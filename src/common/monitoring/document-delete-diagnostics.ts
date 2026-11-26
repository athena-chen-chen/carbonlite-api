import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const DELETE_RECONCILIATION_CODE = 'DOCUMENT_DELETE_RECONCILIATION_REQUIRED';
export const DELETE_DIAGNOSTIC_LIMIT = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASONS = ['EXISTING_RECONCILIATION_REQUIRED', 'DOCUMENT_ROW_MISSING',
  'ACTIVE_AND_QUARANTINE_MISSING', 'QUARANTINE_IDENTITY_MISMATCH',
  'DATABASE_FAILURE', 'STORAGE_FAILURE', 'AUTHORIZATION_DENIED', 'LEGAL_HOLD_DENIED',
  'NOT_FOUND', 'UNKNOWN_FAILURE'] as const;
export type DeleteFailureReason = typeof REASONS[number];
export type DeleteObservation = {
  reason: DeleteFailureReason;
  intentStatus: 'PREPARED' | 'PENDING_PURGE' | 'PURGED' | 'RECONCILIATION_REQUIRED' | null;
  reconciliationCode: 'DOCUMENT_ROW_MISSING' | 'ACTIVE_AND_QUARANTINE_MISSING' | null;
  phase: 'NOT_OBSERVED' | 'QUARANTINE_PRECHECK' | 'AFTER_QUARANTINE';
  activeExists: boolean | null;
  quarantineExists: boolean | null;
  quarantineIdentityMatches: boolean | null;
};
// Never serialize this scope into ordinary logs or HTTP responses.
export type DeleteAuditScope = { organizationId: string; documentId: string; intentId: string };
type Detail = { observation: DeleteObservation; scope?: DeleteAuditScope; correlationLinkAvailable: boolean };
const details = new WeakMap<object, Detail>();
export type CorrelatedRequest = Request & { requestId?: string };

export function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Server-generated only: client headers are deliberately ignored. */
export function requestCorrelation(req: CorrelatedRequest, res: Response, next: NextFunction) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
}

export function emptyDeleteObservation(reason: DeleteFailureReason = 'UNKNOWN_FAILURE'): DeleteObservation {
  return { reason, intentStatus: null, reconciliationCode: null, phase: 'NOT_OBSERVED', activeExists: null,
    quarantineExists: null, quarantineIdentityMatches: null };
}

export function attachDeleteFailure(error: unknown, observation: DeleteObservation, scope?: DeleteAuditScope) {
  if (error && typeof error === 'object') {
    details.set(error, { observation: { ...observation }, scope, correlationLinkAvailable: false });
  }
}

export function deleteAuditScope(error: unknown) {
  return error && typeof error === 'object' ? details.get(error)?.scope : undefined;
}

export function markDeleteCorrelation(error: unknown, available: boolean) {
  if (error && typeof error === 'object') {
    const detail = details.get(error);
    if (detail) detail.correlationLinkAvailable = available;
  }
}

export function copyDeleteFailure(from: unknown, to: unknown) {
  if (from && typeof from === 'object' && to && typeof to === 'object') {
    const detail = details.get(from);
    if (detail) details.set(to, detail);
  }
}

export class DocumentDeleteReconciliationError extends ServiceUnavailableException {
  constructor(observation: DeleteObservation, scope: DeleteAuditScope, requestId?: string) {
    super({ statusCode: 503, code: DELETE_RECONCILIATION_CODE,
      message: 'Document deletion requires storage reconciliation; no permanent purge was attempted.',
      ...(validRequestId(requestId) ? { requestId } : {}) });
    attachDeleteFailure(this, observation, scope);
  }
}

/** Explicit projection; no exception text, identifiers, paths or arbitrary properties. */
export function deleteDiagnostic(error: unknown, requestId: string, status: number) {
  if (!validRequestId(requestId) || !Number.isInteger(status) || status < 400 || status > 599) {
    throw new Error('Invalid diagnostic metadata');
  }
  const detail = error && typeof error === 'object' ? details.get(error) : undefined;
  const held = status === 409 && error instanceof HttpException &&
    (error.getResponse() as { code?: unknown })?.code === 'LEGAL_HOLD_ACTIVE';
  const denied = [401, 403, 404, 409].includes(status);
  const fallback = status === 401 || status === 403 ? 'AUTHORIZATION_DENIED'
    : status === 404 ? 'NOT_FOUND' : held ? 'LEGAL_HOLD_DENIED' : 'UNKNOWN_FAILURE';
  const observation = detail?.observation ?? emptyDeleteObservation(fallback);
  if (!REASONS.includes(observation.reason) ||
      ![null, 'PREPARED', 'PENDING_PURGE', 'PURGED', 'RECONCILIATION_REQUIRED'].includes(observation.intentStatus) ||
      ![null, 'DOCUMENT_ROW_MISSING', 'ACTIVE_AND_QUARANTINE_MISSING'].includes(observation.reconciliationCode) ||
      !['NOT_OBSERVED', 'QUARANTINE_PRECHECK', 'AFTER_QUARANTINE'].includes(observation.phase) ||
      [observation.activeExists, observation.quarantineExists, observation.quarantineIdentityMatches]
        .some(value => value !== null && typeof value !== 'boolean')) throw new Error('Invalid diagnostic metadata');
  // Guard denials must not disclose any previously attached storage observations.
  const safe = denied ? emptyDeleteObservation(fallback) : observation;
  return { schema: 1, operation: 'DOCUMENT_DELETE', requestId, status,
    reason: safe.reason, intentStatus: safe.intentStatus, reconciliationCode: safe.reconciliationCode, phase: safe.phase,
    activeExists: safe.activeExists, quarantineExists: safe.quarantineExists,
    quarantineIdentityMatches: safe.quarantineIdentityMatches,
    evidenceAvailable: safe.phase !== 'NOT_OBSERVED',
    correlationLinkAvailable: !denied && Boolean(detail?.correlationLinkAvailable) };
}

export function writeDeleteDiagnostic(logger: { error(message: string): unknown }, error: unknown,
  requestId: string, status: number) {
  try {
    const text = JSON.stringify(deleteDiagnostic(error, requestId, status));
    if (Buffer.byteLength(text) > DELETE_DIAGNOSTIC_LIMIT) throw new Error('Diagnostic over budget');
    logger.error(text);
  } catch {
    try { logger.error('{"schema":1,"operation":"DOCUMENT_DELETE","diagnostic":"UNAVAILABLE"}'); }
    catch { /* Observability must never mask the original response. */ }
  }
}
