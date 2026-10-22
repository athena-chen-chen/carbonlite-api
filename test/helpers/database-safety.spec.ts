import { assertSafeTestDatabaseTarget } from './database-safety';

describe('disposable database target policy', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it.each([
    undefined, '', 'not-a-url', 'postgresql://%invalid',
    'postgresql://prod-db.example.com/carbonlite',
    'postgresql://localhost/carbonlite_staging',
    'postgresql://localhost/carbonlite_dev',
    'postgresql://localhost/contest_prod',
    'postgresql://prod-db.example.com/carbonlite_test',
    'postgresql://ep-test.neon.tech/carbonlite_e2e',
    'postgresql://postgres/carbonlite_e2e',
    'postgresql://localhost/carbonlite_e2e_prod',
    'postgresql://localhost/carbonlite_e2e/other',
    'postgresql://localhost/%63arbonlite_e2e',
    'file:./carbonlite_test', 'mysql://localhost/carbonlite_test',
    'postgresql://localhost/carbonlite_test?host=production.example.com',
    'postgresql://localhost/carbonlite_test?schema=public',
    'postgresql://localhost/carbonlite_test#secret',
  ])('rejects unsafe or ambiguous target %s', value => {
    delete process.env.DATABASE_URL;
    expect(() => assertSafeTestDatabaseTarget(value)).toThrow('REFUSING TO RUN DATABASE-MUTATING TESTS');
  });

  it.each(['NODE_ENV', 'APP_ENV', 'ALLOW_TEST_DB_RESET', 'ALLOW_UNSAFE_DATABASE'])(
    '%s cannot authorize a production target', key => {
      process.env[key] = key.endsWith('ENV') ? 'test' : 'true';
      expect(() => assertSafeTestDatabaseTarget('postgresql://prod.example.com/carbonlite')).toThrow();
    },
  );

  it.each([
    'postgresql://localhost:5432/carbonlite_e2e', // Actual frontend CI service URL structure.
    'postgres://127.0.0.1:5432/carbonlite_test',
    'postgresql://[::1]:5432/carbonlite_ci_test',
  ])('accepts dedicated local/CI database %s', value => {
    expect(assertSafeTestDatabaseTarget(value).database).toMatch(/^carbonlite_(e2e|test|ci_test)$/);
  });

  it('never exposes credentials, query secrets, or raw parser input', () => {
    for (const value of [
      'postgresql://sensitive-user:private-password@prod.example.com/carbonlite',
      'postgresql://localhost/carbonlite_test?secret=private-password',
      'private-password:%%%invalid',
    ]) {
      let message = '';
      try { assertSafeTestDatabaseTarget(value); } catch (error) { message = (error as Error).message; }
      expect(message).toContain('REFUSING');
      expect(message).not.toContain('private-password');
      expect(message).not.toContain('sensitive-user');
      expect(message).not.toContain(value);
    }
  });
});
