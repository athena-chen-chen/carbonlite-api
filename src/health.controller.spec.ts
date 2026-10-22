import { HealthController } from './health.controller';

describe('HealthController', () => {
  const originalEnv = process.env;
  const prisma = {
    $queryRaw: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      APP_ENV: 'production',
      NODE_ENV: 'test',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns a production-safe health response', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const controller = new HealthController(prisma as never);

    await expect(controller.getHealth()).resolves.toMatchObject({
      status: 'ok',
      service: 'carbonlite-api',
      environment: 'production',
      database: 'ok',
    });

    const response = await controller.getHealth();
    expect(response.timestamp).toEqual(expect.any(String));
    expect(response).not.toHaveProperty('databaseUrl');
  });

  it('reports database unavailable without exposing internals', async () => {
    prisma.$queryRaw.mockRejectedValue(
      new Error('postgres://user:password@example.test/carbonlite'),
    );
    const controller = new HealthController(prisma as never);

    await expect(controller.getHealth()).resolves.toMatchObject({
      status: 'ok',
      service: 'carbonlite-api',
      environment: 'production',
      database: 'unavailable',
    });
  });
});

import { HEALTH_DATABASE_TIMEOUT_MS } from './health.controller';
import { Response } from 'express';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from './prisma/prisma.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

// Only a read-only tagged query is provided: no clients, pools or mutations.
describe('explicit health probes', () => {
  const prisma = { $queryRaw: jest.fn() };
  let controller: HealthController;
  const response = { status: jest.fn() };
  const ready = () => controller.getReadiness(response as unknown as Response);

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new HealthController(prisma as never);
  });
  afterEach(() => { jest.useRealTimers(); });

  it('liveness does not access the database', () => {
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('uses only SELECT 1 on the injected client for repeated readiness requests', async () => {
    prisma.$queryRaw.mockResolvedValue([{ value: 1 }]);
    for (let i = 0; i < 5; i++) {
      await expect(ready()).resolves.toEqual({ status: 'ready', checks: { database: 'ok' } });
      expect(response.status).toHaveBeenLastCalledWith(200);
    }
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
    for (const [sql, ...parameters] of prisma.$queryRaw.mock.calls) {
      expect([...sql]).toEqual(['SELECT 1']);
      expect(parameters).toEqual([]);
    }
  });

  it('returns 503 with stable public information while liveness stays healthy', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('Prisma SELECT 1 DATABASE_URL=postgres://private:secret@internal/db'));
    await expect(ready()).resolves.toEqual({ status: 'not_ready', checks: { database: 'unavailable' } });
    expect(response.status).toHaveBeenCalledWith(503);
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(ready()).resolves.toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('bounds hung probes, shares the pending query, and recovers after it settles', async () => {
    jest.useFakeTimers();
    let resolve!: (value: unknown[]) => void;
    prisma.$queryRaw.mockReturnValue(new Promise(r => { resolve = r; }));
    const first = ready();
    const second = ready();
    const legacy = controller.getHealth();
    await jest.advanceTimersByTimeAsync(HEALTH_DATABASE_TIMEOUT_MS);
    await expect(first).resolves.toEqual({ status: 'not_ready', checks: { database: 'unavailable' } });
    await expect(second).resolves.toEqual({ status: 'not_ready', checks: { database: 'unavailable' } });
    await expect(legacy).resolves.toMatchObject({ status: 'ok', database: 'unavailable' });
    expect(response.status).toHaveBeenLastCalledWith(503);
    const retry = ready();
    await jest.advanceTimersByTimeAsync(HEALTH_DATABASE_TIMEOUT_MS);
    await retry;
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
    resolve([]);
    await jest.advanceTimersByTimeAsync(0);
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(ready()).resolves.toEqual({ status: 'ready', checks: { database: 'ok' } });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('handles rejection after the response deadline without leaking or retaining a query', async () => {
    jest.useFakeTimers();
    let reject!: (error: Error) => void;
    prisma.$queryRaw.mockReturnValue(new Promise((_resolve, r) => { reject = r; }));
    const pending = ready();
    await jest.advanceTimersByTimeAsync(HEALTH_DATABASE_TIMEOUT_MS);
    await pending;
    reject(new Error('private connection credentials'));
    await jest.advanceTimersByTimeAsync(0);
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(ready()).resolves.toMatchObject({ status: 'ready' });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('unauthenticated health HTTP contract', () => {
  let app: INestApplication;
  const prisma = { $queryRaw: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('serves public probes and preserves the legacy contract across database failure', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error');
    const warnLog = jest.spyOn(Logger.prototype, 'warn');
    for (const available of [true, false]) {
      if (available) prisma.$queryRaw.mockResolvedValue([]);
      else prisma.$queryRaw.mockRejectedValue(new Error('DATABASE_URL=postgres://private:password@internal/db Prisma SELECT 1'));
      prisma.$queryRaw.mockClear();
      await request(app.getHttpServer()).get('/api/health/live').expect(200, { status: 'ok' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      await request(app.getHttpServer()).get('/api/health/ready')
        .expect(available ? 200 : 503, {
          status: available ? 'ready' : 'not_ready',
          checks: { database: available ? 'ok' : 'unavailable' },
        });
      const legacy = await request(app.getHttpServer()).get('/api/health').expect(200);
      expect(legacy.body).toEqual({
        status: 'ok', service: 'carbonlite-api', environment: expect.any(String),
        timestamp: expect.any(String), database: available ? 'ok' : 'unavailable',
      });
    }
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
  });
});
