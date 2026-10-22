import { assertSafeTestDatabaseTarget } from './helpers/database-safety';
import { INestApplication, GatewayTimeoutException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MULTER_MODULE_OPTIONS } from '@nestjs/platform-express/multer/files.constants';
import { documentDiskStorage } from '../src/documents/document-upload-storage';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import * as XLSX from 'xlsx';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { openai } from '../src/openai/openai.client';
import * as policy from '../src/documents/document-resource-policy';
import * as workload from '../src/document-extraction/extraction-workload';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';

jest.mock('../src/openai/openai.client', () => ({ openai: { responses: { create: jest.fn() } } }));
const provider = openai.responses.create as jest.Mock;
const pdf = Buffer.from('%PDF-1.4\n% Synthetic resource-boundary fixture\n%%EOF\n');
const emptyResult = { output_text: '{"activities":[]}', status: 'completed' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function workbook(rows: unknown[][], sheets = 1) {
  const book = XLSX.utils.book_new();
  for (let i = 0; i < sheets; i++) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), `Sheet${i}`);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
}

describe('F08 direct upload and extraction resource boundaries', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: ReturnType<typeof authHeader>;
  let organizationId: string;
  let directory: string;
  const run = uniqueTestId('f08-resources');
  const uploadRoot = resolve(process.cwd(), 'uploads');
  beforeAll(async () => {
    const targetDatabase = assertSafeTestDatabaseTarget();
    await mkdir(uploadRoot, { recursive: true });
    directory = await mkdtemp(join(uploadRoot, 'f08-test-'));
    const compiled = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MULTER_MODULE_OPTIONS).useValue({ ...policy.documentUploadOptions, dest: undefined,
        storage: documentDiskStorage(uploadRoot, () => `${basename(directory)}/${randomUUID()}`),
      }).compile();
    app = compiled.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init(); prisma = app.select(PrismaModule).get(PrismaService, { strict: true });
    const [target] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(target.name).toBe(targetDatabase.database);
    const user = await createTestUser(app, { organizationName: run, email: `${run}@carbonlite-e2e.test` });
    auth = authHeader(user.accessToken); organizationId = user.user.organizationId;
  });
  beforeEach(() => { provider.mockReset().mockResolvedValue(emptyResult); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (prisma) await cleanupTestData(prisma, run);
    if (app) await app.close();
    if (directory && dirname(directory) === uploadRoot && basename(directory).startsWith('f08-test-')) await rm(directory, { recursive: true, force: true });
  });
  const files = async () => (await readdir(directory)).sort();
  const count = () => prisma.document.count({ where: { organizationId } });
  const upload = (buffer: Buffer, name = 'source.pdf', contentType = 'application/pdf') => request(app.getHttpServer()).post('/api/documents/upload').set(auth)
    .field('type', 'OTHER').field('allowDuplicate', 'true').attach('file', buffer, { filename: name, contentType });
  const extract = (documentId: string) => request(app.getHttpServer()).post('/api/document-extraction/extract').set(auth).send({ documentId }).then(response => response);
  async function unchangedAfterRejection(work: () => PromiseLike<any>, status: number) {
    const before = { files: await files(), count: await count() };
    const response = await work(); expect(response.status).toBe(status);
    expect(await files()).toEqual(before.files); expect(await count()).toBe(before.count);
    expect(provider).not.toHaveBeenCalled();
  }

  it.each([-1, 0])('accepts supported PDF-like bytes at the 10 MiB boundary (offset %s)', async offset => {
    const buffer = Buffer.alloc(policy.MAX_DOCUMENT_UPLOAD_BYTES + offset, 32); pdf.copy(buffer);
    const response = await upload(buffer).expect(201);
    expect(response.body.fileSize).toBe(buffer.length);
  });
  it('rejects one byte over the limit during multipart intake with no orphan', async () => {
    const buffer = Buffer.alloc(policy.MAX_DOCUMENT_UPLOAD_BYTES + 1, 32); pdf.copy(buffer);
    await unchangedAfterRejection(() => upload(buffer), 413);
  });
  it('accepts generic browser MIME when extension and content are supported', async () => { await upload(pdf, 'generic.pdf', 'application/octet-stream').expect(201); });
  it.each([
    ['evil.exe', 'application/pdf', Buffer.from('MZ executable')],
    ['evil.pdf', 'application/x-msdownload', pdf],
    ['evil.pdf', 'application/pdf', Buffer.from('MZ executable')],
    ['evil.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from('plain text')],
    ['broken.xlsx', 'application/octet-stream', Buffer.from('PK\x03\x04not a workbook zip')],
    ['evil.png', 'image/png', pdf],
    ['bad.json', 'application/json', Buffer.from('{')],
    ['bad.csv', 'text/csv', Buffer.from('header\n"unterminated')],
    ['bad.csv', 'text/csv', Buffer.from([255, 254, 0])],
  ])('rejects unsupported/misleading input %s safely and removes rejected bytes', async (name, mime, buffer) => {
    await unchangedAfterRejection(() => upload(buffer as Buffer, name as string, mime as string), 400);
  });
  it('bounds CSV row counts and record length, and JSON record counts before metadata creation', async () => {
    for (const [buffer, name, mime] of [
      [Buffer.from('header\n' + 'x\n'.repeat(policy.MAX_SPREADSHEET_ROWS)), 'rows.csv', 'text/csv'],
      [Buffer.from('x'.repeat(policy.MAX_CSV_RECORD_CHARACTERS + 1)), 'long.csv', 'text/csv'],
      [Buffer.from(JSON.stringify(Array(policy.MAX_EXTRACTED_REVIEW_ROWS + 1).fill({}))), 'rows.json', 'application/json'],
    ] as const) await unchangedAfterRejection(() => upload(buffer, name, mime), 400);
  });
  it('rejects multiple files and malformed multipart, cleaning any partial disk files', async () => {
    await unchangedAfterRejection(() => request(app.getHttpServer()).post('/api/documents/upload').set(auth)
      .attach('file', pdf, { filename: 'one.pdf', contentType: 'application/pdf' })
      .attach('file', pdf, { filename: 'two.pdf', contentType: 'application/pdf' }), 400);
    await unchangedAfterRejection(() => request(app.getHttpServer()).post('/api/documents/upload').set(auth)
      .set('Content-Type', 'multipart/form-data').send('missing boundary'), 400);
    await unchangedAfterRejection(() => request(app.getHttpServer()).post('/api/documents/upload').set(auth)
      .set('Content-Type', 'multipart/form-data; boundary=f08-test-boundary')
      .send('--f08-test-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\ntruncated'), 400);
  });
  it('cleans stored bytes when hashing or metadata persistence fails', async () => {
    jest.spyOn(policy, 'hashDocumentFile').mockRejectedValueOnce(new Error('Synthetic hash failure'));
    await unchangedAfterRejection(() => upload(pdf), 500);
    jest.restoreAllMocks();
    // Metadata and required audit now share a transaction. Fail that persistence boundary.
    jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('Synthetic metadata failure'));
    await unchangedAfterRejection(() => upload(pdf), 500);
  });
  it('rejects excess sheets before persistence and excessive worksheet rows before extraction results/import', async () => {
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    await unchangedAfterRejection(() => upload(workbook([['activityType', 'quantity'], ['DIESEL', 1]], policy.MAX_SPREADSHEET_SHEETS + 1), 'sheets.xlsx', mime), 400);
    const rows = [['activityType', 'quantity'], ...Array.from({ length: policy.MAX_SPREADSHEET_ROWS }, () => ['DIESEL', 1])];
    const saved = await upload(workbook(rows), 'large.xlsx', mime).expect(201);
    const result = await extract(saved.body.id); expect(result.status).toBe(400);
    expect(await prisma.document.findUnique({ where: { id: saved.body.id } })).toMatchObject({ status: 'EXTRACTION_FAILED' });
    expect(await prisma.documentExtraction.count({ where: { documentId: saved.body.id } })).toBe(0);
    expect(await prisma.activityData.count({ where: { sourceDocumentId: saved.body.id } })).toBe(0);
    expect(provider).not.toHaveBeenCalled();
    await access(join(process.cwd(), saved.body.fileUrl));
  });
  it('keeps failed and timed-out extraction sources retryable', async () => {
    const saved = await upload(pdf).expect(201);
    provider.mockRejectedValueOnce(new Error('Synthetic provider failure'));
    expect((await extract(saved.body.id)).status).toBe(500);
    await access(join(process.cwd(), saved.body.fileUrl));
    expect(await prisma.document.findUnique({ where: { id: saved.body.id } })).toMatchObject({ status: 'EXTRACTION_FAILED' });
    jest.spyOn(workload, 'withExtractionDeadline').mockRejectedValueOnce(new GatewayTimeoutException('Extraction timed out. Please retry extraction.'));
    expect((await extract(saved.body.id)).status).toBe(504);
    await access(join(process.cwd(), saved.body.fileUrl));
    expect(await prisma.document.findUnique({ where: { id: saved.body.id } })).toMatchObject({ status: 'EXTRACTION_FAILED' });
    expect((await extract(saved.body.id)).status).toBe(201);
    expect(provider).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'gpt-4o-mini', max_output_tokens: 16_384 }),
      expect.objectContaining({ timeout: workload.EXTRACTION_TIMEOUT_MS, maxRetries: 0, signal: expect.any(AbortSignal) }),
    );
  });
  it.each(['json', 'xlsx'])('retains a retryable %s source after asynchronous structured-result persistence fails', async extension => {
    const records = [{ activityType: 'DIESEL', quantity: 10, unit: 'L', recordDate: '2026-03-07' }];
    const buffer = extension === 'json' ? Buffer.from(JSON.stringify(records)) : workbook([
      ['activityType', 'quantity', 'unit', 'recordDate'], ['DIESEL', 10, 'L', '2026-03-07'],
    ]);
    const mime = extension === 'json' ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const saved = await upload(buffer, `retry.${extension}`, mime).expect(201);
    jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('Synthetic structured persistence failure'));
    expect((await extract(saved.body.id)).status).toBe(500);
    expect(await prisma.document.findUnique({ where: { id: saved.body.id } })).toMatchObject({ status: 'EXTRACTION_FAILED' });
    expect(await prisma.documentExtraction.count({ where: { documentId: saved.body.id } })).toBe(0);
    expect(await prisma.activityData.count({ where: { sourceDocumentId: saved.body.id } })).toBe(0);
    await access(join(process.cwd(), saved.body.fileUrl));
    const retried = await extract(saved.body.id);
    expect(retried.status).toBe(201);
    expect(retried.body.parsedActivities).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();
  });
  it('prevents overlapping same-document provider work without corrupting the winning operation', async () => {
    const saved = await upload(pdf).expect(201); const entered = deferred<void>(); const release = deferred<typeof emptyResult>();
    provider.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise; });
    const first = extract(saved.body.id);
    try {
      await entered.promise;
      expect((await extract(saved.body.id)).status).toBe(409);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(await prisma.document.findUnique({ where: { id: saved.body.id } })).toMatchObject({ status: 'PROCESSING' });
    } finally { release.resolve(emptyResult); }
    expect((await first).status).toBe(201);
    expect((await extract(saved.body.id)).status).toBe(201);
  });
  it('bounds concurrent documents and allows a capacity-rejected request to retry after release', async () => {
    const documents = [];
    for (let i = 0; i < workload.MAX_CONCURRENT_EXTRACTIONS + 1; i++) documents.push((await upload(pdf).expect(201)).body);
    const entered = deferred<void>(); const release = deferred<typeof emptyResult>(); let active = 0;
    provider.mockImplementation(() => { if (++active === workload.MAX_CONCURRENT_EXTRACTIONS) entered.resolve(undefined); return release.promise; });
    const running = documents.slice(0, -1).map(document => extract(document.id));
    try {
      await entered.promise;
      expect((await extract(documents.at(-1).id)).status).toBe(429);
      expect(provider).toHaveBeenCalledTimes(workload.MAX_CONCURRENT_EXTRACTIONS);
      expect(await prisma.document.findUnique({ where: { id: documents.at(-1).id } })).toMatchObject({ status: 'UPLOADED' });
    } finally { release.resolve(emptyResult); }
    expect((await Promise.all(running)).every(result => result.status === 201)).toBe(true);
    provider.mockResolvedValue(emptyResult);
    expect((await extract(documents.at(-1).id)).status).toBe(201);
  });
});
