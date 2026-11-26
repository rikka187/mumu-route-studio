'use strict';
const $=id=>document.getElementById(id);
const fields=['minutes','loops','returnMode','jitter','variation','interval'];
let points=[],undoStack=[],redoStack=[],token='',savedRoutes=[],settings={},current=null,run={state:'idle'},connected=false,addMode=true,busy=false,pollBusy=false,initial=true,tileErrors=0;
let currentMarker,previewMarker,searchMarker,toastTimer,calibrationDirty=false,selection=null;
const map=L.map('map',{zoomControl:true,doubleClickZoom:false}).setView([35,105],5);
const tiles=[
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'}),
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{maxZoom:20,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>'})
];
let tileIndex=0;tiles[0].addTo(map);
for(const layer of tiles){layer.on('tileerror',()=>{if(++tileErrors>=4)$('mapWarning').hidden=false;});layer.on('tileload',()=>{tileErrors=0;$('mapWarning').hidden=true;});}
const routeLine=L.polyline([],{color:'#008566',weight:4,opacity:.9}).addTo(map);
const returnLine=L.polyline([],{color:'#df963b',weight:3,dashArray:'7 7'}).addTo(map);
const trailLine=L.polyline([],{color:'#397fe0',weight:4,opacity:.8}).addTo(map);
const calibratedLine=L.polyline([],{color:'#9256db',weight:3,dashArray:'4 7',interactive:false}).addTo(map);
const pointLayer=L.layerGroup().addTo(map);
const selectedMarker=L.circleMarker([0,0],{radius:11,color:'#e4a331',weight:3,fillOpacity:0,interactive:false});
L.control.scale({imperial:false,position:'bottomright'}).addTo(map);
function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').className=error?'error':'';$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,error?6500:3200);}
async function api(url,data){
  const response=await fetch(url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(data)});
  let result;try{result=await response.json();}catch{throw new Error('本地服务没有返回有效数据，请检查是否已启动');}
  if(!response.ok)throw new Error(result.error||'操作失败');return result;
}
async function action(fn){if(busy)return;busy=true;renderControls();try{await fn();}catch(e){toast(e.message,true);}finally{busy=false;renderControls();}}
function active(){return ['starting','running','paused','stopping'].includes(run.state);}
function selectedPoint(){return selection?.kind==='route'?points[selection.index]||null:selection?.point||null;}
function renderSelection(){
  const p=selectedPoint();
  $('selectedPointName').textContent=p?(selection.kind==='route'?`已选中：路线点 ${selection.index+1}`:`已选中：${selection.label}`):'尚未选中位置';
  $('selectedPointCoords').textContent=p?`原始：${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`:'点击地图、路线点或搜索结果选择位置。';
  $('selectedPointTarget').hidden=!p;
  try{if(p){const c=draftCalibration(),target=Geo.offset(p,c.east,c.north);$('selectedPointTarget').textContent=`${calibrationDirty?'预览':'发送'}：${target.lat.toFixed(6)}, ${target.lng.toFixed(6)} · WGS-84`;}}
  catch{$('selectedPointTarget').textContent='请先填写有效的整体偏移';}
  $('selectedPointHint').textContent=calibrationDirty?'请先点击“应用偏移”，再应用当前选点位置。':active()?'请先停止路线任务，再单点定位。':'按已保存的整体偏移定位一次，不启动路线移动。';
  document.querySelectorAll('.point-item').forEach((row,i)=>row.classList.toggle('selected',selection?.kind==='route'&&selection.index===i));
  pointLayer.getLayers().forEach((marker,i)=>marker.getElement()?.classList.toggle('selected',selection?.kind==='route'&&selection.index===i));
  if(p&&selection.kind!=='route'){selectedMarker.setLatLng([p.lat,p.lng]);if(!map.hasLayer(selectedMarker))selectedMarker.addTo(map);}else if(map.hasLayer(selectedMarker))map.removeLayer(selectedMarker);
  $('applySelectedPoint').disabled=!p||active()||busy||calibrationDirty||!connected;
  $('applySelectedPoint').title=calibrationDirty?'请先应用整体偏移':active()?'请先停止当前任务':'将所选位置加上整体偏移后发送到 MuMu';
}
function selectPoint(value){selection=value;renderSelection();}
function draftCalibration(){
  if($('offsetEast').value===''||$('offsetNorth').value==='')throw new Error('请填写东西与南北偏移');
  const east=Number($('offsetEast').value),north=Number($('offsetNorth').value);
  Geo.offset({lat:0,lng:0},east,north);return {east,north};
}
function describeCalibration(c){return [c.east?`${c.east>0?'向东':'向西'} ${Math.abs(c.east)} 米`:'',c.north?`${c.north>0?'向北':'向南'} ${Math.abs(c.north)} 米`:''].filter(Boolean).join('，')||'不偏移';}
function syncCalibration(){if(!calibrationDirty){$('offsetEast').value=settings.offsetEast??0;$('offsetNorth').value=settings.offsetNorth??0;}renderCalibration();}
function renderCalibration(){
  try{
    const c=draftCalibration(),dirty=c.east!==(settings.offsetEast??0)||c.north!==(settings.offsetNorth??0);
    calibrationDirty=dirty;$('offsetBadge').textContent=dirty?'尚未应用':c.east||c.north?'已校准':'未偏移';
    $('offsetStatus').textContent=(dirty?'预览（尚未应用）：':'已应用：')+describeCalibration(c);
    let route=points;if(route.length>1&&$('returnMode').value==='move')route=[...route,route[0]];
    calibratedLine.setLatLngs(c.east||c.north?route.map(p=>{const q=Geo.offset(p,c.east,c.north);return [q.lat,q.lng];}):[]);
    $('offsetLegend').hidden=!(c.east||c.north)||points.length<2;
  }catch(e){calibrationDirty=true;$('offsetBadge').textContent='参数无效';$('offsetStatus').textContent=e.message;calibratedLine.setLatLngs([]);$('offsetLegend').hidden=true;}
  renderSelection();
}
async function saveCalibration(c){const d=await api('/api/calibration',c);settings=d.settings;calibrationDirty=false;syncCalibration();renderRun();toast('整体偏移已保存：'+describeCalibration(c));}
function config(){return {points:points.map(p=>({...p})),lapSeconds:Number($('minutes').value)*60,loops:Number($('loops').value),returnMode:$('returnMode').value,jitter:Number($('jitter').value),variation:Number($('variation').value)/100,interval:Number($('interval').value)};}
function validate(c){
  Geo.route(c.points,c.returnMode);
  if(!Number.isFinite(c.lapSeconds)||c.lapSeconds<1||c.lapSeconds>86400)throw new Error('单遍时长须在 1 秒至 24 小时内');
  if(!Number.isInteger(c.loops)||c.loops<1||c.loops>1000)throw new Error('循环次数须为 1 至 1000 的整数');
  if(!Number.isFinite(c.jitter)||c.jitter<0||c.jitter>10||!Number.isFinite(c.variation)||c.variation<0||c.variation>.3||!Number.isFinite(c.interval)||c.interval<.5||c.interval>10)throw new Error('移动参数超出范围');
}
function setConfig(c){
  selection=null;
  points=c.points.map(Geo.point);$('minutes').value=+(c.lapSeconds/60).toFixed(6);$('loops').value=c.loops;
  $('returnMode').value=c.returnMode||'move';$('jitter').value=c.jitter??1.5;$('variation').value=Math.round((c.variation??.08)*100);
  const interval=String(c.interval??1);if(![...$('interval').options].some(o=>o.value===interval))$('interval').add(new Option(`每 ${interval} 秒`,interval));$('interval').value=interval;
}
function persist(){try{localStorage.setItem('mumu-route-draft-v1',JSON.stringify(config()));}catch{}}
function checkpoint(){undoStack.push(points.map(p=>({...p})));if(undoStack.length>100)undoStack.shift();redoStack=[];}
function editPoints(next,index=null){if(active())return;checkpoint();points=next.map(Geo.point);selection=Number.isInteger(index)&&index>=0?{kind:'route',index}:null;renderRoute();persist();}
function addPoint(p){if(points.length>=2000)throw new Error('最多支持 2000 个路线点');editPoints([...points,Geo.point(p)],points.length);}
function removePoint(index){const selected=selection?.kind==='route'?(selection.index===index?null:selection.index-(index<selection.index?1:0)):null;editPoints(points.filter((_,i)=>i!==index),selected);}
function fit(){if(points.length){let ps=points;try{const c=draftCalibration();ps=[...points,...points.map(p=>Geo.offset(p,c.east,c.north))];}catch{}map.fitBounds(L.latLngBounds(ps.map(p=>[p.lat,p.lng])),{padding:[60,90],paddingBottomRight:[60,340],maxZoom:18});}else if(current)map.setView([current.lat,current.lng],17);}
function renderRoute(){
  routeLine.setLatLngs(points.map(p=>[p.lat,p.lng]));
  returnLine.setLatLngs(points.length>1&&$('returnMode').value==='move'?[[points.at(-1).lat,points.at(-1).lng],[points[0].lat,points[0].lng]]:[]);
  pointLayer.clearLayers();$('pointList').replaceChildren();
  if(!points.length){const empty=document.createElement('div');empty.className='empty';empty.append('还没有路线点',document.createElement('br'));const span=document.createElement('span');span.textContent='先搜索学校，或直接点击地图';empty.append(span);$('pointList').append(empty);}
  points.forEach((p,i)=>{
    const marker=L.marker([p.lat,p.lng],{draggable:!active(),icon:L.divIcon({className:'route-point'+(i===0?' first':''),html:String(i+1),iconSize:[27,27],iconAnchor:[13.5,13.5]})}).addTo(pointLayer);
    marker.bindTooltip(`${i===0?'起点':i===points.length-1?'终点':'路线点'} ${i+1} · ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
    marker.on('click',()=>selectPoint({kind:'route',index:i}));
    marker.on('dragstart',()=>{if(!active()){checkpoint();selectPoint({kind:'route',index:i});}});marker.on('dragend',()=>{const ll=marker.getLatLng();points[i]=Geo.point({lat:ll.lat,lng:ll.lng});renderRoute();persist();});
    marker.on('contextmenu',()=>{if(!active())removePoint(i);});
    const row=document.createElement('div');row.className='point-item';const index=document.createElement('span');index.className='point-index';index.textContent=i+1;
    const coord=document.createElement('button');coord.className='point-coord point-select';coord.textContent=`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;coord.title='选中并居中查看此点';coord.setAttribute('aria-label',`选择路线点 ${i+1}`);coord.onclick=()=>{selectPoint({kind:'route',index:i});map.setView([p.lat,p.lng],18);};
    const remove=document.createElement('button');remove.className='point-remove edit';remove.textContent='×';remove.setAttribute('aria-label',`删除第 ${i+1} 个点`);remove.disabled=active();remove.onclick=()=>removePoint(i);row.append(index,coord,remove);$('pointList').append(row);
  });
  $('pointCount').textContent=`${points.length} 个点`;
  $('returnHint').textContent=$('returnMode').value==='move'?'每一遍包含返程距离与时间，最后一遍也回到起点。':'单遍只计起点至终点的距离与时间；两遍之间重置到起点，最后停在终点。';
  renderCalibration();renderMetrics();renderRun();
}
function time(seconds){const n=Math.max(0,Math.ceil(seconds||0)),h=Math.floor(n/3600),m=Math.floor(n/60)%60,s=n%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;}
function renderMetrics(){let length=0;try{length=Geo.route(points,$('returnMode').value).total;}catch{}const c=config();$('lapKm').innerHTML=`${(length/1000).toFixed(3)} <small>km</small>`;$('totalKm').innerHTML=`${(length*c.loops/1000).toFixed(3)} <small>km</small>`;$('speed').innerHTML=`${(c.lapSeconds>0?length/c.lapSeconds*3.6:0).toFixed(2)} <small>km/h</small>`;$('totalTime').textContent=time(c.lapSeconds*c.loops);}
function renderControls(){
  const a=active();document.querySelectorAll('.edit').forEach(el=>el.disabled=a||busy);
  $('undo').disabled=a||busy||!undoStack.length;$('redo').disabled=a||busy||!redoStack.length;
  $('start').disabled=a||busy||calibrationDirty||points.length<2||(!$('preview').checked&&!connected);
  $('start').title=calibrationDirty?'请先应用整体偏移':'';
  $('start').textContent=$('preview').checked?'开始预览':'开始移动';
  $('pause').disabled=run.state!=='running'||busy;$('resume').disabled=run.state!=='paused'||busy;$('stop').disabled=!a||busy;
  $('connect').disabled=a||busy;$('settingsOpen').disabled=a||busy;$('refreshLocation').disabled=busy||a;
  $('centerPosition').disabled=!current;$('usePosition').disabled=a||busy||!current;
  $('manualSend').disabled=a||busy||calibrationDirty||!connected;
  renderSelection();
}
function positionMarker(p,isPreview=false){
  if(isPreview){if(!previewMarker)previewMarker=L.marker([p.lat,p.lng],{icon:L.divIcon({className:'current-point preview-point',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map);else previewMarker.setLatLng([p.lat,p.lng]);previewMarker.bindTooltip('预览位置 · 未发送至 MuMu');}
  else {if(!currentMarker)currentMarker=L.marker([p.lat,p.lng],{icon:L.divIcon({className:'current-point',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map);else currentMarker.setLatLng([p.lat,p.lng]);currentMarker.bindTooltip(p.label||'最近发送位置');}
  if($('follow').checked&&active())map.panTo([p.lat,p.lng],{animate:true,duration:.5});
}
function setPosition(p,center=false){
  if(!p){$('positionSource').textContent='尚未取得位置，可在地图选点后发送';return;}
  current=p;$('position').textContent=`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
  $('positionSource').textContent=(p.label||'最近成功发送的位置')+' · WGS-84';positionMarker(p);
  if(center)map.setView([p.lat,p.lng],17);renderControls();
}
function renderRun(){
  const c=config(),matches=run.config&&['lapSeconds','loops','returnMode','jitter','variation','interval'].every(k=>c[k]===run.config[k])&&JSON.stringify(c.points)===JSON.stringify(run.config.points);
  const view=active()||matches?run:{state:'idle'};
  const names={idle:points.length>1?'准备就绪':'准备规划',starting:'正在发送起点',running:view.preview?'正在预览':'正在移动',paused:'已暂停',completed:'已完成',stopped:'已停止',stopping:'正在停止',error:'启动失败'};
  $('runState').textContent=names[view.state]||view.state;$('lapProgress').textContent=view.config?`第 ${view.lap} / ${view.loops} 遍 · ${(100*view.progress).toFixed(1)}%`:'尚未开始';
  $('progress').style.width=`${Math.max(0,Math.min(100,(view.progress||0)*100))}%`;$('doneKm').textContent=((view.distance||0)/1000).toFixed(3)+' km';$('elapsed').textContent=time(view.elapsed);$('remaining').textContent=time(view.remaining);
  $('previewBadge').hidden=!view.preview||!view.config;$('runError').hidden=!view.error;$('runError').textContent=view.error||'';
  const calibration=view.calibration||{east:0,north:0};
  const shifted=p=>Geo.offset(p,calibration.east,calibration.north);
  trailLine.setLatLngs((view.trail||[]).map(p=>{const q=shifted(p);return [q.lat,q.lng];}));trailLine.setStyle({color:view.preview?'#9256db':'#397fe0'});
  if(view.preview&&view.position)positionMarker(shifted(view.position),true);else if(previewMarker){map.removeLayer(previewMarker);previewMarker=null;}
  renderControls();
}
function renderSaved(){const selected=$('savedRoutes').value;$('savedRoutes').replaceChildren(new Option('选择已保存的路线',''));savedRoutes.forEach(r=>$('savedRoutes').add(new Option(r.name,r.id)));$('savedRoutes').value=selected;}
function connectionState(c){connected=!!c?.connected;$('connection').textContent=connected?`MuMu #${c.index} 已连接`:'MuMu 未连接';$('connection').className='badge '+(connected?'ok':'fail');$('connection').title=c?.error||'使用 MuMuManager 接口';renderControls();}
async function poll(){
  if(pollBusy)return;pollBusy=true;
  try{
    const data=await api('/api/state');token=data.token;settings=data.settings;syncCalibration();connectionState(data.connection);const wasActive=active();run=data.run;
    if(initial){savedRoutes=data.routes;renderSaved();if(active()&&run.config){setConfig(run.config);$('preview').checked=run.preview;renderRoute();}initial=false;const loc=await api('/api/location');setPosition(loc.location,points.length===0);if(points.length)fit();}
    if(data.location)setPosition(data.location);if(wasActive!==active())renderRoute();renderRun();
  }catch(e){connected=false;$('connection').textContent='本地服务已断开';$('connection').className='badge fail';$('runError').hidden=false;$('runError').textContent='无法连接本地服务，请运行启动脚本；页面数据可能已过期。';renderControls();}
  finally{pollBusy=false;}
}
function showSearch(p,name){
  selectPoint({kind:'location',point:Geo.point(p),label:name});
  if(searchMarker)map.removeLayer(searchMarker);searchMarker=L.marker([p.lat,p.lng],{icon:L.divIcon({className:'search-point',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map);
  const content=document.createElement('div');const title=document.createElement('b');title.textContent=name;const coord=document.createElement('p');coord.textContent=`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;const add=document.createElement('button');add.textContent='加入路线';add.disabled=active();add.onclick=()=>{try{addPoint(p);map.closePopup();}catch(e){toast(e.message,true);}};content.append(title,coord,add);searchMarker.bindPopup(content).openPopup();map.setView([p.lat,p.lng],17);$('searchResults').hidden=true;
}
function manual(){let p=Geo.point({lat:Number($('manualLat').value),lng:Number($('manualLng').value)});if(!$('manualLat').value||!$('manualLng').value)throw new Error('请先填写经纬度');return $('inputSystem').value==='gcj02'?Geo.fromGCJ(p):p;}
map.on('click',e=>{if(!active()&&!busy){try{const p={lat:e.latlng.lat,lng:e.latlng.lng};if(addMode)addPoint(p);else selectPoint({kind:'location',point:Geo.point(p),label:'地图位置'});}catch(err){toast(err.message,true);}}$('searchResults').hidden=true;});
map.on('mousemove',e=>$('mapCoord').textContent=`${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)} · WGS-84`);
$('addMode').onclick=()=>{addMode=!addMode;$('addMode').textContent=addMode?'选点模式':'浏览模式';$('addMode').classList.toggle('active',addMode);$('addMode').setAttribute('aria-pressed',String(addMode));};
$('toggleTiles').onclick=()=>{map.removeLayer(tiles[tileIndex]);tileIndex=1-tileIndex;tiles[tileIndex].addTo(map);tileErrors=0;$('mapWarning').hidden=true;};
$('fit').onclick=fit;
$('undo').onclick=()=>{if(!undoStack.length||active())return;redoStack.push(points);points=undoStack.pop();selection=null;renderRoute();persist();};
$('redo').onclick=()=>{if(!redoStack.length||active())return;undoStack.push(points);points=redoStack.pop();selection=null;renderRoute();persist();};
$('clear').onclick=()=>editPoints([]);
document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||$('settingsDialog').open||$('saveDialog').open)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();$(e.shiftKey?'redo':'undo').click();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();$('redo').click();}});
fields.forEach(id=>$(id).addEventListener('change',()=>{renderRoute();persist();}));$('preview').onchange=renderControls;
$('centerPosition').onclick=$('locateMap').onclick=()=>{if(current)map.setView([current.lat,current.lng],17);else toast('暂时没有可用位置，请先选点或输入经纬度',true);};
$('usePosition').onclick=()=>{try{if(current)addPoint(Geo.unoffset(current,settings.offsetEast??0,settings.offsetNorth??0));}catch(e){toast(e.message,true);}};
$('refreshLocation').onclick=()=>action(async()=>{const d=await api('/api/location');setPosition(d.location);toast(d.location?'已读取 MuMu 位置配置':'MuMu 没有可读的位置配置');});
$('manualView').onclick=()=>{try{showSearch(manual(),'输入的坐标');}catch(e){toast(e.message,true);}};
$('manualAdd').onclick=()=>{try{addPoint(manual());}catch(e){toast(e.message,true);}};
$('manualSend').onclick=()=>action(async()=>{const d=await api('/api/location',manual());setPosition(d.location,true);toast('MuMu 已接受位置设置');});
$('applySelectedPoint').onclick=()=>action(async()=>{if(calibrationDirty)throw new Error('请先应用整体偏移');if(active())throw new Error('请先停止当前任务');const p=selectedPoint();if(!p)throw new Error('请先选择地图上的位置或路线点');const d=await api('/api/location',Geo.point(p));setPosition(d.location);toast('已按整体偏移应用所选位置，可在跑步应用中核对');});
$('calibrationOpen').onclick=()=>{$('calibrationSection').scrollIntoView({behavior:'smooth',block:'start'});$('offsetEast').focus({preventScroll:true});};
for(const id of ['offsetEast','offsetNorth'])$(id).addEventListener('input',()=>{renderCalibration();renderControls();});
document.querySelectorAll('.offset-nudge').forEach(button=>button.onclick=()=>{try{const c=draftCalibration(),step=Number($('offsetStep').value);$('offsetEast').value=+(c.east+Number(button.dataset.east)*step).toFixed(2);$('offsetNorth').value=+(c.north+Number(button.dataset.north)*step).toFixed(2);renderCalibration();renderControls();}catch(e){toast(e.message,true);}});
$('calibrationForm').onsubmit=e=>{e.preventDefault();action(async()=>saveCalibration(draftCalibration()));};
$('resetOffset').onclick=()=>action(async()=>{await saveCalibration({east:0,north:0});});
$('searchForm').onsubmit=e=>{e.preventDefault();action(async()=>{
  const q=$('search').value.trim(),pair=q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if(pair){showSearch(Geo.point({lat:Number(pair[1]),lng:Number(pair[2])}),'输入的坐标 · WGS-84');return;}
  $('searchButton').textContent='搜索中';try{const data=await api('/api/search?q='+encodeURIComponent(q));$('searchResults').replaceChildren();if(!data.results.length){const p=document.createElement('p');p.className='muted';p.textContent='没有找到地点，请加上城市名称，或输入经纬度。';$('searchResults').append(p);}for(const r of data.results){const b=document.createElement('button');b.type='button';b.className='search-result';const name=document.createElement('strong');name.textContent=r.name;const address=document.createElement('span');address.textContent=r.address;b.append(name,address);b.onclick=()=>showSearch(r,r.name);$('searchResults').append(b);}$('searchResults').hidden=false;}finally{$('searchButton').textContent='搜索';}
});};
$('connect').onclick=()=>action(async()=>{const d=await api('/api/connect',{});settings=d.settings;connectionState(d.connection);setPosition(d.location);toast('MuMu 接口连接成功');});
$('settingsOpen').onclick=()=>{$('managerPath').value=settings.managerPath||'';$('instanceIndex').value=settings.index??0;$('mumuSystem').value=settings.coordinateSystem||'wgs84';$('settingsDialog').showModal();};
$('settingsClose').onclick=()=>$('settingsDialog').close();
$('settingsForm').onsubmit=e=>{e.preventDefault();action(async()=>{await api('/api/settings',{managerPath:$('managerPath').value.trim(),index:Number($('instanceIndex').value),coordinateSystem:$('mumuSystem').value});const d=await api('/api/connect',{});settings=d.settings;connectionState(d.connection);setPosition(d.location,true);$('settingsDialog').close();toast('设置已保存，MuMu 连接成功');});};
$('start').onclick=()=>action(async()=>{const c=config();validate(c);const d=await api('/api/run/start',{...c,preview:$('preview').checked});run={...d,preview:$('preview').checked};renderRoute();renderRun();toast(run.preview?'开始预览，不向 MuMu 发送坐标':'已发送起点，开始移动');});
for(const op of ['pause','resume','stop'])$(op).onclick=()=>action(async()=>{const d=await api('/api/run/'+op,{});run={...d,preview:run.preview};renderRoute();renderRun();toast({pause:'已暂停，位置保持不变',resume:'已继续移动',stop:'已停止，保留最后位置'}[op]);});
$('save').onclick=()=>{try{validate(config());const selected=savedRoutes.find(r=>r.id===$('savedRoutes').value);$('routeName').value=selected?.name||'';$('saveDialog').showModal();}catch(e){toast(e.message,true);}};
$('saveClose').onclick=()=>$('saveDialog').close();
$('saveForm').onsubmit=e=>{e.preventDefault();action(async()=>{const d=await api('/api/routes/save',{name:$('routeName').value.trim(),config:config()});savedRoutes=d.routes;renderSaved();$('savedRoutes').value=savedRoutes[0].id;$('saveDialog').close();toast('路线已保存到本机');});};
$('load').onclick=()=>{const item=savedRoutes.find(r=>r.id===$('savedRoutes').value);if(!item)return toast('请先选择一条路线',true);checkpoint();setConfig(item.config);renderRoute();persist();fit();toast('已载入 '+item.name);};
$('deleteSaved').onclick=()=>action(async()=>{const id=$('savedRoutes').value;if(!id)throw new Error('请先选择一条路线');const item=savedRoutes.find(r=>r.id===id);if(!confirm(`删除已保存的“${item.name}”？当前编辑的路线会保留。`))return;const d=await api('/api/routes/delete',{id});savedRoutes=d.routes;renderSaved();toast('已删除保存记录');});
$('export').onclick=()=>{try{const c=config();validate(c);const name=savedRoutes.find(r=>r.id===$('savedRoutes').value)?.name||'我的路线';const blob=new Blob([JSON.stringify({version:1,name,coordinateSystem:'wgs84',config:c},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name.replace(/[<>:"/\\|?*]/g,'_')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){toast(e.message,true);}};
$('import').onclick=()=>$('importFile').click();$('importFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>1024*1024)throw new Error('路线文件不能超过 1 MB');const data=JSON.parse(await file.text());if(data.coordinateSystem&&data.coordinateSystem!=='wgs84')throw new Error('导入文件须使用 WGS-84 坐标');validate(data.config);checkpoint();setConfig(data.config);renderRoute();persist();fit();toast('路线已导入，可保存到我的路线');}catch(err){toast(err.message,true);}finally{e.target.value='';}};
try{const draft=JSON.parse(localStorage.getItem('mumu-route-draft-v1'));if(draft&&Array.isArray(draft.points)){if(draft.points.length>=2)validate(draft);setConfig(draft);}}catch{}
renderRoute();poll();setInterval(poll,1000);new ResizeObserver(()=>map.invalidateSize()).observe($('map'));
