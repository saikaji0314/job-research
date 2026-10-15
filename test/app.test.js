import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/storage/store.js';
import {validateConfig,applyOverrides} from '../src/domain/config.js';
import {collectApp,verifyAppConditions} from '../src/app-collection.js';
import {ResearchError} from '../src/domain/errors.js';
import {filterJob} from '../src/domain/filter.js';

const config=(extra={})=>validateConfig({regionName:'示例城市',keywords:['示例'],collection:{source:'android-app',searchSort:'latest',maxUniqueJobs:10,
  maxScrollsPerKeyword:0,detailIntervalMs:1000,...extra},preferences:{candidate:{educationLevel:'本科',experienceYears:2,challengeMaxRequiredYears:3}}});
const card=(key,extra={})=>({fingerprint:key,title:'虚构工程师',company:'虚构公司',salary:'20-30K',experience:'1-3年',degree:'本科',...extra});
function fake(cards,details={}) {
  let filters;const calls=[];return {calls,initialize:async()=>{},call:async(op,args={})=>{
    calls.push({op,...args});if(op==='detail') {
      if(details.error)throw new ResearchError(details.error);
      return {...args.card,platformJobId:'fixture-'+args.card.fingerprint,description:'虚构岗位职责与要求',detailStatus:'complete',detailSource:'verified-app-ui',sourceChannel:'android-app',searchSort:'latest'};
    }
    if(op==='search')filters={groups:{'学历要求':['不限'],'薪资待遇':['不限'],'经验要求':args.filters.experienceInclude.length?args.filters.experienceInclude:['不限'],
      'BOSS活跃':[({within3days:'3日内活跃'})[args.filters.bossActivity] || '不限'],'公司规模':['不限'],'融资阶段':['不限']},showContactedWithin30Days:args.filters.showContactedWithin30Days ?? true};
    return {cards,sort:details.sort || 'latest',keyword:args.keyword || '示例',city:'示例城市',filters};
  }};
}
test('App config explicitly distinguishes verified latest source from unsupported web sorting',()=>{
  assert.throws(()=>validateConfig({collection:{searchSort:'latest'}}));
  assert.throws(()=>validateConfig({collection:{source:'android-app'}}));
  assert.throws(()=>config({targetMatchedJobs:11}));
  assert.equal(applyOverrides({},{source:'android-app',searchSort:'latest',limit:'100',targetMatched:'80'}).collection.targetMatchedJobs,80);
});
test('Native criteria receipts reject missing, stale and broader activity settings',async()=>{
  const c=config({appFilters:{experienceInclude:['1-3年'],bossActivity:'within3days',showContactedWithin30Days:true}});
  const driver=fake([card('one')]);
  const page=await driver.call('search',{keyword:'示例',filters:c.collection.appFilters});
  assert.doesNotThrow(()=>verifyAppConditions(page,c.collection.appFilters));
  page.filters.groups['BOSS活跃']=['本月活跃'];
  assert.throws(()=>verifyAppConditions(page,c.collection.appFilters),e=>e.code==='APP_FILTERS_UNVERIFIED');
  assert.throws(()=>verifyAppConditions({},c.collection.appFilters));
  assert.throws(()=>config({appFilters:{bossActivity:'sevenDays'}}));
  const store=new Store(':memory:');
  try {
    const id=await collectApp({store,driver:fake([card('one')]),config:c});
    assert.equal(store.appConditions(id)[0].filters.groups['BOSS活跃'][0],'3日内活跃');
    assert.equal(store.appConditions(id)[0].filters.showContactedWithin30Days,true);
  }finally{store.close();}
});
test('App target counts only strict matches, skips known list conflicts and retains challenge separately',async()=>{
  const store=new Store(':memory:'),c=config({targetMatchedJobs:2}),driver=fake([
    card('masters',{degree:'硕士'}),card('challenge',{experience:'3-5年'}),card('one'),card('two')]);
  try {
    const id=await collectApp({store,driver,config:c});
    assert.equal(store.jobs(id).length,3);assert.equal(store.appCardCount(id),4);
    assert.equal(store.jobs(id).filter(j=>filterJob(j,c.preferences).status==='matched').length,2);
    assert.equal(driver.calls.filter(x=>x.op==='detail').length,3);assert.equal(store.batch(id).reason,'matched_target');
    assert.equal(store.appCards(id).find(x=>x.fingerprint==='masters').preselection,'rejected');
    assert.ok(!JSON.stringify(store.appCards(id)).includes('tapBounds'));
  }finally{store.close();}
});
test('App verification pauses immediately and preserves the observed card without inventing job IDs',async()=>{
  const store=new Store(':memory:'),c=config(),driver=fake([card('one')],{error:'VERIFICATION_REQUIRED'});
  try {
    let id;await assert.rejects(collectApp({store,driver,config:c}),e=>{id=e.batchId;return e.code==='VERIFICATION_REQUIRED';});
    assert.equal(store.batch(id).status,'paused');assert.equal(store.jobs(id).length,0);assert.equal(store.appCardCount(id),1);
    assert.equal(driver.calls.filter(x=>x.op==='detail').length,1);assert.equal(store.appCards(id)[0].error,'VERIFICATION_REQUIRED');
  }finally{store.close();}
});
test('App refuses unverified ordering and reports an unmet strict target',async()=>{
  const store=new Store(':memory:');
  try {
    await assert.rejects(collectApp({store,driver:fake([card('one')],{sort:'default'}),config:config()}),e=>e.code==='APP_SORT_UNVERIFIED');
    const id=await collectApp({store,driver:fake([]),config:config({targetMatchedJobs:2})});
    assert.equal(store.batch(id).status,'completed_with_gaps');assert.equal(store.batch(id).reason,'TARGET_NOT_REACHED');
  }finally{store.close();}
});
