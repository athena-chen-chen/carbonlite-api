import * as Sentry from '@sentry/nestjs';

const sentryDsn = process.env.SENTRY_DSN;

export function initSentry() {
  if (!sentryDsn) return;

  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV || 'development',
    release:
      process.env.RELEASE_VERSION ||
      process.env.RENDER_GIT_COMMIT ||
      process.env.npm_package_version,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  });
}

export function captureBackendException(
  exception: unknown,
  context?: Record<string, unknown>,
) {
  if (!sentryDsn) return;

  Sentry.withScope((scope) => {
    const userId = context?.userId;
    const organizationId = context?.organizationId;
    if (typeof userId === 'string' || typeof organizationId === 'string') {
      scope.setUser({
        id: typeof userId === 'string' ? userId : undefined,
        organizationId: typeof organizationId === 'string' ? organizationId : undefined,
      });
    }
    if (context) {
      scope.setContext('carbonlite', context);
    }
    Sentry.captureException(exception);
  });
}
