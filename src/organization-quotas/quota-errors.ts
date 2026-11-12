import { HttpException, HttpStatus } from '@nestjs/common';

export type QuotaErrorCode =
  | 'UPLOAD_PERIOD_QUOTA_EXCEEDED'
  | 'DAILY_UPLOAD_QUOTA_EXCEEDED'
  | 'FILE_SIZE_QUOTA_EXCEEDED'
  | 'IMPORT_ROW_QUOTA_EXCEEDED'
  | 'EXTRACTION_CONCURRENCY_EXCEEDED'
  | 'EXTRACTION_ALREADY_RUNNING';

export class QuotaExceededException extends HttpException {
  constructor(
    code: QuotaErrorCode,
    message: string,
    details: { limit: number; remaining?: number; resetAt?: Date } | { limit: number },
    status = HttpStatus.TOO_MANY_REQUESTS,
  ) {
    super(
      {
        code,
        message,
        limit: details.limit,
        ...('remaining' in details && details.remaining !== undefined
          ? { remaining: details.remaining }
          : {}),
        ...('resetAt' in details && details.resetAt
          ? { resetAt: details.resetAt.toISOString() }
          : {}),
      },
      status,
    );
  }
}
