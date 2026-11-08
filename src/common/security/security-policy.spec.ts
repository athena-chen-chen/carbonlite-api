import { ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertDemoResetRuntimeEnabled,
  assertPublicRegistrationEnabled,
  isLocalDemoAuthRuntimeEnabled,
} from './security-policy';

describe('security policy', () => {
  const explicitLocalDevelopment = {
    APP_ENV: 'local',
    NODE_ENV: 'development',
  };

  it('denies public registration by default and requires an approved runtime plus exact opt-in', () => {
    expect(() => assertPublicRegistrationEnabled({})).toThrow(
      ForbiddenException,
    );
    expect(() =>
      assertPublicRegistrationEnabled({
        ...explicitLocalDevelopment,
        PUBLIC_REGISTRATION_ENABLED: 'TRUE',
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertPublicRegistrationEnabled({
        ...explicitLocalDevelopment,
        PUBLIC_REGISTRATION_ENABLED: 'true',
      }),
    ).not.toThrow();
  });

  it.each([
    ['APP staging cannot mask NODE production', { APP_ENV: 'staging', NODE_ENV: 'production' }],
    ['APP production cannot be masked by NODE development', { APP_ENV: 'production', NODE_ENV: 'development' }],
    ['both production values', { APP_ENV: 'production', NODE_ENV: 'production' }],
    ['missing runtime values', {}],
    ['unknown runtime value', { APP_ENV: 'stagin', NODE_ENV: 'development' }],
  ])('fails closed for %s', (_name, runtime) => {
    const environment = {
      ...runtime,
      LOCAL_DEMO_AUTH_ENABLED: 'true',
      PUBLIC_REGISTRATION_ENABLED: 'true',
    };

    expect(isLocalDemoAuthRuntimeEnabled(environment)).toBe(false);
    expect(() => assertPublicRegistrationEnabled(environment)).toThrow(
      ForbiddenException,
    );
  });

  it('allows explicitly enabled local controls in a valid local-development runtime', () => {
    expect(
      isLocalDemoAuthRuntimeEnabled({
        ...explicitLocalDevelopment,
        LOCAL_DEMO_AUTH_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(() =>
      assertPublicRegistrationEnabled({
        ...explicitLocalDevelopment,
        PUBLIC_REGISTRATION_ENABLED: 'true',
      }),
    ).not.toThrow();
  });

  it('denies demo reset in production even when explicitly enabled', () => {
    expect(() =>
      assertDemoResetRuntimeEnabled({
        APP_ENV: 'production',
        DEMO_RESET_ENABLED: 'true',
      }),
    ).toThrow(ForbiddenException);
  });

  it('allows demo reset only when explicitly enabled outside production', () => {
    expect(() =>
      assertDemoResetRuntimeEnabled({ NODE_ENV: 'development' }),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertDemoResetRuntimeEnabled({
        NODE_ENV: 'development',
        DEMO_RESET_ENABLED: 'true',
      }),
    ).not.toThrow();
  });
});

describe('Prisma startup runtime policy', () => {
  const originalEnv = process.env;
  const connectionError = new Error('synthetic database connection failure');

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function subject(environment: NodeJS.ProcessEnv) {
    process.env = {
      ...originalEnv,
      ...environment,
      LOCAL_DEMO_AUTH_ENABLED: 'true',
      DATABASE_URL:
        'postgresql://synthetic:synthetic@127.0.0.1:5432/carbonlite_e2e',
    };
    const prisma = new PrismaService();
    jest.spyOn(prisma, '$connect').mockRejectedValue(connectionError);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    return { prisma, warning };
  }

  it.each([
    ['production', { APP_ENV: 'production', NODE_ENV: 'production' }],
    ['APP staging with NODE production', { APP_ENV: 'staging', NODE_ENV: 'production' }],
    ['APP production with NODE development', { APP_ENV: 'production', NODE_ENV: 'development' }],
  ])('fails startup on a database error in %s', async (_name, environment) => {
    const { prisma, warning } = subject(environment);

    await expect(prisma.onModuleInit()).rejects.toBe(connectionError);
    expect(warning).not.toHaveBeenCalled();
  });

  it('preserves database-optional startup for an explicit local-development demo runtime', async () => {
    const { prisma, warning } = subject({
      APP_ENV: 'local',
      NODE_ENV: 'development',
    });

    await expect(prisma.onModuleInit()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('LOCAL_DEMO_AUTH_ENABLED=true'),
    );
  });
});
