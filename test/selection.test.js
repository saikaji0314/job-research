import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateConfig} from '../src/domain/config.js';
import {filterJob,parseSalary} from '../src/domain/filter.js';
import {checkEducation,checkExperience,internshipEvidence} from '../src/domain/qualification.js';
import {Store} from '../src/storage/store.js';
import {exportBatch} from '../src/export/index.js';

const preferences=input=>validateConfig({preferences:input}).preferences;
const job={platformJobId:'synthetic-base',title:'虚构研发工程师',company:'虚构公司',salary:'20-30K',degree:'本科',experience:'1-3年',
  description:'虚构岗位职责，仅用于离线测试',detailStatus:'complete',detailSource:'fixture'};
test('education eligibility compares required minimum with candidate degree rather than equality',()=> {
  for(const required of ['本科','大专及以上','学历不限','本科或硕士','本科及以上，硕士优先']) assert.equal(checkEducation(required,'本科').result,'matched',required);
  for(const required of ['硕士','硕士及以上','博士']) assert.equal(checkEducation(required,'本科').result,'rejected',required);
  assert.equal(checkEducation('','本科').result,'unknown');
  assert.equal(checkEducation('本科且硕士','本科').result,'unknown');
});
test('experience has explicit primary, challenge and reject boundaries',()=> {
  assert.equal(checkExperience('1-3年',2,3).result,'matched');
  assert.equal(checkExperience('3～5年',2,3).result,'challenge');
  assert.equal(checkExperience('5-10年',2,3).result,'rejected');
  assert.equal(checkExperience('10年以上',2,3).result,'rejected');
  assert.equal(checkExperience('经验不限',2,3).result,'matched');
  assert.equal(checkExperience('1年以下',2,3).result,'matched');
  assert.equal(checkExperience('',2,3).result,'unknown');
});
test('salary period is independent from numeric monthly parsing',()=> {
  for(const [salary,period] of [['200-300元/天','day'],['200-300元/日','day'],['30-40元/小时','hour'],['20-40万/年','year'],['20-30K·14薪','month'],['面议','unknown']]) assert.equal(parseSalary(salary).period,period,salary);
  const p=preferences({salary:{periodInclude:['month']}});
  assert.equal(filterJob({...job,salary:'200-300元/天'},p).status,'rejected');
  assert.equal(filterJob({...job,salary:'面议'},p).status,'review');
});
test('internship evidence is separate from day pay and unrelated mentoring mention',()=> {
  assert.ok(internshipEvidence({...job,title:'虚构研发实习生'}));
  assert.ok(internshipEvidence({...job,title:'Application Engineer Intern'}));
  assert.ok(internshipEvidence({...job,description:'工作性质：实习'}));
  assert.equal(internshipEvidence({...job,description:'负责开发接口，指导实习生'}),null);
  assert.equal(internshipEvidence({...job,title:'非实习研发工程师'}),null);
  const p=preferences({excludeInternships:true});
  assert.equal(filterJob({...job,title:'虚构研发实习生',salary:'20-30K'},p).status,'rejected');
});
test('missing details cannot enter matched by default and hard conflicts still win',()=> {
  const missing={...job,description:'',detailStatus:'missing',detailError:'DETAIL_COMPANY_UNAVAILABLE'};
  assert.equal(filterJob(missing,preferences({})).status,'review');
  assert.equal(filterJob({...missing,degree:'硕士'},preferences({candidate:{educationLevel:'本科'}})).status,'rejected');
  const p=preferences({candidate:{experienceYears:2,challengeMaxRequiredYears:3}});
  assert.equal(filterJob({...job,experience:'3-5年'},p).status,'challenge');
  assert.equal(filterJob({...missing,experience:'3-5年'},p).status,'review');
});
test('qualification config rejects invalid degrees, ranges and bools',()=> {
  for(const p of [{candidate:{educationLevel:'随便'}},{candidate:{experienceYears:-1}},{candidate:{experienceYears:5,challengeMaxRequiredYears:3}},
    {candidate:{challengeMaxRequiredYears:3}},{excludeInternships:'true'},{requireCompleteDetails:1},{salary:{periodInclude:['week']}}]) assert.throws(()=>preferences(p));
});
test('CSV candidate, challenge, review and rejected files partition the audit without deleting jobs',async()=> {
  const dir=await mkdtemp(join(tmpdir(),'job-selection-')),store=new Store(':memory:');
  try {
    const config=validateConfig({preferences:{candidate:{educationLevel:'本科',experienceYears:2,challengeMaxRequiredYears:3},excludeInternships:true,salary:{periodInclude:['month']}}});
    const id=store.createBatch(config);
    const samples=[job,{...job,platformJobId:'synthetic-challenge',experience:'3-5年'},
      {...job,platformJobId:'synthetic-master',degree:'硕士'}, {...job,platformJobId:'synthetic-senior',experience:'5-10年'},
      {...job,platformJobId:'synthetic-intern',title:'虚构工程实习生',salary:'300-400元/天'},
      {...job,platformJobId:'synthetic-missing',description:'',detailStatus:'missing',detailError:'DETAIL_COMPANY_UNAVAILABLE'}];
    for(const sample of samples) store.saveJob(id,sample);
    const result=await exportBatch(store,id,config,dir);
    assert.deepEqual(result.summary.selection,{matched:1,challenge:1,rejected:3,review:1});
    assert.equal(result.summary.csvFiles['jobs.csv'],1);assert.equal(result.summary.csvFiles['jobs-all.csv'],6);
    const main=await readFile(join(result.dir,'jobs.csv'),'utf8');
    assert.ok(main.includes('synthetic-base'));assert.ok(!main.includes('synthetic-master'));assert.ok(!main.includes('synthetic-missing'));
    const rejected=await readFile(join(result.dir,'jobs-rejected.csv'),'utf8');
    for(const value of ['synthetic-master','synthetic-senior','synthetic-intern','岗位最低学历硕士']) assert.ok(rejected.includes(value),value);
    const review=await readFile(join(result.dir,'jobs-review.csv'),'utf8');assert.ok(review.includes('缺少可与列表核对的公司字段'));
    assert.equal(store.jobs(id).length,6);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
