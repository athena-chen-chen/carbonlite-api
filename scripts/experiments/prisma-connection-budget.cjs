/* Disposable CI experiment only. Never import application bootstrap or read .env. */
'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
if (process.env.CI !== 'true' || process.env.GITHUB_REPOSITORY !== 'athena-chen-chen/carbonlite-api' ||
    process.env.GITHUB_REF !== 'refs/heads/experiment/prisma-connection-budgets' || process.env.APP_ENV !== 'test') {
  throw new Error('Disposable experiment identity required');
}
const { PrismaClient } = require('@prisma/client');
assert.equal(require('@prisma/client/package.json').version, '6.19.3');
require('@nestjs/common').Logger.overrideLogger(false);
const { verifyPoolIdentity } = require('../../dist/prisma/pool-identity');
const { classifyPoolStartupFailure } = require('../../dist/prisma/pool-startup-diagnostics');
const { ControlDatabaseService } = require('../../dist/prisma/control-database.service');
const { ControlAdmissionService } = require('../../dist/prisma/control-admission.service');
const { controlRequestContext } = require('../../dist/prisma/control-request.context');
const samples = [], checks = [];
const safeCodes = new Set(['P1000','P1001','P1002','P1008','P1011','P2024','P2028','P2010']);
const safeError = e => ({ code: safeCodes.has(e?.errorCode ?? e?.code) ? (e.errorCode ?? e.code) : 'UNKNOWN', category: classifyPoolStartupFailure(e) });
const url = (port, budget, limit, user='postgres', password='postgres', db='carbonlite_ci_test', tls=false) =>
  `postgresql://${user}:${password}@127.0.0.1:${port}/${db}?sslmode=${tls?'require':'disable'}&sslaccept=strict&connection_limit=${limit}&connect_timeout=${budget}&pool_timeout=${budget}`;
const client = (port,budget,limit,...rest) => new PrismaClient({datasourceUrl:url(port,budget,limit,...rest),log:[]});
const expected = {mode:'local',database:'carbonlite_ci_test',role:'postgres'};
const barrier=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function measure(labels, phase, operation) {
  const start=performance.now(); let result;
  try { result=await operation(); samples.push({...labels,phase,ok:true,ms:performance.now()-start}); return {ok:true,result}; }
  catch(e){samples.push({...labels,phase,ok:false,ms:performance.now()-start,...safeError(e)});return {ok:false,error:e};}
}
function check(name, condition) { checks.push({name,pass:!!condition}); }
async function proxy(target, delay, stall=false) {
  const sockets=new Set(), timers=new Set();
  const server=net.createServer(c=>{
    sockets.add(c);c.pause();c.on('error',()=>{});c.on('close',()=>sockets.delete(c));
    if(stall)return;
    const timer=setTimeout(()=>{
      timers.delete(timer);if(c.destroyed)return;
      const upstream=net.connect(target,'127.0.0.1',()=>{c.pipe(upstream);upstream.pipe(c);c.resume();});
      sockets.add(upstream);upstream.on('error',()=>c.destroy());upstream.on('close',()=>sockets.delete(upstream));c.on('close',()=>upstream.destroy());
    },delay);timers.add(timer);
  });
  await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
  return {port:server.address().port, close:async()=>{for(const t of timers)clearTimeout(t);for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
async function pools(target,budget,delay,trial) {
  const p=await proxy(target,delay), work=client(p.port,budget,4), control=client(p.port,budget,2);
  const labels={case:'initialization',target:target===55447?'postgres':'pgbouncer',budget,delay,trial};
  const total=performance.now();let ok=true;
  try {
    for(const [kind,c] of [['work',work],['control',control]]) {
      const connected=await measure({...labels,kind},'connect',()=>c.$connect());
      if(!connected.ok){ok=false;break;}
      const identity=await measure({...labels,kind},'identity',()=>verifyPoolIdentity(c,expected));
      if(!identity.ok){ok=false;break;}
    }
    samples.push({...labels,phase:'complete',ok,ms:performance.now()-total});
  } finally {
    await measure(labels,'cleanup',async()=>{await Promise.all([work.$disconnect(),control.$disconnect()]);await p.close();});
  }
  const recovered=client(target,budget,4);
  try { const r=await measure(labels,'fresh-recovery',async()=>{await recovered.$connect();await verifyPoolIdentity(recovered,expected);});check('fresh recovery '+JSON.stringify(labels),r.ok); }
  finally{await recovered.$disconnect();}
}
async function negatives(budget,trial) {
  const stalled=await proxy(55447,0,true);
  for(const kind of ['unavailable','invalid-credentials','invalid-tls','wrong-database','wrong-role']) {
    const c=kind==='unavailable'?client(stalled.port,budget,4):kind==='invalid-credentials'?client(55447,budget,4,'postgres','deliberately-invalid'):client(55447,budget,4,'postgres','postgres','carbonlite_ci_test',kind==='invalid-tls');
    try {
      const r=await measure({case:kind,budget,trial},'rejection',async()=>{
        await c.$connect();
        await verifyPoolIdentity(c,{...expected,...(kind==='wrong-database'?{database:'wrong_disposable_database'}:{}),...(kind==='wrong-role'?{role:'wrong_disposable_role'}:{})});
      });
      check(kind+' rejects '+budget+'/'+trial,!r.ok);
    }finally{await c.$disconnect();}
  }
  await stalled.close();
}
async function exhaustion(budget,trial) {
  const work=client(55447,budget,4),control=client(55447,budget,2),release=barrier();
  await work.$connect();await control.$connect();
  const entered=Array.from({length:4},barrier);
  const holders=entered.map(b=>work.$transaction(async tx=>{await tx.$queryRaw`SELECT 1`;b.resolve();await release.promise;},{maxWait:2000,timeout:20000}));
  try {
    await Promise.all(entered.map(b=>b.promise));
    const isolated=await measure({case:'work-saturated-control-identity',budget,trial},'identity',()=>verifyPoolIdentity(control,expected));check('control isolation '+budget+'/'+trial,isolated.ok);
    const blocked=await measure({case:'work-pool-exhaustion',budget,trial},'query',()=>work.$queryRaw`SELECT 1`);check('work exhaustion bounded '+budget+'/'+trial,!blocked.ok && safeError(blocked.error).code==='P2024');
  }finally{release.resolve();await Promise.allSettled(holders);await Promise.all([work.$disconnect(),control.$disconnect()]);}
}
async function controlPressure(budget,trial) {
  // Test-only injection changes client options, not control admission/deadline implementation.
  const admission=new ControlAdmissionService();const service=new ControlDatabaseService({$transaction(){throw Error('No Work fallback');}},admission);
  await service.client.$disconnect();service.client=client(55447,budget,2);await service.initializeVerified();
  const ready=[barrier(),barrier()],release=barrier();
  const held=ready.map(b=>service.client.$transaction(async tx=>{await tx.$queryRaw`SELECT 1`;b.resolve();await release.promise;},{maxWait:2000,timeout:5000}));
  try {
    await Promise.all(ready.map(b=>b.promise));
    const r=await measure({case:'control-pool-exhaustion',budget,trial},'authenticate',()=>service.authenticate(tx=>tx.$queryRaw`SELECT 1`));
    check('control saturation rejects '+budget+'/'+trial,!r.ok && r.error?.getResponse?.().automaticRetry===false);
  } finally {release.resolve();await Promise.allSettled(held);}
  const permit=admission.acquire();
  const context={deadline:Date.now()+6000,expired:false,permit};
  try {
    const r=await measure({case:'control-request-deadline',budget,trial},'transaction',()=>controlRequestContext.run(context,()=>service.transaction('AUTHENTICATION',tx=>tx.$queryRaw`SELECT pg_sleep(7)`)));
    check('control deadline rejects '+budget+'/'+trial,!r.ok);
    const measured=samples.at(-1);check('control deadline bounded '+budget+'/'+trial,measured.ms<6500);
  } finally {permit.endResponse();await permit.done;}
  const latePermit=admission.acquire(), entered=barrier(), finish=barrier();
  const lateContext={deadline:Date.now()+6000,expired:false,permit:latePermit};
  const pending=measure({case:'request-deadline-pending-callback',budget,trial},'deadline',()=>controlRequestContext.run(lateContext,()=>service.transaction('AUTHENTICATION',async tx=>{await tx.$queryRaw`SELECT 1`;entered.resolve();await finish.promise;})));
  await entered.promise;
  const late=await pending;
  latePermit.endResponse();
  let busy=false;try{admission.acquire().endResponse();}catch{busy=true;}
  check('pending permit held after deadline '+budget+'/'+trial,busy);
  check('deadline reports UNKNOWN without retry '+budget+'/'+trial,!late.ok && late.error?.getResponse?.().outcome==='UNKNOWN' && late.error?.getResponse?.().automaticRetry===false);
  finish.resolve();await latePermit.done;
  const recovered=await measure({case:'control-deadline-recovery',budget,trial},'authenticate',()=>service.authenticate(tx=>tx.$queryRaw`SELECT 1`));check('control recovery '+budget+'/'+trial,recovered.ok);
  await service.onModuleDestroy();
}
function summary(){
  const groups=new Map();for(const s of samples){const k=JSON.stringify({case:s.case,target:s.target,budget:s.budget,delay:s.delay,kind:s.kind,phase:s.phase});if(!groups.has(k))groups.set(k,[]);groups.get(k).push(s);}
  return [...groups].map(([key,rows])=>{const times=rows.map(r=>r.ms).sort((a,b)=>a-b);const percentile=p=>Math.round(times[Math.max(0,Math.ceil(p*times.length)-1)]);return {...JSON.parse(key),trials:rows.length,success:rows.filter(r=>r.ok).length,medianMs:percentile(.5),p95Ms:percentile(.95),maxMs:percentile(1),errors:[...new Set(rows.filter(r=>!r.ok).map(r=>`${r.code}/${r.category}`))]};});
}
const watchdog=setTimeout(()=>{console.log('EXPERIMENT_WATCHDOG_EXCEEDED');process.exit(2);},20*60*1000);
(async()=>{
  // Three explicit independent trials, never an automatic retry of an operation.
  for(let trial=1;trial<=3;trial++)for(const budget of [1,5,10]){
    for(const target of [55447,55448])for(const delay of [0,500,1200,2500])await pools(target,budget,delay,trial);
    await negatives(budget,trial);await exhaustion(budget,trial);await controlPressure(budget,trial);
  }
  const report={sha:process.env.GITHUB_SHA,node:process.version,prisma:'6.19.3',limits:{work:4,control:2},limitations:['Synthetic loopback latency is not Neon cold-start or TLS timing.','Prospective options injected only in experiment; not a production constructor change.','Identity helper retains its 1000ms transaction timeout and 500ms acquisition budget.','Three trials: P95 is descriptive, not a reliability or SLA estimate.'],checks,summary:summary(),samples};
  fs.mkdirSync('experiment-results',{recursive:true});fs.writeFileSync('experiment-results/results.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({sha:report.sha,node:report.node,checks:checks.length,failedChecks:checks.filter(c=>!c.pass),summary:report.summary}));
  if(checks.some(c=>!c.pass))process.exitCode=1;
})().catch(e=>{console.log(JSON.stringify({experimentFailed:true,...safeError(e)}));process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
