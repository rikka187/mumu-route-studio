const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Runner,validate}=require('./lib/runner');
const {MuMu}=require('./lib/mumu');
const Geo=require('./lib/geo');
const ROOT=__dirname, DATA=path.join(ROOT,'data'), PORT=Number(process.env.PORT||8765);
const token=crypto.randomBytes(24).toString('hex');
let settings={managerPath:'',index:0,coordinateSystem:'wgs84',searchUrl:'https://photon.komoot.io/api/',offsetEast:0,offsetNorth:0};
let saved=[],preview=false,runCalibration={east:0,north:0},mutations=Promise.resolve(),searchAt=0;
const searchCache=new Map();
const mumu=new MuMu(settings);
const runner=new Runner(async p=>{if(!preview)await mumu.send(p);});
async function store(name,value){const dest=path.join(DATA,name),tmp=dest+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2),'utf8');await fs.rename(tmp,dest);}
async function readJson(name,fallback){try{return JSON.parse(await fs.readFile(path.join(DATA,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new Error(`${name} 无法读取，请先备份并修复 data 中的文件：${e.message}`);}}
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>1024*1024)throw new Error('请求内容过大');}try{return JSON.parse(data||'{}');}catch{throw new Error('JSON 格式错误');}}
function runStatus(){return {...runner.status(),preview,calibration:runCalibration};}
function state(){return {app:'mumu-route-studio',token,settings,connection:mumu.connection,location:preview?null:(mumu.lastSent||null),run:runStatus(),routes:saved};}
async function mutate(route,input){
  if(route==='/api/calibration'){
    if(runner.active())throw new Error('请先停止任务，再调整整体偏移');
    const east=input.east,north=input.north;
    if(typeof east!=='number'||typeof north!=='number')throw new Error('请填写数字形式的东西与南北偏移');
    Geo.offset({lat:0,lng:0},east,north);
    const updated={...settings,offsetEast:east,offsetNorth:north};
    await store('settings.json',updated);Object.assign(settings,updated);
    return {settings};
  }
  if(route==='/api/connect'){
    if(runner.active())throw new Error('请先停止任务再连接');
    try{await mumu.connect();await store('settings.json',settings);return {connection:mumu.connection,location:await mumu.location(),settings};}
    catch(e){mumu.connection={connected:false,error:e.message};throw e;}
  }
  if(route==='/api/settings'){
    if(runner.active())throw new Error('请先停止任务再修改连接');
    if(typeof input.managerPath!=='string'||path.basename(input.managerPath).toLowerCase()!=='mumumanager.exe')throw new Error('请填写 MuMuManager.exe 的完整路径');
    if(!Number.isInteger(input.index)||input.index<0||input.index>999)throw new Error('实例编号无效');
    if(!['wgs84','gcj02'].includes(input.coordinateSystem))throw new Error('坐标系无效');
    await fs.access(input.managerPath);
    Object.assign(settings,{managerPath:input.managerPath,index:input.index,coordinateSystem:input.coordinateSystem});mumu.connection=null;mumu.lastSent=null;await store('settings.json',settings);return {settings};
  }
  if(route==='/api/location'){
    if(runner.active())throw new Error('请先停止任务再单点定位');
    const p=Geo.point(input);await mumu.connect();await mumu.send(p);return {location:mumu.lastSent};
  }
  if(route==='/api/run/start'){
    validate(input);if(runner.active())throw new Error('请先停止当前任务');
    preview=input.preview===true;
    if(!preview)await mumu.connect();
    runCalibration={east:settings.offsetEast,north:settings.offsetNorth};
    // Validate the translated route before sending its first coordinate.
    for(const point of input.points)Geo.offset(point,runCalibration.east,runCalibration.north);
    await runner.start(input);return runStatus();
  }
  if(route==='/api/run/pause'){await runner.pause();return runStatus();}
  if(route==='/api/run/resume'){if(!preview)await mumu.connect();runner.resume();return runStatus();}
  if(route==='/api/run/stop'){await runner.stop();return runStatus();}
  if(route==='/api/routes/save'){
    validate(input.config);
    const name=String(input.name||'').trim();if(!name||name.length>80)throw new Error('路线名称须在 1 至 80 个字符内');
    const existing=saved.find(r=>r.name===name);
    const item={id:existing?.id||crypto.randomUUID(),name,config:input.config,updatedAt:Date.now()};
    saved=saved.filter(r=>r.id!==item.id);saved.unshift(item);await store('routes.json',saved);return {routes:saved};
  }
  if(route==='/api/routes/delete'){saved=saved.filter(r=>r.id!==input.id);await store('routes.json',saved);return {routes:saved};}
  throw new Error('未知操作');
}
async function search(query){
  if(!query||query.length>150)throw new Error('请输入 1 至 150 个字符的地点名称');
  if(searchCache.has(query))return searchCache.get(query);
  const now=Date.now();if(now-searchAt<1100)throw new Error('搜索过于频繁，请稍后再试');searchAt=now;
  const url=new URL(settings.searchUrl);url.searchParams.set('q',query);url.searchParams.set('limit','8');
  const response=await fetch(url,{headers:{'User-Agent':'MuMuRouteStudio/1.0 (local personal map tool)'},signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error(`地点搜索服务返回 ${response.status}，可改用经纬度定位`);
  const data=await response.json();
  const results=(data.features||[]).map(f=>({lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0],name:f.properties.name||query,address:[f.properties.country,f.properties.state,f.properties.city,f.properties.district,f.properties.street].filter(Boolean).join(' · ')}));
  searchCache.set(query,results);if(searchCache.size>100)searchCache.delete(searchCache.keys().next().value);return results;
}
async function handler(req,res){
  try{
    const host=req.headers.host;
    if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(host))return json(res,{error:'仅允许本机访问'},403);
    if(req.headers.origin&&!['http://'+host].includes(req.headers.origin))return json(res,{error:'拒绝跨站请求'},403);
    const url=new URL(req.url,'http://'+host);
    if(url.pathname.startsWith('/api/')){
      if(req.method==='GET'){
        if(url.pathname==='/api/state')return json(res,state());
        if(url.pathname==='/api/location')return json(res,{location:await mumu.location()});
        if(url.pathname==='/api/search')return json(res,{results:await search((url.searchParams.get('q')||'').trim())});
        return json(res,{error:'接口不存在'},404);
      }
      if(req.method!=='POST')return json(res,{error:'不支持此方法'},405);
      if(req.headers['x-local-token']!==token)return json(res,{error:'页面已失效，请刷新后重试'},403);
      if(!req.headers['content-type']?.startsWith('application/json'))return json(res,{error:'需要 JSON 请求'},415);
      const input=await body(req);
      const action=mutations.then(()=>mutate(url.pathname,input));mutations=action.catch(()=>{});
      return json(res,await action);
    }
    if(req.method!=='GET')return json(res,{error:'不支持此方法'},405);
    const name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).replace(/^\//,'');
    const dest=name==='geo.js'?path.join(ROOT,'lib','geo.js'):path.resolve(ROOT,'public',name);
    if(name!=='geo.js'&&!dest.startsWith(path.join(ROOT,'public')+path.sep))return json(res,{error:'文件不存在'},404);
    const file=await fs.readFile(dest);const ext=path.extname(dest);
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'})[ext]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(file);
  }catch(e){json(res,{error:e.message},e.code==='ENOENT'?404:400);}
}
async function main(){
  await fs.mkdir(DATA,{recursive:true});Object.assign(settings,await readJson('settings.json',{}));saved=await readJson('routes.json',[]);
  try{await mumu.detect();await mumu.connect();await store('settings.json',settings);}catch(e){mumu.connection={connected:false,error:e.message};}
  const server=http.createServer(handler);
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`端口 ${PORT} 已占用；若程序已经启动，请直接打开 http://127.0.0.1:${PORT}`:e);process.exitCode=1;});
  server.listen(PORT,'127.0.0.1',()=>console.log(`MuMu Route Studio: http://127.0.0.1:${PORT} (MuMu interface only; no ADB)`));
  const shutdown=async()=>{await runner.stop();server.close();};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={handler,main};
