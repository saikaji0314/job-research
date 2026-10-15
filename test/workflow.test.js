import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { validateConfig } from '../src/domain/config.js';
import { ResearchError } from '../src/domain/errors.js';
import { collect } from '../src/collection.js';
import { exportBatch,csvCell } from '../src/export/index.js';
import { acquireLock } from '../src/browser/lock.js';

const config = () => validateConfig({regionName:'示例城市',keywords:['接口','数据库'],collection:{detailIntervalMs:1000}});
const job = id => ({platform:'boss',platformJobId:id,title:'示例岗位',salary:'18-28K',detailStatus:'pending'});
const fake = overrides => ({initialize:async()=>{},regionCode:async()=> 'fixture-city',
  discover:async({keyword,onBatch})=> {await onBatch([job('one')],{sourceUrl:'https://www.zhipin.com/web/geek/jobs'});return{url:'https://www.zhipin.com/web/geek/jobs',reason:'end'};},
  detail:async j=>({...j,description:'虚构正文',detailStatus:'complete',detailSource:'fixture'}),...overrides});

test('SQLite preserves per-batch history, dedupes jobs and keeps all keyword origins',()=> {
  const store = new Store(':memory:');
  try {
    const id=store.createBatch(config());
    store.saveJob(id,job('one'),{keyword:'接口'});
    store.saveJob(id,{...job('one'),description:'虚构正文',detailStatus:'complete',detailSource:'fixture'},{kind:'detail',attempted:true});
    store.saveJob(id,job('one'),{keyword:'数据库'});
    const rows=store.jobs(id); assert.equal(rows.length,1);assert.equal(rows[0].description,'虚构正文');
    assert.deepEqual(rows[0].keywords,['接口','数据库']); assert.equal(rows[0].detailAttempts,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM snapshots').get().n,3);
    const other=store.createBatch(config());store.saveJob(other,job('one')); assert.equal(store.jobs(other)[0].detailStatus,'pending');
  }finally{store.close();}
});
test('collector saves partial discovery and resumes paused search without losing jobs',async()=> {
  const store = new Store(':memory:');let id;
  try {
    await assert.rejects(collect({store,config:config(),adapter:fake({discover:async({onBatch})=>{
      await onBatch([job('one')],{sourceUrl:'https://www.zhipin.com/web/geek/jobs'});
      throw new ResearchError('VERIFICATION_REQUIRED');
    }}),phase:'list'}),error=>{id=error.batchId;return error.code==='VERIFICATION_REQUIRED';});
    assert.equal(store.batch(id).status,'paused');assert.equal(store.jobs(id).length,1);
    await collect({store,config:config(),adapter:fake(),batchId:id,phase:'list'});
    assert.equal(store.batch(id).status,'listed');assert.equal(store.jobs(id).length,1);
    assert.equal(store.jobs(id)[0].keywords.length,2);
  } finally {store.close();}
});
test('paused detail does not mark job failed or lose pending work',async()=> {
  const store = new Store(':memory:');
  try {
    const c=config(),id=store.createBatch(c);store.saveJob(id,job('one'));
    await assert.rejects(collect({store,config:c,batchId:id,phase:'details',adapter:fake({detail:async()=>{throw new ResearchError('AUTHENTICATION_REQUIRED');}})}));
    assert.equal(store.batch(id).status,'paused');assert.equal(store.jobs(id)[0].detailStatus,'pending');
    const controller=new AbortController();controller.abort();
    await assert.rejects(collect({store,config:c,batchId:id,phase:'details',signal:controller.signal,adapter:fake()}),e=>e.code==='INTERRUPTED');
    assert.equal(store.jobs(id)[0].detailAttempts,0);
  }finally{store.close();}
});
test('identity mismatch is saved as failure with no body and prior evidence retained',async()=> {
  const store = new Store(':memory:');
  try {
    const c=config(),id=store.createBatch(c);store.saveJob(id,job('one'));
    await collect({store,config:c,batchId:id,phase:'details',adapter:fake({detail:async()=>{throw new ResearchError('IDENTITY_MISMATCH');}})});
    assert.equal(store.jobs(id)[0].detailStatus,'identity_mismatch');assert.equal(store.jobs(id)[0].description,'');
    assert.equal(store.batch(id).status,'completed_with_gaps');
    let attempted=0;
    await collect({store,config:c,batchId:id,phase:'details',adapter:fake({detail:async()=>{attempted++;}})});
    assert.equal(attempted,0);
    await collect({store,config:c,batchId:id,phase:'details',retryFailed:true,adapter:fake()});
    assert.equal(store.jobs(id)[0].detailAttempts,2);assert.equal(store.batch(id).status,'complete');
  }finally{store.close();}
});
test('explicit refresh re-reads completed details, saves dates and retains prior snapshots',async()=> {
  const store=new Store(':memory:');let reads=0;
  try {
    const c=config(),id=store.createBatch(c);
    store.saveJob(id,{...job('one'),description:'虚构旧正文',detailStatus:'complete',detailSource:'fixture'},{kind:'detail',attempted:true});
    const adapter=fake({detail:async j=>{reads++;return {...j,description:'虚构新正文',dateEvidence:[{kind:'published',raw:'2026-10-01',source:'fixture:datePosted',observedAt:'2026-10-15T04:00:00Z'}]};}});
    await collect({store,config:c,batchId:id,phase:'details',adapter});assert.equal(reads,0);
    await collect({store,config:c,batchId:id,phase:'details',refreshDetails:true,adapter});
    assert.equal(reads,1);assert.equal(store.jobs(id)[0].publishedAt,'2026-10-01');assert.equal(store.jobs(id)[0].detailAttempts,2);
    const snapshots=store.db.prepare("SELECT data FROM snapshots WHERE batch_id=? AND kind='detail' ORDER BY id").all(id);
    assert.equal(snapshots.length,2);assert.equal(JSON.parse(snapshots[0].data).description,'虚构旧正文');assert.equal(JSON.parse(snapshots[1].data).description,'虚构新正文');
  }finally{store.close();}
});

test('exports preserve raw data, multiline CSV, formulas, and separate re-filter configurations',async()=> {
  const dir=await mkdtemp(join(tmpdir(),'job-research-test-')),store=new Store(join(dir,'test.db'));
  try {
    const c=config(),id=store.createBatch(c);
    store.saveJob(id,{...job('one'),title:'=DANGEROUS()',description:'第一行,"引号"\n第二行',detailStatus:'complete',detailSource:'fixture'});
    const one=await exportBatch(store,id,c,dir);
    const stricter=validateConfig({...c,preferences:{salary:{minMonthlyK:40}}});
    const two=await exportBatch(store,id,stricter,dir);
    assert.equal(one.summary.selection.matched,1);assert.equal(two.summary.selection.rejected,1);assert.notEqual(one.dir,two.dir);
    const csv=await readFile(join(one.dir,'jobs.csv'),'utf8');
    assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("'=DANGEROUS()"));assert.ok(csv.includes('""引号""\n第二行'));
    const row=JSON.parse((await readFile(join(two.dir,'jobs.jsonl'),'utf8')).trim());assert.equal(row.salary,'18-28K');
    assert.equal(store.jobs(id)[0].title,'=DANGEROUS()');
    assert.equal(csvCell('  +SUM(1)'), '"\'  +SUM(1)"');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('profile lock prevents concurrent collectors and can be released',async()=> {
  const dir=await mkdtemp(join(tmpdir(),'job-research-lock-'));
  try {const release=await acquireLock(dir);await assert.rejects(acquireLock(dir),e=>e.code==='PROFILE_BUSY');await release();await(await acquireLock(dir))();}
  finally{await rm(dir,{recursive:true,force:true});}
});
