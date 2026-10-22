import { Test } from '@nestjs/testing';
import { createE2eApp } from './e2e-app';
import { PrismaService } from '../../src/prisma/prisma.service';

// A minimal Nest module exercises the actual compile/init lifecycle without a DB.
jest.mock('../../src/prisma/prisma.service', () => ({
  PrismaService: jest.fn().mockImplementation(() => ({
    $connect: jest.fn(),
    async onModuleInit() { await this.$connect(); },
  })),
}));
jest.mock('../../src/app.module', () => {
  const { Module } = jest.requireActual('@nestjs/common');
  const { PrismaService } = jest.requireMock('../../src/prisma/prisma.service');
  class AppModule {}
  Module({ providers: [PrismaService] })(AppModule);
  return { AppModule };
});

describe('guard before Nest/Prisma bootstrap (also used by single E2E files)', () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it.each([undefined, 'malformed', 'postgresql://prod.example.com/carbonlite',
    'postgresql://localhost/carbonlite_staging', 'postgresql://localhost/carbonlite_dev'])(
    'rejects %s before construction, connection, or destructive setup', async value => {
      if (value === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = value;
      const compile = jest.spyOn(Test, 'createTestingModule');
      const destructiveSetup = jest.fn();
      await expect((async () => {
        await createE2eApp();
        destructiveSetup();
      })()).rejects.toThrow('REFUSING TO RUN DATABASE-MUTATING TESTS');
      expect(compile).not.toHaveBeenCalled();
      expect(PrismaService).not.toHaveBeenCalled();
      expect(destructiveSetup).not.toHaveBeenCalled();
    },
  );

  it('allows safe target through real Nest compile/init to the mocked Prisma connect', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost/carbonlite_e2e';
    const { app, prisma } = await createE2eApp();
    try {
      expect(PrismaService).toHaveBeenCalledTimes(1);
      expect(prisma.$connect).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
