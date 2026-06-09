import { INestApplication } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import request from 'supertest';
import { openai } from '../src/openai/openai.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

jest.mock('@sentry/nestjs', () => {
  const actual = jest.requireActual('@sentry/nestjs');
  const captureException = jest.fn();
  return {
    ...actual,
    withScope: jest.fn((callback) =>
      callback({
        setTag: jest.fn(),
        setUser: jest.fn(),
        setContext: jest.fn(),
      }),
    ),
    captureException,
    __mockCaptureException: captureException,
    addBreadcrumb: jest.fn(),
  };
});

describe('Document extraction retry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('extraction-retry');
  const originalSentryDsn = process.env.SENTRY_DSN;
  const mockCaptureException = (
    Sentry as typeof Sentry & { __mockCaptureException: jest.Mock }
  ).__mockCaptureException;

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockCaptureException.mockClear();
    if (originalSentryDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalSentryDsn;
    }
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  async function uploadTestDocument(
    token: string,
    name: string,
    content = 'activityType,recordDate,quantity,unit\nDIESEL,2026-05-31,10,liters\n',
    contentType = 'text/csv',
  ) {
    const response = await request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(token))
      .field('type', 'SPREADSHEET')
      .attach('file', Buffer.from(content), {
        filename: name,
        contentType,
      })
      .expect(201);

    return response.body;
  }

  function mockExtractionResponse(activities: unknown[]) {
    jest.spyOn(openai.responses, 'create').mockResolvedValue({
      output_text: JSON.stringify({ activities }),
    } as never);
  }

  it('retries extraction successfully', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Success Org`,
      email: `success-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-success.csv`,
    );
    mockExtractionResponse([
      {
        activityType: 'DIESEL',
        recordDate: '2026-05-31',
        quantity: 10,
        unit: 'liters',
        sourceReference: 'retry test',
        notes: null,
      },
    ]);

    const response = await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(user.accessToken))
      .send({ documentId: document.id })
      .expect(201);

    expect(response.body.status).toBe('REVIEW_REQUIRED');
    expect(response.body.parsedActivities).toHaveLength(1);
  });

  it('returns 404 when uploaded file is missing', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Missing Org`,
      email: `missing-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-missing.csv`,
    );

    await prisma.document.update({
      where: { id: document.id },
      data: { fileUrl: '/uploads/does-not-exist.csv' },
    });

    const response = await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(user.accessToken))
      .send({ documentId: document.id })
      .expect(404);

    expect(response.body.message).toBe(
      'Uploaded file is no longer available. Please upload it again.',
    );
    expect(response.body.status).toBe('FILE_MISSING');

    const updated = await prisma.document.findUnique({ where: { id: document.id } });
    expect(updated?.status).toBe('FILE_MISSING');
  });

  it('returns NO_DATA_FOUND without failing when no emissions data is detected', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} No Data Org`,
      email: `no-data-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-no-data.csv`,
      'description\nhello world\n',
    );
    mockExtractionResponse([]);

    const response = await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(user.accessToken))
      .send({ documentId: document.id })
      .expect(201);

    expect(response.body.status).toBe('NO_DATA_FOUND');
    expect(response.body.parsedActivities).toEqual([]);
  });

  it('returns 400 for unsupported file type', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Unsupported Org`,
      email: `unsupported-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-unsupported.txt`,
      'plain text',
      'text/plain',
    );

    const response = await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(user.accessToken))
      .send({ documentId: document.id })
      .expect(400);

    expect(response.body.message).toBe(
      'Unsupported file type. Please upload a PDF, CSV, XLSX, PNG, or JPG file.',
    );
  });

  it('captures an unexpected extraction failure and returns a friendly error', async () => {
    process.env.SENTRY_DSN = 'https://public@example.test/1';
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Failure Org`,
      email: `failure-${testRunId}@carbonlite-e2e.test`,
    });
    const document = await uploadTestDocument(
      user.accessToken,
      `${testRunId}-failure.csv`,
    );
    jest
      .spyOn(openai.responses, 'create')
      .mockRejectedValue(new Error('Extraction provider unavailable'));

    const response = await request(app.getHttpServer())
      .post('/api/document-extraction/extract')
      .set(authHeader(user.accessToken))
      .send({ documentId: document.id })
      .expect(500);

    expect(response.body.message).toBe(
      'Extraction failed. Please try again or upload the file again.',
    );
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
  });
});
