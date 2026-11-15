import { AuthenticationError } from 'openai';
import {
  extractSafeOpenAiProviderErrorMetadata,
  writeSafeOpenAiProviderError,
} from './openai-safe-error';

function authenticationError(input: {
  code: string;
  type?: string;
  requestId?: string;
  message?: string;
}) {
  const headers = new Headers({
    'x-request-id': input.requestId ?? 'req_safe_default',
    authorization: 'Bearer sk-fake-secret',
    'x-arbitrary-provider-header': 'must-not-be-logged',
  });
  return new AuthenticationError(
    401,
    {
      type: input.type ?? 'invalid_request_error',
      code: input.code,
      message: input.message ?? 'provider authentication failed',
      prompt: 'private prompt text',
      output: 'private provider output',
    },
    undefined,
    headers,
  );
}

describe('OpenAI safe provider error diagnostics', () => {
  it('retains only the allowlisted invalid-key metadata', () => {
    const metadata = extractSafeOpenAiProviderErrorMetadata(
      authenticationError({
        code: 'invalid_api_key',
        type: 'invalid_request_error',
        requestId: 'req_invalid_key_123',
      }),
    );

    expect(metadata).toEqual({
      providerStatus: 401,
      providerErrorType: 'invalid_request_error',
      providerErrorCode: 'invalid_api_key',
      providerRequestId: 'req_invalid_key_123',
    });
  });

  it('retains the safe ip_not_authorized provider code', () => {
    expect(
      extractSafeOpenAiProviderErrorMetadata(
        authenticationError({ code: 'ip_not_authorized' }),
      ).providerErrorCode,
    ).toBe('ip_not_authorized');
  });

  it('does not emit raw messages, stack, headers, prompts, outputs, or credentials', () => {
    const logger = { error: jest.fn() };
    const error = authenticationError({
      code: 'invalid_api_key',
      requestId: 'req_safe_456',
      message:
        'Bearer sk-fake-leak Authorization: secret document text customer-content',
    });
    error.stack = 'stack-secret-value';

    writeSafeOpenAiProviderError(
      logger,
      'openai-document-extraction',
      error,
      { organizationId: 'org-safe', documentId: 'doc-safe' },
    );

    const payload = JSON.parse(logger.error.mock.calls[0][0]);
    expect(payload).toEqual({
      operation: 'openai-document-extraction',
      providerStatus: 401,
      providerErrorType: 'invalid_request_error',
      providerErrorCode: 'invalid_api_key',
      providerRequestId: 'req_safe_456',
      identifiers: { organizationId: 'org-safe', documentId: 'doc-safe' },
    });
    const serialized = JSON.stringify(payload);
    for (const unsafeValue of [
      'sk-fake',
      'Authorization',
      'document text',
      'customer-content',
      'stack-secret-value',
      'must-not-be-logged',
      'private prompt text',
      'private provider output',
    ]) {
      expect(serialized).not.toContain(unsafeValue);
    }
  });

  it('returns null fields for non-SDK errors instead of unsafe fallbacks', () => {
    expect(
      extractSafeOpenAiProviderErrorMetadata({
        status: 401,
        type: 'invalid_request_error',
        code: 'invalid_api_key',
        message: 'unsafe raw provider text',
      }),
    ).toEqual({
      providerStatus: null,
      providerErrorType: null,
      providerErrorCode: null,
      providerRequestId: null,
    });
  });
});
