import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkPublishedWithin,parseDateEvidence,publicationState,publicationWindow} from '../src/domain/dates.js';
import {apiDateEvidence,pageDateEvidence} from '../src/platforms/boss/dates.js';
import {validateConfig,applyOverrides} from '../src/domain/config.js';
import {sanitizeJob} from '../src/domain/job.js';
import {filterJob} from '../src/domain/filter.js';
import {Store} from '../src/storage/store.js';
import {exportBatch} from '../src/export/index.js';

const NOW='2026-10-15T04:00:00.000Z';
const job={platformJobId:'fixture-dated',title:'虚构工程师',company:'虚构公司',description:'虚构测试正文',detailStatus:'complete',detailSource:'fixture'};
const evidence=(raw,kind='published',source='fixture:datePosted',observedAt=NOW)=>({kind,source,raw,observedAt});
const dated=raw=>sanitizeJob({...job,dateEvidence:[evidence(raw)]});
test('publication window uses China calendar days including today and exact cutoff',()=> {
  assert.deepEqual(publicationWindow(30,NOW),{timeZone:'Asia/Shanghai',days:30,fromDate:'2026-09-16',throughDate:'2026-10-15',includesToday:true});
  assert.equal(checkPublishedWithin(dated('2026-09-16'),30,NOW).result,'matched');
  assert.equal(checkPublishedWithin(dated('2026-09-15'),30,NOW).result,'rejected');
  assert.equal(checkPublishedWithin(dated('2026-10-15'),1,NOW).result,'matched');
  assert.equal(checkPublishedWithin(dated('2026-10-14'),1,NOW).result,'rejected');
});
test('timezone offsets and epoch timestamps normalize without host timezone assumptions',()=> {
  assert.equal(checkPublishedWithin(dated('2026-09-15T16:00:00Z'),30,NOW).result,'matched');
  assert.equal(checkPublishedWithin(dated('2026-09-15T15:59:59Z'),30,NOW).result,'rejected');
  const ms=Date.parse('2026-10-01T00:00:00+08:00');
  assert.equal(parseDateEvidence(String(ms),NOW).value,'2026-09-30T16:00:00.000Z');
  assert.equal(parseDateEvidence(String(ms/1000),NOW).value,'2026-09-30T16:00:00.000Z');
  assert.equal(parseDateEvidence('2026年10月1日',NOW).value,'2026-10-01');
});
test('future, invalid and conflicting publication dates are review, not fresh or stale guesses',()=> {
  for(const raw of ['2026-10-16','2026-10-15T13:00:00+08:00','2026-02-30','2026-13-01','10-01','30天内','0']) assert.equal(checkPublishedWithin(dated(raw),30,NOW).result,'unknown',raw);
  const conflict=sanitizeJob({...job,dateEvidence:[evidence('2026-10-01'),evidence('2026-09-01')]});
  assert.equal(publicationState(conflict).status,'conflict');assert.equal(checkPublishedWithin(conflict,30,NOW).result,'unknown');
});
test('relative dates retain their observation anchor when exporting later',()=> {
  const saved=sanitizeJob({...job,dateEvidence:[evidence('昨天','published','fixture:datePosted','2026-10-01T04:00:00Z')]});
  assert.equal(saved.publishedAt,'2026-09-30');
  assert.equal(checkPublishedWithin(saved,30,'2026-10-15T04:00:00Z').result,'matched');
  assert.equal(checkPublishedWithin(saved,30,'2026-11-15T04:00:00Z').result,'rejected');
});
test('collection, first-seen, recruiter activity and page update never imply new publication',()=> {
  const result=sanitizeJob({...job,publishedAt:'2026-10-15',collectedAt:NOW,firstSeenAt:NOW,
    dateEvidence:[evidence('2026-10-15','page_updated','job-page:metadata.upDate'),evidence('2026-10-15','updated','job-page:visible-update-label')]});
  assert.equal(result.publishedAt,null);assert.equal(result.pageUpdatedAt,'2026-10-15');assert.equal(result.jobUpdatedAt,'2026-10-15');
  assert.equal(checkPublishedWithin(result,30,NOW).result,'unknown');
  assert.equal(publicationState({dateEvidence:[evidence('2026-10-15','published','recruiter:lastActive')]}).status,'unknown');
});
test('job-scoped JobPosting and explicit publication labels count, generic Baidu upDate does not',()=> {
  const url='https://www.zhipin.com/job_detail/fixture-dated.html';
  const snapshot={url,canonical:url,jsonLd:[JSON.stringify({'@context':'https://zhanzhang.baidu.com/contexts/cambrian.jsonld','@id':url,upDate:'2026-10-15'})],dateLabels:['页面更新时间：2026-10-15']};
  const updated=sanitizeJob({...job,dateEvidence:pageDateEvidence(snapshot,job,NOW)});
  assert.equal(updated.publishedAt,null);assert.equal(updated.pageUpdatedAt,'2026-10-15');
  const record={'@type':'JobPosting','@id':url,name:job.title,datePosted:'2026-09-25'};
  const published=sanitizeJob({...job,dateEvidence:pageDateEvidence({...snapshot,jsonLd:[{'@graph':[record]}]},job,NOW)});
  assert.equal(published.publishedAt,'2026-09-25');assert.equal(published.publishedAtSource,'job-page:JobPosting.datePosted');
  assert.equal(pageDateEvidence({...snapshot,url:'https://www.zhipin.com/',jsonLd:[record]},job,NOW).length,0);
  assert.equal(pageDateEvidence({...snapshot,jsonLd:[{...record,'@id':'https://www.zhipin.com/job_detail/other.html'}]},job,NOW).filter(x=>x.kind==='published').length,0);
  const label=pageDateEvidence({...snapshot,jsonLd:[],dateLabels:['发布于 3天前']},job,NOW);
  assert.equal(sanitizeJob({...job,dateEvidence:label}).publishedAt,'2026-10-12');
});
test('API only uses semantically explicit publication fields, not createTime or activity',()=> {
  const dates=apiDateEvidence({publishTime:'2026-09-20',createTime:NOW,lastModifyTime:'2026-10-14',bossActiveTimeDesc:'刚刚活跃'},'jobInfo',NOW);
  const result=sanitizeJob({...job,dateEvidence:dates});assert.equal(result.publishedAt,'2026-09-20');assert.equal(result.jobUpdatedAt,'2026-10-14');
  assert.equal(apiDateEvidence({createTime:NOW,bossActiveTimeDesc:'刚刚活跃'},'jobInfo',NOW).length,0);
});
test('freshness config is opt-in, rejects bad inputs and preserves other overrides',()=> {
  assert.equal(validateConfig().preferences.publishedWithinDays,null);
  for(const value of [0,-1,1.2,3651,'30',true]) assert.throws(()=>validateConfig({preferences:{publishedWithinDays:value}}));
  const c=applyOverrides({preferences:{candidate:{educationLevel:'本科'}}},{publishedWithinDays:'30'});
  assert.equal(c.preferences.publishedWithinDays,30);assert.equal(c.preferences.candidate.educationLevel,'本科');
  assert.throws(()=>applyOverrides({},{publishedWithinDays:'abc'}));
  assert.equal(filterJob(job,validateConfig({preferences:{publishedWithinDays:30}}).preferences,{now:NOW}).status,'review');
});
test('SQLite revisiting list preserves date evidence and first-seen time independently',()=> {
  const store=new Store(':memory:');
  try {
    const id=store.createBatch(validateConfig());store.saveJob(id,dated('2026-09-20'),{kind:'detail'});store.saveJob(id,{...job,description:'',detailStatus:'pending'});
    assert.equal(store.jobs(id)[0].publishedAt,'2026-09-20');assert.ok(store.jobs(id)[0].firstSeenAt);
    const other=store.createBatch(validateConfig());store.saveJob(other,job);
    assert.equal(store.jobs(other)[0].firstSeenAt,store.jobs(id)[0].firstSeenAt);assert.equal(store.jobs(other)[0].publishedAt,null);
  }finally{store.close();}
});
test('export fixes evaluation time, warns missing dates and partitions recent/old/unknown',async()=> {
  const directory=await mkdtemp(join(tmpdir(),'job-dates-')),store=new Store(':memory:');
  try {
    const config=validateConfig({preferences:{publishedWithinDays:30}}),id=store.createBatch(config);
    store.saveJob(id,dated('2026-09-16'));
    store.saveJob(id,{...dated('2026-09-15'),platformJobId:'fixture-old'});
    store.saveJob(id,{...job,platformJobId:'fixture-undated'});
    const {dir,summary}=await exportBatch(store,id,config,directory,{now:NOW});
    assert.deepEqual(summary.selection,{matched:1,rejected:1,review:1});assert.equal(summary.evaluatedAt,NOW);
    assert.equal(summary.publicationWindow.fromDate,'2026-09-16');assert.equal(summary.publicationDates.unknown,1);assert.equal(summary.warnings.length,1);
    const csv=await readFile(join(dir,'jobs.csv'),'utf8');assert.ok(csv.includes('publishedAtSource'));assert.ok(csv.includes('fixture-dated'));assert.ok(!csv.includes('fixture-undated'));
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
