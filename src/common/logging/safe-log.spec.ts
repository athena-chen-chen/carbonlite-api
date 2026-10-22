import { LOG_LIMITS, REDACTED, TRUNCATED, sanitizeRequestBody, safeErrorSummary, writeSafeError } from './safe-log';

describe('F16 logging representation', () => {
  it.each(['password', 'Password', 'PASSWORD', 'passwordHash', 'oldPassword', 'currentPassword', 'newPassword', 'confirmPassword',
    'token', 'accessToken', 'refreshToken', 'idToken', 'sessionToken', 'sessionId', 'JWT', 'JWT_SECRET',
    'access_token', 'ACCESS_TOKEN', 'access-token', 'AccessToken', 'access token', 'Authorization',
    'Cookie', 'Set-Cookie', 'X-API-Key', 'apiKey', 'api_key', 'API-KEY', 'clientSecret', 'client_secret',
    'secret', 'passwordSetupTokenHash', 'adminScriptToken', 'OPENAI_API_KEY', 'DATABASE_URL'])('redacts %s at every tested nesting level', key => {
    const source = { [key]: 'credential-value-unique', account: { auth: { [key]: 'credential-value-unique' } }, items: [[{ [key]: 'credential-value-unique' }]] };
    const result = sanitizeRequestBody(source);
    const logged = JSON.stringify(result);
    expect(logged).not.toContain('credential-value-unique');
    expect(logged.match(/\[REDACTED\]/g)).toHaveLength(3);
    expect(source[key]).toBe('credential-value-unique');
  });
  it('retains useful safe business metadata and avoids substring matching', () => {
    const input = { quantity: 50, unit: 'L', jurisdictionRegion: 'AB', sourceReference: 'Invoice 123', tokenCount: 7, passwordSetupRequired: true };
    expect(sanitizeRequestBody(input)).toEqual(input);
  });
  it('never serializes full source contents, buffers or provider input', () => {
    const result = sanitizeRequestBody({ extractedSourceText: 'SOURCE-SECRET'.repeat(10000), nested: { rawOcrText: 'private', base64: 'private', input: 'private' }, file: Buffer.from('private') });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('SOURCE-SECRET');
  });
  it('bounds arbitrary strings and arrays without mutating them', () => {
    const input = { text: 'A'.repeat(1000000), items: Array.from({ length: 10000 }, (_, n) => ({ n, password: `password-${n}` })) };
    const result = JSON.stringify(sanitizeRequestBody(input));
    expect(result.length).toBeLessThanOrEqual(LOG_LIMITS.serialized);
    expect(result).toContain(TRUNCATED);
    expect(result).not.toContain('password-');
    expect(input.text).toHaveLength(1000000);
    expect(input.items).toHaveLength(10000);
  });
  it('bounds depth, width, node count and cycles', () => {
    const root: any = {};
    let current = root;
    for (let i = 0; i < 10000; i++) { current.child = {}; current = current.child; }
    current.password = 'unreachable-secret';
    const cycle: any = {}; cycle.self = cycle;
    for (const value of [root, cycle, Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), 'A'.repeat(500)]))]) {
      const output = JSON.stringify(sanitizeRequestBody(value));
      expect(output).toContain(TRUNCATED);
      expect(output.length).toBeLessThanOrEqual(LOG_LIMITS.serialized);
      expect(output).not.toContain('unreachable-secret');
    }
  });
  it('handles primitives, dates, throwing getters, toJSON, proxies and strange values', () => {
    const getter = jest.fn(() => { throw Error('getter-secret'); });
    const obj = { get password() { return getter(); }, get strange() { return getter(); }, toJSON: getter };
    const throwing = new Proxy({}, { ownKeys() { throw Error('proxy-secret'); } });
    for (const value of [null, undefined, true, false, 12, 'plain', new Date('2026-01-01'), new Date('invalid'), 1n, Symbol('secret'), obj, throwing]) {
      expect(() => JSON.stringify(sanitizeRequestBody(value))).not.toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(sanitizeRequestBody(obj)).toMatchObject({ password: REDACTED, strange: '[UNAVAILABLE]' });
  });
  it('never retains original error messages, stack, provider config or payload', () => {
    const error = Object.assign(new Error('secret-provider-message'), { status: 502, code: 'P2002', config: { headers: { Authorization: 'secret-jwt' }, data: 'secret-base64' }, response: { data: 'secret-extraction' } });
    const logger = { error: jest.fn() };
    writeSafeError(logger, 'provider-extract', error, { documentId: 'doc-1' });
    const output = JSON.stringify(logger.error.mock.calls);
    expect(output).toContain('doc-1'); expect(output).toContain('502'); expect(output).toContain('P2002');
    expect(output).not.toContain('secret-');
    expect(safeErrorSummary(new Proxy({}, { getPrototypeOf() { throw Error('secret'); } }))).toEqual({ category: 'UnknownError' });
    expect(() => writeSafeError({ error() { throw Error('logger failure'); } }, 'extract', error)).not.toThrow();
  });
});
