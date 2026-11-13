export const REAL_DATA_POLICY_VERSION = '0.2';
export const REAL_DATA_ALLOWED_SCOPE_CODE = 'CARBONLITE_ALLOWED_DATA_POLICY_V0_2';
export const REAL_DATA_EVIDENCE_HMAC_KEY_ENV = 'REAL_DATA_EVIDENCE_HMAC_KEY';

export const INGESTION_DATA_MODE_HEADER = 'x-carbonlite-data-mode';
export const INGESTION_MODE_SYNTHETIC = 'SYNTHETIC_TEST' as const;
export const INGESTION_MODE_REAL = 'REAL_CUSTOMER_DATA' as const;

export type DeclaredIngestionDataMode =
  | typeof INGESTION_MODE_SYNTHETIC
  | typeof INGESTION_MODE_REAL;

export type RealDataEffectiveReason =
  | 'NOT_CONFIGURED'
  | 'ORGANIZATION_NOT_ACTIVE'
  | 'PENDING_EFFECTIVE_DATE'
  | 'EXPIRED'
  | 'REVIEW_OVERDUE'
  | 'WITHDRAWN'
  | 'REAL_DATA_APPROVED'
  | 'STATUS_LOOKUP_FAILED';

export function codedBadRequest(code: string, message: string) {
  return { statusCode: 400, code, message, error: 'Bad Request' };
}

export function codedForbidden(code: string, message: string) {
  return { statusCode: 403, code, message, error: 'Forbidden' };
}

export function codedServiceUnavailable(code: string, message: string) {
  return { statusCode: 503, code, message, error: 'Service Unavailable' };
}
