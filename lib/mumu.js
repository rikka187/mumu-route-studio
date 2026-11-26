const {execFile}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const Geo=require('./geo');
function run(file,args,timeout=8000){
  return new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout,maxBuffer:2*1024*1024},(error,stdout,stderr)=>{
    if(error)return reject(new Error(error.killed?'MuMu 接口超时，请检查模拟器':`${path.basename(file)}：${(stderr||stdout||error.message).trim().slice(0,300)}`));
    const output=stdout.trim();
    try{
      const data=JSON.parse(output);
      function check(item){if(!item||typeof item!=='object')return;const code=item.errcode??item.error_code??0;if(Number(code)!==0)throw new Error(item.errmsg||item.error_msg||`MuMu 返回错误 ${code}`);for(const value of Object.values(item))if(value&&typeof value==='object')check(value);}
      check(data);
    }catch(e){if(e instanceof SyntaxError){if(/error|failed|invalid/i.test(output))return reject(new Error(output.slice(0,300)));}else return reject(e);}
    resolve(output);
  }));
}
class MuMu {
  constructor(settings,command=run){this.settings=settings;this.command=command;this.connection=null;this.lastSent=null;}
  async detect(){
    const roots=['D:\\MuMuPlayerCN','C:\\MuMuPlayerCN','D:\\Program Files\\Netease\\MuMuPlayer-12.0',path.join(process.env.ProgramFiles||'C:\\Program Files','Netease','MuMuPlayer-12.0')];
    const candidates=[this.settings.managerPath,...roots.flatMap(r=>['nx_main','shell'].map(s=>path.join(r,s,'MuMuManager.exe')))];
    for(const candidate of candidates.filter(Boolean)){try{await fs.access(candidate);this.settings.managerPath=candidate;return candidate;}catch{}}
    throw new Error('未找到 MuMuManager.exe，请在连接设置中填写路径');
  }
  async connect(){
    try{
      await this.detect();
      const info=JSON.parse(await this.command(this.settings.managerPath,['info','-v',String(this.settings.index)]));
      if(!info.is_android_started||!info.is_process_started)throw new Error('MuMu 实例尚未启动完成');
      this.connection={connected:true,name:info.name||'MuMu',index:String(info.index),androidVersion:info.android_version,checkedAt:Date.now()};
      return this.connection;
    }catch(e){this.connection={connected:false,error:e.message};throw e;}
  }
  async send(point){
    Geo.point(point);
    const calibration={east:this.settings.offsetEast??0,north:this.settings.offsetNorth??0};
    const shifted=Geo.offset(point,calibration.east,calibration.north);
    const raw=this.settings.coordinateSystem==='gcj02'?Geo.toGCJ(shifted):shifted;
    try{await this.command(this.settings.managerPath,['control','-v',String(this.settings.index),'tool','location','-lon',raw.lng.toFixed(8),'-lat',raw.lat.toFixed(8)]);}
    catch(e){this.connection={connected:false,error:e.message};throw e;}
    this.lastSent={...shifted,planned:{...point},calibration,raw,source:'sent',label:'最近成功发送的位置'+(calibration.east||calibration.north?'（已校准）':''),updatedAt:Date.now(),coordinateSystem:this.settings.coordinateSystem};
    return this.lastSent;
  }
  async location(){
    // MuMu's settings file is a configured position, not an Android GPS readback.
    if(this.lastSent)return this.lastSent;
    const root=path.dirname(path.dirname(this.settings.managerPath||''));
    try{
      const vms=path.join(root,'vms'),dirs=await fs.readdir(vms);
      const name=dirs.find(d=>new RegExp(`^MuMuPlayer-[\\d.]+-${this.settings.index}$`).test(d));
      if(name){
        const file=path.join(vms,name,'configs','customer_config.json');
        const stat=await fs.stat(file),data=JSON.parse(await fs.readFile(file,'utf8')),c=data.customer;
        const raw=Geo.point({lat:Number(c?.default_location_latitute),lng:Number(c?.default_location_longtitute)});
        if(this.lastSent&&Math.abs(this.lastSent.raw.lat-raw.lat)<1e-6&&Math.abs(this.lastSent.raw.lng-raw.lng)<1e-6)return this.lastSent;
        const p=this.settings.coordinateSystem==='gcj02'?Geo.fromGCJ(raw):raw;
        return {...p,raw,source:'config',label:'MuMu 配置位置（非 GPS 回读）',updatedAt:stat.mtimeMs,coordinateSystem:this.settings.coordinateSystem};
      }
    }catch{}
    return this.lastSent||null;
  }
}
module.exports={MuMu,run};
