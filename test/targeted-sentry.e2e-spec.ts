import { NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

const mockScope = {
  setTag: jest.fn(),
  setUser: jest.fn(),
  setContext: jest.fn(),
};
const mockCaptureException = jest.fn();

jest.mock('@sentry/nestjs', () => ({
  withScope: jest.fn((callback: (scope: typeof mockScope) => void) =>
    callback(mockScope),
  ),
  captureException: mockCaptureException,
  addBreadcrumb: jest.fn(),
}));

import {
  captureAppError,
  sanitizeMetadata,
} from '../src/common/monitoring/capture-app-error';
import { ReportsController } from '../src/reports/reports.controller';

describe('Targeted Sentry error tracking', () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    process.env.SENTRY_DSN = 'https://public@example.test/1';
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
  });

  it('captures report generation failures and returns a friendly error', async () => {
    const reportsService = {
      create: jest.fn().mockRejectedValue(new Error('Database unavailable')),
    };
    const controller = new ReportsController(reportsService as never);

    await expect(
      controller.create(
        {
          id: 'user-1',
          email: 'pilot@example.test',
          organizationId: 'org-1',
          organizationName: 'Pilot Organization',
          role: UserRole.USER,
        },
        {
          name: 'Pilot report',
          reportingYear: 2026,
        } as never,
      ),
    ).rejects.toMatchObject({
      message: 'Report generation failed. Please try again.',
      status: 500,
    });

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    expect(mockScope.setTag).toHaveBeenCalledWith('feature', 'reports');
    expect(mockScope.setTag).toHaveBeenCalledWith(
      'operation',
      'generate-report',
    );
    expect(mockScope.setUser).toHaveBeenCalledWith({
      id: 'user-1',
      email: 'pilot@example.test',
    });
  });

  it('does not capture expected 404 errors', () => {
    captureAppError(new NotFoundException('Document not found.'), {
      feature: 'documents',
      operation: 'download',
      organizationId: 'org-1',
    });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('redacts sensitive metadata before capture', () => {
    captureAppError(new Error('Extraction provider failed'), {
      feature: 'document-extraction',
      operation: 'retry-extract',
      organizationId: 'org-1',
      entityType: 'Document',
      entityId: 'document-1',
      metadata: {
        route: '/api/document-extraction/extract',
        password: 'secret',
        authorization: 'Bearer token',
        fileContent: 'invoice contents',
        nested: {
          rawOcrText: 'private OCR text',
          mimeType: 'application/pdf',
        },
      },
    });

    expect(mockScope.setContext).toHaveBeenCalledWith('carbonlite', {
      organizationId: 'org-1',
      entityType: 'Document',
      entityId: 'document-1',
      metadata: {
        route: '/api/document-extraction/extract',
        password: '[Redacted]',
        authorization: '[Redacted]',
        fileContent: '[Redacted]',
        nested: {
          rawOcrText: '[Redacted]',
          mimeType: 'application/pdf',
        },
      },
    });
  });

  it('does not let Sentry failures affect the application', () => {
    mockCaptureException.mockImplementationOnce(() => {
      throw new Error('Sentry unavailable');
    });

    expect(() =>
      captureAppError(new Error('Operation failed'), {
        feature: 'metrics',
        operation: 'summary-aggregation',
      }),
    ).not.toThrow();
  });

  it('does nothing when SENTRY_DSN is not configured', () => {
    delete process.env.SENTRY_DSN;

    captureAppError(new Error('Not sent'), {
      feature: 'documents',
      operation: 'upload',
    });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('sanitizes metadata independently for safe reuse', () => {
    expect(
      sanitizeMetadata({
        token: 'secret',
        notes: 'safe note',
      }),
    ).toEqual({
      token: '[Redacted]',
      notes: 'safe note',
    });
  });
});
