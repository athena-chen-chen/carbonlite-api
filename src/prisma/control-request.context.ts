import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONTROL_REQUEST_MS } from './control-pool.configuration';

type ControlContext = { deadline: number; expired: boolean };
export const controlRequestContext = new AsyncLocalStorage<ControlContext>();
export const controlTransactionContext = new AsyncLocalStorage<boolean>();

/** Installed only on exact, server-declared control POST routes, before guards. */
@Injectable()
export class ControlRequestMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction) {
    controlRequestContext.run({ deadline: Date.now() + CONTROL_REQUEST_MS, expired: false }, next);
  }
}
