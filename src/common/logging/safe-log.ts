export const REDACTED = '[REDACTED]';
export const TRUNCATED = '[TRUNCATED]';
export const LOG_LIMITS = { depth: 5, array: 10, keys: 20, nodes: 128, string: 256, serialized: 8192 } as const;

const normalizeKey = (key: string) => key.toLowerCase().replace(/[_\-\s]/g, '');
const sensitiveKeys = new Set([
  'password', 'passwordHash', 'oldPassword', 'currentPassword', 'newPassword', 'confirmPassword',
  'passwordSetupToken', 'passwordSetupTokenHash', 'passwordResetToken', 'passwordResetTokenHash',
  'token', 'tokenHash', 'accessToken', 'refreshToken', 'idToken', 'sessionToken', 'csrfToken', 'jwt', 'jwtSecret',
  'authorization', 'authorizationHeader', 'proxyAuthorization', 'cookie', 'setCookie',
  'apiKey', 'xApiKey', 'openaiApiKey', 'clientSecret', 'secret', 'session', 'sessionId',
  'adminScriptToken', 'localDemoPassword', 'databaseUrl',
  'fileContent', 'fileBuffer', 'fileBase64', 'base64', 'documentContent', 'documentText',
  'extractedSourceText', 'extractedText', 'extractedContent', 'ocr', 'ocrText', 'ocrContent',
  'rawOcrText', 'rawText', 'rawContent', 'input', 'inputPayload', 'content',
  'rows', 'parsedActivities', 'activities', 'reportPayload',
].map(normalizeKey));

// Logging representation only: never invoke getters/toJSON or mutate application data.
export function sanitizeRequestBody(value: unknown): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > LOG_LIMITS.nodes || depth > LOG_LIMITS.depth) return TRUNCATED;
    if (item === null || item === undefined || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : '[UNAVAILABLE]';
    if (typeof item === 'string') return item.length > LOG_LIMITS.string ? item.slice(0, LOG_LIMITS.string) + TRUNCATED : item;
    if (typeof item !== 'object') return '[UNAVAILABLE]';
    if (seen.has(item)) return TRUNCATED;
    seen.add(item);
    try {
      if (item instanceof Date) return Date.prototype.toISOString.call(item);
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return REDACTED;
      const result: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : Object.create(null);
      const limit = Array.isArray(item) ? LOG_LIMITS.array : LOG_LIMITS.keys;
      let count = 0;
      for (const key of Object.keys(item)) {
        if (count++ >= limit || nodes >= LOG_LIMITS.nodes) {
          if (Array.isArray(result)) result.push(TRUNCATED);
          else result['[TRUNCATED]'] = TRUNCATED;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        const next = sensitiveKeys.has(normalizeKey(key)) ? REDACTED
          : descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[UNAVAILABLE]';
        if (Array.isArray(result)) result.push(next);
        else result[key.slice(0, LOG_LIMITS.string)] = next;
      }
      return result;
    } catch { return '[UNAVAILABLE]'; }
  }
  try {
    const result = visit(value, 0);
    return (JSON.stringify(result)?.length ?? 0) > LOG_LIMITS.serialized ? TRUNCATED : result;
  } catch { return '[UNAVAILABLE]'; }
}

// Arbitrary error messages/stacks can contain credentials, SQL values or provider input.
export function safeErrorSummary(error: unknown) {
  try {
    const category = error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError'
      : error instanceof RangeError ? 'RangeError' : error instanceof Error ? 'Error' : 'UnknownError';
    const status = Object.getOwnPropertyDescriptor(Object(error), 'status')?.value;
    const code = Object.getOwnPropertyDescriptor(Object(error), 'code')?.value;
    return { category, ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
      ...(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'].includes(code) || /^P\d{4}$/.test(typeof code === 'string' ? code : '') ? { code } : {}) };
  } catch { return { category: 'UnknownError' }; }
}

export function writeSafeError(logger: { error: (message: string) => unknown }, operation: string, error: unknown, identifiers: Record<string, unknown> = {}) {
  try {
    logger.error(JSON.stringify({ operation, ...safeErrorSummary(error), identifiers: sanitizeRequestBody(identifiers) }));
  } catch { /* Logging must not mask the original exception. */ }
}
