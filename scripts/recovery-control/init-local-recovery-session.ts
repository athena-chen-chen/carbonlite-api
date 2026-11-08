import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  DEFAULT_LOCAL_RECOVERY_CONTROL_PATH,
  RecoveryControlRecord,
  parseRecoveryControlRecord,
} from '../../src/common/security/recovery-control-store';

const DISPOSABLE_ROOT = resolve('/tmp/carbonlite-recovery-control');
const args = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf('=');
    return separator === -1
      ? [argument, '']
      : [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);

async function main() {
  if (!args.has('--local-synthetic-only') ||
      !args.has('--acknowledge-external-control-store')) {
    throw new Error(
      'Refusing to initialize recovery control state without both explicit local-only acknowledgements.',
    );
  }

  const path = resolve(args.get('--control-path') || DEFAULT_LOCAL_RECOVERY_CONTROL_PATH);
  assertDisposablePath(path);
  const now = new Date().toISOString();
  const record: RecoveryControlRecord = {
    schemaVersion: 1,
    sessionId: required('--session-id'),
    pairId: required('--pair-id'),
    state: 'RECOVERY_LOCKED',
    evidenceDigest: required('--evidence-digest'),
    restoredDatabaseIdentity: required('--database-identity'),
    restoredStorageIdentity: required('--storage-identity'),
    generation: 1,
    createdAt: now,
    updatedAt: now,
  };
  parseRecoveryControlRecord(JSON.stringify(record));

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  console.log(JSON.stringify({
    path,
    sessionId: record.sessionId,
    pairId: record.pairId,
    state: record.state,
  }));
}

function required(name: string) {
  const value = String(args.get(name) ?? '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertDisposablePath(path: string) {
  if (!isAbsolute(path)) throw new Error('Control-store path must be absolute.');
  const within = relative(DISPOSABLE_ROOT, path);
  if (!within || within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`Control-store path must be below ${DISPOSABLE_ROOT}.`);
  }
}

main().catch((error) => {
  console.error(`Recovery control initialization failed safely: ${
    error instanceof Error ? error.message : 'unknown error'
  }`);
  process.exitCode = 1;
});
