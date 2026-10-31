import { ForbiddenException } from '@nestjs/common';

const ENABLED = 'true';

export function assertPublicRegistrationEnabled(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.PUBLIC_REGISTRATION_ENABLED !== ENABLED) {
    throw new ForbiddenException(
      'Public registration is disabled. Please use an approved invitation.',
    );
  }
}

export function assertDemoResetRuntimeEnabled(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const runtimeEnvironment = String(
    environment.APP_ENV || environment.NODE_ENV || '',
  )
    .trim()
    .toLowerCase();

  if (
    runtimeEnvironment === 'production' ||
    environment.DEMO_RESET_ENABLED !== ENABLED
  ) {
    throw new ForbiddenException('Demo data reset is disabled.');
  }
}
