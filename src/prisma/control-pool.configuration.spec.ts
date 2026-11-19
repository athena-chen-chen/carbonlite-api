import { prototypePoolConfiguration, prototypePoolOptions } from './control-pool.configuration';

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
    expect(url.searchParams.get('pool_timeout')).toBe('1'); expect(url.searchParams.get('connect_timeout')).toBe('1');
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
