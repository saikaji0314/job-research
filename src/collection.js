import { setTimeout as sleep } from 'node:timers/promises';
import { ResearchError, isPause, abortIfNeeded } from './domain/errors.js';

export async function collect({ store, adapter, config, batchId, phase = 'all', retryFailed = false, refreshDetails = false, signal, log = () => {} }) {
  const id = batchId || store.createBatch(config);
  const batch = store.batch(id);
  // A resumed batch always uses the original search plan. Filtering can change independently on export.
  const effective = batch.config;
  store.setStatus(id,'running');
  log(`批次 ${id}`);
  try {
    abortIfNeeded(signal);
    await adapter.initialize();
    if (phase !== 'details') {
      const cityCode = await adapter.regionCode(effective.regionName);
      for (let index=0;index<effective.keywords.length;index++) {
        abortIfNeeded(signal);
        const keyword = effective.keywords[index];
        if (store.search(id,keyword)?.status === 'complete') continue;
        const remaining = effective.collection.maxUniqueJobs-store.jobs(id).length;
        if (remaining<=0) break;
        // Budget each keyword so that an early popular query cannot consume the entire batch.
        const budget = Math.max(1,Math.ceil(remaining/(effective.keywords.length-index)));
        store.setSearch(id,keyword,'','running');
        try {
          const result = await adapter.discover({ keyword,cityCode,maxScrolls: effective.collection.maxScrollsPerKeyword,limit: budget,signal,
            onBatch: async (jobs,{sourceUrl}) => {
              store.setSearch(id,keyword,sourceUrl,'running');
              for(const job of jobs) {
                const known = store.jobs(id).some(old => old.platformJobId===job.platformJobId);
                if (known || store.jobs(id).length<effective.collection.maxUniqueJobs) store.saveJob(id,job,{keyword});
              }
              log(`${keyword}: 已保存 ${store.jobs(id).length} 个去重岗位`);
            } });
          store.setSearch(id,keyword,result.url,'complete',result.reason);
        } catch(error) {
          if(signal?.aborted) error = new ResearchError('INTERRUPTED','已中断，进度已保存');
          store.setSearch(id,keyword,store.search(id,keyword)?.url || '',isPause(error)?'paused':'failed',error.code || 'SEARCH_FAILED');
          throw error;
        }
      }
    }
    if (phase !== 'list') {
      const jobs = store.jobs(id);
      for (const job of jobs) {
        abortIfNeeded(signal);
        if (!refreshDetails && (job.detailStatus==='complete' || (job.detailStatus!=='pending' && !retryFailed))) continue;
        try {
          const detail = await adapter.detail(job);
          store.saveJob(id,detail,{kind:'detail',attempted:true});
          log(`详情 ${job.platformJobId}: ${detail.detailStatus}`);
        } catch(error) {
          abortIfNeeded(signal);
          if (isPause(error)) throw error;
          const detailStatus = error.code==='IDENTITY_MISMATCH'?'identity_mismatch':/^DETAIL_(?:MISSING|(?:COMPANY|TITLE|LINK)_UNAVAILABLE)$/.test(error.code || '')?'missing':'failed';
          store.saveJob(id,{...job,description:'',detailStatus,detailSource:null,detailError:error.code || 'DETAIL_FAILED'},{kind:'detail',attempted:true});
          log(`详情 ${job.platformJobId}: ${detailStatus} (${error.code || 'DETAIL_FAILED'})`);
        }
        await sleep(effective.collection.detailIntervalMs,undefined,{signal}).catch(() => abortIfNeeded(signal));
      }
    }
    store.setStatus(id, phase==='list'?'listed': store.jobs(id).some(j=>j.detailStatus!=='complete')?'completed_with_gaps':'complete');
    return id;
  } catch(error) {
    if(signal?.aborted) error = new ResearchError('INTERRUPTED','已中断，进度已保存');
    store.setStatus(id,isPause(error)?'paused':'failed',error.code || 'COLLECTION_FAILED');
    error.batchId = id;
    throw error;
  }
}
