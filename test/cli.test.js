import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';

const cli=resolve('src/cli/index.js');
function run(args) { const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});if(result.error)throw result.error;return result; }
test('CLI rejects empty search template before launching browser',()=> {
  const result=run(['validate','--config','config/research.example.json']);
  assert.equal(result.status,1);assert.match(result.stderr,/搜索需要/);
  assert.equal(run(['validate','--city','示例城市','--keywords','示例岗位']).status,0);
});
test('CLI fixture import and re-filter export run offline with no browser dependency',async()=> {
  const dir=await mkdtemp(join(tmpdir(),'job-research-cli-')),db=join(dir,'jobs.db'),out=join(dir,'exports');
  try {
    const imported=run(['import-fixture','--input','test/fixtures/jobs.jsonl','--db',db,'--output',out]);
    assert.equal(imported.status,0,imported.stderr);
    const batches=run(['batches','--db',db]);assert.equal(batches.status,0,batches.stderr);
    const id=JSON.parse(batches.stdout)[0].id;
    const exported=run(['export','--batch',id,'--min-salary','20','--db',db,'--output',out]);assert.equal(exported.status,0,exported.stderr);
    const runs=await readdir(join(out,id));assert.equal(runs.length,2);
    const summaries=await Promise.all(runs.map(async run=>JSON.parse(await readFile(join(out,id,run,'summary.json'),'utf8'))));
    const filtered=summaries.find(x=>x.config.preferences.salary.minMonthlyK===20);
    assert.deepEqual(filtered.selection,{matched:1,rejected:1,review:1});
    assert.equal(run(['collect','--resume',id,'--city','other','--db',db]).status,1);
    const fresh=run(['export','--batch',id,'--published-within-days','30','--db',db,'--output',out]);
    assert.equal(fresh.status,0,fresh.stderr);assert.match(fresh.stdout,/缺少有效发布时间/);
    const after=await readdir(join(out,id));
    const freshSummary=(await Promise.all(after.map(async value=>JSON.parse(await readFile(join(out,id,value,'summary.json'),'utf8'))))).find(x=>x.config.preferences.publishedWithinDays===30);
    assert.equal(freshSummary.csvFiles['jobs.csv'],0);assert.equal(freshSummary.csvFiles['jobs-review.csv'],3);
  }finally{await rm(dir,{recursive:true,force:true});}
});
