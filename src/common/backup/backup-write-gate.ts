import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceUnavailableException } from '@nestjs/common';

export class BackupWriteGate {
  private active = 0;
  private readonly admission = new AsyncLocalStorage<{ active: boolean }>();
  private owner?: object;
  private drained?: () => void;

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.owner && !this.admission.getStore()?.active) {
      throw new ServiceUnavailableException({
        code: 'BACKUP_WRITE_PAUSED',
        message: 'Operation unavailable during a backup window.',
      });
    }
    const scope = { active: true };
    this.active++;
    try {
      return await this.admission.run(scope, work);
    } finally {
      scope.active = false;
      this.active--;
      if (this.active === 0) this.drained?.();
    }
  }

  acquire(owner: object): Promise<void> | undefined {
    if (this.owner) return;
    this.owner = owner;
    if (this.active === 0) return Promise.resolve();
    return new Promise(resolve => { this.drained = resolve; });
  }

  release(owner: object): boolean {
    if (this.owner !== owner) return false;
    this.owner = undefined;
    this.drained?.();
    this.drained = undefined;
    return true;
  }

  ready(owner: object): boolean {
    return this.owner === owner && this.active === 0;
  }
}

// A persistent Render disk has one serving process. Out-of-process writers
// must be excluded independently before a capture may be accepted.
export const backupWriteGate = new BackupWriteGate();
