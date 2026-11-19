import { ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

type Event = { event: string; port?: number; pid?: number; status?: number; code?: string };
export async function controlProcess(mode: string, environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [join(process.cwd(), 'test/helpers/control-process.cjs'), mode], {
    cwd: process.cwd(), env: { ...process.env, ...environment, APP_ENV: 'test', NODE_ENV: 'test', LOCAL_CONTROL_POOL_PROTOTYPE: 'true' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const events: Event[] = [], waiters = new Set<() => void>();
  const exited = new Promise<void>(resolve => child.once('exit', () => { resolve(); for (const wake of waiters) wake(); }));
  child.on('message', (event: Event) => { events.push(event); for (const wake of waiters) wake(); });
  function wait(event: string): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(check); reject(new Error('Subprocess barrier timeout: ' + event)); }, 10000);
      function check() {
        const index = events.findIndex(value => value.event === event);
        if (index >= 0) { clearTimeout(timeout); waiters.delete(check); resolve(events.splice(index, 1)[0]); }
        else if (events.some(value => value.event === 'fatal') || child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timeout); waiters.delete(check); reject(new Error('Subprocess ended before barrier: ' + event));
        }
      }
      waiters.add(check); check();
    });
  }
  async function kill(signal: NodeJS.Signals = 'SIGKILL') { if (child.exitCode === null && child.signalCode === null) child.kill(signal); await exited; }
  try {
    const ready = await wait('ready');
    return { child: child as ChildProcess, wait, exited, kill, events,
      request: (route: string, token: string, body?: unknown, method = 'POST') => fetch(`http://127.0.0.1:${ready.port}/api/${route}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async response => ({ status: response.status, body: await response.json() })).catch(() => ({ status: 0, body: null })) };
  } catch (error) { await kill(); throw error; }
}
