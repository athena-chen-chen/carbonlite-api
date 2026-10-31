import { ForbiddenException } from '@nestjs/common';
import {
  assertDemoResetRuntimeEnabled,
  assertPublicRegistrationEnabled,
} from './security-policy';

describe('security policy', () => {
  it('denies public registration by default and only accepts an exact opt-in', () => {
    expect(() => assertPublicRegistrationEnabled({})).toThrow(
      ForbiddenException,
    );
    expect(() =>
      assertPublicRegistrationEnabled({ PUBLIC_REGISTRATION_ENABLED: 'TRUE' }),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertPublicRegistrationEnabled({ PUBLIC_REGISTRATION_ENABLED: 'true' }),
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
