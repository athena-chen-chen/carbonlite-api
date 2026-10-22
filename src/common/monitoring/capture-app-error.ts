import { sanitizeRequestBody, safeErrorSummary } from '../logging/safe-log';
import {
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

const CAPTURED_ERROR = Symbol('carbonlite.sentryCaptured');
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
        error: safeErrorSummary(error),
        organizationId: context.organizationId,
        entityType: context.entityType,
        entityId: context.entityId,
        metadata: sanitizeMetadata(context.metadata),
      });

      // Never hand provider errors (config, headers, response data, stack) to the SDK.
      Sentry.captureException(new Error(JSON.stringify(safeErrorSummary(error))));
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
  const result = sanitizeRequestBody(metadata);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown> : { diagnostic: '[TRUNCATED]' };
}

function isExpectedHttpError(error: unknown) {
  return (
    error instanceof HttpException &&
    [400, 401, 403, 404, 409].includes(error.getStatus())
  );
}
