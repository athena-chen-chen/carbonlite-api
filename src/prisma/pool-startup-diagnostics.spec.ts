import { PrismaClientInitializationError } from '@prisma/client/runtime/library';
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
  it.each([
    ['P1000', 'AUTHENTICATION'], ['P1001', 'CONNECTION'], ['P1002', 'TIMEOUT'],
    ['P1008', 'TIMEOUT'], ['P1011', 'TLS'], ['P2024', 'CAPACITY'], ['P2037', 'CAPACITY'],
    ['unsupported', 'UNKNOWN'], [undefined, 'UNKNOWN'],
  ])('classifies actual Prisma initialization errors safely: %s', (code, expected) => {
    const error = new PrismaClientInitializationError('synthetic-secret driver message', '6.19.3', code);
    expect(error).not.toHaveProperty('code');
    expect(error.errorCode).toBe(code);
    expect(classifyPoolStartupFailure(error)).toBe(expected);
    const sanitized = new PoolIdentityFailure(classifyPoolStartupFailure(error));
    expect(sanitized.message).not.toContain('synthetic-secret');
    expect(sanitized).not.toHaveProperty('cause');
  });
  it.each([
    { code: 'P1002', errorCode: 'P1001' },
    { code: 'P1002', errorCode: 'P1008' },
    { code: 'unsupported', errorCode: 'P1002' },
    { code: 'P1002', errorCode: 'unsupported' },
    { code: null, errorCode: 'P1002' },
    { code: 'P1002', errorCode: 1002 },
    { code: 'P1002', get errorCode() { throw new Error('synthetic-secret'); } },
    { get code() { throw new Error('synthetic-secret'); }, errorCode: 'P1002' },
  ])('fails closed for conflicting or malformed code fields %#', error => {
    expect(classifyPoolStartupFailure(error)).toBe('UNKNOWN');
  });
  it('accepts identical allowlisted fields and ignores message keywords', () => {
    expect(classifyPoolStartupFailure({ code: 'P1002', errorCode: 'P1002' })).toBe('TIMEOUT');
    expect(classifyPoolStartupFailure({ errorCode: 'unsupported', message: 'TLS timeout' })).toBe('UNKNOWN');
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
