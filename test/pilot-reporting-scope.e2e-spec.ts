import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp } from './helpers/e2e-app';
import { authHeader, cleanupTestData, createTestUser, uniqueTestId } from './helpers/factories';
import request from 'supertest';

describe('Founder Pilot date and selection intersection (disposable e2e)', () => {
  let app: INestApplication, prisma: PrismaService;
  let auth: Record<string,string>, ids: string[], doc: string, foreign: string;
  const run = uniqueTestId('pilot-period');
  beforeAll(async () => {
    ({app,prisma}=await createE2eApp());
    const owner=await createTestUser(app,{organizationName:`${run} A`,email:`a-${run}@carbonlite-e2e.test`,factorProfile:'reviewed'});
    const other=await createTestUser(app,{organizationName:`${run} B`,email:`b-${run}@carbonlite-e2e.test`,factorProfile:'reviewed'});
    auth=authHeader(owner.accessToken);
    const document=await prisma.document.create({data:{organizationId:owner.user.organizationId,fileName:`${run}.csv`,fileUrl:`${run}.csv`,type:'SPREADSHEET',status:'IMPORTED'}}); doc=document.id;
    ids=[];
    for(const date of ['2025-01-31','2026-01-31','2026-03-31']) {
      const row=await prisma.activityData.create({data:{organizationId:owner.user.organizationId,documentId:doc,activityType:'DIESEL',quantity:10,unit:'L',recordDate:new Date(`${date}T00:00:00Z`),sourceType:'MANUAL',sourceReference:run,jurisdictionCountry:'Canada',jurisdictionRegion:'Alberta'}});ids.push(row.id);
    }
    foreign=(await prisma.activityData.create({data:{organizationId:other.user.organizationId,activityType:'DIESEL',quantity:10,unit:'L',recordDate:new Date('2026-01-31T00:00:00Z'),sourceType:'MANUAL',sourceReference:run}})).id;
  });
  afterAll(async()=>{await cleanupTestData(prisma,run);await app.close();});
  it.each(['records','documents'])('intersects selected %s with an inclusive calendar period',async kind=>{
    const query=kind==='records'?{selectedActivityRecordIds:ids.join(',')}:{selectedDocumentIds:doc};
    const response=await request(app.getHttpServer()).get('/api/metrics/calculation-summary').set(auth).query({...query,periodStart:'2026-01-01',periodEnd:'2026-01-31'}).expect(200);
    expect(response.body.recordsInScope).toBe(1);
    expect(response.body.calculationDetails.map((r:{activityDataId:string})=>r.activityDataId)).toEqual([ids[1]]);
    const empty=await request(app.getHttpServer()).get('/api/metrics/calculation-summary').set(auth).query({...query,periodStart:'2024-01-01',periodEnd:'2024-12-31'}).expect(200);
    expect(empty.body.recordsInScope).toBe(0);expect(empty.body.totalEstimatedEmissionsKgCO2e).toBe(0);expect(empty.body.calculationDetails).toEqual([]);
  });
  it('preserves selection-only and tenant isolation',async()=>{
    const selected=await request(app.getHttpServer()).get('/api/metrics/calculation-summary').set(auth).query({selectedActivityRecordIds:ids.join(',')}).expect(200);
    expect(selected.body.recordsInScope).toBe(3);
    const denied=await request(app.getHttpServer()).get('/api/metrics/calculation-summary').set(auth).query({selectedActivityRecordIds:foreign,periodStart:'2026-01-01',periodEnd:'2026-12-31'}).expect(200);
    expect(denied.body.recordsInScope).toBe(0);expect(denied.body.calculationDetails).toEqual([]);
    await request(app.getHttpServer()).get('/api/metrics/calculation-summary').expect(401);
  });
  it.each(['2026-02-30','invalid'])('rejects invalid period %s',async periodStart=>{
    await request(app.getHttpServer()).get('/api/metrics/calculation-summary').set(auth).query({selectedActivityRecordIds:ids[0],periodStart,periodEnd:'2026-12-31'}).expect(400);
  });
});
