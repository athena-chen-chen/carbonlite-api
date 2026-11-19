import type { Prisma } from '@prisma/client';

export const CONTROL_POOL_FLAG = 'LOCAL_CONTROL_POOL_PROTOTYPE';
export const WORK_POOL_LIMIT = 4;
export const CONTROL_POOL_LIMIT = 2;
export const CONTROL_LOCK_WAIT_MS = 250;
export const CONTROL_TRANSACTION_MS = 5000;
export const CONTROL_REQUEST_MS = 6000;
export const CONTROL_ACQUIRE_MS = 500;

export const CLEAN_RC_TARGET = Object.freeze({
  renderServiceId: 'srv-dbtppde7bikc73fcg2j0', neonProjectId: 'gentle-art-04408150',
  neonBranchId: 'br-shiny-boat-bcll0hxz', database: 'carbonlite_rc', runtimeRole: 'carbonlite_rc_app',
});
export type PoolConfiguration = { url: URL; mode: 'local' | 'clean-rc-v1'; database: string; role: string };
function refuse(): never { throw new Error('Control-pool activation configuration is invalid or unapproved.'); }
function rcConfiguration(env: NodeJS.ProcessEnv): PoolConfiguration {
  if (env.LOCAL_CONTROL_POOL_PROTOTYPE !== undefined && env.LOCAL_CONTROL_POOL_PROTOTYPE !== 'false') refuse();
  if (env.APP_ENV !== 'rc' || env.NODE_ENV !== 'production' || env.RENDER_SERVICE_ID !== CLEAN_RC_TARGET.renderServiceId ||
      env.RENDER_GIT_BRANCH !== 'release/phase2-real-data-rc') refuse();
  let manifest: Record<string, unknown>, url: URL;
  try { manifest = JSON.parse(env.CONTROL_POOL_RC_MANIFEST || ''); url = new URL(env.DATABASE_URL || ''); } catch { return refuse(); }
  const keys = [...Object.keys(CLEAN_RC_TARGET), 'version', 'endpointHostname', 'releaseSha', 'approvalReference', 'workPoolLimit', 'controlPoolLimit'];
  if (!manifest || Array.isArray(manifest) || Object.keys(manifest).length !== keys.length || Object.keys(manifest).some(key => !keys.includes(key))) refuse();
  for (const [key, value] of Object.entries(CLEAN_RC_TARGET)) if (manifest[key] !== value) refuse();
  if (manifest.version !== 1 || manifest.workPoolLimit !== 4 || manifest.controlPoolLimit !== 2 ||
      typeof manifest.releaseSha !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.releaseSha) || manifest.releaseSha !== env.RENDER_GIT_COMMIT ||
      typeof manifest.approvalReference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:/.@_-]{7,159}$/.test(manifest.approvalReference) ||
      /synthetic|fixture|example|test-only/i.test(manifest.approvalReference) ||
      typeof manifest.endpointHostname !== 'string' || !/^ep-[a-z0-9-]+-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(manifest.endpointHostname) ||
      /synthetic|fixture|example|localhost/.test(manifest.endpointHostname)) refuse();
  if (url.hostname !== manifest.endpointHostname || !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname !== '/carbonlite_rc' || decodeURIComponent(url.username) !== 'carbonlite_rc_app' || url.hash ||
      (url.port && url.port !== '5432') || url.searchParams.get('sslmode') !== 'require' || url.searchParams.get('sslaccept') !== 'strict') refuse();
  const allowed = new Set(['sslmode', 'sslaccept', 'channel_binding', 'pgbouncer', 'connection_limit', 'pool_timeout', 'connect_timeout']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) refuse();
  return { url, mode: 'clean-rc-v1', database: CLEAN_RC_TARGET.database, role: CLEAN_RC_TARGET.runtimeRole };
}

/** Experimental local-only gate. Never infer deployment capacity from these caps. */
export function prototypePoolConfiguration(environment: NodeJS.ProcessEnv = process.env): PoolConfiguration | null {
  if (environment.CONTROL_POOL_MODE === 'clean-rc-v1') return rcConfiguration(environment);
  if (environment.CONTROL_POOL_MODE !== undefined || environment.CONTROL_POOL_RC_MANIFEST !== undefined) return refuse();
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
  return { url, mode: 'local', database: decodeURIComponent(url.pathname.slice(1)), role: decodeURIComponent(url.username) };
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
