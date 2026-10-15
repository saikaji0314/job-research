// BOSS list-field mapping and private-use salary digits adapted from npe_get_jobs
// 21f506907a3af28ef96ba700b621c10af4263270. See licenses/npe_get_jobs.LICENSE.txt.
import { ResearchError } from '../../domain/errors.js';
import { sanitizeJob } from '../../domain/job.js';
import { classifyEmployment } from '../../domain/employment.js';

export const decodeBossText = (value = '') => String(value).replace(/[\uE031-\uE03A]/g, c => String(c.codePointAt(0)-0xE031));
const strings = value => Array.isArray(value) ? value.map(x => typeof x === 'string' ? x : x?.name || x?.text).filter(x => typeof x === 'string') : [];
export function mapListJob(item) {
  return sanitizeJob({ platform: 'boss', platformJobId: item.encryptJobId, title: item.jobName, company: item.brandName,
    city: [item.cityName,item.areaDistrict,item.businessDistrict].filter(Boolean).join('·'), salary: decodeBossText(item.salaryDesc || ''),
    experience: item.jobExperience, degree: item.jobDegree, industry: item.brandIndustry, companyScale: item.brandScaleName,
    companyStage: item.brandStageName, summary: [...strings(item.skills),...strings(item.jobLabels)].join(' '), detailStatus: 'pending' });
}
export function mapDetail(payload, expected) {
  if (payload?.code !== 0) throw new ResearchError('DETAIL_RESPONSE_REJECTED', '详情接口未返回成功状态');
  const info = payload.zpData?.jobInfo;
  if (!info) throw new ResearchError('DETAIL_MISSING', '详情接口缺少岗位信息');
  const id = info.encryptId || info.encryptJobId;
  if (!id || id !== expected.platformJobId) throw new ResearchError('IDENTITY_MISMATCH', '详情岗位 ID 与目标不符，已拒绝保存正文');
  const brand = payload.zpData.brandComInfo || {};
  const description = typeof info.postDescription === 'string' ? info.postDescription.trim() : '';
  const expired = /已关闭|已下线|停止招聘|已结束/.test(info.jobStatusDesc || '');
  return sanitizeJob({ ...expected, title: info.jobName || expected.title, company: brand.brandName || expected.company,
    city: info.locationName || expected.city, salary: info.salaryDesc ? decodeBossText(info.salaryDesc) : expected.salary,
    experience: info.experienceName || expected.experience, degree: info.degreeName || expected.degree,
    industry: brand.industryName || expected.industry, companyScale: brand.scaleName || expected.companyScale,
    companyStage: brand.stageName || expected.companyStage, companyAddress: info.address,
    recruitmentStatus: info.jobStatusDesc, description: expired ? '' : description,
    detailStatus: expired ? 'expired' : description ? 'complete' : 'missing', detailSource: 'network-response',
    ...classifyEmployment(`${info.jobName || ''}\n${description}`) });
}

export function mapDomDetail(snapshot, expected) {
  const path = `/job_detail/${expected.platformJobId}.html`;
  for(const value of [snapshot.url,snapshot.canonical]) {
    let url;
    try { url=new URL(value); } catch { throw new ResearchError('DETAIL_LINK_UNAVAILABLE','页面缺少可核对的岗位链接'); }
    if(url.origin!=='https://www.zhipin.com' || url.pathname!==path) throw new ResearchError('IDENTITY_MISMATCH','页面岗位链接与目标不符');
  }
  const normalize = text => String(text || '').normalize('NFKC').replace(/\s/g,'');
  if(!expected.title || !snapshot.title) throw new ResearchError('DETAIL_TITLE_UNAVAILABLE','页面缺少可核对的岗位标题');
  if(!expected.company || !snapshot.company) throw new ResearchError('DETAIL_COMPANY_UNAVAILABLE','页面缺少可与列表核对的公司字段');
  if(normalize(snapshot.title)!==normalize(expected.title) || normalize(snapshot.company)!==normalize(expected.company)) throw new ResearchError('IDENTITY_MISMATCH','页面标题或公司与列表不符，已拒绝写入');
  const expired=/已关闭|已下线|停止招聘|已结束/.test(snapshot.statusText || '');
  const description=typeof snapshot.description==='string'?snapshot.description.trim():'';
  return sanitizeJob({...expected,description:expired?'':description,
    detailStatus:expired?'expired':description?'complete':'missing',detailSource:'verified-dom',
    recruitmentStatus:snapshot.statusText || expected.recruitmentStatus,
    ...classifyEmployment(`${snapshot.title}\n${description}`)});
}

// Adapted from npe_get_jobs regions.js; platform city codes are NOT administrative codes.
export function resolveRegion(provinces, name) {
  const normalize = value => value.trim().replace(/[省市区县]$/, '');
  const target = normalize(name), matches = [];
  for (const province of provinces) for (const city of province.subLevelModelList || []) {
    if (normalize(city.name) === target) matches.push(String(city.code));
    for (const district of city.subLevelModelList || []) if (normalize(district.name) === target) matches.push(String(city.code));
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) throw new ResearchError('INVALID_REGION', '城市名称无法唯一匹配，请填写明确的城市名称');
  return unique[0];
}
export function searchUrl(cityCode, keyword) {
  const url = new URL('https://www.zhipin.com/web/geek/jobs');
  url.search = new URLSearchParams({ city: cityCode, query: keyword }).toString();
  return url.toString();
}
