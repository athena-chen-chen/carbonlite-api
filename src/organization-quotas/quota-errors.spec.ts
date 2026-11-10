import { ServiceUnavailableException } from '@nestjs/common';
import { throwCapturedAppError } from '../common/monitoring/capture-app-error';
import { QuotaExceededException } from './quota-errors';

it('preserves quota HTTP status and safe response through controller error capture', () => {
  const quotaError = new QuotaExceededException(
    'UPLOAD_PERIOD_QUOTA_EXCEEDED',
    'Your organization has reached its upload limit for this quota period.',
    { limit: 20, remaining: 0 },
  );

  expect(() => throwCapturedAppError(
    quotaError,
    { feature: 'documents', operation: 'upload' },
    'Document upload failed. Please try again.',
  )).toThrow(quotaError);
  expect(quotaError.getStatus()).toBe(429);
  expect(quotaError.getResponse()).toMatchObject({
    code: 'UPLOAD_PERIOD_QUOTA_EXCEEDED', limit: 20, remaining: 0,
  });
});

it('preserves service-unavailable status through controller error capture', () => {
  const unavailable = new ServiceUnavailableException(
    'Document deletion requires storage reconciliation; no permanent purge was attempted.',
  );

  expect(() => throwCapturedAppError(
    unavailable,
    { feature: 'documents', operation: 'delete' },
    'Document deletion failed. Please try again.',
  )).toThrow(unavailable);
  expect(unavailable.getStatus()).toBe(503);
});
