import { ConflictException, GatewayTimeoutException, HttpException, HttpStatus } from '@nestjs/common';

export const MAX_CONCURRENT_EXTRACTIONS = 2;
export const EXTRACTION_TIMEOUT_MS = 60_000;
export const MAX_PROVIDER_OUTPUT_TOKENS = 16_384;
export const MAX_PROVIDER_OUTPUT_CHARACTERS = 2 * 1024 * 1024;

/** Resource admission only: process-local, no queue or distributed correctness claim. */
export class ExtractionWorkload {
  private readonly running = new Set<string>();
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.running.has(key)) throw new ConflictException('Extraction is already running for this document. Please wait before retrying.');
    if (this.running.size >= MAX_CONCURRENT_EXTRACTIONS) throw new HttpException('Extraction capacity is busy. Please retry shortly.', HttpStatus.TOO_MANY_REQUESTS);
    this.running.add(key);
    try { return await work(); }
    finally { this.running.delete(key); }
  }
}
export const extractionWorkload = new ExtractionWorkload();

export async function withExtractionDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reject first so a synchronous abort listener cannot mask the timeout.
          reject(new GatewayTimeoutException('Extraction timed out. Please retry extraction.'));
          controller.abort();
        }, EXTRACTION_TIMEOUT_MS);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
