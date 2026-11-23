import { verifyPoolIdentity } from './pool-identity';
import { CLEAN_RC_TARGET, prototypePoolConfiguration } from './control-pool.configuration';

// Synthetic in-memory fixtures only. No client construction or network access.
describe('pool activation identity', () => {
  const expected = { mode: 'clean-rc-v1' as const, url: new URL('postgresql://fixture.invalid/carbonlite_rc'), database: 'carbonlite_rc', role: 'carbonlite_rc_app' };
  const row = { database: 'carbonlite_rc', role: 'carbonlite_rc_app', session: 'carbonlite_rc_app', elevated: false };
  function client(rows = [row]) {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0), $queryRaw: jest.fn().mockResolvedValue(rows) };
    return { tx, $transaction: jest.fn(async callback => callback(tx)) };
  }
  it('verifies both database and login identity using a read-only transaction', async () => {
    const database = client(); await verifyPoolIdentity(database, expected);
    expect(database.tx.$executeRaw).toHaveBeenCalledTimes(1); expect(database.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000, maxWait: 500 });
  });
  it.each([{ database: 'other' }, { role: 'owner' }, { session: 'owner' }, { elevated: true }])('rejects identity mismatch %#', async change => {
    await expect(verifyPoolIdentity(client([{ ...row, ...change }]), expected)).rejects.toThrow('identity verification failed');
  });
  it('rejects absent identity and sanitizes driver errors', async () => {
    await expect(verifyPoolIdentity(client([]), expected)).rejects.toThrow('identity verification failed');
    await expect(verifyPoolIdentity({ $transaction: jest.fn().mockRejectedValue(new Error('synthetic sensitive driver payload')) }, expected)).rejects.toThrow('identity verification failed');
  });
  const manifest = { ...CLEAN_RC_TARGET, version: 1, endpointHostname: 'ep-synthetic-pooler.us-east-1.aws.neon.tech', releaseSha: 'a'.repeat(40),
    approvalReference: 'SYNTHETIC_TEST_ONLY', workPoolLimit: 4, controlPoolLimit: 2 };
  const env = { CONTROL_POOL_MODE: 'clean-rc-v1', APP_ENV: 'rc', NODE_ENV: 'production', RENDER_SERVICE_ID: CLEAN_RC_TARGET.renderServiceId,
    RENDER_GIT_BRANCH: 'release/phase2-real-data-rc', RENDER_GIT_COMMIT: manifest.releaseSha,
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/carbonlite_ci_test', CONTROL_POOL_RC_MANIFEST: JSON.stringify(manifest) };
  // Pure parser model, NOT an operator approval or usable endpoint. No client
  // is constructed here. Actual activation still requires independently supplied
  // deployment metadata and both live SQL identity checks.
  const parserModel = { ...manifest, endpointHostname: 'ep-rc-parser-only-pooler.us-east-1.aws.neon.tech', approvalReference: 'CL-UNIT-MOCK-APPROVAL-0001' };
  const parserEnvironment = { ...env, DATABASE_URL: `postgresql://carbonlite_rc_app:unused@${parserModel.endpointHostname}/carbonlite_rc?sslmode=require&sslaccept=strict`,
    CONTROL_POOL_RC_MANIFEST: JSON.stringify(parserModel) };
  it('parses a complete approval-shaped model without constructing or connecting a client', () => {
    expect(prototypePoolConfiguration(parserEnvironment)).toMatchObject({ mode: 'clean-rc-v1', database: 'carbonlite_rc', role: 'carbonlite_rc_app' });
  });
  it.each([
    { runtimeRole: 'wrong-role' }, { database: 'wrong-db' }, { neonProjectId: 'wrong-project' }, { neonBranchId: 'wrong-branch' },
    { renderServiceId: 'wrong-service' }, { endpointHostname: 'different.invalid' }, { releaseSha: 'b'.repeat(40) },
    { workPoolLimit: 5 }, { controlPoolLimit: 3 }, { approvalReference: '' }, { endpointHostname: undefined }, { unexpected: true },
  ])('rejects mismatches against an otherwise complete parser model %#', change => {
    expect(() => prototypePoolConfiguration({ ...parserEnvironment, CONTROL_POOL_RC_MANIFEST: JSON.stringify({ ...parserModel, ...change }) })).toThrow();
  });
  it('never accepts a synthetic manifest for RC activation', () => { expect(() => prototypePoolConfiguration(env)).toThrow(); });
  it.each([
    { CONTROL_POOL_RC_MANIFEST: undefined }, { CONTROL_POOL_RC_MANIFEST: '{}' }, { LOCAL_CONTROL_POOL_PROTOTYPE: 'true' },
    { RENDER_SERVICE_ID: 'other-service' }, { RENDER_GIT_COMMIT: 'b'.repeat(40) }, { APP_ENV: 'production' }, { APP_ENV: 'preview' },
    { CONTROL_POOL_MODE: 'unknown' }, { CONTROL_POOL_MODE: undefined },
  ])('fails closed for incomplete or conflicting approval %#', change => { expect(() => prototypePoolConfiguration({ ...env, ...change })).toThrow(); });
});
