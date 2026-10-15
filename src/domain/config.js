import { readFile } from 'node:fs/promises';
import { ResearchError } from './errors.js';
import { educationLevels } from './qualification.js';

export const defaults = {
  schemaVersion: 1, platform: 'boss', regionName: null, keywords: [],
  collection: { maxUniqueJobs: 30, maxScrollsPerKeyword: 2, detailConcurrency: 1,
    detailIntervalMs: 3000, onAuthenticationOrVerification: 'pause' },
  preferences: { salary: { minMonthlyK: null, maxMonthlyK: null, matchMode: 'overlap', periodInclude: [] },
    candidate: { educationLevel: null, experienceYears: null, challengeMaxRequiredYears: null },
    excludeInternships: false, requireCompleteDetails: true, publishedWithinDays: null,
    titleInclude: [], experienceInclude: [], educationInclude: [], industriesInclude: [], companyScalesInclude: [],
    employment: { include: [], exclude: [], prefer: [] }, excludeKeywords: [], unknownPolicy: 'keep_for_review' },
  exports: ['jsonl', 'csv', 'summary'],
};
const fail = message => { throw new ResearchError('INVALID_CONFIG', message); };
function merge(base, input, prefix = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${prefix || '配置'} 必须是对象`);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(input)) {
    const path = `${prefix}${key}`;
    if (!Object.hasOwn(base, key)) fail(`未知配置项: ${path}`);
    out[key] = base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? merge(base[key], value, `${path}.`) : value;
  }
  return out;
}
export function validateConfig(input = {}, { requireSearch = false } = {}) {
  const c = merge(defaults, input);
  if (c.schemaVersion !== 1 || c.platform !== 'boss') fail('只支持 schemaVersion=1 和 platform=boss');
  if (c.regionName !== null && (typeof c.regionName !== 'string' || !c.regionName.trim())) fail('regionName 必须是非空城市名称或 null');
  const arrays = [c.keywords, c.exports, c.preferences.salary.periodInclude, c.preferences.titleInclude, c.preferences.experienceInclude, c.preferences.educationInclude,
    c.preferences.industriesInclude, c.preferences.companyScalesInclude, c.preferences.excludeKeywords,
    ...Object.values(c.preferences.employment)];
  if (arrays.some(a => !Array.isArray(a) || a.some(v => typeof v !== 'string' || !v.trim()))) fail('集合配置必须是非空字符串数组');
  c.keywords = [...new Set(c.keywords.map(k => k.trim()))];
  if (requireSearch && (!c.regionName?.trim() || !c.keywords.length)) fail('搜索需要 regionName 和至少一个关键词');
  for (const key of ['maxUniqueJobs', 'maxScrollsPerKeyword', 'detailIntervalMs', 'detailConcurrency']) {
    if (!Number.isSafeInteger(c.collection[key]) || c.collection[key] < 0) fail(`collection.${key} 必须是非负整数`);
  }
  if (c.collection.maxUniqueJobs < 1 || c.collection.maxUniqueJobs > 500) fail('maxUniqueJobs 必须在 1～500 之间');
  if (c.collection.maxScrollsPerKeyword > 100 || c.collection.detailConcurrency !== 1 || c.collection.detailIntervalMs < 1000) fail('滚动上限为 100，详情并发为 1，间隔至少 1000ms');
  if (c.collection.onAuthenticationOrVerification !== 'pause') fail('登录失效或验证时必须 pause');
  const s = c.preferences.salary;
  for (const v of [s.minMonthlyK, s.maxMonthlyK]) if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) fail('月薪上下限必须是非负数字或 null');
  if (s.minMonthlyK !== null && s.maxMonthlyK !== null && s.minMonthlyK > s.maxMonthlyK) fail('月薪下限不能大于上限');
  if(s.periodInclude.some(x=>!['month','day','hour','year'].includes(x))) fail('薪资周期可选 month、day、hour、year');
  const candidate=c.preferences.candidate;
  if(candidate.educationLevel!==null && !educationLevels.includes(candidate.educationLevel)) fail('候选学历必须是明确学历层级或 null');
  for(const value of [candidate.experienceYears,candidate.challengeMaxRequiredYears]) if(value!==null && (typeof value!=='number' || !Number.isFinite(value) || value<0)) fail('候选经验与挑战上限必须是非负数字或 null');
  if(candidate.challengeMaxRequiredYears!==null && (candidate.experienceYears===null || candidate.challengeMaxRequiredYears<candidate.experienceYears)) fail('挑战上限需要候选经验，且不能低于候选经验');
  for(const key of ['excludeInternships','requireCompleteDetails']) if(typeof c.preferences[key]!=='boolean') fail(`${key} 必须为布尔值`);
  if(c.preferences.publishedWithinDays!==null && (!Number.isSafeInteger(c.preferences.publishedWithinDays) || c.preferences.publishedWithinDays<1 || c.preferences.publishedWithinDays>3650)) fail('publishedWithinDays 必须是 1～3650 的整数或 null');
  if (s.matchMode !== 'overlap' || c.preferences.unknownPolicy !== 'keep_for_review') fail('当前仅支持 overlap 和 keep_for_review');
  const types = ['direct', 'outsourcing', 'onsite', 'agency'];
  for (const values of Object.values(c.preferences.employment)) if (values.some(x => !types.includes(x))) fail(`用工类型可选 ${types.join(', ')}`);
  if (c.preferences.employment.include.some(v => c.preferences.employment.exclude.includes(v))) fail('用工类型不能同时 include 和 exclude');
  if (!c.exports.length || c.exports.some(x => !['jsonl', 'csv', 'summary'].includes(x))) fail('exports 可选 jsonl、csv、summary');
  return c;
}
export async function loadConfig(path, overrides = {}, options = {}) {
  let input = {};
  if (path) {
    try { input = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { fail('无法读取配置，请确认文件存在且为合法 JSON'); }
  }
  return applyOverrides(input, overrides, options);
}
export function applyOverrides(input, overrides = {}, options = {}) {
  const c = validateConfig(input);
  if (overrides.city !== undefined) c.regionName = overrides.city;
  if (overrides.keywords !== undefined) c.keywords = overrides.keywords.split(',').map(x => x.trim()).filter(Boolean);
  if (overrides.minSalary !== undefined) c.preferences.salary.minMonthlyK = Number(overrides.minSalary);
  if (overrides.maxSalary !== undefined) c.preferences.salary.maxMonthlyK = Number(overrides.maxSalary);
  if (overrides.limit !== undefined) c.collection.maxUniqueJobs = Number(overrides.limit);
  if (overrides.publishedWithinDays !== undefined) c.preferences.publishedWithinDays = Number(overrides.publishedWithinDays);
  return validateConfig(c, options);
}
