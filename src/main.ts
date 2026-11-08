import 'dotenv/config';
import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { PerfTimer, SLOW_REQUEST_THRESHOLD_MS } from './common/monitoring/performance-logging';
import { initSentry } from './sentry';
import { configureHttpSecurity } from './common/security/http-security';
import { RecoveryAccessPolicy, restoreAccessGate } from './common/security/restore-access-gate';

async function bootstrap() {
  initSentry();

  // Validate the external recovery trust boundary before Nest initializes any
  // application module. A locked/invalid recovery still starts health and the
  // explicitly allowlisted, authenticated read-only reconciliation route.
  const recoveryAccessPolicy = new RecoveryAccessPolicy(process.env);
  const recoveryStartup = await recoveryAccessPolicy.evaluate();
  if (recoveryStartup.blocked) {
    new Logger('RecoveryAccess').warn(
      `Recovery access locked reason=${recoveryStartup.reason}`,
    );
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const requestLogger = new Logger('RequestPerformance');

  app.use(restoreAccessGate(recoveryAccessPolicy));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const timer = new PerfTimer();

    res.on('finish', () => {
      const durationMs = timer.elapsedMs();
      const requestPath = typeof req.route?.path === 'string' ? req.route.path.slice(0, 256) : '[UNMATCHED]';
      const message = `${req.method} ${requestPath} ${res.statusCode} ${durationMs}ms`;

      if (durationMs > SLOW_REQUEST_THRESHOLD_MS) {
        requestLogger.warn(`SLOW ${message}`);
        return;
      }

      requestLogger.log(message);
    });

    next();
  });

  configureHttpSecurity(app);
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'debug/sentry', method: RequestMethod.GET }],
  });
  // Uploaded sources are private. Serve them only through the authenticated,
  // organization-scoped /api/documents/:id/download endpoint.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  const PORT = process.env.PORT ? Number(process.env.PORT) : 3333;
  await app.listen(PORT);
  const url = await app.getUrl();
  console.log('[CarbonLite API] Listening on', url);
}
bootstrap();
