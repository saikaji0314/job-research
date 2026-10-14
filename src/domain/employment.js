// Only explicit statements are evidence; company names or recruiter titles are insufficient.
export function classifyEmployment(text = '') {
  const rules = [
    ['onsite', /需要(?:长期)?驻场|需(?:长期)?驻场|长期驻场办公|工作方式[：:]\s*驻场/g],
    ['outsourcing', /(?:本岗位|本职位|该岗位|该职位)(?:属于|为|是)外包|外包性质(?:岗位|职位)/g],
    ['agency', /(?:本岗位|本职位)(?:由|为)人力(?:资源)?(?:公司|服务商)(?:发布|招聘)/g],
    ['direct', /(?:本公司|企业|公司)直招|与我司直接签订劳动合同/g],
  ];
  for(const [type,pattern] of rules) for(const match of text.matchAll(pattern)) {
    const prefix = text.slice(Math.max(0,match.index-6),match.index);
    if(/(?:不需要|无需|不是|并非|不是由|不属|不接受|不|无|非)\s*$/.test(prefix)) continue;
    return {employmentType:type,employmentEvidence:match[0]};
  }
  return {employmentType:'unknown',employmentEvidence:null};
}
