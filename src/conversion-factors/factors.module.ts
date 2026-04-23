// api/src/factors/factors.module.ts
import { Module } from '@nestjs/common';
import { FactorsController } from './factors.controller';
import { FactorsService } from './factors.service';
import { PrismaService } from '../prisma/prisma.service';
import { PRISMA } from '../tokens';
import { FACTORS_SERVICE } from './factors.tokens';

@Module({
  controllers: [FactorsController],
  providers: [
    // real Prisma service (bound to PRISMA token so DI works in FactorsService)
    { provide: PRISMA, useClass: PrismaService },

    // real FactorsService instance
    FactorsService,

    // alias: FACTORS_SERVICE → the same FactorsService instance
    { provide: FACTORS_SERVICE, useExisting: FactorsService },
  ],
  exports: [FACTORS_SERVICE],
})
export class FactorsModule {}
