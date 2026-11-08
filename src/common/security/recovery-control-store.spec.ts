import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalFileRecoveryControlStore,
  RecoveryControlRecord,
  isA21TransitionAllowed,
  parseRecoveryControlRecord,
} from './recovery-control-store';

const DIGEST = 'a'.repeat(64);

describe('external recovery control store', () => {
  it('reads a protected, valid local synthetic record', async () => {
    const { path, record } = await controlFile();
    await expect(new LocalFileRecoveryControlStore(path).read()).resolves.toEqual(record);
  });

  it('rejects corrupt records, permissive files, and RELEASED', async () => {
    expect(() => parseRecoveryControlRecord('{not-json')).toThrow('CORRUPT_EXTERNAL_STATE');
    expect(() => parseRecoveryControlRecord(JSON.stringify({
      ...record(),
      state: 'RELEASED',
    }))).toThrow('CORRUPT_EXTERNAL_STATE');

    const { path } = await controlFile('RECOVERY_LOCKED', 0o644);
    await expect(new LocalFileRecoveryControlStore(path).read())
      .rejects.toThrow('UNREADABLE_EXTERNAL_STATE');
  });

  it('defines only locked A2-1 transitions and reserves release for A2-2', () => {
    expect(isA21TransitionAllowed('RECOVERY_LOCKED', 'RECONCILIATION_PENDING')).toBe(true);
    expect(isA21TransitionAllowed('RECONCILIATION_PENDING', 'APPROVAL_PENDING')).toBe(true);
    expect(isA21TransitionAllowed('APPROVAL_PENDING', 'RECOVERY_LOCKED')).toBe(true);
    expect(isA21TransitionAllowed('APPROVAL_PENDING', 'RELEASED')).toBe(false);
  });
});

async function controlFile(
  state: RecoveryControlRecord['state'] = 'RECOVERY_LOCKED',
  mode = 0o600,
) {
  const directory = await mkdtemp(join(tmpdir(), 'carbonlite-a2-1-'));
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = join(directory, 'active-session.json');
  const value = record(state);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode, flag: 'wx' });
  return { path, record: value };
}

function record(
  state: RecoveryControlRecord['state'] = 'RECOVERY_LOCKED',
): RecoveryControlRecord {
  return {
    schemaVersion: 1,
    sessionId: 'recovery_synthetic_a21',
    pairId: 'PAIR_SYNTHETIC_A21',
    state,
    evidenceDigest: DIGEST,
    restoredDatabaseIdentity: 'db:synthetic-a21',
    restoredStorageIdentity: 'storage:synthetic-a21',
    generation: 1,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  };
}
