import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { parse } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnvironment(mode, inherited = process.env) {
  if (!['neon', 'localdb'].includes(mode)) throw new Error('Choose neon or localdb.');
  const file = resolve(root, mode === 'neon' ? '.env.neon.local' : '.env.docker.local');
  let selected;
  try { selected = parse(readFileSync(file)); } catch {
    throw new Error('Selected development env file is missing or unreadable.');
  }
  let url;
  try { url = new URL(selected.DATABASE_URL); } catch {
    throw new Error('Selected file needs a valid PostgreSQL DATABASE_URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.searchParams.has('host') || url.searchParams.has('hostaddr') ||
      /prod|production|staging|stage/i.test(decodeURIComponent(url.hostname + url.pathname)) ||
      !['development', 'test'].includes(selected.NODE_ENV) ||
      !['local', 'development', 'test'].includes(selected.APP_ENV)) {
    throw new Error('Refusing an unsafe development database configuration.');
  }
  if (mode === 'localdb') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        (url.port && url.port !== '5432') || url.pathname !== '/carbonlite_dev') {
      throw new Error('Local mode requires localhost:5432/carbonlite_dev.');
    }
  } else if (!url.hostname.endsWith('.neon.tech') ||
      selected.NEON_DEVELOPMENT_HOST !== url.hostname ||
      url.searchParams.get('sslmode') !== 'require') {
    throw new Error('Neon mode requires a confirmed NEON_DEVELOPMENT_HOST and sslmode=require.');
  }
  return {
    summary: mode === 'neon' ? 'Neon development' : 'Local PostgreSQL',
    env: {
      ...inherited, ...selected,
      NODE_ENV: 'development', APP_ENV: 'local', PORT: '3333',
      DOTENV_CONFIG_PATH: file, DOTENV_CONFIG_OVERRIDE: '', DOTENV_CONFIG_QUIET: 'true',
      LOCAL_DEMO_AUTH_ENABLED: 'false',
      ALLOW_TASK7_DEV_FIXTURES: mode === 'neon' ? 'false' : (selected.ALLOW_TASK7_DEV_FIXTURES || 'false'),
      DEMO_RESET_ENABLED: 'false',
    },
  };
}

async function main() {
  const { env, summary } = loadEnvironment(process.argv[2]);
  // Fail before compiling if another backend is still serving the old mode.
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('Port 3333 is occupied. Stop the existing backend before switching modes.')));
    server.listen(3333, () => server.close(resolvePort));
  });
  console.log(`Database: ${summary}`);
  const child = spawn('npm', ['run', 'dev'], { cwd: root, env, stdio: 'inherit', detached: true });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      try { process.kill(-child.pid, signal); } catch { /* Already stopped. */ }
    });
  }
  child.on('error', () => { console.error('Could not start Nest development server.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 0; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.name === 'Error' ? error.message : 'Invalid development database configuration.');
    process.exitCode = 1;
  });
}
