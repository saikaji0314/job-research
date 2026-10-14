#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { loadConfig, validateConfig, applyOverrides } from '../domain/config.js';
import { ResearchError, isPause } from '../domain/errors.js';
import { Store } from '../storage/store.js';
import { exportBatch } from '../export/index.js';
import { collect } from '../collection.js';
import { acquireLock } from '../browser/lock.js';

const HELP = `Job Research 0.1.0 — 本地岗位采集与筛选（Node.js 24+）

用法: node src/cli/index.js <command> [options]

命令:
  validate        检查搜索配置；不启动浏览器
  login           打开独立浏览器，由使用者登录；本机保存会话
  collect         采集列表和完整 JD，可 --phase list|details|all
  batches         列出本地批次
  export          --batch <id>，使用保存条件或 --config 重新筛选后导出
  import-fixture  --input <jsonl>，导入明确虚构的离线样例供验证

选项:
  --config <file>       本地 JSON 条件
  --city <name>         覆盖搜索城市
  --keywords <a,b>      覆盖搜索词（英文逗号分隔）
  --min-salary <K>      月薪下限，区间重叠匹配
  --max-salary <K>      月薪上限
  --limit <n>           批次去重上限（1～500）
  --db <file>           数据库，默认 data/jobs.db
  --output <dir>        导出根目录，默认 output
  --profile-dir <dir>   专用浏览器资料目录，默认 .profiles/boss
  --browser <name>      chrome（默认）、msedge、chromium
  --timeout <seconds>   login 等待时间，默认 300 秒
  --resume <id>         继续批次，使用该批次原有搜索配置
  --retry-failed        详情阶段重试之前未取得完整正文的岗位
  --headless           无头采集（login 不支持）
  --help               显示帮助

搜索需要填写城市和关键词。原始记录始终保留；所有发送／投递功能均不提供。
`;
async function main() {
  const { values:v, positionals } = parseArgs({ allowPositionals:true, strict:true, options: {
    help:{type:'boolean'}, config:{type:'string'}, city:{type:'string'}, keywords:{type:'string'},
    'min-salary':{type:'string'}, 'max-salary':{type:'string'}, limit:{type:'string'}, db:{type:'string',default:'data/jobs.db'},
    output:{type:'string',default:'output'}, 'profile-dir':{type:'string',default:'.profiles/boss'}, browser:{type:'string',default:'chrome'},
    timeout:{type:'string',default:'300'}, resume:{type:'string'}, batch:{type:'string'}, phase:{type:'string',default:'all'},
    'retry-failed':{type:'boolean',default:false}, headless:{type:'boolean',default:false}, input:{type:'string'},
  } });
  if(v.help || !positionals.length) { console.log(HELP); return; }
  const command = positionals[0];
  if(positionals.length!==1 || !['validate','login','collect','batches','export','import-fixture'].includes(command)) throw new ResearchError('INVALID_COMMAND','未知命令，使用 --help 查看用法');
  const overrides = { city:v.city,keywords:v.keywords,minSalary:v['min-salary'],maxSalary:v['max-salary'],limit:v.limit };
  const changed = Object.values(overrides).some(value=>value!==undefined) || v.config;
  let config = await loadConfig(v.config,overrides);
  if(command==='validate') { validateConfig(config,{requireSearch:true}); console.log('配置有效'); return; }
  if(v.resume && (command!=='collect' || changed)) throw new ResearchError('INVALID_ARGUMENT','--resume 仅用于 collect，且不能同时修改搜索条件；重新筛选请用 export');
  if(!['all','list','details'].includes(v.phase)) throw new ResearchError('INVALID_PHASE','phase 可选 all、list、details');
  const controller = new AbortController();
  let store, session, release;
  const onSignal = () => { controller.abort(); console.error('收到中断，正在保存并关闭浏览器…'); session?.close().catch(()=>{}); };
  process.on('SIGINT',onSignal); process.on('SIGTERM',onSignal);
  try {
    if(command==='login') {
      const timeoutSeconds = Number(v.timeout);
      if(v.headless || !Number.isFinite(timeoutSeconds) || timeoutSeconds<=0) throw new ResearchError('INVALID_ARGUMENT','login 需要可见浏览器和正数 timeout');
      release = await acquireLock(v['profile-dir']);
      const browserModule = await import('../browser/session.js');
      session = await browserModule.openSession({profileDir:v['profile-dir'],browser:v.browser});
      await browserModule.login(session,{timeoutSeconds,signal:controller.signal});
      return;
    }
    if(['batches','export'].includes(command) || v.resume) await access(v.db).catch(()=> { throw new ResearchError('DATABASE_MISSING','数据库不存在，请先采集或导入样例'); });
    if(command==='collect' && !v.resume) validateConfig(config,{requireSearch:true});
    store = new Store(v.db);
    if(command==='batches') { console.log(JSON.stringify(store.batches(),null,2)); return; }
    if(command==='export') {
      if(!v.batch) throw new ResearchError('BATCH_REQUIRED','export 需要 --batch');
      if(!v.config) config = applyOverrides(store.batch(v.batch).config, overrides);
      const result = await exportBatch(store,v.batch,config,v.output);
      console.log(`已导出 ${result.summary.jobs} 个岗位：${result.dir}`); return;
    }
    if(command==='import-fixture') {
      if(!v.input) throw new ResearchError('INPUT_REQUIRED','import-fixture 需要 --input');
      const lines = (await readFile(v.input,'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());
      const rows = lines.map(line => JSON.parse(line));
      if(rows.some(row=>row.synthetic!==true)) throw new ResearchError('FIXTURE_REQUIRED','只允许 synthetic=true 的虚构样例');
      const id = store.createBatch(config);
      try { for(const row of rows) store.saveJob(id,row,{kind:'fixture',keyword:'synthetic-fixture'}); store.setStatus(id,'fixture'); }
      catch(error) { store.setStatus(id,'failed','IMPORT_FAILED'); throw error; }
      const result = await exportBatch(store,id,config,v.output);
      console.log(`虚构样例批次 ${id}\n导出 ${result.dir}`); return;
    }
    if(v.resume) config = validateConfig(store.batch(v.resume).config,{requireSearch:true});
    if(v.phase==='details' && !v.resume) throw new ResearchError('BATCH_REQUIRED','详情阶段需要 --resume 指定已有批次');
    release = await acquireLock(v['profile-dir']);
    const { openSession } = await import('../browser/session.js');
    const { BossAdapter } = await import('../platforms/boss/adapter.js');
    session = await openSession({profileDir:v['profile-dir'],browser:v.browser,headless:v.headless});
    let batchId;
    try { batchId = await collect({store,adapter:new BossAdapter(session.page),config,batchId:v.resume,phase:v.phase,
      retryFailed:v['retry-failed'],signal:controller.signal,log:console.log}); }
    catch(error) {
      if(error.batchId) { const result = await exportBatch(store,error.batchId,config,v.output); console.log(`阶段性结果 ${result.dir}`); }
      throw error;
    }
    const result = await exportBatch(store,batchId,config,v.output);
    console.log(`采集结束，状态 ${result.summary.batchStatus}，${result.summary.jobs} 个岗位。导出 ${result.dir}`);
  } finally {
    if(session) await session.close().catch(()=>{});
    if(release) await release();
    store?.close(); process.off('SIGINT',onSignal); process.off('SIGTERM',onSignal);
  }
}
main().catch(error => {
  // Do not dump browser errors, URLs with credentials, or configuration into logs.
  console.error(`${error.code || 'ERROR'}: ${error instanceof ResearchError ? error.message : '执行失败；请检查输入、依赖、浏览器及本机目录权限。'}`);
  if(error.batchId) console.error(`批次 ${error.batchId} 已保存，可 --resume 继续。`);
  process.exitCode = isPause(error) ? 2 : 1;
});
