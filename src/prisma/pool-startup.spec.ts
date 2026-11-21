import { Test } from '@nestjs/testing';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';
import { ControlDatabaseService } from './control-database.service';

describe('awaited pool startup failure', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original, APP_ENV: 'test', NODE_ENV: 'test', LOCAL_CONTROL_POOL_PROTOTYPE: 'true',
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/carbonlite_test' }; });
  afterEach(() => { process.env = original; jest.restoreAllMocks(); });
  it('closes Work and the constructed Control instance before module initialization can proceed', async () => {
    const work = { $disconnect: jest.fn().mockResolvedValue(undefined) };
    jest.spyOn(ControlDatabaseService.prototype, 'initializeVerified').mockRejectedValue(new Error('Synthetic identity failure'));
    const close = jest.spyOn(ControlDatabaseService.prototype, 'onModuleDestroy').mockResolvedValue();
    await expect(Test.createTestingModule({ imports: [PrismaModule] }).overrideProvider(PrismaService).useValue(work).compile()).rejects.toThrow('Database pools did not activate');
    expect(work.$disconnect).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });
  it('closes a Work client whose own identity verification fails', async () => {
    const work = new PrismaService();
    jest.spyOn(work, '$connect').mockResolvedValue();
    jest.spyOn(work, '$transaction').mockRejectedValue(new Error('Synthetic untrusted driver payload'));
    const close = jest.spyOn(work, '$disconnect').mockResolvedValue();
    await expect(work.initializeVerified()).rejects.toThrow('Work Pool activation failed'); expect(close).toHaveBeenCalledTimes(1);
  });
  it.each([['P1001', 'CONNECTION'], ['P1011', 'TLS'], ['P1002', 'TIMEOUT'], ['P2024', 'CAPACITY'], ['P2028', 'UNKNOWN']])(
    'reports CONNECT phase and sanitized category for %s without retry or fallback', async (code, category) => {
      const work = new PrismaService();
      const connect = jest.spyOn(work, '$connect').mockRejectedValue({ code, message: 'postgresql://synthetic:secret@fixture.invalid/private', cause: 'synthetic-token' });
      const transaction = jest.spyOn(work, '$transaction');
      const close = jest.spyOn(work, '$disconnect').mockResolvedValue();
      const first = work.initializeVerified();
      await expect(first).rejects.toThrow(`phase=CONNECT category=${category}`);
      await expect(first).rejects.not.toThrow('synthetic');
      await expect(work.initializeVerified()).rejects.toThrow(`phase=CONNECT category=${category}`);
      expect(connect).toHaveBeenCalledTimes(1); expect(transaction).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves IDENTITY timeout category across both wrappers', async () => {
    const work = new PrismaService();
    jest.spyOn(work, '$connect').mockResolvedValue();
    jest.spyOn(work, '$transaction').mockRejectedValue({ code: 'P1008', message: 'synthetic-secret' });
    const close = jest.spyOn(work, '$disconnect').mockResolvedValue();
    await expect(work.initializeVerified()).rejects.toThrow('phase=IDENTITY category=TIMEOUT');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('reports an inspected identity mismatch without emitting returned identity values', async () => {
    const work = new PrismaService();
    jest.spyOn(work, '$connect').mockResolvedValue();
    jest.spyOn(work, '$transaction').mockImplementation(async callback => callback({
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest.fn().mockResolvedValue([{ database: 'synthetic-secret', role: 'owner', session: 'owner', elevated: true }]),
    } as never));
    jest.spyOn(work, '$disconnect').mockResolvedValue();
    await expect(work.initializeVerified()).rejects.toThrow('phase=IDENTITY category=IDENTITY_MISMATCH');
    await expect(work.initializeVerified()).rejects.not.toThrow('synthetic-secret');
  });
});
