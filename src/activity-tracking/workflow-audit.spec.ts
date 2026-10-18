import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { ActivityTrackingController } from './activity-tracking.controller';
import { ActivityTrackingService } from './activity-tracking.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { DocumentExtractionService } from '../document-extraction/document-extraction.service';
import { SpreadsheetImportService } from '../spreadsheet-import/spreadsheet-import.service';

jest.mock('../openai/openai.client', () => ({ openai: {} }));

function database() {
  const events: any[] = [];
  const records: any[] = [];
  const client: any = {
    userActivityEvent: {
      create: jest.fn(async ({ data }) => { const row = { ...data, id: `event-${String(events.length + 1).padStart(3, '0')}`, createdAt: new Date('2026-10-14T14:00:00Z') }; events.push(row); return row; }),
      findMany: jest.fn(async ({ where, skip = 0, take = 20 }) => events.filter((row) => row.organizationId === where.organizationId && (!where.eventName?.in || where.eventName.in.includes(row.eventName))).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(skip, skip + take)),
      count: jest.fn(async ({ where }) => events.filter((row) => row.organizationId === where.organizationId && (!where.eventName?.in || where.eventName.in.includes(row.eventName))).length),
    },
    document: { findFirst: jest.fn(async () => ({ id: 'source', fileName: 'operations.xlsx' })), update: jest.fn(async ({ data }) => ({ ...data, id: 'source', createdAt: new Date() })), create: jest.fn(async ({ data }) => ({ ...data, id: 'source', createdAt: new Date() })) },
    documentExtraction: { upsert: jest.fn() },
    spreadsheetImportReviewRow: { findMany: jest.fn(async () => []), upsert: jest.fn() },
    activityData: { findMany: jest.fn(async () => records), create: jest.fn(async ({ data }) => { const row = { ...data, id: `record-${records.length}` }; records.push(row); return row; }) },
    $transaction: jest.fn(async (arg) => typeof arg === 'function' ? arg(client) : Promise.all(arg)),
  };
  return { client, events, records };
}

const importRows = ['ELECTRICITY', 'WATER', 'HOTEL', 'NATURAL_GAS', 'GASOLINE'].map((activityType, i) => ({ activityType, recordDate: '2026-02-01', quantity: i + 1, unit: i === 2 ? 'nights' : i === 1 ? 'm3' : 'GJ', sourceRow: i + 2, sourceReference: `reference-${i}` }));

describe('workflow audit persistence', () => {
  it('appends partial import 3 then 1 and emits no event for unchanged reconfirm', async () => {
    const { client, events } = database();
    const subject = new DocumentExtractionService(client, { log: jest.fn() } as never, new ActivityTrackingService(client), { prepareCreate: jest.fn(async (_client, data) => data), fields: jest.fn() } as never);
    expect((await subject.confirmImport('org-a', 'source', importRows.slice(0, 3), 'actor-a')).count).toBe(3);
    const first = JSON.stringify(events[0]);
    expect((await subject.confirmImport('org-a', 'source', importRows.slice(0, 4), 'actor-a')).count).toBe(1);
    expect((await subject.confirmImport('org-a', 'source', importRows.slice(0, 4), 'actor-a')).count).toBe(0);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[0])).toBe(first);
    expect(events.map((event) => event.metadata.createdRecordCount)).toEqual([3, 1]);
    expect(events[0]).toMatchObject({ organizationId: 'org-a', userId: 'actor-a', eventName: 'ACTIVITY_RECORD_IMPORTED', entityType: 'Document', entityId: 'source', metadata: { sourceFileName: 'operations.xlsx', sourceDocumentId: 'source', trackedMetricCount: 1 } });
  });
  it('records one five-record batch with minimal source identity inside the transaction', async () => {
    const { client, events } = database();
    const track = new ActivityTrackingService(client);
    const spy = jest.spyOn(track, 'track');
    await new DocumentExtractionService(client, { log: jest.fn() } as never, track, { prepareCreate: jest.fn(async (_client, data) => data), fields: jest.fn() } as never).confirmImport('org-a', 'source', importRows, 'actor-a');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ createdRecordCount: 5, reviewableRowCount: 5, unresolvedRowCount: 0, skippedCount: 0 });
    expect(spy.mock.calls[0][1]).toBe(client);
    expect(Object.keys(events[0].metadata)).not.toEqual(expect.arrayContaining(['rawSourceRow', 'activities', 'content', 'email']));
  });
  it('audits a newly persisted spreadsheet source once and not repeated review saves', async () => {
    const { client, events } = database();
    client.document.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'source', fileName: 'operations.xlsx' });
    const subject = new SpreadsheetImportService(client, new ActivityTrackingService(client));
    const dto: any = { sourceType: 'EXCEL', importBatchId: 'batch-a', sourceFileName: 'operations.xlsx', rows: importRows.map((row, i) => ({ ...row, rowId: `row-${i}`, status: 'READY', issues: [], rawSourceRow: { confidential: 'do not copy' } })) };
    await subject.saveReviewRows('org-a', dto, 'actor-a');
    await subject.saveReviewRows('org-a', dto, 'actor-a');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventName: 'DOCUMENT_UPLOADED', organizationId: 'org-a', userId: 'actor-a', entityId: 'source' });
    expect(events[0].metadata).toEqual({ sourceFileName: 'operations.xlsx', sourceDocumentId: 'source', importBatchId: 'batch-a', sourceType: 'EXCEL', reviewableRowCount: 5 });
  });
});

describe('authenticated workflow API isolation and pagination', () => {
  let app: INestApplication;
  let db: ReturnType<typeof database>;
  let jwt: JwtService;
  beforeAll(async () => {
    db = database();
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({ secret: 'workflow-test-secret' })],
      controllers: [ActivityTrackingController],
      providers: [ActivityTrackingService, JwtStrategy, { provide: PrismaService, useValue: db.client }, { provide: ConfigService, useValue: { get: () => 'workflow-test-secret' } }, { provide: AuthService, useValue: { validateJwtPayload: jest.fn(async (payload) => ({ id: payload.sub, organizationId: payload.sub === 'actor-b' ? 'org-b' : 'org-a', role: 'MEMBER' })) } }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    jwt = module.get(JwtService);
  });
  afterAll(async () => app.close());
  beforeEach(() => { db.events.length = 0; });
  const token = (actor: string) => jwt.sign({ sub: actor });
  it('rejects unauthenticated requests', async () => { await request(app.getHttpServer()).get('/activity-events/workflow').expect(401); });
  it('returns a truly empty fresh workspace', async () => {
    const result = await request(app.getHttpServer()).get('/activity-events/workflow').set('Authorization', `Bearer ${token('actor-a')}`).expect(200);
    expect(result.body).toMatchObject({ items: [], total: 0 });
  });
  it('filters noise before pagination, includes other workspace actors, and sorts ties deterministically', async () => {
    const track = new ActivityTrackingService(db.client);
    await track.track({ organizationId: 'org-a', userId: 'other-actor', eventName: 'DOCUMENT_UPLOADED' });
    await track.track({ organizationId: 'org-a', userId: 'actor-a', eventName: 'ACTIVITY_RECORD_IMPORTED', metadata: { createdRecordCount: 5 } });
    for (let i = 0; i < 30; i++) await track.track({ organizationId: 'org-a', userId: 'actor-a', eventName: 'REPORT_VIEWED' });
    const result = await request(app.getHttpServer()).get('/activity-events/workflow?pageSize=1').set('Authorization', `Bearer ${token('actor-a')}`).expect(200);
    expect(result.body.total).toBe(2);
    expect(result.body.items[0].eventName).toBe('ACTIVITY_RECORD_IMPORTED');
    const second = await request(app.getHttpServer()).get('/activity-events/workflow?pageSize=1&page=2').set('Authorization', `Bearer ${token('actor-a')}`).expect(200);
    expect(second.body.items[0].userId).toBe('other-actor');
    expect(db.client.userActivityEvent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
  });
  it('ignores forged tenant and user filters and never returns another organization', async () => {
    const track = new ActivityTrackingService(db.client);
    await track.track({ organizationId: 'org-a', userId: 'actor-a', eventName: 'ACTIVITY_RECORD_IMPORTED' });
    await track.track({ organizationId: 'org-b', userId: 'actor-b', eventName: 'ACTIVITY_RECORD_IMPORTED' });
    for (const [actor, expected] of [['actor-a', 'org-a'], ['actor-b', 'org-b']]) {
      const result = await request(app.getHttpServer()).get('/activity-events/workflow?organizationId=org-b&user=actor-b').set('Authorization', `Bearer ${token(actor)}`).expect(200);
      expect(result.body.items).toHaveLength(1);
      expect(result.body.items[0].organizationId).toBe(expected);
    }
  });
});
