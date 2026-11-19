import { ControlDatabaseService } from './control-database.service';
import { ControlRequestMiddleware } from './control-request.context';
// api/src/prisma/prisma.module.ts
import { Global, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, ControlDatabaseService, ControlRequestMiddleware],
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
