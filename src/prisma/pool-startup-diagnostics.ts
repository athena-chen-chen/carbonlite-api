export type PoolStartupCategory =
  | 'AUTHENTICATION' | 'CONNECTION' | 'TLS' | 'TIMEOUT'
  | 'CAPACITY' | 'IDENTITY_MISMATCH' | 'UNKNOWN';

// Never inspect messages, stringify a driver error, or retain its cause/meta.
const categories: Readonly<Record<string, PoolStartupCategory>> = Object.freeze({
  P1000: 'AUTHENTICATION', P1001: 'CONNECTION', P1002: 'TIMEOUT',
  P1008: 'TIMEOUT', P1011: 'TLS', P2024: 'CAPACITY', P2037: 'CAPACITY',
  ECONNREFUSED: 'CONNECTION', ENOTFOUND: 'CONNECTION',
  ETIMEDOUT: 'TIMEOUT', '53300': 'CAPACITY', '28P01': 'AUTHENTICATION',
});

const unreadableProperty = Symbol('unreadable');

function property(value: unknown, key: string): unknown {
  try { return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return unreadableProperty; }
}

export function classifyPoolStartupFailure(error: unknown): PoolStartupCategory {
  if (error instanceof PoolIdentityFailure) return error.category;
  const requestCode = property(error, 'code');
  const initializationCode = property(error, 'errorCode');
  // Conflicting or malformed fields must never be rescued by the other field.
  if ((requestCode !== undefined && typeof requestCode !== 'string')
    || (initializationCode !== undefined && typeof initializationCode !== 'string')
    || (requestCode !== undefined && initializationCode !== undefined && requestCode !== initializationCode)) return 'UNKNOWN';
  const code = requestCode ?? initializationCode;
  if (typeof code === 'string' && Object.hasOwn(categories, code)) return categories[code];
  // Prisma raw-query failures expose a PostgreSQL SQLSTATE in meta.code.
  if (code === 'P2010') {
    const sqlState = property(property(error, 'meta'), 'code');
    if (typeof sqlState === 'string' && Object.hasOwn(categories, sqlState)) return categories[sqlState];
  }
  return 'UNKNOWN';
}

export class PoolIdentityFailure extends Error {
  constructor(readonly category: PoolStartupCategory) {
    super(`Control-pool database identity verification failed. No activation or fallback permitted. phase=IDENTITY category=${category}`);
  }
}
