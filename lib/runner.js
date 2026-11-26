const {performance} = require('node:perf_hooks');
const Geo = require('./geo');
function validate(input) {
  const path=Geo.route(input.points,input.returnMode);
  const lapSeconds=Number(input.lapSeconds), loops=Number(input.loops), interval=Number(input.interval??1), jitter=Number(input.jitter??1.5), variation=Number(input.variation??.08);
  if(!Number.isFinite(lapSeconds)||lapSeconds<1||lapSeconds>86400) throw new Error('单遍时间须在 1 秒至 24 小时内');
  if(!Number.isInteger(loops)||loops<1||loops>1000) throw new Error('循环次数须为 1 至 1000 的整数');
  if(!Number.isFinite(interval)||interval<.5||interval>10) throw new Error('更新间隔须在 0.5 至 10 秒内');
  if(!Number.isFinite(jitter)||jitter<0||jitter>10) throw new Error('位置抖动须在 0 至 10 米内');
  if(!Number.isFinite(variation)||variation<0||variation>.3) throw new Error('速度变化须在 0 至 30% 内');
  return {path,lapSeconds,loops,interval,jitter,variation,points:input.points,returnMode:input.returnMode};
}
class Runner {
  constructor(send,now=()=>performance.now()/1000) { this.send=send; this.now=now; this.state='idle';this.elapsed=0;this.distance=0;this.token=0;this.error=null;this.trail=[]; }
  active() { return ['starting','running','paused','stopping'].includes(this.state); }
  status() {
    const c=this.config;
    return {state:this.state,error:this.error,elapsed:this.elapsed,distance:this.distance,remaining:c?Math.max(0,c.lapSeconds*c.loops-this.elapsed):0,progress:c?this.elapsed/(c.lapSeconds*c.loops):0,lap:c?Math.min(c.loops,Math.floor(this.elapsed/c.lapSeconds)+1):0,loops:c?.loops||0,totalDistance:c?c.path.total*c.loops:0,lapDistance:c?.path.total||0,position:this.position||null,trail:this.trail,config:c?{points:c.points,lapSeconds:c.lapSeconds,loops:c.loops,interval:c.interval,jitter:c.jitter,variation:c.variation,returnMode:c.returnMode}:null};
  }
  async start(input) {
    if(this.active()) throw new Error('请先停止当前任务');
    this.config=validate(input);this.state='starting';this.error=null;this.elapsed=0;this.distance=0;this.trail=[];const token=++this.token;
    this.pending=this.send(this.config.path.points[0]);
    try { await this.pending; if(token!==this.token)return;this.position={...this.config.path.points[0]};this.trail.push(this.position);this.last=this.now();this.state='running';this.schedule(); }
    catch(e){if(token===this.token){this.state='error';this.error=e.message;}throw e;}
  }
  schedule() { clearTimeout(this.timer); if(this.state==='running')this.timer=setTimeout(()=>this.tick(),this.config.interval*1000); }
  async tick() {
    if(this.state!=='running')return;
    const token=this.token,c=this.config,now=this.now(),dt=now-this.last;
    if(dt>Math.max(15,c.interval*5)){this.state='paused';this.error='电脑休眠或调度中断，已暂停。点击继续后从当前位置恢复。';return;}
    const elapsed=Math.min(c.lapSeconds*c.loops,this.elapsed+Math.max(0,dt));
    const done=elapsed>=c.lapSeconds*c.loops, lap=done?c.loops-1:Math.floor(elapsed/c.lapSeconds), fraction=done?1:(elapsed%c.lapSeconds)/c.lapSeconds;
    const motion=Geo.motion(c.path,fraction,elapsed,c.jitter,c.variation);
    this.pending=this.send(motion.point);
    try {
      await this.pending;
      // A successfully submitted position is committed even when pause/stop was requested in flight.
      this.position=motion.point;this.elapsed=elapsed;this.distance=lap*c.path.total+motion.metres;this.trail.push(motion.point);if(this.trail.length>4000)this.trail.splice(0,2000);
      this.last=now;
      if(token===this.token&&this.state==='running'){if(done)this.state='completed';else this.schedule();}
    }catch(e){if(token===this.token&&this.state==='running'){this.state='paused';this.error='位置发送失败，已暂停：'+e.message;}}
  }
  async pause(){if(this.state!=='running')throw new Error('当前没有正在运行的任务');this.state='paused';clearTimeout(this.timer);await this.pending?.catch(()=>{});}
  resume(){if(this.state!=='paused')throw new Error('当前任务未暂停');this.error=null;this.last=this.now();this.state='running';this.schedule();}
  async stop(){++this.token;clearTimeout(this.timer);this.state='stopping';await this.pending?.catch(()=>{});this.state='stopped';}
}
module.exports={Runner,validate};
