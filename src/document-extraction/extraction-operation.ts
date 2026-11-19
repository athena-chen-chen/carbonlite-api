import { ForbiddenException } from '@nestjs/common';
import { IngestionDataMode, Prisma } from '@prisma/client';

export type ExtractionOperationMetadata = {
  version: 2;
  phase: 'ADMITTED' | 'DISPATCH_ADMITTED';
  operationId: string;
  organizationId: string;
  documentId: string;
  ingestionDataMode: IngestionDataMode;
  realDataDecisionId: string | null;
  approvalRevision: number | null;
  provider: 'OPENAI' | null;
  processingScope: 'DOCUMENT_EXTRACTION' | null;
  consentVersion: string | null;
  aiGrantGeneration: number | null;
};
export function extractionProvider(fileName: string): 'OPENAI' | null {
  return /\.(?:xlsx?|json)$/i.test(fileName) ? null : 'OPENAI';
}
export function invalidExtractionOperation(): never {
  throw new ForbiddenException({ statusCode: 403, code: 'EXTRACTION_OPERATION_INVALID', message: 'Extraction operation identity is invalid.' });
}
type RecoveryMetadata = Omit<ExtractionOperationMetadata, 'version'> & { version: 1 | 2 };
export function readExtractionOperation(value: Prisma.JsonValue | null): ExtractionOperationMetadata {
  return parseOperation(value, false) as ExtractionOperationMetadata;
}
/** Recovery cannot grant dispatch/finalization rights or fabricate a generation. */
export function readExtractionRecovery(value: Prisma.JsonValue | null): RecoveryMetadata { return parseOperation(value, true); }
function parseOperation(value: Prisma.JsonValue | null, recovery: boolean): RecoveryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidExtractionOperation();
  const keys = ['version', 'phase', 'operationId', 'organizationId', 'documentId', 'ingestionDataMode', 'realDataDecisionId', 'approvalRevision', 'provider', 'processingScope', 'consentVersion'];
  const legacy = recovery && value.version === 1;
  if (!legacy) keys.push('aiGrantGeneration');
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return invalidExtractionOperation();
  const text = (input: unknown): input is string => typeof input === 'string' && input.trim().length > 0 && input.length <= 500;
  if ((!legacy && value.version !== 2) || !['ADMITTED', 'DISPATCH_ADMITTED'].includes(String(value.phase)) || !text(value.operationId) || !text(value.organizationId) || !text(value.documentId)) return invalidExtractionOperation();
  if (value.ingestionDataMode === 'REAL_CUSTOMER_DATA') {
    if (!text(value.realDataDecisionId) || typeof value.approvalRevision !== 'number' || !Number.isSafeInteger(value.approvalRevision) || value.approvalRevision < 1) return invalidExtractionOperation();
  } else if (value.ingestionDataMode !== 'SYNTHETIC_TEST' || value.realDataDecisionId !== null || value.approvalRevision !== null) return invalidExtractionOperation();
  if (value.provider === null) {
    if (value.phase !== 'ADMITTED') return invalidExtractionOperation();
    if (value.processingScope !== null || value.consentVersion !== null || (!legacy && value.aiGrantGeneration !== null)) return invalidExtractionOperation();
  } else if (value.provider !== 'OPENAI' || value.processingScope !== 'DOCUMENT_EXTRACTION' || !text(value.consentVersion) || (!legacy && (typeof value.aiGrantGeneration !== 'number' || !Number.isInteger(value.aiGrantGeneration) || value.aiGrantGeneration < 1 || value.aiGrantGeneration > 2147483647))) return invalidExtractionOperation();
  return { ...value, aiGrantGeneration: legacy ? null : value.aiGrantGeneration } as RecoveryMetadata;
}
