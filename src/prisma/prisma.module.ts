import { ControlAdmissionService } from './control-admission.service';
import { ControlDatabaseService } from './control-database.service';
import { ControlRequestMiddleware } from './control-request.context';
// api/src/prisma/prisma.module.ts
import { Global, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { prototypePoolConfiguration } from './control-pool.configuration';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: async () => {
      const work = new PrismaService();
      if (prototypePoolConfiguration()) await work.initializeVerified();
      return work;
    } },
    { provide: ControlDatabaseService, inject: [PrismaService, ControlAdmissionService], useFactory: async (work: PrismaService, admission: ControlAdmissionService) => {
      let control: ControlDatabaseService | undefined;
      try { control = new ControlDatabaseService(work, admission); await control.initializeVerified(); return control; }
      catch { await Promise.allSettled([work.$disconnect(), control?.onModuleDestroy()]); throw new Error('Database pools did not activate.'); }
    } }, ControlAdmissionService, ControlRequestMiddleware],
  exports: [PrismaService, ControlDatabaseService],
})
export class PrismaModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ControlRequestMiddleware).forRoutes(
      { path: 'admin/organizations/:organizationId/real-data-authorization/withdraw', method: RequestMethod.POST },
      { path: 'admin/organizations/:organizationId/ai-authorization/withdraw', method: RequestMethod.POST },
      { path: 'admin/customer-provisioning/suspend', method: RequestMethod.POST },
    );
  }
}
