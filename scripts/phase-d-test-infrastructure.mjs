// Explicit disposable-local infrastructure only; no application environment is read.
import { execFileSync } from 'node:child_process';
const pg = 'carbonlite-d-release-pg', pool = 'carbonlite-d-release-pooler', network = 'carbonlite-d-release-net';
const label = 'carbonlite.phase-d.disposable=true';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const mode = process.argv[2];
if (mode === 'up') {
  // Existing names or occupied loopback ports fail; never replace unknown resources.
  docker('network', 'create', '--label', label, network);
  try {
    docker('run', '--name', pg, '--label', label, '--network', network, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=carbonlite_ci_test',
      '-p', '127.0.0.1:55447:5432', '-d', 'postgres:16');
    docker('run', '--name', pool, '--label', label, '--network', network, '-e', `DB_HOST=${pg}`, '-e', 'DB_USER=postgres', '-e', 'DB_PASSWORD=postgres',
      '-e', 'DB_NAME=carbonlite_ci_test', '-e', 'AUTH_TYPE=scram-sha-256', '-e', 'POOL_MODE=transaction', '-e', 'DEFAULT_POOL_SIZE=2',
      '-e', 'MAX_CLIENT_CONN=30', '-e', 'ADMIN_USERS=postgres', '-p', '127.0.0.1:55448:5432', '-d',
      'edoburu/pgbouncer@sha256:53d98b3174b0842c475b9842fb0a733b2d9f7ec9da834ec42252aa553f48c628');
    console.log('Disposable Phase D PostgreSQL/PgBouncer created on loopback ports 55447/55448.');
  } catch { throw new Error('Disposable fixture creation failed; inspect only the named fixture resources. No automatic deletion attempted.'); }
} else if (mode === 'down') {
  for (const name of [pool, pg]) {
    if (docker('inspect', '-f', '{{ index .Config.Labels "carbonlite.phase-d.disposable" }}', name).trim() !== 'true') throw new Error('Refusing to remove an unlabelled resource.');
  }
  if (docker('network', 'inspect', '-f', '{{ index .Labels "carbonlite.phase-d.disposable" }}', network).trim() !== 'true') throw new Error('Refusing to remove an unlabelled network.');
  for (const name of [pool, pg]) { docker('stop', name); docker('rm', name); }
  docker('network', 'rm', network); console.log('Disposable Phase D fixtures removed.');
} else throw new Error('Use up or down. No default action.');
