import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESTORE_ACCESS_BLOCK_CODE,
  RecoveryAccessPolicy,
  isRecoveryAllowlisted,
  restoreAccessGate,
} from './restore-access-gate';
import { RecoveryControlRecord } from './recovery-control-store';

const DIGEST = 'a'.repeat(64);

describe('durable A2-1 recovery access gate', () => {
  it('starts recovery locked and COMPLETE cannot unlock it', async () => {
    const { path } = await controlFile();
    const policy = new RecoveryAccessPolicy({
      ...recoveryEnvironment(path),
      RECOVERY_RECONCILIATION_STATUS: 'COMPLETE',
      FORCE_RELEASE: 'true',
      SKIP_RECONCILIATION: 'true',
    });
    await expect(policy.evaluate()).resolves.toMatchObject({
      mode: 'RECOVERY',
      blocked: true,
      reason: 'RECOVERY_LOCKED',
    });
  });

  it('restore mode false cannot unlock an existing external session', async () => {
    const { path } = await controlFile();
    const policy = new RecoveryAccessPolicy({
      RECOVERY_RESTORE_MODE: 'false',
    }, { defaultControlPath: path });
    await expect(policy.evaluate()).resolves.toMatchObject({
      mode: 'RECOVERY',
      blocked: true,
    });
  });

  it.each([
    'RECOVERY_LOCKED',
    'RECONCILIATION_PENDING',
    'APPROVAL_PENDING',
  ] as const)('keeps A2-1 state %s locked', async (state) => {
    const { path } = await controlFile(state);
    await expect(new RecoveryAccessPolicy(recoveryEnvironment(path)).evaluate())
      .resolves.toMatchObject({ blocked: true, reason: state });
  });

  it('blocks missing, corrupt, and identity-mismatched external state', async () => {
    const missing = `/tmp/carbonlite-a2-1-missing-${Date.now()}/state.json`;
    await expect(new RecoveryAccessPolicy({
      RECOVERY_RESTORE_MODE: 'true',
      RECOVERY_CONTROL_STORE_PATH: missing,
    }).evaluate()).resolves.toMatchObject({ blocked: true, reason: 'MISSING_EXTERNAL_STATE' });

    const corrupt = await controlFile();
    await writeFile(corrupt.path, '{broken', { mode: 0o600 });
    await expect(new RecoveryAccessPolicy(recoveryEnvironment(corrupt.path)).evaluate())
      .resolves.toMatchObject({ blocked: true, reason: 'CORRUPT_EXTERNAL_STATE' });

    const mismatch = await controlFile();
    await expect(new RecoveryAccessPolicy({
      ...recoveryEnvironment(mismatch.path),
      RECOVERY_SESSION_ID: 'recovery_wrong_session',
    }).evaluate()).resolves.toMatchObject({
      blocked: true,
      reason: 'RECOVERY_SESSION_BINDING_MISMATCH',
    });
  });

  it('survives restart and an old restored DB cannot authorize release', async () => {
    const { path } = await controlFile();
    const environment = {
      ...recoveryEnvironment(path),
      DATABASE_URL: 'postgresql://restored-database-with-old-state.invalid/db',
      RECOVERY_RECONCILIATION_STATUS: 'COMPLETE',
    };
    const beforeRestart = await new RecoveryAccessPolicy(environment).evaluate();
    const afterRestart = await new RecoveryAccessPolicy({
      ...environment,
      RECOVERY_RESTORE_MODE: 'false',
    }).evaluate();
    expect(beforeRestart).toMatchObject({ blocked: true, reason: 'RECOVERY_LOCKED' });
    expect(afterRestart).toMatchObject({ blocked: true, reason: 'RECOVERY_LOCKED' });
  });

  it.each([
    ['GET', '/api/documents/doc-1/download'],
    ['GET', '/api/reports/report-1'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/activity-data'],
  ])('blocks customer route %s %s', async (method, path) => {
    const { path: controlPath } = await controlFile();
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const next = jest.fn();
    await restoreAccessGate(
      new RecoveryAccessPolicy(recoveryEnvironment(controlPath)),
    )({ method, path } as never, { status, json } as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      code: RESTORE_ACCESS_BLOCK_CODE,
    }));
  });

  it('allowlists only health and authenticated read-only reconciliation routing', () => {
    expect(isRecoveryAllowlisted('GET', '/api/health/live')).toBe(true);
    expect(isRecoveryAllowlisted('GET', '/api/health/ready')).toBe(false);
    expect(isRecoveryAllowlisted('POST', '/api/admin/storage-reconciliation/report')).toBe(true);
    expect(isRecoveryAllowlisted('POST', '/api/admin/storage-reconciliation/purge')).toBe(false);
    expect(isRecoveryAllowlisted('POST', '/api/admin/legal-holds/activate')).toBe(false);
  });

  it('keeps normal non-recovery startup compatible', async () => {
    const missingDefault = `/tmp/carbonlite-a2-1-normal-${Date.now()}/state.json`;
    await expect(new RecoveryAccessPolicy({}, {
      defaultControlPath: missingDefault,
    }).evaluate()).resolves.toEqual({
      mode: 'NORMAL',
      blocked: false,
      reason: 'NORMAL_STARTUP',
    });
  });

  it('blocks background mutation while recovery is active', async () => {
    const { path } = await controlFile('APPROVAL_PENDING');
    await expect(new RecoveryAccessPolicy(recoveryEnvironment(path))
      .assertBackgroundMutationAllowed())
      .rejects.toThrow(RESTORE_ACCESS_BLOCK_CODE);
  });
});

async function controlFile(
  state: RecoveryControlRecord['state'] = 'RECOVERY_LOCKED',
) {
  const directory = await mkdtemp(join(tmpdir(), 'carbonlite-a2-1-gate-'));
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = join(directory, 'active-session.json');
  const now = '2026-11-05T00:00:00.000Z';
  const record: RecoveryControlRecord = {
    schemaVersion: 1,
    sessionId: 'recovery_synthetic_a21',
    pairId: 'PAIR_SYNTHETIC_A21',
    state,
    evidenceDigest: DIGEST,
    restoredDatabaseIdentity: 'db:synthetic-a21',
    restoredStorageIdentity: 'storage:synthetic-a21',
    generation: 1,
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
  return { path };
}

function recoveryEnvironment(path: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    RECOVERY_RESTORE_MODE: 'true',
    RECOVERY_CONTROL_STORE_PATH: path,
    RECOVERY_SESSION_ID: 'recovery_synthetic_a21',
    RECOVERY_PAIR_ID: 'PAIR_SYNTHETIC_A21',
    RECOVERY_EVIDENCE_DIGEST: DIGEST,
  };
}
