// Do not infer publication from createTime, generic upDate, refreshes, HR activity or observation time.
export function apiDateEvidence(item,scope,observedAt=new Date().toISOString()) {
  const result=[];
  for(const [kind,fields] of [['published',['publishTime','publishDate','datePosted']],['updated',['updateTime','lastModifyTime']]]) {
    for(const field of fields) {
      const raw=item?.[field];
      if((typeof raw==='string' && raw.trim()) || (typeof raw==='number' && Number.isFinite(raw))) result.push({kind,raw:String(raw),source:`boss-api:${scope}.${field}`,observedAt});
    }
  }
  return result;
}
export function pageDateEvidence(snapshot,expected,observedAt=new Date().toISOString()) {
  const path=`/job_detail/${expected.platformJobId}.html`;
  const sameJob=value=>{try{const u=new URL(value);return u.origin==='https://www.zhipin.com'&&u.pathname===path;}catch{return false;}};
  if(!sameJob(snapshot.url) || !sameJob(snapshot.canonical)) return [];
  const result=[];
  const append=(kind,raw,source)=>{if(typeof raw==='string' && raw.trim())result.push({kind,raw,source,observedAt});};
  const normalized=value=>String(value || '').normalize('NFKC').replace(/\s/g,'');
  function visit(node) {
    if(Array.isArray(node)) {node.forEach(visit);return;}
    if(!node || typeof node!=='object') return;
    if(Array.isArray(node['@graph'])) node['@graph'].forEach(visit);
    if(!sameJob(node.url || node['@id'])) return;
    const types=Array.isArray(node['@type'])?node['@type']:[node['@type']];
    if(types.some(type=>type==='JobPosting'||type==='https://schema.org/JobPosting'||type==='http://schema.org/JobPosting')
      && normalized(node.title || node.name)===normalized(expected.title)) {
      append('published',node.datePosted,'job-page:JobPosting.datePosted');
      append('updated',node.dateModified,'job-page:JobPosting.dateModified');
    }
    // Baidu upDate describes the page, and is deliberately not promoted to job publication/update.
    append('page_updated',node.upDate,'job-page:metadata.upDate');
  }
  for(const value of snapshot.jsonLd || []) {try{visit(typeof value==='string'?JSON.parse(value):value);}catch{/* malformed metadata is not a date */}}
  for(const text of snapshot.dateLabels || []) {
    const match=text.match(/^(发布时间|发布日期|发布于|更新于|更新时间|页面更新时间)[：:\s]*([\s\S]+)$/);
    if(!match) continue;
    const kind=match[1]==='页面更新时间'?'page_updated':/^发布/.test(match[1])?'published':'updated';
    append(kind,match[2].trim(),kind==='published'?'job-page:visible-publication-label':kind==='updated'?'job-page:visible-update-label':'job-page:visible-page-update-label');
  }
  return result;
}
