(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geo = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const R = 6371008.8, rad = Math.PI / 180;
  function point(p) {
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 85 || Math.abs(p.lng) > 180) throw new Error('经纬度无效：纬度须在 ±85°、经度须在 ±180° 内');
    return { lat: p.lat, lng: p.lng };
  }
  function distance(a, b) {
    const h = Math.sin((b.lat-a.lat)*rad/2)**2 + Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((b.lng-a.lng)*rad/2)**2;
    return 2*R*Math.asin(Math.sqrt(Math.min(1,h)));
  }
  function route(points, mode = 'move') {
    if (!Array.isArray(points) || points.length < 2 || points.length > 2000) throw new Error('路线需要 2 至 2000 个点');
    const ps = points.map(point), outbound = ps.slice(1).reduce((s,p,i)=>s+distance(ps[i],p),0);
    if (outbound < 1) throw new Error('路线长度至少为 1 米');
    if (!['move','reset'].includes(mode)) throw new Error('返程模式无效');
    if (mode === 'move' && distance(ps.at(-1),ps[0]) > .001) ps.push({...ps[0]});
    const segments = []; let total = 0;
    for (let i=1;i<ps.length;i++) {
      const length = distance(ps[i-1],ps[i]);
      if (length > .001) { segments.push({ a:ps[i-1], b:ps[i], start:total, length }); total += length; }
    }
    return { points:ps, segments, total, outbound, returning:total-outbound };
  }
  function sample(path, metres) {
    const d = Math.max(0,Math.min(path.total,metres));
    const s = path.segments.find(s=>s.start+s.length>=d) || path.segments.at(-1);
    const f = Math.max(0,Math.min(1,(d-s.start)/s.length));
    // Great-circle interpolation keeps long straight segments consistent with distance.
    const angle = s.length/R;
    let lat,lng;
    if (angle < 1e-8) { lat=s.a.lat+(s.b.lat-s.a.lat)*f; lng=s.a.lng+(s.b.lng-s.a.lng)*f; }
    else {
      const x=Math.sin((1-f)*angle)/Math.sin(angle), y=Math.sin(f*angle)/Math.sin(angle);
      const ax=s.a.lat*rad, ay=s.a.lng*rad, bx=s.b.lat*rad, by=s.b.lng*rad;
      const X=x*Math.cos(ax)*Math.cos(ay)+y*Math.cos(bx)*Math.cos(by), Y=x*Math.cos(ax)*Math.sin(ay)+y*Math.cos(bx)*Math.sin(by), Z=x*Math.sin(ax)+y*Math.sin(bx);
      lat=Math.atan2(Z,Math.hypot(X,Y))/rad; lng=Math.atan2(Y,X)/rad;
    }
    const dy=(s.b.lat-s.a.lat)*rad, dx=(s.b.lng-s.a.lng)*rad*Math.cos(lat*rad), norm=Math.hypot(dx,dy)||1;
    return { lat,lng,north:-dx/norm,east:dy/norm,fraction:f };
  }
  function motion(path, fraction, seconds, jitter, variation) {
    const f=Math.max(0,Math.min(1,fraction));
    const warped=f + variation*Math.sin(2*Math.PI*3*f)/(2*Math.PI*3);
    const p=sample(path,path.total*warped);
    const offset=jitter*(.65*Math.sin(seconds*.72)+.35*Math.sin(seconds*1.17)) * Math.sin(Math.PI*f) * Math.sin(Math.PI*p.fraction);
    return { point:{lat:p.lat+offset*p.north/111195,lng:p.lng+offset*p.east/(111195*Math.max(.08,Math.cos(p.lat*rad)))}, metres:path.total*warped };
  }
  // GCJ-02 conversion for coordinates copied from Chinese map services.
  function delta(lat,lng) {
    const x=lng-105,y=lat-35;
    let a=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));
    let b=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));
    a+=(20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;
    a+=(20*Math.sin(y*Math.PI)+40*Math.sin(y/3*Math.PI))*2/3;
    a+=(160*Math.sin(y/12*Math.PI)+320*Math.sin(y*Math.PI/30))*2/3;
    b+=(20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;
    b+=(20*Math.sin(x*Math.PI)+40*Math.sin(x/3*Math.PI))*2/3;
    b+=(150*Math.sin(x/12*Math.PI)+300*Math.sin(x/30*Math.PI))*2/3;
    const magic=1-.00669342162296594323*Math.sin(lat*rad)**2;
    return {lat:a*180/((6378245*(1-.00669342162296594323))/(magic*Math.sqrt(magic))*Math.PI),lng:b*180/(6378245/Math.sqrt(magic)*Math.cos(lat*rad)*Math.PI)};
  }
  function toGCJ(p) {
    if(p.lng<72.004||p.lng>137.8347||p.lat<.8293||p.lat>55.8271) return {...p};
    const d=delta(p.lat,p.lng); return {lat:p.lat+d.lat,lng:p.lng+d.lng};
  }
  function fromGCJ(p) { let q={...p}; for(let i=0;i<4;i++){const g=toGCJ(q);q.lat+=p.lat-g.lat;q.lng+=p.lng-g.lng;} return q; }
  function offset(p,east=0,north=0) {
    point(p);
    if(!Number.isFinite(east)||!Number.isFinite(north)||Math.abs(east)>10000||Math.abs(north)>10000)throw new Error('整体偏移每个方向须在 -10000 至 10000 米内');
    return point({lat:p.lat+north/R/rad,lng:p.lng+east/(R*rad*Math.cos(p.lat*rad))});
  }
  function unoffset(p,east=0,north=0) {
    offset(p,east,north); // Validate both coordinates and offsets.
    const lat=p.lat-north/R/rad;
    return point({lat,lng:p.lng-east/(R*rad*Math.cos(lat*rad))});
  }
  return { point,distance,route,sample,motion,toGCJ,fromGCJ,offset,unoffset };
});
