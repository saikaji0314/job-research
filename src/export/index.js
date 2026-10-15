import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filterJob } from '../domain/filter.js';
import { hash } from '../domain/job.js';
import {publicationState,temporalFields,publicationWindow} from '../domain/dates.js';

export const selectionLabels={matched:'通过已设筛选',challenge:'年限稍高，可挑战',review:'待核实',rejected:'已排除'};
const employmentLabels={unknown:'用工关系未核实',direct:'正文明确直招',outsourcing:'正文明确外包',onsite:'正文明确驻场',agency:'正文明确人力服务商发布'};
const detailReasons={DETAIL_COMPANY_UNAVAILABLE:'缺少可与列表核对的公司字段',DETAIL_TITLE_UNAVAILABLE:'缺少可核对的岗位标题',
  DETAIL_LINK_UNAVAILABLE:'缺少可核对的岗位链接',DETAIL_MISSING:'未取得可完成身份核验的正文，可能缺少公司等核验字段',
  IDENTITY_MISMATCH:'岗位链接、标题或公司与目标不一致，已拒绝写入正文'};

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s\uFEFF]*[=+\-@\t\r\n]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function exportBatch(store, batchId, config, root, {now=new Date()}={}) {
  const batch = store.batch(batchId), runId = store.saveRun(batchId, config);
  const dir = join(root, batchId, runId);
  await mkdir(dir, { recursive: true });
  const evaluatedAt=new Date(now).toISOString();
  const rows = store.jobs(batchId).map(job => {const dated={...job,...temporalFields(job)};return {...dated, selection: filterJob(dated, config.preferences,{now:evaluatedAt})};});
  rows.sort((a,b) => Number(b.selection.preferred) - Number(a.selection.preferred));
  const statuses = count(rows.map(x => x.selection.status));
  const details = count(rows.map(x => x.detailStatus));
  const dateCoverage=count(rows.map(job=>publicationState(job).status));
  const warnings=[];
  if(config.preferences.publishedWithinDays!=null && (dateCoverage.valid || 0)<rows.length) warnings.push(`已启用最近${config.preferences.publishedWithinDays}天发布；${rows.length-(dateCoverage.valid || 0)}条缺少有效发布时间，不能当作近期新挂岗位。仅页面更新、采集或首次发现时间不能证明发布新旧。`);
  const summary = { batchId, runId, exportedAt:evaluatedAt, evaluatedAt,batchStatus: batch.status,
    stopReason: batch.reason, config, configHash: hash(config), jobs: rows.length,
    listObservations: store.db.prepare("SELECT count(*) AS n FROM snapshots WHERE batch_id=? AND kind='list'").get(batchId).n,
    keywordAssociations: store.db.prepare('SELECT count(*) AS n FROM origins WHERE batch_id=?').get(batchId).n,
    detailAttemptedJobs: rows.filter(x => x.detailAttempts > 0).length,
    detailAttempts: rows.reduce((sum,x) => sum+x.detailAttempts,0), details, selection: statuses,
    employment:count(rows.map(x=>x.employmentType || 'unknown')),
    publicationDates:dateCoverage,publicationWindow:config.preferences.publishedWithinDays==null?null:publicationWindow(config.preferences.publishedWithinDays,evaluatedAt),warnings,
    searches: store.db.prepare('SELECT keyword,status,reason FROM searches WHERE batch_id=?').all(batchId),
    note: 'jobs.csv 仅含通过筛选的记录；挑战、待核实、已排除记录分别导出，jobs-all.csv 和 jobs.jsonl 保留全部证据。通过规则不等于能力适配或确认可投。' };
  if (config.exports.includes('jsonl')) await writeFile(join(dir,'jobs.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  if (config.exports.includes('csv')) {
    const columns = ['platformJobId','title','company','city','salary','salaryPeriod','experience','degree','industry','companyScale','employmentType','employmentLabel','employmentEvidence','selectionWarnings','detailStatus','detailError','detailReason','description','href','publishedAt','publishedAtStatus','publishedAtSource','publishedAtRaw','jobUpdatedAt','jobUpdatedAtSource','pageUpdatedAt','pageUpdatedAtSource','firstSeenAt','collectedAt','keywords','selectionStatus','selectionLabel','selectionReasons','selectionEvidence'];
    const csvRows=rows.map(x=>({...x,salaryPeriod:x.selection.salary.period,employmentLabel:employmentLabels[x.employmentType] || employmentLabels.unknown,
      selectionWarnings:(!x.employmentType || x.employmentType==='unknown')?'用工关系未核实，不能视为企业直招':'',
      detailReason:x.detailStatus==='complete'?'正文已取得且身份核验通过':detailReasons[x.detailError] || `详情状态 ${x.detailStatus}，需进一步核对`,
      selectionStatus:x.selection.status,selectionLabel:selectionLabels[x.selection.status],
      selectionReasons:x.selection.checks.filter(c=>c.result!=='matched').map(c=>c.reason).join('；') || '已通过所有已设条件',selectionEvidence:x.selection.checks}));
    const groups={'jobs.csv':csvRows.filter(x=>x.selectionStatus==='matched'),'jobs-challenge.csv':csvRows.filter(x=>x.selectionStatus==='challenge'),
      'jobs-review.csv':csvRows.filter(x=>x.selectionStatus==='review'),'jobs-rejected.csv':csvRows.filter(x=>x.selectionStatus==='rejected'),'jobs-all.csv':csvRows};
    summary.csvFiles={};
    for(const [file,items] of Object.entries(groups)) {
      const body=items.map(x=>columns.map(k=>csvCell(x[k])).join(','));
      await writeFile(join(dir,file),'\uFEFF'+[columns.join(','),...body].join('\r\n')+'\r\n','utf8');
      summary.csvFiles[file]=items.length;
    }
  }
  if (config.exports.includes('summary')) await writeFile(join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n','utf8');
  return { dir, summary };
}
function count(values) { const counts = {}; for(const value of values) counts[value]=(counts[value]||0)+1; return counts; }
