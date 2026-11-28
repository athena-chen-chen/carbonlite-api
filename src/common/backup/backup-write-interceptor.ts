import { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { from, lastValueFrom } from 'rxjs';
import { backupWriteGate } from './backup-write-gate';

export class BackupWriteInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    if ((req.method === 'GET' || req.method === 'HEAD') && (req.path === '/api/health/live' || req.path === '/api/health/ready')) {
      return next.handle();
    }
    // Subscribe independently of the client connection. A disconnected
    // upload still owns its slot until parser cleanup and the handler settle.
    return from(backupWriteGate.run(() => lastValueFrom(next.handle())));
  }
}
