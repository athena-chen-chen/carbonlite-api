import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import {
  authHeader,
  cleanupTestData,
  createTestUser,
  uniqueTestId,
} from './helpers/factories';

describe('Document duplicate protection (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testRunId = uniqueTestId('duplicate-protection');
  const fileContents =
    'activityType,recordDate,quantity,unit\nDIESEL,2026-05-01,10,L\n';

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    prisma = e2e.prisma;
  });

  afterAll(async () => {
    await cleanupTestData(prisma, testRunId);
    await app.close();
  });

  async function upload(
    accessToken: string,
    fileName: string,
    allowDuplicate = false,
  ) {
    const uploadRequest = request(app.getHttpServer())
      .post('/api/documents/upload')
      .set(authHeader(accessToken))
      .field('type', 'SPREADSHEET');

    if (allowDuplicate) {
      uploadRequest.field('allowDuplicate', 'true');
    }

    return uploadRequest.attach('file', Buffer.from(fileContents), {
      filename: fileName,
      contentType: 'text/csv',
    });
  }

  it('detects the same file hash within an organization and allows an explicit copy', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Upload Org`,
      email: `upload-${testRunId}@carbonlite-e2e.test`,
    });

    const firstUpload = await upload(
      user.accessToken,
      `${testRunId}-utility.xlsx`,
    ).expect(201);

    const duplicateResponse = await upload(
      user.accessToken,
      `${testRunId}-utility-copy.xlsx`,
    ).expect(409);

    expect(duplicateResponse.body).toMatchObject({
      message: 'This file appears to have already been uploaded.',
      existingDocument: {
        id: firstUpload.body.id,
        fileName: `${testRunId}-utility.xlsx`,
      },
    });

    const keptCopy = await upload(
      user.accessToken,
      `${testRunId}-utility-kept-copy.xlsx`,
      true,
    ).expect(201);

    expect(keptCopy.body.fileHash).toBe(firstUpload.body.fileHash);
  });

  it('scopes duplicate file detection to the current organization', async () => {
    const userA = await createTestUser(app, {
      organizationName: `${testRunId} Org A`,
      email: `org-a-${testRunId}@carbonlite-e2e.test`,
    });
    const userB = await createTestUser(app, {
      organizationName: `${testRunId} Org B`,
      email: `org-b-${testRunId}@carbonlite-e2e.test`,
    });

    await upload(userA.accessToken, `${testRunId}-org-a.csv`).expect(201);
    await upload(userB.accessToken, `${testRunId}-org-b.csv`).expect(201);
  });

  it('imports a document once and persists source and batch metadata', async () => {
    const user = await createTestUser(app, {
      organizationName: `${testRunId} Import Org`,
      email: `import-${testRunId}@carbonlite-e2e.test`,
    });
    const uploaded = await upload(
      user.accessToken,
      `${testRunId}-import.csv`,
    ).expect(201);
    const importBatchId = `document-${uploaded.body.id}`;
    const payload = {
      documentId: uploaded.body.id,
      importBatchId,
      activities: [
        {
          activityType: 'DIESEL',
          recordDate: '2026-05-01',
          quantity: 10,
          unit: 'L',
          sourceReference: uploaded.body.fileName,
          importBatchId,
        },
      ],
    };

    const firstImport = await request(app.getHttpServer())
      .post('/api/document-extraction/confirm')
      .set(authHeader(user.accessToken))
      .send(payload)
      .expect(201);

    expect(firstImport.body).toMatchObject({
      count: 1,
      importBatchId,
    });

    await request(app.getHttpServer())
      .post('/api/document-extraction/confirm')
      .set(authHeader(user.accessToken))
      .send(payload)
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toBe('This document has already been imported.');
      });

    const importedRecords = await prisma.activityData.findMany({
      where: {
        organizationId: user.user.organizationId,
        sourceDocumentId: uploaded.body.id,
      },
    });
    const importedDocument = await prisma.document.findUnique({
      where: { id: uploaded.body.id },
    });

    expect(importedRecords).toHaveLength(1);
    expect(importedRecords[0].importBatchId).toBe(importBatchId);
    expect(importedDocument).toMatchObject({
      status: 'IMPORTED',
      importBatchId,
    });
    expect(importedDocument?.importedAt).toBeInstanceOf(Date);
  });
});
