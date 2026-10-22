import { ExtractionWorkload, EXTRACTION_TIMEOUT_MS, MAX_CONCURRENT_EXTRACTIONS, withExtractionDeadline } from './extraction-workload';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it('caps simultaneous work, prevents duplicate keys, and releases capacity after success and failure', async () => {
  const limiter = new ExtractionWorkload(); const releases = Array.from({ length: MAX_CONCURRENT_EXTRACTIONS }, () => deferred<void>());
  let active = 0, maximum = 0;
  const running = releases.map((release, i) => limiter.run(String(i), async () => { active++; maximum = Math.max(maximum, active); await release.promise; active--; }));
  try {
    await expect(limiter.run('0', async () => undefined)).rejects.toThrow('already running');
    await expect(limiter.run('overflow', async () => undefined)).rejects.toThrow('capacity');
    expect(maximum).toBe(MAX_CONCURRENT_EXTRACTIONS);
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
