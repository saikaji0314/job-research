const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s/g,'').replace(/[～~—至]/g,'-');
const levels = {初中:1,高中:2,中专:2,中技:2,大专:3,本科:4,硕士:5,博士:6};
export const educationLevels = Object.keys(levels);
export function minimumEducation(raw) {
  const text=normalize(raw);
  if(/学历不限|不限学历|不要求学历|^不限$/.test(text)) return {level:'不限',rank:0};
  const required=text.replace(/(?:博士|硕士|本科|大专)(?:学历)?优先/g,'');
  const matches=[...required.matchAll(/初中|高中|中专|中技|大专|本科|硕士|博士/g)].map(m=>({level:m[0],rank:levels[m[0]]}));
  if(!matches.length) return null;
  // Multiple qualifications are accepted only when explicitly alternatives, not a guessed conjunction.
  if(matches.length>1 && !/[或/、]/.test(required)) return null;
  return matches.sort((a,b)=>a.rank-b.rank)[0];
}
export function checkEducation(required, candidate) {
  const minimum=minimumEducation(required);
  if(!minimum) return {result:'unknown',reason:'无法明确解析岗位最低学历要求'};
  return minimum.rank<=levels[candidate]
    ? {result:'matched',reason:`岗位最低学历${minimum.level}，候选学历${candidate}满足学历层级`}
    : {result:'rejected',reason:`岗位最低学历${minimum.level}，高于候选学历${candidate}`};
}
export function minimumExperience(raw) {
  const text=normalize(raw);
  if(/经验不限|不限经验|^不限$|在校\/应届|应届(?:生)?$/.test(text)) return 0;
  let match=text.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)年$/);
  if(match) return Number(match[1])<=Number(match[2])?Number(match[1]):null;
  if(/^\d+(?:\.\d+)?年(?:以下|以内)$/.test(text)) return 0;
  match=text.match(/^(\d+(?:\.\d+)?)年(?:以上|经验)?$/);
  return match?Number(match[1]):null;
}
export function checkExperience(required, years, challengeMax) {
  const minimum=minimumExperience(required);
  if(minimum===null) return {result:'unknown',reason:'无法明确解析岗位最低工作年限'};
  if(minimum<=years) return {result:'matched',reason:`岗位最低要求${minimum}年，候选经验${years}年满足年限`};
  if(challengeMax!==null && minimum<=challengeMax) return {result:'challenge',reason:`岗位最低要求${minimum}年，高于候选${years}年，单列可挑战`};
  return {result:'rejected',reason:`岗位最低要求${minimum}年，超出候选${years}年及允许挑战范围`};
}
export function internshipEvidence(job) {
  const title=String(job.title || '').normalize('NFKC').toLowerCase();
  if(!/非实习|不是实习/.test(title) && /实习|\bintern(?:ship)?\b/.test(title)) return `职位标题：${job.title}`;
  const text=String(job.description || '');
  const match=text.match(/(?:本岗位|本职位)(?:为|是|属于)实习|(?:岗位性质|职位类型|工作性质)[：:\s]*实习|(?:仅限|要求|面向)[^。；\n]{0,12}在校(?:生|学生)|实习时长[：:\s]*不少于/);
  return match?`正文：${match[0]}`:null;
}
