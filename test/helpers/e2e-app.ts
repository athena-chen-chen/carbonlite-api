import {
  ExceptionFilter,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { assertSafeTestDatabaseTarget } from './database-safety';
import { configureHttpSecurity } from '../../src/common/security/http-security';

export async function createE2eApp(options?: {
  globalFilters?: ExceptionFilter[];
  enableSentryDebugRoute?: boolean;
}) {
  assertSafeTestDatabaseTarget();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureHttpSecurity(app, {
    ...process.env,
    APP_ENV: 'test',
    NODE_ENV: 'test',
    LOGIN_RATE_LIMIT: '10000',
    REGISTRATION_RATE_LIMIT: '10000',
    PASSWORD_SETUP_RATE_LIMIT: '10000',
    DOCUMENT_UPLOAD_RATE_LIMIT: '10000',
    AI_EXTRACTION_RATE_LIMIT: '10000',
  });
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
