import {
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

const CAPTURED_ERROR = Symbol('carbonlite.sentryCaptured');
const SENSITIVE_KEY_PATTERN =
  /password|token|secret|authorization|cookie|file(content|buffer)|document(content|text)|ocr(text|content)?|extracted(text|content)|raw(text|content)/i;

export type AppErrorContext = {
  feature: string;
  operation: string;
  userId?: string;
  userEmail?: string;
  organizationId?: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
};

export function captureAppError(error: unknown, context: AppErrorContext) {
  if (!process.env.SENTRY_DSN || isExpectedHttpError(error)) return;

  try {
    Sentry.withScope((scope) => {
      scope.setTag('feature', context.feature);
      scope.setTag('operation', context.operation);

      if (context.organizationId) {
        scope.setTag('organizationId', context.organizationId);
      }

      if (context.userId || context.userEmail) {
        scope.setUser({
          id: context.userId,
          email: context.userEmail,
        });
      }

      scope.setContext('carbonlite', {
        organizationId: context.organizationId,
        entityType: context.entityType,
        entityId: context.entityId,
        metadata: sanitizeMetadata(context.metadata),
      });

      Sentry.captureException(error);
      markAppErrorCaptured(error);
    });
  } catch {
    // Monitoring must never interfere with the application response.
  }
}

export function throwCapturedAppError(
  error: unknown,
  context: AppErrorContext,
  friendlyMessage: string,
): never {
  if (isExpectedHttpError(error)) {
    throw error;
  }

  captureAppError(error, context);
  const friendlyError = new InternalServerErrorException(friendlyMessage);
  markAppErrorCaptured(friendlyError);
  throw friendlyError;
}

export function addAppBreadcrumb(
  message: string,
  context: Omit<AppErrorContext, 'userId' | 'userEmail'>,
) {
  if (!process.env.SENTRY_DSN) return;

  try {
    Sentry.addBreadcrumb({
      category: context.feature,
      message,
      level: 'info',
      data: {
        operation: context.operation,
        organizationId: context.organizationId,
        entityType: context.entityType,
        entityId: context.entityId,
        metadata: sanitizeMetadata(context.metadata),
      },
    });
  } catch {
    // Monitoring must never interfere with the application response.
  }
}

export function markAppErrorCaptured(error: unknown) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;

  try {
    Object.defineProperty(error, CAPTURED_ERROR, {
      value: true,
      configurable: true,
    });
  } catch {
    // Some third-party errors may be non-extensible.
  }
}

export function wasAppErrorCaptured(error: unknown) {
  return Boolean(
    error &&
      (typeof error === 'object' || typeof error === 'function') &&
      (error as Record<PropertyKey, unknown>)[CAPTURED_ERROR],
  );
}

export function sanitizeMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return sanitizeValue(metadata, 0) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key)
        ? '[Redacted]'
        : sanitizeValue(item, depth + 1),
    ]),
  );
}

function isExpectedHttpError(error: unknown) {
  return (
    error instanceof HttpException &&
    [400, 401, 403, 404].includes(error.getStatus())
  );
}
