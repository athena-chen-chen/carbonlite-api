export const SLOW_REQUEST_THRESHOLD_MS = 1000;

export class PerfTimer {
  private readonly startedAt = process.hrtime.bigint();

  elapsedMs() {
    return elapsedMs(this.startedAt);
  }
}

export function elapsedMs(startedAt: bigint) {
  const elapsedNs = process.hrtime.bigint() - startedAt;
  return Number(elapsedNs / BigInt(1_000_000));
}

export async function timeAsync<T>(
  action: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const timer = new PerfTimer();
  const result = await action();
  return { result, durationMs: timer.elapsedMs() };
}

export function timeSync<T>(
  action: () => T,
): { result: T; durationMs: number } {
  const timer = new PerfTimer();
  const result = action();
  return { result, durationMs: timer.elapsedMs() };
}
