import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { captureBackendException } from '../../sentry';
import { AuthenticatedUser } from '../../auth/auth.service';

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { user?: AuthenticatedUser }>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (!this.isExpectedUserError(status)) {
      captureBackendException(exception, {
        method: request.method,
        path: request.originalUrl || request.url,
        statusCode: status,
        userId: request.user?.id,
        organizationId: request.user?.organizationId,
      });
    }

    const body = this.getResponseBody(exception);

    response.status(status).json({
      statusCode: status,
      ...body,
      path: request.originalUrl || request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private isExpectedUserError(status: number) {
    return [400, 401, 403, 404].includes(status);
  }

  private getResponseBody(exception: unknown): Record<string, unknown> {
    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        return { message: exceptionResponse };
      }
      if (
        exceptionResponse &&
        typeof exceptionResponse === 'object'
      ) {
        return exceptionResponse as Record<string, unknown>;
      }
    }

    return {
      message:
        exception instanceof Error
          ? exception.message
          : 'Internal server error',
    };
  }
}
