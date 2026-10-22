import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';

const fixtureRoot = join(__dirname, 'fixtures/xlsx-date-systems');
const expected = JSON.parse(readFileSync(join(fixtureRoot, 'expected.json'), 'utf8'));

describe('workbook epoch through upload, extraction and F21 confirmation', () => {
  let app: INestApplication, prisma: PrismaService;
  let auth: Record<string, string>;
  const run = uniqueTestId('f22-date');
  beforeAll(async () => {
    const setup = await createE2eApp(); app = setup.app; prisma = setup.prisma;
    const user = await createTestUser(app, { organizationName: run, email: `${run}@carbonlite-e2e.test` });
    auth = authHeader(user.accessToken);
  });
  afterAll(async () => { if (prisma) await cleanupTestData(prisma, run); if (app) await app.close(); });
  it.each(['1900', '1904'])('imports the intended 2026 date from a real %s XLSX and deduplicates a matching browser retry', async system => {
    const uploaded = await request(app.getHttpServer()).post('/api/documents/upload').set(auth).field('type', 'SPREADSHEET')
      .attach('file', readFileSync(join(fixtureRoot, `dates-${system}.xlsx`)), {
        filename: `dates-${system}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }).expect(201);
    const documentId = uploaded.body.id;
    const extraction = await request(app.getHttpServer()).post('/api/document-extraction/extract').set(auth).send({ documentId }).expect(201);
    expect(extraction.body.parsedActivities.map((row: { recordDate: { value: string } }) => row.recordDate.value))
      .toEqual(expected.map((row: { recordDate: string }) => row.recordDate));
    const row = extraction.body.parsedActivities[0];
    const activity = { activityType: row.activityType.value, recordDate: row.recordDate.value,
      quantity: row.quantity.value, unit: row.unit.value, jurisdictionCountry: row.jurisdictionCountry.value,
      jurisdictionRegion: row.jurisdictionRegion.value, sourceRow: row.sourceRow,
      sourceSheetName: row.sourceSheetName, sourceReference: row.sourceReference.value };
    const confirmed = await request(app.getHttpServer()).post('/api/document-extraction/confirm').set(auth)
      .send({ documentId, activities: [activity] }).expect(201);
    expect(confirmed.body.count).toBe(1);
    const saved = await prisma.activityData.findUniqueOrThrow({ where: { id: confirmed.body.createdIds[0] } });
    expect(saved.recordDate.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(saved).toMatchObject({ recordYear: 2026, sourceSheetName: 'Dates', sourceRow: '2',
      calculationStatus: 'CALCULATED', calculatedEmissionsKgCO2e: 519.4 });
    // This canonical row is the independent browser fixture oracle also asserted
    // by the real browser parser parity tests. Row and rowless date inputs agree.
    const retry = await request(app.getHttpServer()).post('/api/document-extraction/confirm').set(auth)
      .send({ documentId, activities: [expected[0]] }).expect(201);
    expect(retry.body.count).toBe(0);
    expect(await prisma.activityData.count({ where: { sourceDocumentId: documentId } })).toBe(1);
  });
});
