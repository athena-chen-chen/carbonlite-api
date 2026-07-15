import 'dotenv/config';
import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NextFunction, Request, Response } from 'express';
import { join } from 'path';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { PerfTimer, SLOW_REQUEST_THRESHOLD_MS } from './common/monitoring/performance-logging';
import { initSentry } from './sentry';

async function bootstrap() {
  initSentry();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const requestLogger = new Logger('RequestPerformance');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const timer = new PerfTimer();

    res.on('finish', () => {
      const durationMs = timer.elapsedMs();
      const requestPath = (req.originalUrl || req.url).split('?')[0];
      const message = `${req.method} ${requestPath} ${res.statusCode} ${durationMs}ms`;

      if (durationMs > SLOW_REQUEST_THRESHOLD_MS) {
        requestLogger.warn(`SLOW ${message}`);
        return;
      }

      requestLogger.log(message);
    });

    next();
  });

  app.enableCors();
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'debug/sentry', method: RequestMethod.GET }],
  });
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads',
  });
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
