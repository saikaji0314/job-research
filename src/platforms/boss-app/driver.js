import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {ResearchError} from '../../domain/errors.js';

export class AndroidDriver {
  constructor({python='python',adbPath,serial}={}) {
    this.serial=serial; this.next=0;this.pending=new Map();
    this.child=spawn(python,['-u',fileURLToPath(new URL('./ui.py',import.meta.url))],{
      windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONUTF8:'1',
        ANDROID_USER_HOME:process.env.ANDROID_USER_HOME || resolve('.local/android'),...(adbPath?{ADBUTILS_ADB_PATH:resolve(adbPath)}:{})}});
    const fail=()=>{for(const {reject,timer} of this.pending.values()){clearTimeout(timer);reject(new ResearchError('ANDROID_DRIVER_ERROR','安卓界面服务退出；检查连接和 Python 依赖'));}this.pending.clear();};
    this.child.on('error',fail);this.child.on('exit',fail);
    this.lines=createInterface({input:this.child.stdout});this.lines.on('line',line=>{
      let response;try{response=JSON.parse(line);}catch{return;}
      const waiting=this.pending.get(response.id);if(!waiting)return;
      clearTimeout(waiting.timer);this.pending.delete(response.id);
      if(response.error)waiting.reject(new ResearchError(response.error,`App 操作暂停或失败：${response.error}（${response.stage || 'unknown'}）`));else waiting.resolve(response.result);
    });
  }
  call(op,args={}) {
    return new Promise((resolve,reject)=>{
      const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(new ResearchError('ANDROID_DRIVER_ERROR','安卓界面操作超时，已停止继续读取'));this.child.kill();},90000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,op,...args})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new ResearchError('ANDROID_DRIVER_ERROR','安卓界面服务不可用'));}});
    });
  }
  async initialize(){return this.call('init',{serial:this.serial});}
  async close(){if(this.child.exitCode===null){await this.call('close').catch(()=>{});this.child.stdin.end();this.child.kill();}this.lines.close();}
}
