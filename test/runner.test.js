const test=require('node:test');
const assert=require('node:assert/strict');
const Geo=require('../lib/geo');
const {Runner,validate}=require('../lib/runner');
const points=[{lat:30,lng:104},{lat:30.001,lng:104.001},{lat:30.002,lng:104}];
const config={points,returnMode:'move',lapSeconds:10,loops:2,interval:1,jitter:1.5,variation:.08};
function fixture(send=async()=>{}){let clock=0;const runner=new Runner(send,()=>clock);runner.schedule=()=>{};return {runner,at:async n=>{clock=n;await runner.tick();}};}
test('open route adds direct return distance and ends at its starting coordinate',()=>{
  const open=Geo.route(points,'reset'),closed=Geo.route(points,'move');
  assert.ok(Math.abs(closed.total-open.total-Geo.distance(points.at(-1),points[0]))<1e-7);
  const end=Geo.motion(closed,1,20,10,.3).point;
  assert.ok(Geo.distance(end,points[0])<1e-6);
});
test('jitter stays within configured distance and progress remains monotonic',()=>{
  const path=Geo.route(points,'move');let prev=-1;
  for(let i=0;i<=1000;i++){
    const f=i/1000,m=Geo.motion(path,f,i/20,3,.3),base=Geo.sample(path,m.metres);
    assert.ok(m.metres>=prev);prev=m.metres;assert.ok(Geo.distance(m.point,base)<3.02);
  }
});
test('pause excludes paused time; completing all loops reports exact planned distance',async()=>{
  const sent=[],f=fixture(async p=>sent.push(p));await f.runner.start(config);await f.at(3);assert.equal(f.runner.elapsed,3);
  await f.runner.pause();await f.at(100);assert.equal(f.runner.elapsed,3);assert.equal(sent.length,2);
  f.runner.resume();await f.at(104);assert.equal(f.runner.elapsed,7);
  await f.at(114);await f.at(117);assert.equal(f.runner.state,'completed');assert.equal(f.runner.elapsed,20);
  assert.ok(Math.abs(f.runner.distance-2*Geo.route(points,'move').total)<1e-6);
  assert.ok(Geo.distance(sent.at(-1),points[0])<1e-6);
});
test('failed update pauses without counting unsubmitted movement; resume retries from last committed progress',async()=>{
  let fail=false;const f=fixture(async()=>{if(fail)throw new Error('offline');});await f.runner.start(config);await f.at(2);fail=true;await f.at(4);
  assert.equal(f.runner.state,'paused');assert.equal(f.runner.elapsed,2);assert.match(f.runner.error,/offline/);
  fail=false;await f.at(50);f.runner.resume();await f.at(51);assert.equal(f.runner.elapsed,3);await f.runner.stop();
});
test('stop waits for in-flight command and prevents further updates',async()=>{
  let release,calls=0;const f=fixture(async()=>{if(++calls===2)await new Promise(r=>release=r);});await f.runner.start(config);
  const tick=f.at(2);let stopped=false;const stop=f.runner.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);
  release();await Promise.all([tick,stop]);assert.equal(f.runner.state,'stopped');await f.at(5);assert.equal(calls,2);assert.equal(f.runner.elapsed,2);
});
test('computer suspension pauses instead of jumping forward',async()=>{const f=fixture();await f.runner.start(config);await f.at(300);assert.equal(f.runner.state,'paused');assert.equal(f.runner.elapsed,0);assert.match(f.runner.error,/休眠/);});
test('direct reset mode finishes at endpoint after final pass',async()=>{const f=fixture();await f.runner.start({...config,returnMode:'reset'});await f.at(10);await f.at(20);assert.equal(f.runner.state,'completed');assert.ok(Geo.distance(f.runner.position,points.at(-1))<1e-6);});
test('reject invalid coordinates and nonfinite timing or movement parameters',()=>{
  for(const patch of [{lapSeconds:NaN},{loops:1.5},{interval:0},{jitter:Infinity},{variation:-1},{points:[points[0],{lat:91,lng:104}]},{points:[points[0],points[0]]}])assert.throws(()=>validate({...config,...patch}));
});
test('coordinate conversion round trips within a centimetre',()=>{const p={lat:39.9,lng:116.4};assert.ok(Geo.distance(p,Geo.fromGCJ(Geo.toGCJ(p)))<.01);});
