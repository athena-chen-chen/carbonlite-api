import {
  ExceptionFilter,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

export async function createE2eApp(options?: {
  globalFilters?: ExceptionFilter[];
  enableSentryDebugRoute?: boolean;
}) {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', {
    exclude: options?.enableSentryDebugRoute
      ? [{ path: 'debug/sentry', method: RequestMethod.GET }]
      : [],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  if (options?.globalFilters?.length) {
    app.useGlobalFilters(...options.globalFilters);
  }

  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
  };
}

export type E2eApp = {
  app: INestApplication;
  prisma: PrismaService;
};
