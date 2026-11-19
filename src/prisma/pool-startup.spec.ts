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
});
