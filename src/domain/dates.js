// All calendar-day comparisons are fixed to the recruitment site's Asia/Shanghai context.
const DAY=86400000, OFFSET=8*3600000;
export const timeZone='Asia/Shanghai';
export const chinaDay=instant=>Math.floor((new Date(instant).getTime()+OFFSET)/DAY);
const dateText=day=>new Date(day*DAY).toISOString().slice(0,10);
function calendar(y,m,d) {
  if(y<1970 || y>2100 || m<1 || m>12 || d<1 || d>31) return null;
  const time=Date.UTC(y,m-1,d),date=new Date(time);
  return date.getUTCFullYear()===y && date.getUTCMonth()===m-1 && date.getUTCDate()===d?Math.floor(time/DAY):null;
}
export function parseDateEvidence(raw,observedAt) {
  const observed=new Date(observedAt).getTime();
  if(!Number.isFinite(observed) || typeof raw!=='string') return null;
  const text=raw.normalize('NFKC').trim();
  let day,instant=null;
  const relative=text.match(/^(?:今天|今日|刚刚|昨天|昨日|前天|\d{1,4}天前)$/);
  if(/^\d{10}(?:\d{3})?$/.test(text)) {
    instant=Number(text)*(text.length===10?1000:1);
    const year=new Date(instant).getUTCFullYear();
    if(year<1970 || year>2100) return null;
    day=chinaDay(instant);
  } else if(relative) {
    const days=/昨天|昨日/.test(text)?1:text==='前天'?2:/^\d/.test(text)?Number.parseInt(text,10):0;
    day=chinaDay(observed)-days;
  } else {
    const match=text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/);
    if(!match) return null;
    day=calendar(Number(match[1]),Number(match[2]),Number(match[3]));
    if(day===null) return null;
    if(match[4]!==undefined) {
      const hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6] || 0),millisecond=Number((match[7] || '').padEnd(3,'0'));
      if(hour>23 || minute>59 || second>59) return null;
      let offset=OFFSET;
      if(match[8]==='Z') offset=0;
      else if(match[8]) {
        const hours=Number(match[8].slice(1,3)),minutes=Number(match[8].slice(4,6));
        if(hours>14 || minutes>59 || (hours===14 && minutes!==0)) return null;
        offset=(match[8][0]==='-'?-1:1)*(hours*60+minutes)*60000;
      }
      instant=day*DAY+hour*3600000+minute*60000+second*1000+millisecond-offset;
      day=chinaDay(instant);
    }
  }
  return {day,instant,value:instant===null?dateText(day):new Date(instant).toISOString(),precision:instant===null?'day':'instant'};
}

// Sources are semantic labels assigned by adapters after verifying the job's identity.
const publishedSources=new Set(['boss-api:jobInfo.publishTime','boss-api:jobInfo.publishDate','boss-api:jobInfo.datePosted',
  'boss-api:jobList.publishTime','boss-api:jobList.publishDate','boss-api:jobList.datePosted',
  'job-page:JobPosting.datePosted','job-page:visible-publication-label','fixture:datePosted']);
export function safeDateEvidence(input) {
  if(!Array.isArray(input)) return [];
  return input.slice(-24).filter(x=>x && ['published','updated','page_updated'].includes(x.kind)
    && typeof x.raw==='string' && typeof x.source==='string' && typeof x.observedAt==='string')
    .map(x=>({kind:x.kind,raw:x.raw.slice(0,200),source:x.source.slice(0,200),observedAt:x.observedAt.slice(0,40)}));
}
export function publicationState(job) {
  const evidence=safeDateEvidence(job.dateEvidence).filter(x=>x.kind==='published' && publishedSources.has(x.source));
  if(!evidence.length) return {status:'unknown',value:null,source:null,raw:null,parsed:null};
  const values=evidence.map(item=>({...item,parsed:parseDateEvidence(item.raw,item.observedAt)}));
  if(values.some(x=>!x.parsed)) return {status:'invalid',value:null,source:null,raw:values.map(x=>x.raw).join(' | '),parsed:null};
  if(new Set(values.map(x=>x.parsed.day)).size!==1) return {status:'conflict',value:null,source:null,raw:values.map(x=>x.raw).join(' | '),parsed:null};
  // Preserve the original relative text and observation anchor; do not interpret '昨天' anew on export.
  const selected=values.find(x=>x.parsed.instant!==null) || values[0];
  return {status:'valid',value:selected.parsed.value,source:selected.source,raw:selected.raw,parsed:selected.parsed};
}
export function temporalFields(job) {
  const dateEvidence=safeDateEvidence(job.dateEvidence),publication=publicationState({dateEvidence});
  const extract=kind=>{
    const evidence=dateEvidence.filter(x=>x.kind===kind).map(x=>({...x,parsed:parseDateEvidence(x.raw,x.observedAt)})).find(x=>x.parsed);
    return {value:evidence?.parsed.value || null,source:evidence?.source || null};
  };
  const updated=extract('updated'),pageUpdated=extract('page_updated');
  return {dateEvidence,publishedAt:publication.value,publishedAtSource:publication.source,publishedAtRaw:publication.raw,
    publishedAtStatus:publication.status,jobUpdatedAt:updated.value,jobUpdatedAtSource:updated.source,
    pageUpdatedAt:pageUpdated.value,pageUpdatedAtSource:pageUpdated.source};
}
export function checkPublishedWithin(job,days,now=new Date()) {
  const state=publicationState(job),nowMs=new Date(now).getTime();
  if(!Number.isFinite(nowMs)) return {result:'unknown',reason:'筛选时刻无效，需要核实',state:'invalid'};
  if(state.status!=='valid') return {result:'unknown',reason:state.status==='conflict'?'发布时间证据冲突，需要核实':state.status==='invalid'?'发布时间格式无效，需要核实':'缺少可核对的岗位发布时间；采集、活跃和页面更新时间不能替代',state:state.status};
  const today=chinaDay(nowMs),ageDays=today-state.parsed.day;
  if(ageDays<0 || (state.parsed.instant!==null && state.parsed.instant>nowMs)) return {result:'unknown',reason:'发布时间晚于筛选时刻，需要核实',state:'future'};
  return {result:ageDays<days?'matched':'rejected',reason:ageDays<days?`发布于${state.value}，在最近${days}个自然日内`:`发布于${state.value}，超出最近${days}个自然日`,state:'valid',ageDays};
}
export function publicationWindow(days,now=new Date()) {
  const today=chinaDay(now);
  return {timeZone,days,fromDate:dateText(today-days+1),throughDate:dateText(today),includesToday:true};
}
