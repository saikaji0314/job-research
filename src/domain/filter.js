import {checkEducation,checkExperience,internshipEvidence} from './qualification.js';
export function parseSalary(raw = '') {
  const text = String(raw).normalize('NFKC').replace(/\s/g, '');
  const months = text.match(/[·•.](\d{2})薪/);
  const period=/\/天|\/日|每天|每日|日薪/.test(text)?'day':/\/小时|\/时|时薪/.test(text)?'hour':/\/年|每年|年薪/.test(text)?'year':/[kK千万](?:元)?(?:\/月|每月)?(?:[·•.]\d{2}薪)?$/.test(text)?'month':'unknown';
  const result = { minMonthlyK: null, maxMonthlyK: null, months: months ? Number(months[1]) : null, period, raw };
  if (/年|天|日|时|面议|以上|以下|起/.test(text)) return result;
  const m = text.match(/^(\d+(?:\.\d+)?)\s*([kK千万]?)\s*[-~～—至]\s*(\d+(?:\.\d+)?)\s*([kK千万])(?:元)?(?:\/月|每月)?(?:[·•.]\d{2}薪)?$/);
  if (!m) return result;
  const multiplier = unit => ({ k: 1, K: 1, 千: 1, 万: 10 }[unit]);
  const lower = Number(m[1]) * multiplier(m[2] || m[4]);
  const upper = Number(m[3]) * multiplier(m[4]);
  if (lower <= upper) Object.assign(result, { minMonthlyK: lower, maxMonthlyK: upper });
  return result;
}
const normalized = v => String(v ?? '').normalize('NFKC').replace(/\s/g, '').replace(/[～~—]/g, '-').toLowerCase();
export function filterJob(job, preferences) {
  const checks = [];
  const add = (field, result, evidence, reason) => checks.push({ field, result, evidence, reason:reason || `${field}: ${result}` });
  const salary = parseSalary(job.salary);
  if(preferences.requireCompleteDetails) add('detail',job.detailStatus==='complete' && job.description?.trim()?'matched':'unknown',job.detailError || job.detailStatus || null,
    job.detailStatus==='complete' && job.description?.trim()?'已取得通过身份核验的岗位正文':'未取得通过身份核验的完整正文，需要补读');
  if(preferences.excludeInternships) {
    const evidence=internshipEvidence(job);
    add('internship',evidence?'rejected':job.detailStatus==='complete'?'matched':'unknown',evidence,
      evidence?'职位明确包含实习或在校专属要求':job.detailStatus==='complete'?'未发现明确实习要求':'正文缺失，无法排查实习要求');
  }
  const periodLabels={month:'月薪',day:'日薪',hour:'时薪',year:'年薪'};
  if(preferences.salary.periodInclude.length) add('salaryPeriod',salary.period==='unknown'?'unknown':preferences.salary.periodInclude.includes(salary.period)?'matched':'rejected',salary.period,
    salary.period==='unknown'?'薪资周期无法确认':`薪资周期为${periodLabels[salary.period]}；允许${preferences.salary.periodInclude.map(x=>periodLabels[x]).join('、')}`);
  const candidate=preferences.candidate;
  if(candidate.educationLevel!==null) {const check=checkEducation(job.degree,candidate.educationLevel);add('educationEligibility',check.result,job.degree || null,check.reason);}
  if(candidate.experienceYears!==null) {const check=checkExperience(job.experience,candidate.experienceYears,candidate.challengeMaxRequiredYears);add('experienceEligibility',check.result,job.experience || null,check.reason);}
  if(preferences.titleInclude.length) {
    const result=!job.title?'unknown':preferences.titleInclude.some(word=>normalized(job.title).includes(normalized(word)))?'matched':'rejected';
    add('title',result,job.title || null,!job.title?'缺少岗位标题':result==='matched'?'标题包含允许的岗位方向词':'标题未包含允许的岗位方向词');
  }
  const target = preferences.salary;
  if (target.minMonthlyK !== null || target.maxMonthlyK !== null) {
    const known = salary.minMonthlyK !== null;
    const match = known && salary.maxMonthlyK >= (target.minMonthlyK ?? -Infinity) && salary.minMonthlyK <= (target.maxMonthlyK ?? Infinity);
    add('salary', known ? (match ? 'matched' : 'rejected') : 'unknown', job.salary || null,
      !known?'无法按月薪区间比较':match?'职位月薪区间与目标区间相交':'职位月薪区间与目标区间不相交');
  }
  for (const [field, allowed] of [['experience', preferences.experienceInclude], ['degree', preferences.educationInclude],
    ['industry', preferences.industriesInclude], ['companyScale', preferences.companyScalesInclude]]) {
    if (!allowed.length) continue;
    const label={experience:'经验',degree:'学历',industry:'行业',companyScale:'公司规模'}[field];
    const result=!job[field]?'unknown':allowed.some(x=>normalized(x)===normalized(job[field]))?'matched':'rejected';
    add(field,result,job[field] || null,!job[field]?`${label}信息缺失`:result==='matched'?`${label}在允许集合中`:`${label}“${job[field]}”不在允许集合中`);
  }
  const employment = preferences.employment;
  const type = job.employmentType || 'unknown';
  if (employment.include.length || employment.exclude.length) {
    add('employmentType', type === 'unknown' ? 'unknown'
      : employment.exclude.includes(type) || (employment.include.length && !employment.include.includes(type)) ? 'rejected' : 'matched', type);
  }
  const searchable = [job.title, job.company, job.description, job.summary].filter(Boolean).join('\n').toLowerCase();
  if (preferences.excludeKeywords.length) {
    const hits = preferences.excludeKeywords.filter(word => searchable.includes(word.toLowerCase()));
    // A missing JD cannot establish that an exclusion term is absent.
    add('excludeKeywords', hits.length ? 'rejected' : job.detailStatus === 'complete' ? 'matched' : 'unknown', hits);
  }
  return { status: checks.some(x => x.result === 'rejected') ? 'rejected' : checks.some(x => x.result === 'unknown') ? 'review' : checks.some(x=>x.result==='challenge')?'challenge':'matched',
    checks, salary, preferred: employment.prefer.includes(type) };
}
