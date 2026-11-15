import { APIError } from 'openai';
import { sanitizeRequestBody } from '../common/logging/safe-log';

export type SafeOpenAiProviderErrorMetadata = {
  providerStatus: number | null;
  providerErrorType: string | null;
  providerErrorCode: string | null;
  providerRequestId: string | null;
};

const SAFE_PROVIDER_SCALAR = /^[A-Za-z0-9._:-]{1,256}$/;

function safeProviderScalar(value: unknown): string | null {
  return typeof value === 'string' && SAFE_PROVIDER_SCALAR.test(value)
    ? value
    : null;
}

export function extractSafeOpenAiProviderErrorMetadata(
  error: unknown,
): SafeOpenAiProviderErrorMetadata {
  if (!(error instanceof APIError)) {
    return {
      providerStatus: null,
      providerErrorType: null,
      providerErrorCode: null,
      providerRequestId: null,
    };
  }

  return {
    providerStatus:
      Number.isInteger(error.status) &&
      (error.status as number) >= 400 &&
      (error.status as number) <= 599
        ? (error.status as number)
        : null,
    providerErrorType: safeProviderScalar(error.type),
    providerErrorCode: safeProviderScalar(error.code),
    // openai@6 exposes the scalar x-request-id value as APIError.requestID.
    // Do not inspect or serialize the provider headers object.
    providerRequestId: safeProviderScalar(error.requestID),
  };
}

export function writeSafeOpenAiProviderError(
  logger: { error: (message: string) => unknown },
  operation: string,
  error: unknown,
  identifiers: Record<string, unknown> = {},
) {
  try {
    const metadata = extractSafeOpenAiProviderErrorMetadata(error);
    logger.error(
      JSON.stringify({
        operation,
        providerStatus: metadata.providerStatus,
        providerErrorType: metadata.providerErrorType,
        providerErrorCode: metadata.providerErrorCode,
        providerRequestId: metadata.providerRequestId,
        identifiers: sanitizeRequestBody(identifiers),
      }),
    );
  } catch {
    // Diagnostics must never mask the original provider exception.
  }
}
