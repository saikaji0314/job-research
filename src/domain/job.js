import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['platformJobId', 'title', 'company', 'city', 'salary', 'experience', 'degree', 'industry', 'companyScale',
  'companyStage', 'summary', 'description', 'detailStatus', 'detailSource', 'detailError', 'recruitmentStatus', 'companyAddress', 'updatedAtSource'];
export function sanitizeJob(input) {
  if (!input || typeof input !== 'object' || typeof input.platformJobId !== 'string' || !/^[\w~-]{1,160}$/.test(input.platformJobId)) throw new Error('无效岗位 ID');
  if (input.platform !== undefined && input.platform !== 'boss') throw new Error('仅支持 boss 岗位');
  const out = { platform: 'boss' };
  for (const field of fields) out[field] = typeof input[field] === 'string' ? input[field].slice(0, field === 'description' ? 100000 : 10000) : null;
  out.href = `https://www.zhipin.com/job_detail/${out.platformJobId}.html`;
  out.employmentType = ['direct', 'outsourcing', 'onsite', 'agency'].includes(input.employmentType) ? input.employmentType : 'unknown';
  out.employmentEvidence = typeof input.employmentEvidence === 'string' ? input.employmentEvidence.slice(0, 2000) : null;
  out.description = out.description || '';
  if (out.description && input.detailStatus === 'complete') {
    if (!['network-response', 'verified-dom', 'fixture'].includes(input.detailSource)) throw new Error('完整正文需要明确来源');
  } else { out.description = ''; out.detailStatus = input.detailStatus === 'complete' ? 'missing' : input.detailStatus || 'pending'; }
  if (!['pending', 'complete', 'missing', 'failed', 'identity_mismatch', 'expired'].includes(out.detailStatus)) throw new Error('无效详情状态');
  return out;
}
