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
