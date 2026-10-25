import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAnalysisReport,sharedWorldGraph,comparePeople,mergeIntervals,analysisCSV,DAY,jstDay} from '../extension/analysis-lab.js';
import {location} from '../extension/core.js';
const accountId='usr_account00001',otherAccount='usr_account00002',alice='usr_alice000001',bob='usr_bob00000001';
const a='wrld_world00001',b='wrld_world00002',c='wrld_world00003';
const at=Date.parse('2026-10-20T12:00:00Z'),hour=3600000;
const state=(id=alice,world=a)=>({id,displayName:id===alice?'Alice':'Bob',isFriend:true,presence:'online',location:location(world+':123'),platform:'android',status:'active'});
const snapshot=(time,id=alice,world=a)=>({...state(id,world),accountId,observedAt:time});
const event=(time,from,to,id=alice,previousAt=time-60000)=>({accountId,userId:id,displayName:state(id).displayName,observedAt:time,previousObservedAt:previousAt,kind:'changed',previous:state(id,from),current:state(id,to)});
const visit=(start,end,world=a,instance='123')=>({accountId,displayName:'Self',presence:'online',location:location(world+':'+instance),startedAt:start,lastSeenAt:end,observedAt:end,endedAt:null});
const encounter=(start,end,id=alice,world=a,instance='123',relation='instance')=>({...visit(start,end,world,instance),userId:id,displayName:state(id).displayName,relation,visitStartedAt:start,otherInstanceId:instance});
const input=(extra={})=>({accountId,friends:[],events:[],visits:[],encounters:[],runs:[],worlds:[{id:a,name:'A'},{id:b,name:'B'},{id:c,name:'C'}],...extra});
const report=(data,extra={})=>buildAnalysisReport(input(data),{now:at+hour,since:at,until:at+hour,...extra});

test('lab deduplicates event snapshots, isolates accounts and ignores future records',()=>{
  const e=event(at+60000,a,b),f=snapshot(at+60000,alice,b);
  const r=report({events:[e,e,{...e,accountId:otherAccount},{...e,observedAt:at+2*hour}],friends:[f,f,{...f,accountId:otherAccount}]});
  assert.equal(r.metrics.observations,2);assert.equal(r.metrics.users,1);assert.equal(r.metrics.changes,1);assert.equal(r.routes[0].count,1);
  assert.equal(r.hourly.reduce((n,h)=>n+h.observations,0),2);
});
test('period comparison uses disjoint point boundaries and never divides a zero baseline',()=>{
  const r=report({friends:[snapshot(at),snapshot(at+hour,bob)],events:[event(at-1,a,b,bob,at-60000)]});
  assert.equal(r.metrics.users,1);assert.equal(r.previousMetrics.users,1);assert.equal(r.metrics.changes,0);
  assert.equal(r.worldGrowth.find(w=>w.id===a).change,0);
  const fresh=report({friends:[snapshot(at)]}).worldGrowth[0];assert.equal(fresh.change,null);assert.equal(fresh.delta,1);
});
test('JST daily and hourly durations split at midnight and exclude duplicate collectors',()=>{
  const midnight=Date.parse('2026-10-20T15:00:00Z'),start=midnight-hour,end=midnight+hour;
  const r=buildAnalysisReport(input({visits:[visit(start,end),visit(start+1000,end)]}),{now:end,since:start,until:end});
  assert.equal(r.metrics.selfDuration,2*hour);assert.equal(r.metrics.selfVisits,1);
  assert.deepEqual(r.daily.map(d=>[d.day,d.selfDuration]),[['2026-10-20',hour],['2026-10-21',hour]]);
  assert.equal(r.hourly[23].selfDuration,hour);assert.equal(r.hourly[0].selfDuration,hour);
  assert.equal(jstDay(midnight),'2026-10-21');
});
test('unconfirmed private/offline locations do not become routes or world similarity',()=>{
  const e=event(at+1000,a,b);e.current.location=location('private');
  const f=snapshot(at+2000,bob,b);f.presence='offline';
  const r=report({events:[e],friends:[f]});
  assert.equal(r.routes.length,0);assert.equal(r.people.find(p=>p.id===bob).worlds.length,0);
  assert.ok(r.states.some(s=>s.name.includes('プライベート')));assert.ok(!r.worlds.some(w=>w.id===b));
});
test('world and user filters apply to observations, routes and encounters without hiding own visits',()=>{
  const r=report({friends:[snapshot(at+1000),snapshot(at+2000,bob,b)],events:[event(at+3000,a,b),event(at+4000,b,c,bob)],
    visits:[visit(at,at+10000,a),visit(at+20000,at+30000,b)],encounters:[encounter(at,at+10000),encounter(at,at+10000,bob)]},{userId:alice,worldId:a});
  assert.equal(r.metrics.users,1);assert.equal(r.routes.length,1);assert.equal(r.metrics.selfVisits,1);assert.equal(r.connections.length,1);
  assert.ok(r.worlds.every(w=>w.id===a));
});
test('round trips require consecutive observed world changes, even with a world filter',()=>{
  const clean=report({events:[event(at+1000,a,b),event(at+3000,b,a,alice,at+2000)]});assert.equal(clean.roundTrips[0].count,1);
  const detour=report({events:[event(at+1000,a,b),event(at+2000,b,c,alice,at+1500),event(at+3000,c,b,alice,at+2500),event(at+4000,b,a,alice,at+3500)]},{worldId:a});
  assert.equal(detour.roundTrips.length,0);
  const hidden=event(at+2000,b,c);hidden.current.location=location('private');
  const privateGap=report({events:[event(at+1000,a,b),hidden,event(at+3000,b,a,alice,at+2500)]});assert.equal(privateGap.roundTrips.length,0);
});
test('long observation gaps are not counted as nearby transitions',()=>{
  const r=report({events:[event(at+1000,a,b,alice,at-1000000),event(at+3000,b,c,alice,at+2000)]},{pollSeconds:60});
  assert.equal(r.metrics.moves,2);assert.equal(r.routes.reduce((n,r)=>n+r.nearby,0),1);
});
test('time statistics exclude single points, clip to range and preserve gaps',()=>{
  const r=report({visits:[visit(at-10000,at+10000),visit(at+20000,at+20000),visit(at+30000,at+90000,b)]});
  assert.equal(r.metrics.selfDuration,70000);assert.equal(r.dwellStats.confirmed,2);assert.equal(r.dwellStats.unconfirmed,1);
  assert.equal(r.dwellStats.median,35000);assert.equal(r.dwellStats.mean,35000);assert.equal(r.dwellStats.p90,55000);
  assert.equal(r.selfWorlds.find(w=>w.id===a).returns,1);assert.equal(r.dwell[0].count,1);
});
test('company time intersects matching instance visits and unions all companions once',()=>{
  const r=report({visits:[visit(at,at+10000)],encounters:[encounter(at,at+5000),encounter(at+2000,at+8000,bob),encounter(at,at+10000,'usr_charlie0001',a,'456'),encounter(at,at+10000,'usr_delta000001',a,'123','world')]});
  assert.equal(r.company.together,8000);assert.equal(r.company.unconfirmed,2000);assert.equal(r.metrics.companions,3);
  assert.equal(r.quality.worldOnly,1);assert.equal(r.connectionWorlds[0].duration,21000);
});
test('connection cohorts and first-in-saved-history records use the previous period',()=>{
  const r=report({encounters:[encounter(at-10000,at-5000),encounter(at+10000,at+20000),encounter(at+1000,at+5000,bob)]});
  assert.equal(r.cohorts.find(c=>c.name==='両期間で観測').count,1);assert.equal(r.cohorts.find(c=>c.name==='今期のみ観測').count,1);
  assert.deepEqual(r.firstEncounters.map(r=>r.id),[bob]);assert.equal(r.connectionChanges.find(r=>r.id===alice).durationDelta,5000);
});
test('latest world ranking excludes stale, future and offline snapshots regardless of historical period',()=>{
  const r=report({friends:[snapshot(at+hour-1000),snapshot(at,bob,b),{...snapshot(at+hour-500,'usr_offline0001',a),presence:'offline'}]});
  assert.deepEqual(r.currentWorlds.map(w=>[w.id,w.users]),[[a,1]]);assert.equal(r.quality.freshness.reduce((n,r)=>n+r.count,0),3);
});
test('collection coverage does not claim missing days are failures and reports only bounded gaps',()=>{
  const run=(start,end)=>({accountId,startedAt:start,completedAt:end,observedAt:end,onlineComplete:true});
  const r=report({runs:[run(at,at+1000),run(at+1000000,at+1001000)]});
  assert.equal(r.quality.runs,2);assert.equal(r.quality.runDays,1);assert.equal(r.quality.gaps[0].duration,999000);
  assert.equal(r.quality.completeRuns,2);
});
test('similarity uses world set overlap, graph thresholds, bounded node count and explicit components',()=>{
  const people=[{id:alice,name:'Alice',worlds:[a,b],hours:[1,2]},{id:bob,name:'Bob',worlds:[b,c],hours:[2,3]},{id:'third',name:'Third',worlds:['wrld_other0001'],hours:[]}];
  const compared=comparePeople(people,alice,bob);assert.equal(compared.similarity,1/3);assert.deepEqual(compared.sharedHours,[2]);
  assert.equal(comparePeople(people,alice,alice),null);
  const graph=sharedWorldGraph(people,{limit:2});assert.equal(graph.nodes.length,2);assert.equal(graph.total,3);assert.equal(graph.edges[0].count,1);
  const disconnected=sharedWorldGraph(people,{minShared:2});assert.equal(disconnected.edges.length,0);assert.equal(disconnected.groups.length,3);
  assert.equal(sharedWorldGraph(Array.from({length:100},(_,i)=>({id:String(i),name:String(i),worlds:[a],hours:[]})),{limit:100}).nodes.length,80);
});
test('report export contains only derived allowlisted data and neutralizes spreadsheet formulas',()=>{
  const r=report({friends:[{...snapshot(at+1000),authToken:'SECRET',email:'SECRET',extensions:{unsafe:'SECRET'},displayName:'=HYPERLINK("evil")'}]});
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  const text=analysisCSV([['name'],[r.people[0].name],['  +cmd'],['line\n"quoted"']]);
  assert.ok(text.startsWith('\uFEFF'));assert.ok(text.includes("'=HYPERLINK"));assert.ok(text.includes("'  +cmd"));assert.ok(text.includes('""quoted""'));
});
test('empty datasets are usable, invalid periods are rejected and interval union is deterministic',()=>{
  const r=report({});assert.equal(r.metrics.users,0);assert.equal(r.dwellStats.mean,null);assert.equal(r.company.together,0);assert.equal(sharedWorldGraph(r.people).nodes.length,0);
  assert.throws(()=>report({},{since:at+hour,until:at}));assert.throws(()=>report({},{since:at-367*DAY}));
  assert.deepEqual(mergeIntervals([{start:5,end:10},{start:1,end:7},{start:11,end:12}]),[{start:1,end:10},{start:11,end:12}]);
});
test('large histories retain all users in summaries while graph work is bounded',()=>{
  const friends=Array.from({length:10000},(_,i)=>snapshot(at+i,'usr_test'+String(i).padStart(8,'0'),i%2?a:b));
  const r=report({friends});assert.equal(r.metrics.users,10000);assert.equal(r.people.length,10000);
  const graph=sharedWorldGraph(r.people);assert.equal(graph.nodes.length,40);assert.equal(graph.total,10000);
});
