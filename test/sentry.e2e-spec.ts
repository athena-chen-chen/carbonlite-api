import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { createE2eApp } from './helpers/e2e-app';

describe('Sentry debug endpoint (e2e)', () => {
  let app: INestApplication;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    const e2e = await createE2eApp({
      globalFilters: [new GlobalExceptionFilter()],
      enableSentryDebugRoute: true,
    });
    app = e2e.app;
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    await app?.close();
  });

  it('throws a server error in development', async () => {
    const response = await request(app.getHttpServer())
      .get('/debug/sentry')
      .expect(500);

    expect(response.body.message).toBe('Internal server error');
  });
});
