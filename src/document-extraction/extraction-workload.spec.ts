import { cancelExtractionAttempts, registerExtractionAttempt } from './extraction-cancellation';
import { ExtractionWorkload, EXTRACTION_TIMEOUT_MS, withExtractionDeadline } from './extraction-workload';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it('preserves process capacity by default and permits database-leased tenant work', async () => {
  const limiter = new ExtractionWorkload(); const releases = Array.from({ length: 3 }, () => deferred<void>());
  let active = 0, maximum = 0;
  const running = releases.slice(0, 2).map((release, i) => limiter.run(String(i), async () => { active++; maximum = Math.max(maximum, active); await release.promise; active--; }));
  try {
    await expect(limiter.run('0', async () => undefined)).rejects.toThrow('already running');
    await expect(limiter.run('legacy-capacity', async () => undefined)).rejects.toThrow('capacity is busy');
    running.push(limiter.run('database-leased', async () => { active++; maximum = Math.max(maximum, active); await releases[2].promise; active--; }, false));
    await Promise.resolve();
    expect(maximum).toBe(3);
  } finally { releases.forEach(release => release.resolve(undefined)); await Promise.all(running); }
  await expect(limiter.run('failure', async () => { throw Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
  await expect(limiter.run('failure', async () => 'retried')).resolves.toBe('retried');
});
it('aborts a hung provider at the deadline with a controlled timeout', async () => {
  jest.useFakeTimers(); let signal: AbortSignal | undefined;
  try {
    const pending = withExtractionDeadline(input => { signal = input; return new Promise<never>(() => undefined); });
    const assertion = expect(pending).rejects.toThrow('Extraction timed out');
    await jest.advanceTimersByTimeAsync(EXTRACTION_TIMEOUT_MS);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
it('clears the timer when a provider completes normally', async () => {
  jest.useFakeTimers();
  try { await expect(withExtractionDeadline(async () => 'ok')).resolves.toBe('ok'); expect(jest.getTimerCount()).toBe(0); }
  finally { jest.useRealTimers(); }
});

it('cancels only registered operations in the withdrawn organization and data scope', () => {
  const real = registerExtractionAttempt('synthetic-real-op', 'org-a', true);
  const synthetic = registerExtractionAttempt('synthetic-local-op', 'org-a', false);
  const other = registerExtractionAttempt('synthetic-other-op', 'org-b', true);
  try {
    cancelExtractionAttempts('org-a', true);
    expect(real.signal.aborted).toBe(true); expect(synthetic.signal.aborted).toBe(false); expect(other.signal.aborted).toBe(false);
    cancelExtractionAttempts('org-a', false);
    expect(synthetic.signal.aborted).toBe(true); expect(other.signal.aborted).toBe(false);
  } finally { real.release(); synthetic.release(); other.release(); }
});
it('forwards best-effort cancellation to the provider and removes listeners after completion', async () => {
  const controller = new AbortController(), entered = deferred<void>(), finish = deferred<string>();
  let providerSignal: AbortSignal | undefined;
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  const pending = withExtractionDeadline(async signal => { providerSignal = signal; entered.resolve(undefined); return finish.promise; }, controller.signal);
  await entered.promise; controller.abort(); expect(providerSignal?.aborted).toBe(true);
  finish.resolve('synthetic response'); await expect(pending).resolves.toBe('synthetic response');
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
it('unregisters completed attempts before later withdrawals', () => {
  const attempt = registerExtractionAttempt('synthetic-complete-op', 'org-c', true);
  attempt.release(); cancelExtractionAttempts('org-c', false); expect(attempt.signal.aborted).toBe(false);
});
