import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResearchError } from '../domain/errors.js';

export async function acquireLock(directory) {
  await mkdir(directory,{recursive:true});
  const path = join(directory,'.collector.lock'), token = randomUUID();
  for(let attempt=0;attempt<2;attempt++) {
    let handle;
    try { handle = await open(path,'wx'); }
    catch(error) {
      if(error.code!=='EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(path,'utf8')); } catch { throw new ResearchError('PROFILE_BUSY','Profile 锁无法确认，请确认没有其他采集进程后再处理锁文件'); }
      try { process.kill(owner.pid,0); throw new ResearchError('PROFILE_BUSY','同一 Profile 已有运行进程'); }
      catch(error) { if(error.code!=='ESRCH') throw error; }
      await unlink(path);
      continue;
    }
    await handle.writeFile(JSON.stringify({pid:process.pid,token})); await handle.close();
    return async () => {
      const current = JSON.parse(await readFile(path,'utf8').catch(()=> '{}'));
      if(current.token===token) await unlink(path);
    };
  }
  throw new ResearchError('PROFILE_BUSY','无法取得 Profile 锁');
}
