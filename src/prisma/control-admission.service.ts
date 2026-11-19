import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export class ControlPermit {
  private pending = 0;
  private responseEnded = false;
  private released = false;
  private complete!: () => void;
  readonly done = new Promise<void>(resolve => { this.complete = resolve; });
  constructor(private readonly release: () => void) {}
  track<T>(operation: Promise<T>) {
    ++this.pending;
    const settled = () => { --this.pending; this.finish(); };
    operation.then(settled, settled); // Observe both outcomes; do not create an unhandled rejection.
    return operation;
  }
  endResponse() { this.responseEnded = true; this.finish(); }
  private finish() {
    if (!this.released && this.responseEnded && this.pending === 0) {
      this.released = true; this.release(); this.complete();
    }
  }
}

/** One request (authentication AND mutation), no application waiting queue. */
@Injectable()
export class ControlAdmissionService {
  private readonly active = new Set<ControlPermit>();
  private closing = false;
  acquire() {
    if (this.closing || this.active.size >= 1) throw new ServiceUnavailableException({
      statusCode: 503, code: this.closing ? 'CONTROL_SHUTTING_DOWN' : 'CONTROL_ADMISSION_BUSY',
      message: 'Control admission unavailable. No submission was queued.', outcome: 'NOT_COMMITTED', automaticRetry: false,
    });
    const permit = new ControlPermit(() => this.active.delete(permit));
    this.active.add(permit); return permit;
  }
  async whenIdle() { await Promise.all([...this.active].map(permit => permit.done)); }
  async close() { this.closing = true; await this.whenIdle(); }
}
