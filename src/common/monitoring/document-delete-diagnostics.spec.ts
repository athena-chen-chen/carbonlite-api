import { ArgumentsHost, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from '../filters/global-exception.filter';
import { attachDeleteFailure, deleteDiagnostic, DocumentDeleteReconciliationError,
  emptyDeleteObservation, requestCorrelation, validRequestId, writeDeleteDiagnostic } from './document-delete-diagnostics';

const reference = '72676144-1328-4cd1-95f4-d677e7d55139';
const scope = { organizationId: 'tenant-canary', documentId: 'document-canary', intentId: 'intent-canary' };
afterEach(() => jest.restoreAllMocks());

it('generates fresh trusted UUIDs and ignores even valid spoofed client references', () => {
  const req: any = { headers: { 'x-request-id': reference }, requestId: reference };
  const header = jest.fn(); const next = jest.fn();
  requestCorrelation(req, { setHeader: header } as any, next);
  expect(validRequestId(req.requestId)).toBe(true); expect(req.requestId).not.toBe(reference);
  expect(header).toHaveBeenCalledWith('X-Request-ID', req.requestId); expect(next).toHaveBeenCalledTimes(1);
  const first = req.requestId;
  requestCorrelation(req, { setHeader: header } as any, next); expect(req.requestId).not.toBe(first);
});

it('preserves unknown observations as null and projects no protected identifiers', () => {
  const error = new DocumentDeleteReconciliationError(emptyDeleteObservation('EXISTING_RECONCILIATION_REQUIRED'), scope);
  const record = deleteDiagnostic(error, reference, 503);
  expect(record).toMatchObject({ activeExists: null, quarantineExists: null,
    quarantineIdentityMatches: null, evidenceAvailable: false });
  expect(JSON.stringify(record)).not.toContain('canary');
});

it('suppresses state details on authorization, not-found and legal-hold denial', () => {
  for (const status of [401, 403, 404, 409]) {
    const error = new Error('secret-canary');
    attachDeleteFailure(error, { ...emptyDeleteObservation(), intentStatus: 'RECONCILIATION_REQUIRED',
      activeExists: false, quarantineExists: true, phase: 'AFTER_QUARANTINE' }, scope);
    expect(deleteDiagnostic(error, reference, status)).toMatchObject({ intentStatus: null,
      activeExists: null, quarantineExists: null, evidenceAvailable: false });
  }
});

it('rejects malformed values, control characters and overlong/untrusted request identifiers', () => {
  const error = new Error('secret'); const logger = { error: jest.fn() };
  for (const value of ['short', reference + '\nsecret', 'x'.repeat(8192)]) {
    writeDeleteDiagnostic(logger, error, value, 503);
    expect(logger.error).toHaveBeenLastCalledWith('{"schema":1,"operation":"DOCUMENT_DELETE","diagnostic":"UNAVAILABLE"}');
  }
  attachDeleteFailure(error, { ...emptyDeleteObservation(), reason: 'secret-token' as any }, scope);
  writeDeleteDiagnostic(logger, error, reference, 503);
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
});

function invoke(error: unknown) {
  const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const json = jest.fn(); const status = jest.fn((_status: number) => ({ json }));
  const req = { method: 'DELETE', requestId: reference, route: { path: '/api/documents/:id' },
    originalUrl: '/api/documents/document-canary?token=secret-token',
    headers: { authorization: 'Bearer secret-token' }, user: { id: 'person-canary', organizationId: scope.organizationId } };
  const host = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ status }) }) } as ArgumentsHost;
  new GlobalExceptionFilter().catch(error, host);
  return { log, json, status };
}

it('returns the fixed 503 and reference without paths, identities or exception text', () => {
  const { log, json, status } = invoke(new DocumentDeleteReconciliationError(
    { ...emptyDeleteObservation('ACTIVE_AND_QUARANTINE_MISSING'), activeExists: false,
      quarantineExists: false, phase: 'QUARANTINE_PRECHECK' }, scope));
  expect(status).toHaveBeenCalledWith(503);
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DOCUMENT_DELETE_RECONCILIATION_REQUIRED', requestId: reference }));
  const output = JSON.stringify([log.mock.calls, json.mock.calls]);
  expect(output).not.toContain('canary'); expect(output).not.toContain('secret');
  expect(Buffer.byteLength(log.mock.calls[0][0] as string)).toBeLessThanOrEqual(2048);
});

it('keeps denial and unexpected failure responses non-successful and generic', () => {
  for (const error of [new ForbiddenException('secret-canary'), new Error('secret-canary'),
    new ConflictException({ code: 'LEGAL_HOLD_ACTIVE', message: 'secret-canary' })]) {
    const { json, status } = invoke(error);
    expect(status.mock.calls[0][0]).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(json.mock.calls)).not.toContain('canary');
  }
});

it('does not replace the original 503 when diagnostic logging fails', () => {
  const logger = { error: jest.fn(() => { throw new Error('logger failure'); }) };
  expect(() => writeDeleteDiagnostic(logger, new Error('secret'), reference, 503)).not.toThrow();
});
