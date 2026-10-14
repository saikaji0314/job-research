export function parseSalary(raw = '') {
  const text = String(raw).normalize('NFKC').replace(/\s/g, '');
  const months = text.match(/[·•.](\d{2})薪/);
  const result = { minMonthlyK: null, maxMonthlyK: null, months: months ? Number(months[1]) : null, raw };
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
  const add = (field, result, evidence) => checks.push({ field, result, evidence });
  const salary = parseSalary(job.salary);
  if(preferences.titleInclude.length) add('title',!job.title?'unknown':preferences.titleInclude.some(word=>normalized(job.title).includes(normalized(word)))?'matched':'rejected',job.title || null);
  const target = preferences.salary;
  if (target.minMonthlyK !== null || target.maxMonthlyK !== null) {
    const known = salary.minMonthlyK !== null;
    const match = known && salary.maxMonthlyK >= (target.minMonthlyK ?? -Infinity) && salary.minMonthlyK <= (target.maxMonthlyK ?? Infinity);
    add('salary', known ? (match ? 'matched' : 'rejected') : 'unknown', job.salary || null);
  }
  for (const [field, allowed] of [['experience', preferences.experienceInclude], ['degree', preferences.educationInclude],
    ['industry', preferences.industriesInclude], ['companyScale', preferences.companyScalesInclude]]) {
    if (!allowed.length) continue;
    add(field, !job[field] ? 'unknown' : allowed.some(x => normalized(x) === normalized(job[field])) ? 'matched' : 'rejected', job[field] || null);
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
  return { status: checks.some(x => x.result === 'rejected') ? 'rejected' : checks.some(x => x.result === 'unknown') ? 'review' : 'matched',
    checks, salary, preferred: employment.prefer.includes(type) };
}
