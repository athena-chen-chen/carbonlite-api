import { classifyPoolStartupFailure, PoolIdentityFailure } from './pool-startup-diagnostics';

describe('sanitized pool startup diagnostics', () => {
  it.each([
    ['P1000', 'AUTHENTICATION'], ['P1001', 'CONNECTION'], ['P1002', 'TIMEOUT'],
    ['P1008', 'TIMEOUT'], ['P1011', 'TLS'], ['P2024', 'CAPACITY'], ['P2037', 'CAPACITY'],
    ['ECONNREFUSED', 'CONNECTION'], ['ENOTFOUND', 'CONNECTION'], ['ETIMEDOUT', 'TIMEOUT'],
    ['53300', 'CAPACITY'], ['28P01', 'AUTHENTICATION'],
  ])('classifies supported code %s without retaining payloads', (code, expected) => {
    expect(classifyPoolStartupFailure({ code, message: 'synthetic-secret', meta: { password: 'synthetic-secret' } })).toBe(expected);
  });
  it.each(['P2028', '57014', 'toString', 'unrecognized-secret'])('does not guess from ambiguous/unknown code %s', code => {
    expect(classifyPoolStartupFailure({ code, message: 'TLS timeout connection capacity' })).toBe('UNKNOWN');
  });
  it('reads only allowlisted SQLSTATE for Prisma raw-query failures', () => {
    expect(classifyPoolStartupFailure({ code: 'P2010', meta: { code: '53300', message: 'synthetic-secret' } })).toBe('CAPACITY');
    expect(classifyPoolStartupFailure({ code: 'P2010', meta: { code: '57014' } })).toBe('UNKNOWN');
    expect(classifyPoolStartupFailure({ code: 'other', meta: { code: '53300' } })).toBe('UNKNOWN');
  });
  it('does not access messages, causes or serialization hooks', () => {
    const forbidden = jest.fn(() => { throw new Error('synthetic-secret'); });
    const error = { code: 'P1011', get message() { return forbidden(); }, get cause() { return forbidden(); }, toJSON: forbidden };
    const sanitized = new PoolIdentityFailure(classifyPoolStartupFailure(error));
    expect(sanitized.message).toContain('category=TLS');
    expect(JSON.stringify(sanitized)).not.toContain('synthetic-secret');
    expect(sanitized).not.toHaveProperty('cause');
    expect(forbidden).not.toHaveBeenCalled();
  });
  it.each([null, undefined, 'synthetic-secret', { get code() { throw new Error('synthetic-secret'); } }])('handles malformed errors without leaking them', error => {
    expect(classifyPoolStartupFailure(error)).toBe('UNKNOWN');
  });
});
