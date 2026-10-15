import {setTimeout as sleep} from 'node:timers/promises';
import {filterJob} from './domain/filter.js';
import {classifyEmployment} from './domain/employment.js';
import {ResearchError,abortIfNeeded} from './domain/errors.js';

export function prefilterCard(card,preferences) {
  return filterJob({...card,detailStatus:'pending'}, {...preferences,requireCompleteDetails:false});
}
export function verifyAppConditions(page,filters) {
  const labels={today:'今日活跃',within3days:'3日内活跃',thisWeek:'本周活跃',thisMonth:'本月活跃'};
  const expected={'学历要求':['不限'],'薪资待遇':['不限'],'经验要求':filters.experienceInclude.length?filters.experienceInclude:['不限'],
    'BOSS活跃':[labels[filters.bossActivity] || '不限'],'公司规模':['不限'],'融资阶段':['不限']};
  const equal=(a,b)=>Array.isArray(a) && JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
  if(!page.filters || Object.entries(expected).some(([k,v])=>!equal(page.filters.groups?.[k],v)) ||
      typeof page.filters.showContactedWithin30Days!=='boolean' || (filters.showContactedWithin30Days!==null && page.filters.showContactedWithin30Days!==filters.showContactedWithin30Days))
    throw new ResearchError('APP_FILTERS_UNVERIFIED','App 实际筛选与本批条件不符，停止采集');
}
export async function collectApp({store,driver,config,batchId,signal,log=()=>{}}) {
  const id=batchId || store.createBatch(config),effective=store.batch(id).config;
  if(effective.collection.source!=='android-app' || effective.collection.searchSort!=='latest') throw new ResearchError('INVALID_CONFIG','App 采集只支持经核对的 latest 排序');
  const matched=()=>store.jobs(id).filter(job=>filterJob(job,effective.preferences).status==='matched').length;
  const target=effective.collection.targetMatchedJobs;
  const reached=()=>target!==null && matched()>=target;
  store.setStatus(id,'running');log(`App 批次 ${id}；严格通过目标 ${target ?? '未指定'}`);
  try {
    abortIfNeeded(signal);await driver.initialize();
    let failures=0;
    for(let index=0;index<effective.keywords.length && !reached();index++) {
      const keyword=effective.keywords[index];
      if(store.search(id,keyword)?.status==='complete')continue;
      const remaining=effective.collection.maxUniqueJobs-store.appCardCount(id);
      if(remaining<=0)break;
      const budget=Math.ceil(remaining/(effective.keywords.length-index));
      store.setSearch(id,keyword,'boss-app:search/latest','running');
      const filters=effective.collection.appFilters;
      let page=await driver.call('search',{keyword,city:effective.regionName,filters}),stagnant=0,reason='scroll_budget';
      verifyAppConditions(page,filters);
      store.saveAppConditions(id,keyword,{sort:page.sort,city:page.city,filters:page.filters});
      const seen=new Set();
      for(let step=0;step<=effective.collection.maxScrollsPerKeyword;step++) {
        abortIfNeeded(signal);
        const before=seen.size;
        // Each detail visit returns to the list. Refresh card bounds instead of reusing old coordinates.
        while(!reached()) {
          abortIfNeeded(signal);page=await driver.call('list');
          if(page.sort!=='latest' || page.keyword!==keyword)throw new ResearchError('APP_SORT_UNVERIFIED','搜索条件或最新优先状态不一致，已停止');
          verifyAppConditions(page,filters);
          const card=page.cards.find(c=>!seen.has(c.fingerprint));
          if(!card)break;
          if(store.appCardCount(id)>=effective.collection.maxUniqueJobs && !store.appCard(id,card.fingerprint)) {reason='raw_limit';break;}
          seen.add(card.fingerprint);
          const previous=store.appCard(id,card.fingerprint);
          const check=prefilterCard(card,effective.preferences);
          store.saveAppCard(id,keyword,card,seen.size,check.status,check.checks.filter(c=>c.result==='rejected').map(c=>c.reason).join('；'));
          if(previous?.jobId) {
            const job=store.jobs(id).find(j=>j.platformJobId===previous.jobId);
            if(job)store.saveJob(id,job,{kind:'app-revisit',keyword});
            store.setAppCardResult(id,keyword,card.fingerprint,'duplicate',previous.jobId);
            continue;
          }
          // Only proven conflicts skip detail visits; unknowns never get promoted to matched.
          if(check.status==='rejected')continue;
          try {
            const detail=await driver.call('detail',{card});
            store.saveJob(id,{...detail,...classifyEmployment(`${detail.title}\n${detail.description}`)},{kind:'app-detail',keyword,attempted:true});
            store.setAppCardResult(id,keyword,card.fingerprint,'captured',detail.platformJobId);
            failures=0;log(`${keyword}：已核验 ${store.jobs(id).length} 条详情，严格通过 ${matched()}${target?'/'+target:''}；列表线索 ${store.appCardCount(id)}`);
          }catch(error) {
            store.setAppCardResult(id,keyword,card.fingerprint,'failed',null,error.code || 'APP_DETAIL_FAILED');
            if(!['DETAIL_MISSING','DETAIL_COMPANY_UNAVAILABLE','DETAIL_EXPANSION_UNAVAILABLE','APP_CARD_MOVED'].includes(error.code))throw error;
            failures++;log(`${keyword}：详情未取得 ${error.code}，保留列表证据`);
            if(failures>=3)throw new ResearchError('APP_STATE_CHANGED','连续三条详情无法核实，停止扩量');
            if(error.code!=='APP_CARD_MOVED')await driver.call('recover');
          }
          await sleep(effective.collection.detailIntervalMs,undefined,{signal}).catch(()=>abortIfNeeded(signal));
        }
        if(reached()){reason='matched_target';break;}
        if(reason==='raw_limit')break;
        if(seen.size>=budget){reason='keyword_budget';break;}
        stagnant=seen.size===before?stagnant+1:0;
        if(stagnant>=2){reason='stagnant';break;}
        if(step<effective.collection.maxScrollsPerKeyword)page=await driver.call('scroll');
      }
      store.setSearch(id,keyword,'boss-app:search/latest','complete',reason);
      log(`${keyword} 结束：${reason}；严格通过 ${matched()}；列表线索 ${store.appCardCount(id)}`);
    }
    store.setStatus(id,reached()?'complete':'completed_with_gaps',reached()?'matched_target':target!==null?'TARGET_NOT_REACHED':'search_budget_finished');
    return id;
  }catch(error) {
    if(signal?.aborted)error=new ResearchError('INTERRUPTED','已中断');
    store.setStatus(id,'paused',error.code || 'APP_COLLECTION_FAILED');error.batchId=id;throw error;
  }
}
