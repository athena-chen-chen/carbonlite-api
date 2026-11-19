import {
  ExceptionFilter,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { assertSafeTestDatabaseTarget } from './database-safety';
import { configureHttpSecurity } from '../../src/common/security/http-security';

export async function createE2eApp(options?: {
  globalFilters?: ExceptionFilter[];
  enableSentryDebugRoute?: boolean;
  beforeInit?: (app: INestApplication) => void;
}) {
  assertSafeTestDatabaseTarget();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
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

  options?.beforeInit?.(app);
  await app.init();
  // Own one ready loopback listener for the fixture lifetime. Supertest must
  // not repeatedly bind/close this server between requests under suite pressure.
  await app.listen(0, '127.0.0.1');

  return {
    app,
    prisma: app.get(PrismaService),
  };
}

export type E2eApp = {
  app: INestApplication;
  prisma: PrismaService;
};
