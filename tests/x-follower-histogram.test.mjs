import test from 'node:test';
import assert from 'node:assert/strict';
import {followerHistogram,histogramBinCount} from '../extension/x-follower-histogram.js';
const accountId='usr_histowner001',other='usr_histowner002',now=Date.now();
const metric=(name,followers,extra={})=>({accountId,url:'https://x.com/'+name,followers,approximate:false,source:'x-profile',observedAt:now-1000,...extra});
const profile=(userId,urls,owner=accountId)=>({accountId:owner,userId,urls:urls.map(n=>'https://x.com/'+n),checkedAt:now-1000});
const cache=rows=>Object.fromEntries(rows.map(r=>[r.accountId+'/'+r.userId,r]));
const build=(rows,profiles={},options={})=>followerHistogram(rows,profiles,{accountId,now,...options});
test('histogram counts latest distinct X accounts, including zero and unlinked metrics, within the selected owner',()=>{
 const profiles=cache([profile('usr_friend0001',['shared','missing']),profile('usr_friend0002',['shared'])]);
 const report=build([metric('shared',10),metric('shared',20,{observedAt:now-100}),metric('zero',0),metric('unlinked',100,{approximate:true}),metric('foreign',999,{accountId:other}),metric('invalid',-1)],profiles);
 assert.equal(report.total,3);assert.equal(report.missing,1);assert.equal(report.approximate,1);assert.equal(report.median,20);assert.equal(report.max,100);assert.equal(report.bins.reduce((n,b)=>n+b.count,0),3);assert.equal(report.bins[0].count,1);assert.equal(report.rows.find(r=>r.url.endsWith('shared')).followers,20);
});
test('friend scope uses every explicit X link of current friends once, and excludes former friends and other owners',()=>{
 const profiles=cache([profile('usr_friend0001',['shared','second','missing']),profile('usr_friend0002',['shared']),profile('usr_former0001',['former']),profile('usr_friend0001',['foreign'],other)]);
 const rows=['shared','second','former','unlinked','foreign'].map((name,i)=>metric(name,i));
 const friends=[{accountId,id:'usr_friend0001',isFriend:true},{accountId,id:'usr_friend0002',isFriend:true},{accountId,id:'usr_former0001',isFriend:false},{accountId:other,id:'usr_friend0001',isFriend:true}];
 const r=build(rows,profiles,{scope:'friends',friends});assert.equal(r.total,2);assert.equal(r.missing,1);assert.deepEqual(r.rows.map(r=>r.url),['https://x.com/shared','https://x.com/second']);assert.equal(r.median,0.5);
});
test('decade boundaries put zero, powers of ten and their neighbors in exactly one bin',()=>{
 const values=[0,1,9,10,99,100,999,1000,9999,10000];const r=build(values.map((v,i)=>metric('fixture'+i,v)));
 assert.deepEqual(r.bins.map(b=>b.count),[1,2,2,2,2,1]);assert.deepEqual(r.bins.map(b=>b.min),[0,1,10,100,1000,10000]);
 for(const value of values)assert.equal(r.bins.filter(b=>value>=b.min&&value<=b.max).length,1);
});
test('linear bins remain equal width, retain empty intervals and include the maximum exactly once',()=>{
 const r=build([metric('zero',0),metric('boundary',20),metric('maximum',99)],{},{scale:'linear',binCount:5});
 assert.deepEqual(r.bins.map(b=>[b.min,b.max,b.count]),[[0,19,1],[20,39,1],[40,59,0],[60,79,0],[80,99,1]]);
});
test('empty and all-zero samples do not produce invalid axes or fabricate observations',()=>{
 for(const scale of ['log','linear']){
  const empty=build([],{},{scale});assert.equal(empty.total,0);assert.deepEqual(empty.bins,[]);assert.equal(empty.median,null);
  const zero=build([metric('a',0),metric('b',0)],{},{scale});assert.deepEqual(zero.bins.map(b=>b.count),[2]);assert.equal(zero.median,0);assert.equal(zero.max,0);
 }
});
test('both scales cover the largest valid count without unbounded bin creation or losing totals',()=>{
 for(const scale of ['log','linear']){const values=[0,1,10,10**12,Number.MAX_SAFE_INTEGER],r=build(values.map((v,i)=>metric('large'+i,v)),{},{scale,binCount:20});assert.ok(r.bins.length<=20);assert.equal(r.bins.reduce((n,b)=>n+b.count,0),5);for(const v of values)assert.equal(r.bins.filter(b=>v>=b.min&&v<=b.max).length,1);}
});
test('large samples are fully aggregated rather than inheriting the display pagination limit',()=>{
 const r=build(Array.from({length:3000},(_,i)=>metric('bulk'+i,i)));assert.equal(r.total,3000);assert.equal(r.bins.reduce((n,b)=>n+b.count,0),3000);assert.equal(r.median,1499.5);
});

test('arbitrary class counts work on both scales without gaps, overlaps, or lost observations',()=>{
 const rows=Array.from({length:1001},(_,i)=>metric('bin'+i,i,{approximate:i%5===0}));
 for(const scale of ['log','linear'])for(const binCount of [1,7,37,100]){
  const r=build(rows,{},{scale,binCount});assert.equal(r.requestedBinCount,binCount);assert.equal(r.bins.length,binCount);
  assert.equal(r.bins[0].min,0);assert.equal(r.bins.at(-1).max,1000);
  assert.equal(r.bins.reduce((n,b)=>n+b.count,0),rows.length);assert.equal(r.bins.reduce((n,b)=>n+b.approximate,0),201);
  for(const [i,b] of r.bins.entries()){assert.ok(Number.isSafeInteger(b.min)&&Number.isSafeInteger(b.max)&&b.max>=b.min);if(i)assert.equal(b.min,r.bins[i-1].max+1);}
  for(const row of rows)assert.equal(r.bins.filter(b=>row.followers>=b.min&&row.followers<=b.max).length,1);
 }
});
test('narrow integer ranges reduce the class count and empty samples stay empty',()=>{
 for(const scale of ['log','linear'])for(const max of [0,1,3]){
  const r=build([metric('max',max)],{},{scale,binCount:100});assert.equal(r.requestedBinCount,100);assert.equal(r.bins.length,max+1);assert.equal(r.bins.at(-1).count,1);
  assert.deepEqual(r.bins.map(b=>[b.min,b.max]),Array.from({length:max+1},(_,i)=>[i,i]));
 }
 assert.deepEqual(build([],{},{binCount:100}).bins,[]);
});
test('custom classes cover maximum-safe-integer boundaries on both scales',()=>{
 for(const scale of ['log','linear']){
  const model=build([metric('max',Number.MAX_SAFE_INTEGER)],{},{scale,binCount:100});assert.equal(model.bins.length,100);
  const rows=model.bins.flatMap((b,i)=>[metric('lower'+i,b.min),metric('upper'+i,b.max)]),r=build(rows,{},{scale,binCount:100});
  assert.ok(r.bins.every(b=>b.count===2&&Number.isSafeInteger(b.min)&&Number.isSafeInteger(b.max)));assert.equal(r.total,200);
 }
});
test('invalid or absent class counts use automatic binning without unbounded work',()=>{
 for(const value of [null,undefined,0,-1,101,1.5,Infinity,NaN,'7']){
  assert.equal(histogramBinCount(value),null);
  const r=build([metric('max',10000)],{},{binCount:value});assert.equal(r.requestedBinCount,null);assert.deepEqual(r.bins.map(b=>b.min),[0,1,10,100,1000,10000]);
 }
 assert.equal(histogramBinCount(7),7);
});
