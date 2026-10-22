import type { ErrorEvent } from '@sentry/nestjs';
import { sanitizeRequestBody } from './safe-log';

// SDK integrations may attach raw requests/provider errors after captureAppError.
// Only application diagnostic metadata is allowed across the transport boundary.
export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent | null {
  try {
    const context = sanitizeRequestBody(event.contexts?.carbonlite);
    return {
      type: undefined,
      event_id: event.event_id, timestamp: event.timestamp, platform: event.platform,
      level: event.level, release: event.release, environment: event.environment,
      tags: {
        feature: String(event.tags?.feature ?? 'api').slice(0, 100),
        operation: String(event.tags?.operation ?? 'unhandled').slice(0, 100),
      },
      contexts: { carbonlite: context && typeof context === 'object' && !Array.isArray(context)
        ? context as Record<string, unknown> : { diagnostic: '[TRUNCATED]' } },
      exception: { values: [{ type: 'Error', value: 'Application exception; see diagnostic metadata' }] },
    };
  } catch { return null; }
}
