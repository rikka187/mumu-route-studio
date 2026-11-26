const test=require('node:test');
const assert=require('node:assert/strict');
const Geo=require('../lib/geo');
test('metre calibration has correct cardinal direction and latitude-aware distance',()=>{
  for(const lat of [0,30,60]){
    const p={lat,lng:104},east=Geo.offset(p,100,0),north=Geo.offset(p,0,100);
    assert.ok(east.lng>p.lng);assert.equal(east.lat,p.lat);assert.ok(north.lat>p.lat);assert.equal(north.lng,p.lng);
    assert.ok(Math.abs(Geo.distance(p,east)-100)<.001);assert.ok(Math.abs(Geo.distance(p,north)-100)<.001);
    const west=Geo.offset(p,-100,0),south=Geo.offset(p,0,-100);assert.ok(west.lng<p.lng);assert.ok(south.lat<p.lat);
  }
});
test('inverse calibration prevents accumulating offset when using current position as a route point',()=>{
  const p={lat:30.77,lng:103.98};for(const [east,north] of [[0,0],[500,-300],[-10000,10000]])assert.ok(Geo.distance(Geo.unoffset(Geo.offset(p,east,north),east,north),p)<1e-7);
});
test('reject oversized or nonnumeric offsets',()=>{for(const v of [NaN,Infinity,10001,'12',null]){assert.throws(()=>Geo.offset({lat:30,lng:104},v,0));assert.throws(()=>Geo.offset({lat:30,lng:104},0,v));}});
