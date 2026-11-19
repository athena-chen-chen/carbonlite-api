import { HttpException, Injectable, InternalServerErrorException, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { CONTROL_ACQUIRE_MS, CONTROL_LOCK_WAIT_MS, CONTROL_REQUEST_MS, CONTROL_TRANSACTION_MS, prototypePoolConfiguration, prototypePoolOptions } from './control-pool.configuration';
import { controlRequestContext, controlTransactionContext } from './control-request.context';

function unavailable(code: string, uncertain = false) {
  return new ServiceUnavailableException({ statusCode: 503, code,
    message: uncertain ? 'Control operation outcome is uncertain. Reconcile authoritative state before another submission.' : 'Control operation could not complete within its budget.',
    outcome: uncertain ? 'UNKNOWN' : 'NOT_COMMITTED', reconciliationRequired: uncertain, automaticRetry: false });
}

@Injectable()
export class ControlDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlDatabaseService.name);
  readonly enabled = prototypePoolConfiguration() !== null;
  private readonly client = this.enabled ? new PrismaClient(prototypePoolOptions('control')) : undefined;
  constructor(private readonly work: PrismaService) {}

  async onModuleInit() {
    if (!this.client) return;
    try { await this.client.$connect(); }
    catch { throw new Error('Local control-pool connection unavailable. No Work Pool fallback is permitted.'); }
  }
  async onModuleDestroy() { await this.client?.$disconnect(); }
  isControlRequest() { return this.enabled && !!controlRequestContext.getStore(); }

  async authenticate<T>(work: (tx: Pick<Prisma.TransactionClient, 'user'>) => Promise<T>): Promise<T> {
    if (!this.enabled) return work(this.work);
    return this.transaction('AUTHENTICATION', work, 1000);
  }

  async transaction<T>(operation: string, work: (tx: Prisma.TransactionClient) => Promise<T>, budget = CONTROL_TRANSACTION_MS): Promise<T> {
    // Flag-off is an explicit legacy mode, not a failure fallback. It does not
    // instantiate a control client or claim capacity isolation.
    if (!this.enabled) return this.work.$transaction(work);
    if (!this.client) throw unavailable('CONTROL_POOL_UNAVAILABLE');
    if (controlTransactionContext.getStore()) throw unavailable('CONTROL_NESTED_TRANSACTION_REJECTED');
    const context = controlRequestContext.getStore() ?? { deadline: Date.now() + CONTROL_REQUEST_MS, expired: false };
    const remaining = context.deadline - Date.now();
    if (context.expired || remaining <= 0) throw unavailable('CONTROL_REQUEST_DEADLINE');
    const started = Date.now();
    let entered = false, callbackCompleted = false, acquisitionMs = -1, timer: ReturnType<typeof setTimeout> | undefined;
    let outcome = 'FAILED';
    const transactionMs = Math.max(1, Math.min(budget, remaining - CONTROL_ACQUIRE_MS));
    try {
      const pending = this.client.$transaction(async tx => {
        entered = true;
        acquisitionMs = Date.now() - started;
        const transactionDeadline = Date.now() + transactionMs;
        if (context.expired || Date.now() >= context.deadline) throw unavailable('CONTROL_REQUEST_DEADLINE');
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${CONTROL_LOCK_WAIT_MS}ms`}, true)`;
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${transactionMs}ms`}, true)`;
        const result = await controlTransactionContext.run(true, () => work(tx));
        if (Date.now() >= transactionDeadline) throw unavailable('CONTROL_TRANSACTION_TIMEOUT');
        if (context.expired || Date.now() >= context.deadline) throw unavailable('CONTROL_REQUEST_DEADLINE');
        callbackCompleted = true;
        return result;
      }, { maxWait: Math.max(1, Math.min(CONTROL_ACQUIRE_MS, remaining)), timeout: transactionMs,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { context.expired = true; reject(unavailable('CONTROL_OUTCOME_UNCERTAIN', true)); }, remaining);
      })]);
      outcome = 'COMMITTED';
      return result;
    } catch (error) {
      // A callback that returned may have committed despite a lost response.
      // Never retry or report durable success on an ambiguous acknowledgement.
      if (callbackCompleted || context.expired) { outcome = 'UNKNOWN'; throw unavailable('CONTROL_OUTCOME_UNCERTAIN', true); }
      if (error instanceof HttpException) throw error;
      const code = (error as { code?: string })?.code;
      const sqlCode = (error as { meta?: { code?: string } })?.meta?.code;
      if (!entered) throw unavailable('CONTROL_CAPACITY_UNAVAILABLE');
      if (sqlCode === '55P03') throw unavailable('CONTROL_FENCE_BUSY');
      if (code === 'P2028' || sqlCode === '57014') throw unavailable('CONTROL_TRANSACTION_TIMEOUT');
      throw new InternalServerErrorException({ statusCode: 500, code: 'CONTROL_TRANSACTION_FAILED',
        message: 'Control transaction failed. No automatic retry was performed.', automaticRetry: false });
    } finally {
      clearTimeout(timer);
      // Fixed labels/numeric timing only. No actor, document, SQL, URL or error payload.
      const label = ['AUTHENTICATION', 'REAL_DATA_WITHDRAWAL', 'AI_WITHDRAWAL', 'CUSTOMER_SUSPENSION'].includes(operation) ? operation : 'CONTROL';
      this.logger.log(`operation=${label} outcome=${outcome} durationMs=${Date.now() - started} acquisitionMs=${acquisitionMs}`);
    }
  }
}

/** Manually constructed legacy unit subjects may omit the optional provider.
 * Enabled prototype mode never falls back if wiring or control capacity fails. */
export function runControlOperation<T>(control: ControlDatabaseService | undefined, work: PrismaService,
  operation: string, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (control) return control.transaction(operation, callback);
  if (prototypePoolConfiguration()) throw unavailable('CONTROL_POOL_UNAVAILABLE');
  return work.$transaction(callback);
}
