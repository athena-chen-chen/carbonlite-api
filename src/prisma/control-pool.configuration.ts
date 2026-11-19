import type { Prisma } from '@prisma/client';

export const CONTROL_POOL_FLAG = 'LOCAL_CONTROL_POOL_PROTOTYPE';
export const WORK_POOL_LIMIT = 4;
export const CONTROL_POOL_LIMIT = 2;
export const CONTROL_LOCK_WAIT_MS = 250;
export const CONTROL_TRANSACTION_MS = 5000;
export const CONTROL_REQUEST_MS = 6000;
export const CONTROL_ACQUIRE_MS = 500;

/** Experimental local-only gate. Never infer deployment capacity from these caps. */
export function prototypePoolConfiguration(environment: NodeJS.ProcessEnv = process.env) {
  if (environment[CONTROL_POOL_FLAG] === undefined || environment[CONTROL_POOL_FLAG] === 'false') return null;
  if (environment[CONTROL_POOL_FLAG] !== 'true') throw new Error('Invalid local control-pool prototype configuration.');
  if (!['local', 'development', 'test'].includes(environment.APP_ENV || '') || !['development', 'test'].includes(environment.NODE_ENV || '')) {
    throw new Error('The control-pool prototype is restricted to local test environments.');
  }
  let url: URL;
  try { url = new URL(environment.DATABASE_URL || ''); }
  catch { throw new Error('The control-pool prototype requires a local test database.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.searchParams.has('host') || url.searchParams.has('hostaddr') || url.searchParams.has('service') ||
      !['carbonlite_ci_test', 'carbonlite_test'].includes(decodeURIComponent(url.pathname.slice(1)))) {
    throw new Error('The control-pool prototype requires a disposable loopback test database.');
  }
  return { url };
}

export function prototypePoolOptions(kind: 'work' | 'control', environment: NodeJS.ProcessEnv = process.env): Prisma.PrismaClientOptions {
  const configuration = prototypePoolConfiguration(environment);
  if (!configuration) return {};
  const url = new URL(configuration.url);
  url.searchParams.set('connection_limit', String(kind === 'work' ? WORK_POOL_LIMIT : CONTROL_POOL_LIMIT));
  url.searchParams.set('pool_timeout', '1');
  url.searchParams.set('connect_timeout', '1');
  url.searchParams.set('application_name', `carbonlite-local-${kind}`);
  // Both clients derive their endpoint, database and credentials from exactly
  // the same value. No second URL/role or credential fallback is accepted.
  return { datasourceUrl: url.toString(), log: [] };
}
