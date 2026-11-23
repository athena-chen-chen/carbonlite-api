import { CLEAN_RC_TARGET, prototypePoolConfiguration, prototypePoolOptions } from './control-pool.configuration';

const local = { LOCAL_CONTROL_POOL_PROTOTYPE: 'true', APP_ENV: 'test', NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:55447/carbonlite_ci_test?connection_limit=99' };

describe('local-only control pool configuration', () => {
  it('is disabled by default and preserves ordinary options', () => {
    expect(prototypePoolConfiguration({})).toBeNull(); expect(prototypePoolOptions('work', {})).toEqual({});
    expect(prototypePoolOptions('control', { LOCAL_CONTROL_POOL_PROTOTYPE: 'false' })).toEqual({});
  });
  it.each(['work', 'control'] as const)('caps the %s pool without changing database/role boundaries', kind => {
    const options = prototypePoolOptions(kind, local), url = new URL(options.datasourceUrl!);
    const original = new URL(local.DATABASE_URL);
    for (const field of ['protocol', 'hostname', 'port', 'pathname', 'username', 'password'] as const) expect(url[field]).toBe(original[field]);
    expect(url.searchParams.get('connection_limit')).toBe(kind === 'work' ? '4' : '2');
    expect(url.searchParams.get('pool_timeout')).toBe('5'); expect(url.searchParams.get('connect_timeout')).toBe('5');
    expect(options.log).toEqual([]);
  });
  it.each([
    { APP_ENV: 'production' }, { APP_ENV: 'preview' }, { APP_ENV: 'rc' }, { NODE_ENV: 'production' },
    { LOCAL_CONTROL_POOL_PROTOTYPE: 'yes' }, { DATABASE_URL: 'postgresql://synthetic:synthetic@remote.example/carbonlite_ci_test' },
    { DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/carbonlite_rc' },
    { DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/carbonlite_ci_test?host=remote.example' },
    { DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/carbonlite_ci_test?hostaddr=192.0.2.1' },
    { DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/carbonlite_ci_test?service=live' },
    { DATABASE_URL: 'not-a-database-url' },
  ])('fails closed for unsupported target or mode %#', override => {
    expect(() => prototypePoolOptions('control', { ...local, ...override })).toThrow();
    try { prototypePoolOptions('control', { ...local, ...override }); } catch (error) {
      expect((error as Error).message).not.toContain('synthetic:synthetic');
      expect((error as Error).message).not.toContain('postgresql://');
    }
  });
});

// Pure parser fixtures: no connection or real operator approval is created.
describe('effective connection budgets', () => {
  it.each(['work', 'control'] as const)('overrides incoming %s budgets without mutating the shared environment', kind => {
    const environment = { ...local, DATABASE_URL: local.DATABASE_URL + '&connect_timeout=1&pool_timeout=10' };
    const original = environment.DATABASE_URL;
    const work = new URL(prototypePoolOptions('work', environment).datasourceUrl!);
    const control = new URL(prototypePoolOptions('control', environment).datasourceUrl!);
    const result = kind === 'work' ? work : control;
    expect(result.searchParams.getAll('connect_timeout')).toEqual(['5']);
    expect(result.searchParams.getAll('pool_timeout')).toEqual(['5']);
    expect(work.searchParams.get('connection_limit')).toBe('4');
    expect(control.searchParams.get('connection_limit')).toBe('2');
    expect(work.searchParams.get('application_name')).not.toBe(control.searchParams.get('application_name'));
    expect(environment.DATABASE_URL).toBe(original);
  });
});

describe('RC-shaped parser model budgets (no clients or network)', () => {
  const manifest = { ...CLEAN_RC_TARGET, version: 1, endpointHostname: 'ep-rc-parser-only-pooler.us-east-1.aws.neon.tech',
    releaseSha: 'a'.repeat(40), approvalReference: 'CL-UNIT-MOCK-APPROVAL-5S', workPoolLimit: 4, controlPoolLimit: 2 };
  const environment = { CONTROL_POOL_MODE: 'clean-rc-v1', APP_ENV: 'rc', NODE_ENV: 'production',
    RENDER_SERVICE_ID: CLEAN_RC_TARGET.renderServiceId, RENDER_GIT_BRANCH: 'release/phase2-real-data-rc',
    RENDER_GIT_COMMIT: manifest.releaseSha, CONTROL_POOL_RC_MANIFEST: JSON.stringify(manifest),
    DATABASE_URL: `postgresql://carbonlite_rc_app:unused@${manifest.endpointHostname}/carbonlite_rc?sslmode=require&sslaccept=strict&connect_timeout=1&pool_timeout=1&connection_limit=99` };
  it.each(['work', 'control'] as const)('generates the approved %s URL while preserving RC identity and strict TLS', kind => {
    const result = new URL(prototypePoolOptions(kind, environment).datasourceUrl!);
    expect(result.searchParams.getAll('connect_timeout')).toEqual(['5']);
    expect(result.searchParams.getAll('pool_timeout')).toEqual(['5']);
    expect(result.searchParams.get('connection_limit')).toBe(kind === 'work' ? '4' : '2');
    expect(result.hostname).toBe(manifest.endpointHostname); expect(result.pathname).toBe('/carbonlite_rc');
    expect(result.username).toBe('carbonlite_rc_app');
    expect(result.searchParams.get('sslmode')).toBe('require'); expect(result.searchParams.get('sslaccept')).toBe('strict');
  });
  it.each([
    { DATABASE_URL: environment.DATABASE_URL + '&connect_timeout=10' },
    { CONTROL_POOL_RC_MANIFEST: JSON.stringify({ ...manifest, releaseSha: 'b'.repeat(40) }) },
    { DATABASE_URL: environment.DATABASE_URL.replace('sslaccept=strict', 'sslaccept=accept_invalid_certs') },
  ])('does not rescue invalid RC activation with a larger connection budget %#', override => {
    expect(() => prototypePoolOptions('control', { ...environment, ...override })).toThrow('invalid or unapproved');
  });
});
