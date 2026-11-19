// Disposable-test subprocess only. Never load this fixture as application code.
const path = require('node:path');
const database = new URL(process.env.DATABASE_URL || '');
if (process.env.NODE_ENV !== 'test' || process.env.APP_ENV !== 'test' || process.env.LOCAL_CONTROL_POOL_PROTOTYPE !== 'true' ||
    process.env.CONTROL_POOL_MODE || database.search || !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !['carbonlite_ci_test', 'carbonlite_test'].includes(database.pathname.slice(1))) throw new Error('Disposable subprocess target required');
const root = process.cwd(), mode = process.argv[2];
let release; const blocked = new Promise(resolve => { release = resolve; });
const send = event => process.send?.(event);
const pause = async event => { send({ event }); await blocked; };
// Replace the module BEFORE loading any application service. No SDK/provider is constructed.
const providerPath = require.resolve(path.join(root, 'dist/openai/openai.client.js'));
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: {
  isOpenAiConfigured: () => true,
  openai: { responses: { create: async () => {
    send({ event: 'provider-accepted' });
    if (mode === 'after-dispatch') await blocked;
    return { output_text: JSON.stringify({ activities: [] }) };
  } } },
} };
delete process.env.OPENAI_API_KEY;
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require(path.join(root, 'dist/app.module.js'));
const { PrismaService } = require(path.join(root, 'dist/prisma/prisma.service.js'));
const { ControlDatabaseService } = require(path.join(root, 'dist/prisma/control-database.service.js'));
const { ControlAdmissionService } = require(path.join(root, 'dist/prisma/control-admission.service.js'));
const { ExtractionOperationsService } = require(path.join(root, 'dist/document-extraction/extraction-operations.service.js'));
const { DocumentExtractionService } = require(path.join(root, 'dist/document-extraction/document-extraction.service.js'));
const { AuditLogService } = require(path.join(root, 'dist/audit-log/audit-log.service.js'));
(async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })); app.enableShutdownHooks();
  const work = app.get(PrismaService), control = app.get(ControlDatabaseService), operations = app.get(ExtractionOperationsService);
  if (mode === 'before-dispatch') {
    const dispatch = operations.dispatch.bind(operations);
    operations.dispatch = async (...args) => { await pause('before-dispatch'); return dispatch(...args); };
  }
  if (mode === 'before-final') {
    const finalize = operations.finalize.bind(operations);
    operations.finalize = (...args) => {
      const mutate = args[4];
      return finalize(...args.slice(0, 4), async tx => { const result = await mutate(tx); await pause('before-final'); return result; });
    };
  }
  if (mode === 'after-final') {
    const extraction = app.get(DocumentExtractionService), extract = extraction.extract.bind(extraction);
    extraction.extract = async (...args) => { const result = await extract(...args); await pause('after-final'); return result; };
  }
  if (mode === 'shutdown') {
    const audit = app.get(AuditLogService), log = audit.log.bind(audit), admission = app.get(ControlAdmissionService), close = admission.close.bind(admission);
    audit.log = async (input, tx) => { const result = await log(input, tx); if (input.action === 'REAL_DATA_AUTHORIZATION_WITHDRAWN') await pause('withdrawal-prepared'); return result; };
    admission.close = () => { send({ event: 'draining' }); return close(); };
  }
  process.on('message', message => {
    if (message === 'release') release();
    if (message && message.command === 'finalize') {
      work.$transaction(tx => operations.finalize(tx, message.organizationId, message.documentId, message.operationId,
        async () => { send({ event: 'unsafe-finalization' }); }))
        .then(() => send({ event: 'finalized' }), error => send({ event: 'fence-denied', status: error.getStatus?.() }));
    }
    if (message === 'hold-pools') {
      const hold = async tx => { const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`; send({ event: 'connection-held', pid: row.pid }); await blocked; };
      Promise.all([...Array.from({ length: 4 }, () => work.$transaction(hold, { timeout: 15000 })),
        ...Array.from({ length: 2 }, () => control.client.$transaction(hold, { timeout: 15000 }))])
        .then(() => send({ event: 'pools-released' }), () => send({ event: 'hold-failed' }));
    }
  });
  await app.listen(0, '127.0.0.1'); send({ event: 'ready', port: app.getHttpServer().address().port });
})().catch(() => { send({ event: 'fatal' }); process.exit(1); });
