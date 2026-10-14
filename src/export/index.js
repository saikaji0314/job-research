import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filterJob } from '../domain/filter.js';
import { hash } from '../domain/job.js';

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s\uFEFF]*[=+\-@\t\r\n]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function exportBatch(store, batchId, config, root) {
  const batch = store.batch(batchId), runId = store.saveRun(batchId, config);
  const dir = join(root, batchId, runId);
  await mkdir(dir, { recursive: true });
  const rows = store.jobs(batchId).map(job => ({ ...job, selection: filterJob(job, config.preferences) }));
  rows.sort((a,b) => Number(b.selection.preferred) - Number(a.selection.preferred));
  const statuses = count(rows.map(x => x.selection.status));
  const details = count(rows.map(x => x.detailStatus));
  const summary = { batchId, runId, exportedAt: new Date().toISOString(), batchStatus: batch.status,
    stopReason: batch.reason, config, configHash: hash(config), jobs: rows.length,
    listObservations: store.db.prepare("SELECT count(*) AS n FROM snapshots WHERE batch_id=? AND kind='list'").get(batchId).n,
    keywordAssociations: store.db.prepare('SELECT count(*) AS n FROM origins WHERE batch_id=?').get(batchId).n,
    detailAttemptedJobs: rows.filter(x => x.detailAttempts > 0).length,
    detailAttempts: rows.reduce((sum,x) => sum+x.detailAttempts,0), details, selection: statuses,
    searches: store.db.prepare('SELECT keyword,status,reason FROM searches WHERE batch_id=?').all(batchId),
    note: '完整 JD 状态表示已取得带身份校验的正文，内容完整性仍需人工抽查；不等于确认当前可投递。' };
  if (config.exports.includes('jsonl')) await writeFile(join(dir,'jobs.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  if (config.exports.includes('csv')) {
    const columns = ['platformJobId','title','company','city','salary','experience','degree','industry','companyScale','employmentType','detailStatus','description','href','collectedAt','keywords','selectionStatus','selectionReasons'];
    const body = rows.map(x => ({ ...x, selectionStatus: x.selection.status, selectionReasons: x.selection.checks })).map(x => columns.map(k => csvCell(x[k])).join(','));
    await writeFile(join(dir,'jobs.csv'), '\uFEFF'+[columns.join(','),...body].join('\r\n')+'\r\n','utf8');
  }
  if (config.exports.includes('summary')) await writeFile(join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n','utf8');
  return { dir, summary };
}
function count(values) { const counts = {}; for(const value of values) counts[value]=(counts[value]||0)+1; return counts; }
