import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, applyOverrides } from '../src/domain/config.js';
import { filterJob, parseSalary } from '../src/domain/filter.js';
import { sanitizeJob } from '../src/domain/job.js';
import { mapListJob, mapDetail, mapDomDetail, resolveRegion } from '../src/platforms/boss/mapping.js';
import { assertBossUrl } from '../src/browser/session.js';
import { classifyEmployment } from '../src/domain/employment.js';

const config = input => validateConfig(input);
const prefs = input => config({preferences:input}).preferences;
const job = { platformJobId:'fixture-one', salary:'18-28K', title:'示例岗位', degree:'本科', experience:'1-3年',detailStatus:'complete',description:'虚构岗位职责',detailSource:'fixture' };
test('unconfigured filters impose no personal defaults or salary unknown',()=> {
  const c = config(); assert.equal(c.regionName,null); assert.deepEqual(c.keywords,[]);
  assert.equal(filterJob({},c.preferences).status,'review');
  assert.ok(!filterJob({},c.preferences).checks.some(x=>x.field==='salary'));
  assert.equal(filterJob({},prefs({requireCompleteDetails:false})).status,'matched');
  assert.throws(()=>validateConfig({}, {requireSearch:true}), /搜索需要/);
});
test('config rejects typos, invalid limits, contradictions and unsupported concurrency',()=> {
  for(const input of [{region:'x'},{collection:{maxUniqueJobs:0}},{collection:{detailConcurrency:2}},
    {preferences:{salary:{minMonthlyK:40,maxMonthlyK:20}}},{preferences:{employment:{include:['direct'],exclude:['direct']}}},
    {keywords:'word'},{preferences:{salary:{minMonthlyK:'20'}}},{preferences:{unknownPolicy:'drop'}}]) assert.throws(()=>config(input));
});
test('CLI overrides preserve existing filters and validate numeric arguments',()=> {
  const c = applyOverrides({preferences:{educationInclude:['本科']}},{minSalary:'20',city:'示例城市',keywords:'a,a,b'});
  assert.deepEqual(c.preferences.educationInclude,['本科']); assert.deepEqual(c.keywords,['a','b']);
  assert.equal(c.preferences.salary.minMonthlyK,20);
  assert.throws(()=>applyOverrides({}, {minSalary:'NaN'}));
});
test('salary parser handles K, decimal 万, private-use decoding separately and pay months',()=> {
  assert.deepEqual(parseSalary('18-28K·13薪'),{minMonthlyK:18,maxMonthlyK:28,months:13,period:'month',raw:'18-28K·13薪'});
  assert.equal(parseSalary('1.8-2.8万/月').maxMonthlyK,28);
  assert.equal(parseSalary('18K-28K').minMonthlyK,18);
  for(const raw of ['30-50万/年','200-300元/天','面议','20K以上','28-18K','123','']) assert.equal(parseSalary(raw).minMonthlyK,null,raw);
});
test('salary interval boundaries, upper-only, missing and known rejection',()=> {
  assert.equal(filterJob(job,prefs({salary:{minMonthlyK:28}})).status,'matched');
  assert.equal(filterJob(job,prefs({salary:{minMonthlyK:29}})).status,'rejected');
  assert.equal(filterJob(job,prefs({salary:{maxMonthlyK:18}})).status,'matched');
  assert.equal(filterJob(job,prefs({salary:{maxMonthlyK:17}})).status,'rejected');
  assert.equal(filterJob({...job,salary:'面议'},prefs({salary:{minMonthlyK:20}})).status,'review');
});
test('preferences do not exclude; unknown employment stays unknown',()=> {
  const p = prefs({employment:{prefer:['direct']}});
  assert.equal(filterJob({...job,employmentType:'onsite'},p).status,'matched');
  assert.equal(filterJob({...job,employmentType:'direct'},p).preferred,true);
  assert.equal(filterJob(job,prefs({employment:{include:['direct']}})).status,'review');
  assert.equal(filterJob({...job,employmentType:'onsite'},prefs({employment:{exclude:['onsite']}})).status,'rejected');
});
test('experience punctuation normalized, known mismatch rejects and missing is review',()=> {
  assert.equal(filterJob({...job,experience:'1～3年'},prefs({experienceInclude:['1-3年']})).status,'matched');
  assert.equal(filterJob(job,prefs({experienceInclude:['3-5年']})).status,'rejected');
  assert.equal(filterJob(job,prefs({industriesInclude:['软件']})).status,'review');
});
test('exclusion scans full JD and does not assert absence from a list summary',()=> {
  const p = prefs({excludeKeywords:['驻场']});
  assert.equal(filterJob({...job,description:'需要驻场'},p).status,'rejected');
  assert.equal(filterJob({...job,detailStatus:'pending'},p).status,'review');
  assert.equal(filterJob({...job,description:'开发接口'},p).status,'matched');
});
test('list mapping retains safe facts, strips security and never calls tags full JD',()=> {
  const result = mapListJob({encryptJobId:'fixture-one',jobName:'示例',salaryDesc:'\uE033\uE031-\uE034\uE031K',securityId:'secret',bossName:'private',jobExperience:'1-3年',skills:['数据库']});
  assert.equal(result.salary,'20-30K'); assert.equal(result.description,''); assert.equal(result.detailStatus,'pending');
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('private'));
});
test('detail rejects mismatched or missing identity and preserves source status',()=> {
  const payload = {code:0,zpData:{jobInfo:{encryptId:'fixture-one',postDescription:'岗位职责：测试正文',jobName:'示例'}}};
  assert.equal(mapDetail(payload,job).detailStatus,'complete');
  assert.throws(()=>mapDetail(payload,{...job,platformJobId:'other'}),error=>error.code==='IDENTITY_MISMATCH');
  assert.throws(()=>mapDetail({code:0,zpData:{jobInfo:{postDescription:'x'}}},job),error=>error.code==='IDENTITY_MISMATCH');
  assert.equal(mapDetail({code:0,zpData:{jobInfo:{encryptId:'fixture-one'}}},job).detailStatus,'missing');
  assert.equal(mapDetail({code:0,zpData:{jobInfo:{encryptId:'fixture-one',jobStatusDesc:'已下线',postDescription:'旧正文'}}},job).detailStatus,'expired');
});
test('job persistence allows only selected fields and validates source and IDs',()=> {
  assert.equal(sanitizeJob({...job,cookie:'secret'}).cookie,undefined);
  assert.throws(()=>sanitizeJob({platformJobId:'../bad'}));
  assert.throws(()=>sanitizeJob({...job,description:'正文',detailSource:'tags'}));
  assert.equal(sanitizeJob({...job,description:''}).detailStatus,'missing');
});
test('platform city codes resolve exactly and ambiguous names fail',()=> {
  const tree = [{subLevelModelList:[{name:'甲市',code:101},{name:'乙市',code:102}]}];
  assert.equal(resolveRegion(tree,'甲市'),'101');
  assert.throws(()=>resolveRegion(tree,'未指定'));
  assert.throws(()=>resolveRegion([{subLevelModelList:[{name:'甲市',code:101},{name:'甲市',code:202}]}],'甲市'));
});
test('browser URL boundary rejects credentials, unrelated subdomains and HTTP',()=> {
  assertBossUrl('https://www.zhipin.com/job_detail/fixture.html');
  for(const url of ['http://www.zhipin.com/','https://zhipin.com.evil.test/','https://u:p@www.zhipin.com/','file:///x']) assert.throws(()=>assertBossUrl(url));
});
test('employment labels require explicit evidence and respect negative statements',()=> {
  assert.equal(classifyEmployment('我们是一家知名公司，现招聘工程师').employmentType,'unknown');
  assert.equal(classifyEmployment('本公司直招，与我司直接签订劳动合同').employmentType,'direct');
  assert.equal(classifyEmployment('本岗位属于外包').employmentType,'outsourcing');
  assert.equal(classifyEmployment('需要长期驻场').employmentType,'onsite');
  assert.equal(classifyEmployment('无需长期驻场办公').employmentType,'unknown');
  assert.equal(classifyEmployment('不是本公司直招').employmentType,'unknown');
});
test('DOM fallback needs URL, canonical, title and company agreement before accepting JD',()=> {
  const expected={...job,company:'虚构公司'};
  const snapshot={url:'https://www.zhipin.com/job_detail/fixture-one.html',canonical:'https://www.zhipin.com/job_detail/fixture-one.html',
    title:job.title,company:'虚构公司',description:'由本地虚构页面提供的完整正文'};
  assert.equal(mapDomDetail(snapshot,expected).detailSource,'verified-dom');
  assert.throws(()=>mapDomDetail({...snapshot,canonical:'https://www.zhipin.com/job_detail/other.html'},expected),e=>e.code==='IDENTITY_MISMATCH');
  assert.throws(()=>mapDomDetail({...snapshot,company:'其他公司'},expected),e=>e.code==='IDENTITY_MISMATCH');
  assert.throws(()=>mapDomDetail({...snapshot,canonical:null},expected),e=>e.code==='DETAIL_LINK_UNAVAILABLE');
  assert.throws(()=>mapDomDetail({...snapshot,company:null},expected),e=>e.code==='DETAIL_COMPANY_UNAVAILABLE');
  assert.equal(mapDomDetail({...snapshot,description:''},expected).detailStatus,'missing');
});
test('title filters can reject keyword-search noise without deleting originals',()=> {
  const p=prefs({titleInclude:['工程师','开发']});
  assert.equal(filterJob({...job,title:'示例开发工程师'},p).status,'matched');
  assert.equal(filterJob({...job,title:'示例运营'},p).status,'rejected');
  assert.equal(filterJob({...job,title:null},p).status,'review');
});
