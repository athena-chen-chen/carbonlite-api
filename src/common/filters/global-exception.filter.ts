import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../../auth/auth.service';
import {
  captureAppError,
  wasAppErrorCaptured,
} from '../monitoring/capture-app-error';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (
      status >= HttpStatus.INTERNAL_SERVER_ERROR &&
      !wasAppErrorCaptured(exception)
    ) {
      captureAppError(exception, {
        feature: 'api',
        operation: 'unhandled-request',
        userId: request.user?.id,
        userEmail: request.user?.email,
        organizationId: request.user?.organizationId,
        metadata: {
          route: request.originalUrl || request.url,
          method: request.method,
          statusCode: status,
        },
      });
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        [
          `${request.method} ${request.originalUrl || request.url} failed with ${status}`,
          getErrorMessage(exception),
          `body=${JSON.stringify(sanitizeRequestBody(request.body))}`,
        ].join(' '),
        getErrorStack(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      ...this.getResponseBody(exception, status),
      path: request.originalUrl || request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private getResponseBody(
    exception: unknown,
    status: number,
  ): Record<string, unknown> {
    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        return { message: exceptionResponse };
      }

      if (exceptionResponse && typeof exceptionResponse === 'object') {
        return exceptionResponse as Record<string, unknown>;
      }
    }

    return {
      message:
        status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Internal server error'
          : 'Request failed',
    };
  }
}

function getErrorMessage(exception: unknown) {
  if (exception instanceof Error) return exception.message;
  return String(exception);
}

function getErrorStack(exception: unknown) {
  return exception instanceof Error ? exception.stack : undefined;
}

function sanitizeRequestBody(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;

  const sensitiveKeys = new Set([
    'password',
    'passwordHash',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
  ]);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) => [
      key,
      sensitiveKeys.has(key.toLowerCase()) ? '[REDACTED]' : fieldValue,
    ]),
  );
}
