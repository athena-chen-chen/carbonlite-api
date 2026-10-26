import { assertSafeTestDatabaseTarget } from './helpers/database-safety';
import * as XLSX from 'xlsx';
import { INestApplication } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';

jest.mock('../src/openai/openai.client', () => ({ openai: { responses: { create: jest.fn().mockRejectedValue(new Error('Unexpected provider request in authorization test')) } } }));

describe('platform, workspace and tenant authorization boundaries', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const run = uniqueTestId('authorization-wave');
  beforeAll(async () => {
    const targetDatabase = assertSafeTestDatabaseTarget();
    const setup = await createE2eApp(); app = setup.app; prisma = setup.prisma;
    const [target] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(target.name).toBe(targetDatabase.database);
  });
  afterAll(async () => { if (prisma) await cleanupTestData(prisma, run); if (app) await app.close(); });
  async function actor(membershipRole?: MembershipRole, platform = false, pilot = false) {
    const result = await createTestUser(app, { organizationName: uniqueTestId(run), email: `${uniqueTestId(run)}@carbonlite-e2e.test`, factorProfile: 'reviewed' });
    await prisma.user.update({ where: { id: result.user.id }, data: { role: platform ? 'ADMIN' : 'USER', accountType: pilot ? 'PILOT_REVIEWER' : 'CUSTOMER' } });
    if (membershipRole) await prisma.membership.create({ data: { userId: result.user.id, organizationId: result.user.organizationId, role: membershipRole } });
    return { ...result, auth: authHeader(result.accessToken) };
  }
  type Actor = Awaited<ReturnType<typeof actor>>;
  async function ownWorkspaceAdministration(user: Actor) {
    const response = await request(app.getHttpServer()).get('/api/organization-profile').set(user.auth).expect(200);
    await request(app.getHttpServer()).patch('/api/organization-profile').set(user.auth)
      .send({ organizationName: `${run} Updated workspace`, industry: 'Technology', provinceOrState: 'Alberta', country: 'Canada' }).expect(200);
    await request(app.getHttpServer()).get('/api/audit-logs').set(user.auth).expect(200);
    await request(app.getHttpServer()).get('/api/feedback').set(user.auth).expect(200);
  }

  describe('checkpoint A platform separation', () => {
    it.each([MembershipRole.OWNER, MembershipRole.ADMIN])('%s in two customer organizations is blocked from global administration', async role => {
      for (const user of [await actor(role), await actor(role)]) {
        const me = await request(app.getHttpServer()).get('/api/auth/me').set(user.auth).expect(200);
        expect(me.body).toMatchObject({ role: 'ADMIN', membershipRole: role, platformRole: 'USER' });
        for (const route of ['/admin/activity', '/admin/activity/summary', '/admin/activity/active-users', '/admin/feedback']) {
          await request(app.getHttpServer()).get('/api' + route).set(user.auth).expect(403);
        }
        await request(app.getHttpServer()).patch('/api/admin/feedback/not-owned/status').set(user.auth).send({ status: 'REVIEWED' }).expect(403);
        await request(app.getHttpServer()).post('/api/factor-sources').set(user.auth).send({}).expect(403);
        await request(app.getHttpServer()).patch('/api/factor-sources/not-owned').set(user.auth).send({}).expect(403);
        await request(app.getHttpServer()).delete('/api/factor-sources/not-owned').set(user.auth).expect(403);
        await request(app.getHttpServer()).post('/api/factors/not-owned/versions').set(user.auth).send({}).expect(403);
        await request(app.getHttpServer()).patch('/api/factor-versions/not-owned/draft').set(user.auth).send({}).expect(403);
        for (const action of ['verify', 'deprecate', 'archive']) await request(app.getHttpServer()).post(`/api/factor-versions/not-owned/${action}`).set(user.auth).send({}).expect(403);
        await request(app.getHttpServer()).post('/api/admin/pilot-reviewers').set(user.auth)
          .send({ name: 'Test reviewer', email: `${uniqueTestId(run)}@carbonlite-e2e.test`, workspace: uniqueTestId(run) }).expect(403);
        await ownWorkspaceAdministration(user);
      }
    });
    it('retains explicit platform admin global access and own-workspace administration', async () => {
      const user = await actor(undefined, true);
      for (const route of ['/admin/activity', '/admin/activity/summary', '/admin/activity/active-users', '/admin/feedback']) {
        await request(app.getHttpServer()).get('/api' + route).set(user.auth).expect(200);
      }
      await ownWorkspaceAdministration(user);
    });
  });
  describe('checkpoint B factor usage privacy', () => {
    it('scopes shared-version counts, calculations and history to each customer; platform sees global usage', async () => {
      const a = await actor(MembershipRole.OWNER);
      const b = await actor(MembershipRole.ADMIN);
      const platform = await actor(undefined, true);
      const source = await prisma.factorSource.create({ data: { sourceAuthority: run, sourceDocument: run, sourceVersion: 'test', sourceYear: 2026,
        sourceUrl: 'https://example.com/test-only', page: '1', tableReference: 'test', publishedDate: new Date('2026-01-01'), notes: 'Synthetic privacy test only' } });
      const factor = await prisma.factor.create({ data: { activityType: 'CUSTOM', displayName: run, isActive: false } });
      try {
        const version = await prisma.factorVersion.create({ data: { factorId: factor.id, sourceId: source.id, version: 'test', factorValue: 1, inputUnit: 'kg', resultUnit: 'kgCO2e' } });
        const fixtures = [];
        for (const [index, user] of [a, b].entries()) {
          const activity = await prisma.activityData.create({ data: { organizationId: user.user.organizationId, activityType: 'CUSTOM', quantity: 1, unit: 'kg', recordDate: new Date('2026-01-01'), sourceType: 'MANUAL' } });
          const metrics = [];
          for (let n = 0; n < index + 1; n++) metrics.push(await prisma.metricResult.create({ data: { organizationId: user.user.organizationId, activityDataId: activity.id, factorVersionId: version.id, metricType: 'CARBON_EMISSION', value: 1, unit: 'kgCO2e' } }));
          const history = await prisma.factorChangeLog.create({ data: { factorId: factor.id, factorVersionId: version.id, action: 'TEST_ONLY', changedBy: user.user.id } });
          fixtures.push({ user, activity, metrics, history });
        }
        for (const [index, own] of fixtures.entries()) {
          const other = fixtures[1 - index];
          const usage = await request(app.getHttpServer()).get(`/api/factor-versions/${version.id}/usage`).set(own.user.auth)
            .query({ organizationId: other.user.user.organizationId, platform: 'true' }).expect(200);
          expect(usage.body).toMatchObject({ activityRecordsUsingThisFactor: 1, calculations: index + 1, organizations: 1 });
          expect(usage.body.recentCalculations.map((item: any) => item.id).sort()).toEqual(own.metrics.map(row => row.id).sort());
          const serialized = JSON.stringify(usage.body);
          for (const secret of [other.user.user.organizationId, other.activity.id, ...other.metrics.map(row => row.id)]) expect(serialized).not.toContain(secret);
          const history = await request(app.getHttpServer()).get(`/api/factors/${factor.id}/history`).set(own.user.auth).expect(200);
          expect(history.body).toMatchObject({ total: 1, items: [expect.objectContaining({ id: own.history.id, changedBy: own.user.user.id })] });
          expect(JSON.stringify(history.body)).not.toContain(other.user.user.id);
          expect(JSON.stringify(history.body)).not.toContain(other.user.user.email);
        }
        const all = await request(app.getHttpServer()).get(`/api/factor-versions/${version.id}/usage`).set(platform.auth).expect(200);
        expect(all.body).toMatchObject({ calculations: 3, organizations: 2, activityRecordsUsingThisFactor: 2 });
        expect(all.body.recentCalculations).toHaveLength(3);
        const history = await request(app.getHttpServer()).get(`/api/factors/${factor.id}/history`).set(platform.auth).expect(200);
        expect(history.body.total).toBe(2);
      } finally {
        await prisma.metricResult.deleteMany({ where: { organizationId: { in: [a.user.organizationId, b.user.organizationId] } } });
        await prisma.factor.delete({ where: { id: factor.id } });
        await prisma.factorSource.delete({ where: { id: source.id } });
      }
    });
  });
  const activityInput = { activityType: 'DIESEL', quantity: 10, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada', sourceType: 'MANUAL' };
  const factorInput = { name: 'Synthetic custom test factor', activityType: 'CUSTOM', type: 'EMISSION', unit: 'kg', factorValue: 1, resultUnit: 'kgCO2e' };
  async function fixtures(user: Actor) {
    const activity = await request(app.getHttpServer()).post('/api/activity-data').set(user.auth).send(activityInput).expect(201);
    const facility = await request(app.getHttpServer()).post('/api/facilities').set(user.auth).send({ name: 'Synthetic test facility' }).expect(201);
    const factor = await request(app.getHttpServer()).post('/api/conversion-factors').set(user.auth).send(factorInput).expect(201);
    const report = await request(app.getHttpServer()).post('/api/reports').set(user.auth).send({ title: 'Synthetic authorization report' }).expect(201);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['activityType', 'recordDate', 'quantity', 'unit', 'jurisdictionCountry'],
      ['DIESEL', '2026-03-07', 10, 'L', 'Canada'],
    ]), 'Operations');
    const uploaded = await request(app.getHttpServer()).post('/api/documents/upload').set(user.auth).field('type', 'SPREADSHEET')
      .attach('file', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { filename: `${uniqueTestId(run)}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).expect(201);
    return { activity: activity.body, facility: facility.body, factor: factor.body, report: report.body, document: uploaded.body };
  }
  type Fixtures = Awaited<ReturnType<typeof fixtures>>;
  function mutations(f: Fixtures): Array<[string, string, unknown]> {
    return [
      ['post', '/activity-data', activityInput],
      ['post', '/activity-data/bulk-import', { items: [activityInput] }],
      ['post', '/activity-data/json-preview', {}],
      ['patch', `/activity-data/${f.activity.id}`, { quantity: 20 }],
      ['delete', `/activity-data/${f.activity.id}`, {}],
      ['post', '/activity-data/bulk-delete', { ids: [f.activity.id] }],
      ['delete', '/activity-data/bulk-delete', { ids: [f.activity.id] }],
      ['patch', '/activity-data/bulk-province', { ids: [f.activity.id], province: 'AB' }],
      ['patch', '/activity-data/bulk-facility', { ids: [f.activity.id], facilityName: 'Changed' }],
      ['delete', `/documents/${f.document.id}`, {}],
      ['post', '/document-extraction/extract', { documentId: f.document.id }],
      ['post', '/document-extraction/confirm', { documentId: f.document.id, activities: [] }],
      ['post', '/spreadsheet-import/review-rows', {}],
      ['post', '/facilities', { name: 'Denied' }],
      ['patch', `/facilities/${f.facility.id}`, { name: 'Denied' }],
      ['post', '/conversion-factors', factorInput],
      ['patch', `/conversion-factors/${f.factor.id}`, { factorValue: 2 }],
      ['delete', `/conversion-factors/${f.factor.id}`, {}],
      ['post', '/metrics/calculate', { activityDataIds: [f.activity.id], metricTypes: ['CARBON_EMISSION'] }],
      ['post', '/reports', { title: 'Denied' }],
      ['patch', `/reports/${f.report.id}`, { title: 'Denied' }],
      ['delete', `/reports/${f.report.id}`, {}],
      ['patch', '/organization-profile', { organizationName: 'Denied', industry: 'Technology', country: 'Canada', provinceOrState: 'Alberta' }],
      ['delete', '/admin/activity-records/clear', { confirmation: 'CLEAR' }],
      ['post', '/admin/demo-data/reset', { confirmation: 'RESET' }],
    ];
  }
  async function state(user: Actor) {
    const where = { organizationId: user.user.organizationId };
    return {
      activities: await prisma.activityData.findMany({ where, orderBy: { id: 'asc' } }),
      documents: await prisma.document.findMany({ where, orderBy: { id: 'asc' } }),
      facilities: await prisma.facility.findMany({ where, orderBy: { id: 'asc' } }),
      factors: await prisma.conversionFactor.findMany({ where, orderBy: { id: 'asc' } }),
      reports: await prisma.report.findMany({ where, orderBy: { id: 'asc' } }),
      metrics: await prisma.metricResult.findMany({ where, orderBy: { id: 'asc' } }),
      staging: await prisma.spreadsheetImportReviewRow.findMany({ where, orderBy: { id: 'asc' } }),
      organization: await prisma.organization.findUnique({ where: { id: user.user.organizationId } }),
    };
  }
  describe('checkpoint C mutation capability matrix', () => {
    it.each(['VIEWER', 'PILOT_REVIEWER', 'ADMIN_WITH_VIEWER_MEMBERSHIP'])('rejects direct HTTP customer mutations for %s without changing resource state', async kind => {
      const user = await actor(MembershipRole.EDITOR);
      const f = await fixtures(user);
      await prisma.membership.update({ where: { userId_organizationId: { userId: user.user.id, organizationId: user.user.organizationId } }, data: { role: 'VIEWER' } });
      await prisma.user.update({ where: { id: user.user.id }, data: { role: kind === 'ADMIN_WITH_VIEWER_MEMBERSHIP' ? 'ADMIN' : 'USER', accountType: kind === 'PILOT_REVIEWER' ? 'PILOT_REVIEWER' : 'CUSTOMER' } });
      const before = await state(user);
      for (const [method, path, body] of mutations(f)) {
        const response = await (request(app.getHttpServer()) as any)[method]('/api' + path).set(user.auth).send(body);
        expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
      }
      for (const allowDuplicate of ['false', 'true']) await request(app.getHttpServer()).post('/api/documents/upload').set(user.auth)
        .field('type', 'SPREADSHEET').field('allowDuplicate', allowDuplicate)
        .attach('file', Buffer.from('test-only'), { filename: 'denied.csv', contentType: 'text/csv' }).expect(403);
      expect(await state(user)).toEqual(before);
      for (const route of ['/activity-data', '/documents', '/facilities', '/reports', '/conversion-factors', '/organization-profile', `/activity-data/${f.activity.id}`, `/reports/${f.report.id}`, `/documents/${f.document.id}/download`]) {
        await request(app.getHttpServer()).get('/api' + route).set(user.auth).expect(200);
      }
      // Communication remains available to read-only reviewers by design.
      await request(app.getHttpServer()).post('/api/feedback').set(user.auth).send({ type: 'SUGGESTION', intent: 'Authorization review', message: 'Synthetic reviewer feedback' }).expect(201);
    });

    it.each([undefined, MembershipRole.EDITOR])('preserves authorized non-admin customer workflows (membership=%s)', async membership => {
      const user = await actor(membership);
      const f = await fixtures(user);
      await request(app.getHttpServer()).patch(`/api/activity-data/${f.activity.id}`).set(user.auth).send({ quantity: 100 }).expect(200);
      await request(app.getHttpServer()).post('/api/activity-data/bulk-import').set(user.auth).send({ items: [{ ...activityInput, activityType: 'GASOLINE', quantity: 50 }] }).expect(201);
      const electricity = await request(app.getHttpServer()).post('/api/activity-data').set(user.auth).send({ ...activityInput, activityType: 'ELECTRICITY', unit: 'kWh' }).expect(201);
      await request(app.getHttpServer()).patch('/api/activity-data/bulk-province').set(user.auth).send({ ids: [electricity.body.id], province: 'AB' }).expect(200);
      await request(app.getHttpServer()).patch('/api/activity-data/bulk-facility').set(user.auth).send({ ids: [f.activity.id], facilityName: 'Edited facility' }).expect(200);
      await request(app.getHttpServer()).post('/api/metrics/calculate').set(user.auth).send({ activityDataIds: [f.activity.id], metricTypes: ['CARBON_EMISSION'] }).expect(201);
      await request(app.getHttpServer()).patch(`/api/facilities/${f.facility.id}`).set(user.auth).send({ name: 'Edited facility' }).expect(200);
      await request(app.getHttpServer()).patch(`/api/conversion-factors/${f.factor.id}`).set(user.auth).send({ factorValue: 2 }).expect(200);
      await request(app.getHttpServer()).delete(`/api/conversion-factors/${f.factor.id}`).set(user.auth).expect(200);
      await request(app.getHttpServer()).patch(`/api/reports/${f.report.id}`).set(user.auth).send({ title: 'Edited report' }).expect(200);
      await request(app.getHttpServer()).delete(`/api/reports/${f.report.id}`).set(user.auth).expect(200);
      const extracted = await request(app.getHttpServer()).post('/api/document-extraction/extract').set(user.auth).send({ documentId: f.document.id }).expect(201);
      const unwrap = (value: any) => value && typeof value === 'object' && 'value' in value ? value.value : value;
      const activities = extracted.body.parsedActivities.map((row: any) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, unwrap(value)])));
      const confirmed = await request(app.getHttpServer()).post('/api/document-extraction/confirm').set(user.auth).send({ documentId: f.document.id, activities }).expect(201);
      expect(confirmed.body.count).toBe(1);
      const staged = await request(app.getHttpServer()).post('/api/spreadsheet-import/review-rows').set(user.auth)
        .send({ sourceType: 'EXCEL', sourceFileName: 'staged.csv', importBatchId: uniqueTestId(run), rows: [{ activityType: 'DIESEL', quantity: 10, unit: 'L', recordDate: '2026-03-07', jurisdictionCountry: 'Canada', rowId: 'row-2', sourceRow: 2, status: 'READY', issues: [] }] }).expect(201);
      expect(staged.body.sourceDocument.id).toBeTruthy();
      await request(app.getHttpServer()).delete(`/api/documents/${f.document.id}`).set(user.auth).expect(200);
      expect(await prisma.activityData.findUnique({ where: { id: confirmed.body.createdIds[0] } })).not.toBeNull();
      for (const method of ['post', 'delete']) {
        const extra = await request(app.getHttpServer()).post('/api/activity-data').set(user.auth).send(activityInput).expect(201);
        await (request(app.getHttpServer()) as any)[method]('/api/activity-data/bulk-delete').set(user.auth).send({ ids: [extra.body.id] }).expect(200);
      }
      await request(app.getHttpServer()).delete(`/api/activity-data/${f.activity.id}`).set(user.auth).expect(200);
      await request(app.getHttpServer()).patch('/api/organization-profile').set(user.auth)
        .send({ organizationName: run, industry: 'Technology', country: 'Canada', provinceOrState: 'Alberta' }).expect(403);
    });

    it('requires ownership in addition to editor capability for guessed resource IDs', async () => {
      const a = await actor(MembershipRole.EDITOR);
      const b = await actor(MembershipRole.EDITOR);
      const f = await fixtures(b);
      const before = await state(b);
      const attempts: Array<[string, string, unknown]> = [
        ['get', `/activity-data/${f.activity.id}`, {}], ['patch', `/activity-data/${f.activity.id}`, { quantity: 99 }], ['delete', `/activity-data/${f.activity.id}`, {}],
        ['get', `/documents/${f.document.id}/download`, {}], ['delete', `/documents/${f.document.id}`, {}],
        ['post', '/document-extraction/extract', { documentId: f.document.id }], ['post', '/document-extraction/confirm', { documentId: f.document.id, activities: [] }],
        ['patch', `/facilities/${f.facility.id}`, { name: 'Cross-tenant denied' }],
        ['get', `/reports/${f.report.id}`, {}], ['patch', `/reports/${f.report.id}`, { title: 'Cross-tenant denied' }], ['delete', `/reports/${f.report.id}`, {}],
        ['get', `/conversion-factors/${f.factor.id}`, {}], ['patch', `/conversion-factors/${f.factor.id}`, { factorValue: 5 }], ['delete', `/conversion-factors/${f.factor.id}`, {}],
      ];
      for (const [method, path, body] of attempts) {
        const result = await (request(app.getHttpServer()) as any)[method]('/api' + path).set(a.auth).send(body);
        expect({ method, path, blocked: [403, 404].includes(result.status) }).toEqual({ method, path, blocked: true });
        expect(result.body).not.toHaveProperty('organizationId');
      }
      expect(await state(b)).toEqual(before);
      await request(app.getHttpServer()).post('/api/activity-data').set(a.auth).send({ ...activityInput, organizationId: b.user.organizationId }).expect(400);
      const list = await request(app.getHttpServer()).get('/api/activity-data').set(a.auth).query({ organizationId: b.user.organizationId });
      expect([200, 400]).toContain(list.status);
      expect(JSON.stringify(list.body)).not.toContain(f.activity.id);
    });
  });
});
