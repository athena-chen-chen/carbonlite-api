import { sanitizeSentryEvent } from './common/logging/sentry-event';
import 'dotenv/config';
import * as Sentry from '@sentry/nestjs';

export function initSentry() {
  const sentryDsn = process.env.SENTRY_DSN;
  if (!sentryDsn) return;

  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    beforeSend: sanitizeSentryEvent,
    environment: process.env.NODE_ENV || 'development',
    release:
      process.env.RELEASE_VERSION ||
      process.env.RENDER_GIT_COMMIT ||
      process.env.npm_package_version,
  });
}
