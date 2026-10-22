import { Controller, HttpException, INestApplication, Logger, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

@Controller('controlled')
class ControlledController {
  @Post('failure') failure() { throw new Error('secret-provider-message'); }
  @Post('expected') expected() { throw new HttpException({ message: 'Controlled unavailable', code: 'CONTROLLED' }, 503); }
}

describe('F16 actual HTTP exception logging (no database)', () => {
  let app: INestApplication;
  const dsn = process.env.SENTRY_DSN;
  beforeAll(async () => {
    delete process.env.SENTRY_DSN;
    const module = await Test.createTestingModule({ controllers: [ControlledController] }).compile();
    app = module.createNestApplication(); app.useGlobalFilters(new GlobalExceptionFilter()); await app.init();
  });
  afterAll(async () => { await app.close(); if (dsn !== undefined) process.env.SENTRY_DSN = dsn; });
  afterEach(() => jest.restoreAllMocks());
  it('retains HTTP contracts while omitting nested secrets, headers, query and source text', async () => {
    const logs = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = await request(app.getHttpServer()).post('/controlled/failure?token=secret-query')
      .set('Authorization', 'Bearer secret-jwt').set('Cookie', 'session=secret-session')
      .send({ account: { auth: { accessToken: 'secret-access', clientSecret: 'secret-client' } }, users: [{ password: 'secret-password' }], extractedSourceText: 'secret-source'.repeat(5000) }).expect(500);
    expect(response.body).toMatchObject({ statusCode: 500, message: 'Internal server error', path: '/controlled/failure?token=secret-query' });
    const output = JSON.stringify(logs.mock.calls);
    expect(output).not.toContain('secret-'); expect(output).toContain('/controlled/failure'); expect(output).toContain('500');
    expect(output.length).toBeLessThan(1024);
  });
  it('still responds when the logging sink fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => { throw Error('logger failed'); });
    const response = await request(app.getHttpServer()).post('/controlled/expected').send({ password: 'secret' }).expect(503);
    expect(response.body).toMatchObject({ message: 'Controlled unavailable', code: 'CONTROLLED', statusCode: 503 });
  });
});
