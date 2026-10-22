// Test tooling only. Keep the carbonlite_e2e convention used by frontend CI.
// The frontend helper also owns fixture/reset flags, so it cannot be imported
// from this independently checked-out backend package.
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const disposableNames = new Set([
  'carbonlite_e2e',
  'carbonlite_test',
  'carbonlite_ci_test',
]);

export function assertSafeTestDatabaseTarget(value = process.env.DATABASE_URL) {
  const refuse = (reason: string): never => {
    throw new Error(`REFUSING TO RUN DATABASE-MUTATING TESTS: ${reason}`);
  };
  if (!value) return refuse('DATABASE_URL is required.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse('DATABASE_URL must be a valid PostgreSQL URL.');
  }

  // No query options: Prisma/libpq options such as host or schema must not
  // redirect the validated destination or select a shared schema.
  // Never echo input, parser errors, credentials, or query values.
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    return refuse('Only PostgreSQL test databases are supported.');
  }
  if (url.search || url.hash) {
    return refuse('Test DATABASE_URL must not contain query options or a fragment.');
  }
  const database = url.pathname.slice(1);
  if (!localHosts.has(url.hostname) || !disposableNames.has(database)) {
    return refuse(
      'Target is not a recognized disposable local CarbonLite test database. ' +
      'Use loopback PostgreSQL with carbonlite_e2e, carbonlite_test, or carbonlite_ci_test.',
    );
  }
  return { hostname: url.hostname, database, port: url.port || '5432' };
}
