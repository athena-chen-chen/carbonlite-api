import { randomUUID } from 'node:crypto';
import { CorrelatedRequest, DocumentDeleteReconciliationError, validRequestId, writeDeleteDiagnostic } from '../monitoring/document-delete-diagnostics';
import { writeSafeError } from '../logging/safe-log';
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
    const request = http.getRequest<CorrelatedRequest & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const deletion = request.method === 'DELETE' && /^\/(?:api\/)?documents\/:id$/.test(request.route?.path ?? '');
    const requestId = validRequestId(request.requestId) ? request.requestId : randomUUID();
    try {
      if (deletion) {
        writeDeleteDiagnostic(this.logger, exception, requestId, status);
      } else {
        const route = typeof request.route?.path === 'string'
          ? request.route.path.slice(0, 256) : '[UNMATCHED]';
        if (status >= HttpStatus.INTERNAL_SERVER_ERROR && !wasAppErrorCaptured(exception)) {
          captureAppError(exception, {
            feature: 'api',
            operation: 'unhandled-request',
            userId: request.user?.id,
            userEmail: request.user?.email,
            organizationId: request.user?.organizationId,
            metadata: { route, method: request.method, statusCode: status },
          });
        }

        if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
          // Bodies, headers, query values and concrete route params are deliberately omitted.
          writeSafeError(this.logger, 'unhandled-request', exception, {
            method: request.method, route, statusCode: status,
            organizationId: request.user?.organizationId, userId: request.user?.id,
          });
        }
      }
    } catch { /* Diagnostic failures must not mask the original HTTP response. */ }

    response.status(status).json({
      statusCode: status,
      ...(deletion ? this.deleteResponse(exception, status) : this.getResponseBody(exception, status)),
      ...(deletion ? { requestId } : {}),
      path: deletion ? '/api/documents/:id' : request.originalUrl || request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private deleteResponse(exception: unknown, status: number): Record<string, unknown> {
    if (exception instanceof DocumentDeleteReconciliationError) {
      return { code: 'DOCUMENT_DELETE_RECONCILIATION_REQUIRED',
        message: 'This source document needs storage reconciliation. Deletion was not completed. Contact support with this reference.' };
    }
    if (status === 409 && exception instanceof HttpException &&
        (exception.getResponse() as { code?: unknown })?.code === 'LEGAL_HOLD_ACTIVE') {
      return { code: 'LEGAL_HOLD_ACTIVE', message: 'Deletion is temporarily restricted.' };
    }
    return { message: status === 404 ? 'Document not found.' : status === 401 ? 'Authentication required.'
      : status === 403 ? 'Document deletion is not permitted.' : 'Document deletion could not be completed.' };
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
