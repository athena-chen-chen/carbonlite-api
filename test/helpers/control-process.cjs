// Disposable-test subprocess only. Never load this fixture as application code.
const path = require('node:path');
const database = new URL(process.env.DATABASE_URL || '');
if (process.env.NODE_ENV !== 'test' || process.env.APP_ENV !== 'test' || process.env.LOCAL_CONTROL_POOL_PROTOTYPE !== 'true' ||
    process.env.CONTROL_POOL_MODE || database.search || !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !['carbonlite_ci_test', 'carbonlite_test'].includes(database.pathname.slice(1))) throw new Error('Disposable subprocess target required');
const root = process.env.CARBONLITE_TEST_BUILD_ROOT || process.cwd(), mode = process.argv[2];
if (root !== process.cwd() && !/^\/(?:private\/)?tmp\/carbonlite-phase-e-rollback-[A-Za-z0-9_-]+$/.test(require('node:fs').realpathSync(root))) throw new Error('Disposable rollback artifact required');
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
    if (mode === 'after-provider-response') return { get output_text() { send({ event: 'provider-response' }); return JSON.stringify({ activities: [{ activityType: 'DIESEL', recordDate: '2026-03-07', quantity: 1, unit: 'L', jurisdictionCountry: 'Canada' }] }); } };
    return { output_text: JSON.stringify({ activities: ['final-ack', 'dispatch-before-send', 'after-provider-response'].includes(mode) ? [{ activityType: 'DIESEL', recordDate: '2026-03-07', quantity: 1, unit: 'L', jurisdictionCountry: 'Canada' }] : [] }) };
  } } },
} };
delete process.env.OPENAI_API_KEY;
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require(path.join(root, 'dist/app.module.js'));
const { PrismaService } = require(path.join(root, 'dist/prisma/prisma.service.js'));
const { ControlDatabaseService } = mode === 'rollback' ? {} : require(path.join(root, 'dist/prisma/control-database.service.js'));
const { ControlAdmissionService } = mode === 'rollback' ? {} : require(path.join(root, 'dist/prisma/control-admission.service.js'));
const { ExtractionOperationsService } = mode === 'rollback' ? {} : require(path.join(root, 'dist/document-extraction/extraction-operations.service.js'));
const { DocumentExtractionService } = require(path.join(root, 'dist/document-extraction/document-extraction.service.js'));
const { AuditLogService } = require(path.join(root, 'dist/audit-log/audit-log.service.js'));
(async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })); app.enableShutdownHooks();
  const work = app.get(PrismaService), control = mode === 'rollback' ? null : app.get(ControlDatabaseService), operations = mode === 'rollback' ? null : app.get(ExtractionOperationsService);
  if (mode === 'dispatch-before-send') {
    // Emission after the dispatch transaction resolves and before RPC arguments
    // are constructed; unlike wrapping dispatch(), this is outside its transaction.
    let dispatchCommitted = false;
    const transaction = work.$transaction.bind(work);
    work.$transaction = async (...args) => { const result = await transaction(...args); if (dispatchCommitted) { dispatchCommitted = false; await pause('dispatch-before-send'); } return result; };
    const dispatch = operations.dispatch.bind(operations);
    operations.dispatch = async (...args) => { const result = await dispatch(...args); dispatchCommitted = true; return result; };
  }
  if (mode === 'after-provider-response' || mode === 'final-ack') {
    const finalize = operations.finalize.bind(operations);
    operations.finalize = async (...args) => {
      if (mode === 'after-provider-response') await pause('response-before-persistence');
      const mutate = args[4];
      return finalize(...args.slice(0, 4), async tx => { const result = await mutate(tx); if (mode === 'final-ack') await pause('final-ack'); return result; });
    };
  }
  if (mode.startsWith('deletion-')) {
    const { DeletionRecoveryService } = require(path.join(root, 'dist/deletion-recovery/deletion-recovery.service.js'));
    const { DOCUMENT_STORAGE } = require(path.join(root, 'dist/documents/document-storage.js'));
    const deletion = app.get(DeletionRecoveryService), prepare = deletion.prepareDocument.bind(deletion), complete = deletion.completeDocument.bind(deletion);
    if (mode === 'deletion-prepared' || mode === 'deletion-ack') deletion.prepareDocument = async (...args) => { const result = await prepare(...args); await pause('deletion-prepared'); return result; };
    if (mode === 'deletion-committed') deletion.completeDocument = async (...args) => { const result = await complete(...args); await pause('deletion-committed'); return result; };
    if (mode === 'deletion-quarantined') {
      const storage = app.get(DOCUMENT_STORAGE), quarantine = storage.quarantine.bind(storage);
      storage.quarantine = async (...args) => { const result = await quarantine(...args); await pause('deletion-quarantined'); return result; };
    }
  }
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
  if (mode === 'suspension-before-fence' || mode === 'suspension-after-fence') {
    const validate = operations.lockAndValidate.bind(operations);
    operations.lockAndValidate = async (...args) => {
      if (mode === 'suspension-before-fence') await pause('suspension-before-fence');
      const result = await validate(...args);
      if (mode === 'suspension-after-fence') await pause('suspension-after-fence');
      return result;
    };
  }
  if (mode === 'suspension-audit-failure') {
    const transaction = control.transaction.bind(control);
    control.transaction = (label, callback, ...options) => transaction(label, tx => callback(new Proxy(tx, {
      get(target, property) {
        if (property !== 'auditLog') return target[property];
        return new Proxy(target.auditLog, { get(delegate, method) {
          if (method !== 'create') return delegate[method];
          return input => { if (input.data.action === 'CUSTOMER_ORGANIZATION_SUSPENDED') throw new Error('Synthetic suspension audit failure'); return delegate.create(input); };
        } });
      },
    })), ...options);
  }
  if (mode === 'after-final') {
    const extraction = app.get(DocumentExtractionService), extract = extraction.extract.bind(extraction);
    extraction.extract = async (...args) => { const result = await extract(...args); await pause('after-final'); return result; };
  }
  if (mode === 'control-withdraw' || mode === 'control-suspend') {
    const { RealDataAuthorizationService } = require(path.join(root, 'dist/real-data-authorization/real-data-authorization.service.js'));
    const real = app.get(RealDataAuthorizationService), lock = real.lockProcessingApproval.bind(real); let once = true;
    real.lockProcessingApproval = async (...args) => { await lock(...args); if (!args[2] && once) { once = false; await pause('control-fence-held'); } };
  }
  if (mode === 'shutdown') {
    const audit = app.get(AuditLogService), log = audit.log.bind(audit), admission = app.get(ControlAdmissionService), close = admission.close.bind(admission);
    audit.log = async (input, tx) => { const result = await log(input, tx); if (input.action === 'REAL_DATA_AUTHORIZATION_WITHDRAWN') await pause('withdrawal-prepared'); return result; };
    admission.close = () => { send({ event: 'draining' }); return close(); };
  }
  process.on('message', message => {
    if (message === 'release') release();
    if (message === 'wait-idle') app.get(ControlAdmissionService).whenIdle().then(() => send({ event: 'control-idle' }));
    if (message && ['finalize', 'finalize-probe'].includes(message.command)) {
      work.$transaction(tx => operations.finalize(tx, message.organizationId, message.documentId, message.operationId,
        async tx => { if (message.command === 'finalize-probe') { await tx.userActivityEvent.create({ data: { organizationId: message.organizationId, entityId: message.documentId, eventName: 'PHASE_E_PROVISIONAL' } }); send({ event: 'provisional-prepared' }); } else send({ event: 'unsafe-finalization' }); }))
        .then(() => send({ event: 'finalized' }), error => send({ event: 'fence-denied', status: error.getStatus?.(), code: error.getResponse?.()?.code }));
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
