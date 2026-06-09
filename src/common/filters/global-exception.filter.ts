import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../../auth/auth.service';
import {
  captureAppError,
  wasAppErrorCaptured,
} from '../monitoring/capture-app-error';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
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
