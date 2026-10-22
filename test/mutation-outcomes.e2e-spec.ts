import { assertSafeTestDatabaseTarget } from './helpers/database-safety';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MULTER_MODULE_OPTIONS } from '@nestjs/platform-express/multer/files.constants';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { ActivityTrackingService } from '../src/activity-tracking/activity-tracking.service';
import { documentUploadOptions } from '../src/documents/document-resource-policy';
import { documentDiskStorage } from '../src/documents/document-upload-storage';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';

describe('F09 truthful mutation outcomes (real PostgreSQL rollback)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tracker: ActivityTrackingService;
  let organizationId: string;
  let userId: string;
  let auth: ReturnType<typeof authHeader>;
  let directory: string;
  const run = uniqueTestId('f09-outcomes');
  const uploadRoot = resolve(process.cwd(), 'uploads');
  const fixture = { activityType: 'DIESEL', quantity: 10, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada', sourceType: 'MANUAL' };
  const sourceIds: string[] = [];
  const factorIds: string[] = [];

  beforeAll(async () => {
    const targetDatabase = assertSafeTestDatabaseTarget();
    await mkdir(uploadRoot, { recursive: true });
    directory = await mkdtemp(join(uploadRoot, 'f09-test-'));
    const compiled = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MULTER_MODULE_OPTIONS).useValue({ ...documentUploadOptions,
        storage: documentDiskStorage(uploadRoot, () => `${basename(directory)}/${randomUUID()}`),
      }).compile();
    app = compiled.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    prisma = app.select(PrismaModule).get(PrismaService, { strict: true }); tracker = app.get(ActivityTrackingService);
    const [target] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(target.name).toBe(targetDatabase.database);
    const user = await createTestUser(app, { organizationName: run, email: `${run}@carbonlite-e2e.test` });
    organizationId = user.user.organizationId; userId = user.user.id; auth = authHeader(user.accessToken);
    // Use the existing platform authorization path; never bypass endpoint guards.
    await prisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try {
    if (prisma) {
      await prisma.factorVersion.updateMany({ where: { factorId: { in: factorIds } }, data: { status: 'ARCHIVED' } });
      await prisma.factor.deleteMany({ where: { id: { in: factorIds } } });
      await prisma.factorSource.deleteMany({ where: { id: { in: sourceIds } } });
      await prisma.factorSource.deleteMany({ where: { sourceAuthority: { startsWith: run } } });
      await cleanupTestData(prisma, run);
    }
    } finally {
    if (app) await app.close();
    if (directory && dirname(directory) === uploadRoot && basename(directory).startsWith('f09-test-')) await rm(directory, { recursive: true, force: true });
    }
  });
  const api = () => request(app.getHttpServer());
  const createActivity = async (payload = fixture) => (await api().post('/api/activity-data').set(auth).send(payload).expect(201)).body;
  const upload = (name = 'source.json') => api().post('/api/documents/upload').set(auth).field('type', 'OTHER')
    .attach('file', Buffer.from(JSON.stringify([{ ...fixture, sourceReference: name.replace('-copy', '') }])), { filename: name, contentType: 'application/json' });
  const extract = (id: string) => api().post('/api/document-extraction/extract').set(auth).send({ documentId: id });

  // Only replace the selected audit FK inside the real transaction. PostgreSQL
  // performs the business writes and then rejects the actual evidence INSERT.
  function rejectRequiredInsert(model = 'auditLog', fk = 'userId', action?: string) {
    const transaction = prisma.$transaction.bind(prisma);
    let reached = 0;
    jest.spyOn(prisma, '$transaction').mockImplementation(((work: any, options: any) => {
      if (typeof work !== 'function') return transaction(work, options);
      return transaction(async tx => work(new Proxy(tx, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== model) return value;
          return new Proxy(value, {
            get(delegate, operation) {
              if (operation !== 'create') return Reflect.get(delegate, operation);
              return (args: any) => {
                if (!action || args.data.action === action) {
                  reached++;
                  return delegate.create({ ...args, data: { ...args.data, [fk]: `missing-${run}` } });
                }
                return delegate.create(args);
              };
            },
          });
        },
      })), options);
    }) as any);
    return () => expect(reached).toBeGreaterThan(0);
  }

  it('rolls back Document creation and removes its stored bytes when required upload audit fails', async () => {
    const before = await prisma.document.count({ where: { organizationId } });
    const files = await readdir(directory);
    const reached = rejectRequiredInsert('auditLog', 'userId', 'UPLOAD_DOCUMENT');
    await upload().expect(500); reached();
    expect(await prisma.document.count({ where: { organizationId } })).toBe(before);
    expect(await readdir(directory)).toEqual(files);
    expect(await prisma.auditLog.count({ where: { organizationId, action: 'UPLOAD_DOCUMENT' } })).toBe(0);
  });
  it('rolls back ActivityData create after the real required audit insert fails', async () => {
    const before = await prisma.activityData.count({ where: { organizationId } });
    const reached = rejectRequiredInsert('auditLog', 'userId', 'CREATE_ACTIVITY_RECORD');
    await api().post('/api/activity-data').set(auth).send(fixture).expect(500); reached();
    expect(await prisma.activityData.count({ where: { organizationId } })).toBe(before);
  });
  it('rolls back ActivityData update, recalculation evidence and snapshot together', async () => {
    const row = await createActivity();
    const before = await prisma.activityData.findUniqueOrThrow({ where: { id: row.id } });
    const audits = await prisma.auditLog.count({ where: { entityId: row.id } });
    const reached = rejectRequiredInsert('auditLog', 'userId', 'UPDATE_ACTIVITY_RECORD');
    await api().patch(`/api/activity-data/${row.id}`).set(auth).send({ quantity: 25 }).expect(500); reached();
    expect(await prisma.activityData.findUnique({ where: { id: row.id } })).toEqual(before);
    expect(await prisma.auditLog.count({ where: { entityId: row.id } })).toBe(audits);
  });
  it('rolls back ActivityData delete instead of falsely reporting a committed deletion as failed', async () => {
    const row = await createActivity();
    const reached = rejectRequiredInsert('auditLog', 'userId', 'DELETE_ACTIVITY_RECORD');
    await api().delete(`/api/activity-data/${row.id}`).set(auth).expect(500); reached();
    expect(await prisma.activityData.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('rolls back report creation when its required creation audit fails', async () => {
    const title = `${run}-rollback-report`;
    const reached = rejectRequiredInsert('auditLog', 'userId', 'GENERATE_REPORT');
    await api().post('/api/reports').set(auth).send({ title }).expect(500); reached();
    expect(await prisma.report.count({ where: { organizationId, title } })).toBe(0);
  });
  it('rolls back a governed global source create when its audit insert fails', async () => {
    const sourceAuthority = `${run}-rollback-source`;
    const reached = rejectRequiredInsert('auditLog', 'userId', 'CREATE_FACTOR_SOURCE');
    await api().post('/api/factor-sources').set(auth).send({ sourceAuthority, sourceDocument: 'Synthetic F09 source' }).expect(500); reached();
    expect(await prisma.factorSource.count({ where: { sourceAuthority } })).toBe(0);
  });
  it('rolls back verified status, predecessor deprecation and review history if the final governance log fails', async () => {
    const source = await prisma.factorSource.create({ data: {
      sourceAuthority: run, sourceDocument: 'Synthetic F09', sourceVersion: 'test', sourceYear: 2026,
      sourceUrl: 'https://example.invalid/f09', page: '', tableReference: '', publishedDate: new Date(), notes: '',
      publisherType: 'COMPANY', isOfficial: true, isActive: true,
    } }); sourceIds.push(source.id);
    const factor = await prisma.factor.create({ data: { displayName: run, activityType: 'DIESEL' } }); factorIds.push(factor.id);
    const data = { factorId: factor.id, factorValue: 2.68, inputUnit: 'L', resultUnit: 'kgCO2e', jurisdictionCountry: 'Canada', factorYear: 2026, sourceId: source.id };
    const previous = await prisma.factorVersion.create({ data: { ...data, version: 'old', status: 'VERIFIED', verified: true } });
    const draft = await prisma.factorVersion.create({ data: { ...data, version: 'new' } });
    const reached = rejectRequiredInsert('factorChangeLog', 'changedBy', 'VERSION_VERIFIED');
    await api().post(`/api/factor-versions/${draft.id}/verify`).set(auth).send({ reviewNotes: 'Synthetic test' }).expect(500); reached();
    expect(await prisma.factorVersion.findUnique({ where: { id: previous.id } })).toMatchObject({ status: 'VERIFIED', verified: true });
    expect(await prisma.factorVersion.findUnique({ where: { id: draft.id } })).toMatchObject({ status: 'DRAFT', verified: false });
    expect(await prisma.factorChangeLog.count({ where: { factorId: factor.id } })).toBe(0);
    expect(await prisma.factorReviewLog.count({ where: { factorVersionId: draft.id } })).toBe(0);
  });
  it('rolls back extracted rows on required extraction audit failure and retains the source for retry', async () => {
    const saved = (await upload('rollback-extraction.json').expect(201)).body;
    const reached = rejectRequiredInsert('auditLog', 'userId', 'EXTRACT_DOCUMENT');
    await extract(saved.id).expect(500); reached();
    expect(await prisma.documentExtraction.count({ where: { documentId: saved.id } })).toBe(0);
    expect(await prisma.document.findUnique({ where: { id: saved.id } })).toMatchObject({ status: 'EXTRACTION_FAILED' });
    await access(join(process.cwd(), saved.fileUrl));
  });
  it('rolls back calculation results and recalculated snapshots on required summary audit failure', async () => {
    const row = await createActivity();
    const before = await prisma.activityData.findUniqueOrThrow({ where: { id: row.id } });
    const reached = rejectRequiredInsert('auditLog', 'userId', 'GENERATE_METRICS_SUMMARY');
    await api().post('/api/metrics/calculate').set(auth).send({ activityDataIds: [row.id], metricTypes: ['CARBON_EMISSION'] }).expect(500); reached();
    expect(await prisma.metricResult.count({ where: { activityDataId: row.id } })).toBe(0);
    expect(await prisma.activityData.findUnique({ where: { id: row.id } })).toEqual(before);
  });

  it.each([
    ['bulk-delete', 'BULK_DELETE_ACTIVITY_RECORDS'],
    ['bulk-facility', 'BULK_UPDATE_ACTIVITY_RECORD_FACILITY'],
    ['bulk-province', 'BULK_UPDATE_ACTIVITY_RECORD_PROVINCE'],
  ])('rolls back %s on required accounting audit failure', async (route, action) => {
    const row = await createActivity(route === 'bulk-province' ? { ...fixture, activityType: 'ELECTRICITY', jurisdictionRegion: 'Alberta' } as typeof fixture : fixture);
    const before = await prisma.activityData.findUniqueOrThrow({ where: { id: row.id } });
    const reached = rejectRequiredInsert('auditLog', 'userId', action);
    if (route === 'bulk-delete') await api().post(`/api/activity-data/${route}`).set(auth).send({ ids: [row.id] }).expect(500);
    if (route === 'bulk-facility') await api().patch(`/api/activity-data/${route}`).set(auth).send({ ids: [row.id], facilityName: 'Changed' }).expect(500);
    if (route === 'bulk-province') await api().patch(`/api/activity-data/${route}`).set(auth).send({ ids: [row.id], province: 'BC' }).expect(500);
    reached();
    expect(await prisma.activityData.findUnique({ where: { id: row.id } })).toEqual(before);
  });
  it('rolls back source deletion and retains imported records when its required audit fails', async () => {
    const saved = (await upload('delete-rollback.json').expect(201)).body;
    const row = await prisma.activityData.create({ data: { organizationId, activityType: 'DIESEL', recordDate: new Date('2026-03-07'), quantity: 10, unit: 'L', sourceType: 'DOCUMENT_AI', documentId: saved.id, sourceDocumentId: saved.id } });
    const reached = rejectRequiredInsert('auditLog', 'userId', 'DELETE_DOCUMENT');
    await api().delete(`/api/documents/${saved.id}`).set(auth).expect(500); reached();
    expect(await prisma.document.findUnique({ where: { id: saved.id } })).not.toBeNull();
    expect(await prisma.activityData.findUnique({ where: { id: row.id } })).toMatchObject({ documentId: saved.id, sourceDocumentId: saved.id });
    await access(join(process.cwd(), saved.fileUrl));
  });
  it('rolls back a workspace boundary update if its required evidence cannot be persisted', async () => {
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const reached = rejectRequiredInsert('auditLog', 'userId', 'BOUNDARY_UPDATED');
    await api().patch('/api/organization-profile').set(auth).send({
      organizationName: run, industry: 'Technology', country: 'Canada', provinceOrState: 'Alberta',
      geographicBoundary: 'Synthetic changed boundary',
    }).expect(500); reached();
    expect(await prisma.organization.findUnique({ where: { id: organizationId } })).toEqual(before);
  });
  it('returns upload success and keeps the source if optional feed persistence fails; retries retain duplicate semantics', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(tracker, 'track').mockRejectedValue(new Error('Synthetic optional event failure'));
    const saved = (await upload('optional-upload.json').expect(201)).body;
    expect(await prisma.document.findUnique({ where: { id: saved.id } })).not.toBeNull();
    await access(join(process.cwd(), saved.fileUrl));
    expect(await prisma.auditLog.count({ where: { entityId: saved.id, action: 'UPLOAD_DOCUMENT' } })).toBe(1);
    expect(await prisma.userActivityEvent.count({ where: { entityId: saved.id, eventName: 'DOCUMENT_UPLOADED' } })).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DOCUMENT_UPLOADED'));
    await upload('optional-upload-copy.json').expect(409);
  });
  it('preserves successful ActivityData create/update/delete responses when optional events fail', async () => {
    jest.spyOn(tracker, 'track').mockRejectedValue(new Error('Synthetic optional event failure'));
    const row = await createActivity();
    await api().patch(`/api/activity-data/${row.id}`).set(auth).send({ quantity: 22 }).expect(200);
    expect(Number((await prisma.activityData.findUniqueOrThrow({ where: { id: row.id } })).quantity)).toBe(22);
    await api().delete(`/api/activity-data/${row.id}`).set(auth).expect(200);
    expect(await prisma.activityData.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: { in: ['CREATE_ACTIVITY_RECORD', 'UPDATE_ACTIVITY_RECORD', 'DELETE_ACTIVITY_RECORD'] } } })).toBe(3);
  });
  it('returns successful report creation and extraction despite optional event failures', async () => {
    const saved = (await upload('optional-extraction.json').expect(201)).body;
    jest.spyOn(tracker, 'track').mockRejectedValue(new Error('Synthetic optional event failure'));
    const report = (await api().post('/api/reports').set(auth).send({ title: `${run}-optional-report` }).expect(201)).body;
    expect(await prisma.report.findUnique({ where: { id: report.id } })).not.toBeNull();
    await extract(saved.id).expect(201);
    expect(await prisma.document.findUnique({ where: { id: saved.id } })).toMatchObject({ status: 'REVIEW_REQUIRED' });
    expect(await prisma.documentExtraction.count({ where: { documentId: saved.id } })).toBe(1);
  });
  it('keeps bulk import and feedback successful if their optional activity feed fails', async () => {
    jest.spyOn(tracker, 'track').mockRejectedValue(new Error('Synthetic optional event failure'));
    const before = await prisma.activityData.count({ where: { organizationId } });
    const imported = await api().post('/api/activity-data/bulk-import').set(auth).send({ items: [fixture] }).expect(201);
    expect(imported.body.count).toBe(1);
    expect(await prisma.activityData.count({ where: { organizationId } })).toBe(before + 1);
    const feedback = (await api().post('/api/feedback').set(auth).send({ type: 'BUG', intent: 'Synthetic F09', message: 'Synthetic feedback' }).expect(201)).body;
    expect(await prisma.feedback.findUnique({ where: { id: feedback.id } })).not.toBeNull();
  });
  it('returns registration success when the informational registration event fails', async () => {
    jest.spyOn(tracker, 'track').mockRejectedValue(new Error('Synthetic optional event failure'));
    const user = await createTestUser(app, { organizationName: `${run}-registration`, email: `${run}-registration@carbonlite-e2e.test` });
    expect(user.accessToken).toBeTruthy();
    expect(await prisma.user.findUnique({ where: { id: user.user.id } })).not.toBeNull();
  });
  it('keeps business success even when logging the optional failure also throws', async () => {
    jest.spyOn(tracker, 'track').mockRejectedValue(new Error('Synthetic optional event failure'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => { throw Error('Synthetic logger failure'); });
    const row = await createActivity();
    expect(await prisma.activityData.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
});
