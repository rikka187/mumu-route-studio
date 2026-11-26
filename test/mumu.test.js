const test=require('node:test');
const assert=require('node:assert/strict');
const {run,MuMu}=require('../lib/mumu');
const Geo=require('../lib/geo');
test('MuMu command adapter accepts success and detects errors nested under instance IDs',async()=>{
  const ok=await run(process.execPath,['-e','console.log(JSON.stringify({"0":{errcode:0,errmsg:""}}))']);assert.equal(JSON.parse(ok)['0'].errcode,0);
  await assert.rejects(run(process.execPath,['-e','console.log(JSON.stringify({"0":{errcode:5,errmsg:"instance is offline"}}))']),/instance is offline/);
  await assert.rejects(run(process.execPath,['-e','console.log(JSON.stringify({error_code:3,error_msg:"bad command"}))']),/bad command/);
});
test('global calibration shifts outgoing WGS-84 coordinates without changing route input',async()=>{
  const calls=[],settings={managerPath:'MuMuManager.exe',index:0,coordinateSystem:'wgs84',offsetEast:120,offsetNorth:-65};
  const mumu=new MuMu(settings,async(file,args)=>{calls.push(args);return '{}';});
  const p={lat:30.77,lng:103.98},original={...p},expected=Geo.offset(p,120,-65);
  await mumu.send(p);const args=calls[0];
  assert.ok(Math.abs(Number(args[args.indexOf('-lon')+1])-expected.lng)<1e-8);
  assert.ok(Math.abs(Number(args[args.indexOf('-lat')+1])-expected.lat)<1e-8);
  assert.deepEqual(p,original);assert.deepEqual(mumu.lastSent.planned,original);
  assert.equal(mumu.lastSent.lat,expected.lat);assert.match(mumu.lastSent.label,/已校准/);
  settings.offsetEast=0;assert.equal((await mumu.location()).lng,expected.lng);
});
test('calibration is applied before GCJ conversion and is never applied twice',async()=>{
  const mumu=new MuMu({managerPath:'MuMuManager.exe',index:0,coordinateSystem:'gcj02',offsetEast:-80,offsetNorth:140},async()=> '{}');
  const p={lat:39.9,lng:116.4},expected=Geo.toGCJ(Geo.offset(p,-80,140));await mumu.send(p);
  assert.ok(Geo.distance(mumu.lastSent.raw,expected)<1e-8);assert.ok(Geo.distance(Geo.fromGCJ(mumu.lastSent.raw),mumu.lastSent)<.01);
});
test('invalid calibration prevents MuMu invocation',async()=>{
  let calls=0;const mumu=new MuMu({offsetEast:Infinity,offsetNorth:0},async()=>{calls++;});
  await assert.rejects(mumu.send({lat:30,lng:104}),/偏移/);assert.equal(calls,0);assert.equal(mumu.lastSent,null);
});
