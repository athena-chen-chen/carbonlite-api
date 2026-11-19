import { Logger } from '@nestjs/common';
import { ControlDatabaseService, runControlOperation } from './control-database.service';
import { PrismaService } from './prisma.service';
import { controlRequestContext, controlTransactionContext } from './control-request.context';

// Unit tests never connect; PostgreSQL budget/rollback proofs live in E2E.
describe('control database ownership', () => {
  const previous = process.env.LOCAL_CONTROL_POOL_PROTOTYPE;
  const work = { $transaction: jest.fn() };
  beforeEach(() => { delete process.env.LOCAL_CONTROL_POOL_PROTOTYPE; jest.clearAllMocks(); jest.spyOn(Logger.prototype, 'log').mockImplementation(); });
  afterEach(() => { jest.restoreAllMocks(); if (previous === undefined) delete process.env.LOCAL_CONTROL_POOL_PROTOTYPE; else process.env.LOCAL_CONTROL_POOL_PROTOTYPE = previous; });
  function enabled(client: unknown) {
    const subject = new ControlDatabaseService(work as unknown as PrismaService);
    Object.assign(subject, { enabled: true, client }); return subject;
  }
  it('creates no control client in explicit legacy mode', async () => {
    const subject = new ControlDatabaseService(work as unknown as PrismaService);
    expect(subject.enabled).toBe(false); expect(subject.isControlRequest()).toBe(false);
    work.$transaction.mockResolvedValue('legacy'); expect(await subject.transaction('CONTROL', jest.fn())).toBe('legacy');
    await subject.onModuleInit(); await subject.onModuleDestroy();
  });
  it('does not fall back when control acquisition fails', async () => {
    const subject = enabled({ $transaction: jest.fn().mockRejectedValue(new Error('synthetic acquisition failure')) });
    await expect(subject.transaction('CONTROL', jest.fn())).rejects.toMatchObject({ response: { code: 'CONTROL_CAPACITY_UNAVAILABLE', automaticRetry: false } });
    expect(work.$transaction).not.toHaveBeenCalled();
  });
  it('rejects nested control transactions before acquiring a connection', async () => {
    const client = { $transaction: jest.fn() }, subject = enabled(client);
    await controlTransactionContext.run(true, async () => {
      await expect(subject.transaction('CONTROL', jest.fn())).rejects.toMatchObject({ response: { code: 'CONTROL_NESTED_TRANSACTION_REJECTED' } });
    });
    expect(client.$transaction).not.toHaveBeenCalled(); expect(work.$transaction).not.toHaveBeenCalled();
  });
  it('rejects an expired request before acquisition', async () => {
    const client = { $transaction: jest.fn() }, subject = enabled(client);
    await controlRequestContext.run({ expired: false, deadline: Date.now() - 1 }, async () => {
      await expect(subject.transaction('CONTROL', jest.fn())).rejects.toMatchObject({ response: { code: 'CONTROL_REQUEST_DEADLINE' } });
    }); expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('disconnects its owning client and fails initialization without leaking errors', async () => {
    const client = { $connect: jest.fn().mockRejectedValue(new Error('synthetic secret placeholder')), $disconnect: jest.fn().mockResolvedValue(undefined) }, subject = enabled(client);
    await expect(subject.onModuleInit()).rejects.toThrow('No Work Pool fallback');
    await subject.onModuleDestroy(); expect(client.$disconnect).toHaveBeenCalledTimes(2); expect(work.$transaction).not.toHaveBeenCalled();
  });
  it('rejects missing enabled-mode wiring instead of silently using Work', async () => {
    const saved = { app: process.env.APP_ENV, node: process.env.NODE_ENV, database: process.env.DATABASE_URL };
    try {
      process.env.LOCAL_CONTROL_POOL_PROTOTYPE = 'true'; process.env.APP_ENV = 'test'; process.env.NODE_ENV = 'test';
      process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1/carbonlite_ci_test';
      expect(() => runControlOperation(undefined, work as unknown as PrismaService, 'CONTROL', jest.fn()))
        .toThrow('Control operation could not complete within its budget.');
      expect(work.$transaction).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of [['APP_ENV', saved.app], ['NODE_ENV', saved.node], ['DATABASE_URL', saved.database]]) {
        if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
      }
    }
  });
  it('uses only the supplied owning transaction', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const client = { $transaction: jest.fn(async callback => callback(tx)) }, subject = enabled(client), callback = jest.fn(async value => { expect(value).toBe(tx); return 'committed'; });
    expect(await subject.transaction('CONTROL', callback)).toBe('committed'); expect(callback).toHaveBeenCalledTimes(1);
    expect(client.$transaction).toHaveBeenCalledTimes(1); expect(work.$transaction).not.toHaveBeenCalled();
  });
  it('preserves legacy manually constructed unit subjects only when the gate is off', async () => {
    work.$transaction.mockResolvedValue('legacy'); expect(await runControlOperation(undefined, work as unknown as PrismaService, 'CONTROL', jest.fn())).toBe('legacy');
  });
  it('reports UNKNOWN when the callback returned before a P2028 transaction rejection', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const client = { $transaction: jest.fn(async callback => { await callback(tx); throw Object.assign(new Error('Synthetic late transaction rejection'), { code: 'P2028' }); }) };
    await expect(enabled(client).transaction('CONTROL', async () => 'prepared')).rejects.toMatchObject({ response: { code: 'CONTROL_OUTCOME_UNCERTAIN', outcome: 'UNKNOWN', automaticRetry: false } });
  });
  it('reports known timeout when P2028 rejects inside the callback before completion', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const client = { $transaction: jest.fn(async callback => callback(tx)) };
    await expect(enabled(client).transaction('CONTROL', async () => { throw Object.assign(new Error('Synthetic expired transaction'), { code: 'P2028' }); })).rejects.toMatchObject({ response: { code: 'CONTROL_TRANSACTION_TIMEOUT', outcome: 'NOT_COMMITTED', automaticRetry: false } });
  });

});
