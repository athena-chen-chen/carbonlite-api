import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ControlAdmissionService, ControlPermit } from './control-admission.service';
import { prototypePoolConfiguration, CONTROL_REQUEST_MS } from './control-pool.configuration';

type ControlContext = { deadline: number; expired: boolean; permit?: ControlPermit };
export const controlRequestContext = new AsyncLocalStorage<ControlContext>();
export const controlTransactionContext = new AsyncLocalStorage<boolean>();

/** Installed only on exact, server-declared control POST routes, before guards. */
@Injectable()
export class ControlRequestMiddleware implements NestMiddleware {
  constructor(private readonly admission: ControlAdmissionService) {}
  use(_request: Request, response: Response, next: NextFunction) {
    if (!prototypePoolConfiguration()) return next();
    try {
      const permit = this.admission.acquire();
      response.once('finish', () => permit.endResponse());
      response.once('close', () => permit.endResponse());
      controlRequestContext.run({ deadline: Date.now() + CONTROL_REQUEST_MS, expired: false, permit }, next);
    } catch (error) { next(error); }
  }
}
