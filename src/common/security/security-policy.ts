import { ForbiddenException } from '@nestjs/common';

const ENABLED = 'true';
const APPROVED_NON_PRODUCTION_RUNTIMES = new Set([
  'local',
  'development',
  'test',
]);

export function assertPublicRegistrationEnabled(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (
    !isApprovedNonProductionRuntime(environment) ||
    environment.PUBLIC_REGISTRATION_ENABLED !== ENABLED
  ) {
    throw new ForbiddenException(
      'Public registration is disabled. Please use an approved invitation.',
    );
  }
}

export function isLocalDemoAuthRuntimeEnabled(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (
    isApprovedNonProductionRuntime(environment) &&
    environment.LOCAL_DEMO_AUTH_ENABLED === ENABLED
  );
}

export function assertDemoResetRuntimeEnabled(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (
    !isApprovedNonProductionRuntime(environment) ||
    environment.DEMO_RESET_ENABLED !== ENABLED
  ) {
    throw new ForbiddenException('Demo data reset is disabled.');
  }
}

function isProductionRuntime(environment: NodeJS.ProcessEnv) {
  return runtimeValues(environment).includes('production');
}

function isApprovedNonProductionRuntime(environment: NodeJS.ProcessEnv) {
  const values = runtimeValues(environment);
  return (
    values.length > 0 &&
    !isProductionRuntime(environment) &&
    values.every((value) => APPROVED_NON_PRODUCTION_RUNTIMES.has(value))
  );
}

function runtimeValues(environment: NodeJS.ProcessEnv) {
  return [environment.APP_ENV, environment.NODE_ENV]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
}
