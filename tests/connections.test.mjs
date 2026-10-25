import test from 'node:test';
import assert from 'node:assert/strict';
import {currentUser,friend,location} from '../extension/core.js';
import {reconcileConnections,connectionSummary,connectionGraph} from '../extension/connections.js';
import {normalizeRecord} from '../extension/sync-format.js';
const accountId='usr_selfaccount0001',uid='usr_friend00000001',world='wrld_testworld0001',place=world+':123~region(jp)';
const self=(at,where=place)=>currentUser({id:accountId,displayName:'Me',state:'online',location:where},at).self;
const other=(at,where=place)=>friend({id:uid,displayName:'Friend',state:'online',location:where},at);
const cycle=(start,previous={visits:[],encounters:[]},where=place,friendWhere=place)=>reconcileConnections(previous.visits,previous.encounters,[self(start,where),self(start+10000,where)],[other(start+5000,friendWhere)],accountId,{completedAt:start+11000,pollSeconds:60});
function merge(previous,next) {const result={};for(const kind of ['visits','encounters']){const rows=new Map(previous[kind].map(r=>[r.userId+':'+r.startedAt,r]));for(const r of next[kind])rows.set(r.userId+':'+r.startedAt,r);result[kind]=[...rows.values()];}return result;}
test('self normalization uses the actual location, never the home preference or private fields',()=>{
  const value=currentUser({id:accountId,displayName:'Me',state:'online',location:'private',worldId:world,instanceId:'123',homeLocation:world,email:'SECRET',authToken:'SECRET'},1000);
  assert.equal(value.self.location.kind,'private');assert.equal(value.self.location.worldId,'');assert.ok(!JSON.stringify(value).includes('SECRET'));
  assert.equal(currentUser({id:accountId,homeLocation:world},1000).self.location.kind,'unknown');
  assert.equal(currentUser({id:accountId,worldId:world,instanceId:'123',state:'online'},1000).self.location.worldId,world);
  assert.equal(currentUser({id:accountId,location:place,state:'offline'},1000).self.location.kind,'offline');
  assert.equal(currentUser({id:accountId,location:place,state:'active'},1000).self.location.kind,'web');
});
test('nearby cycles extend visits and co-observed sessions without creating records per poll',()=>{
  const first=cycle(1000000),next=cycle(1060000,first);
  assert.equal(first.visits.length,1);assert.equal(first.encounters.length,1);assert.equal(first.encounters[0].relation,'instance');
  assert.equal(next.visits[0].startedAt,first.visits[0].startedAt);
  assert.equal(next.encounters[0].startedAt,first.encounters[0].startedAt);
  assert.equal(next.encounters[0].lastSeenAt-first.encounters[0].lastSeenAt,60000);
  const data=merge(first,next);assert.equal(data.visits.length,1);assert.equal(data.encounters.length,1);
  const row=connectionSummary(data.encounters,{accountId,now:2000000})[0];assert.equal(row.count,1);assert.equal(row.duration,60000);
});
test('private, unknown, different instances and movement during collection never create confirmed co-presence',()=>{
  assert.equal(cycle(1000000,undefined,'private').encounters.length,0);
  assert.equal(cycle(1000000,undefined,place,'private').encounters.length,0);
  assert.equal(cycle(1000000,undefined,place,world+':456').encounters[0].relation,'world');
  assert.equal(cycle(1000000,undefined,world,world).encounters[0].relation,'world');
  const result=reconcileConnections([],[],[self(1000000),self(1010000,world+':456')],[other(1005000)],accountId,{completedAt:1011000});
  assert.equal(result.encounters.length,0);assert.equal(result.visits.length,2);
  assert.equal(result.visits[0].lastSeenAt,1000000);assert.equal(result.visits[0].endedAt,1010000);
});
test('long gaps, intervening private states and roster removal close sessions without filling unobserved time',()=>{
  const first=cycle(1000000),later=cycle(2000000,first),combined=merge(first,later);
  assert.equal(combined.encounters.length,2);assert.equal(connectionSummary(combined.encounters,{accountId,now:2100000})[0].duration,0);
  const hidden=cycle(1060000,first,place,'private');assert.equal(hidden.encounters[0].lastSeenAt,1005000);assert.ok(hidden.encounters[0].endedAt);
  const returned=cycle(1120000,merge(first,hidden));assert.notEqual(returned.encounters.at(-1).startedAt,first.encounters[0].startedAt);
  const removed=reconcileConnections(first.visits,first.encounters,[self(1060000),self(1070000)],[],accountId,{completedAt:1071000,roster:new Set()});
  assert.ok(removed.encounters[0].endedAt);
});
test('stale, nonfriend and other-account observations cannot become connections',()=>{
  const result=reconcileConnections([],[],[self(1000000),self(1010000)],[other(500000),{...other(1005000),isFriend:false}],accountId,{completedAt:1011000});
  assert.equal(result.encounters.length,0);
  const wrong=cycle(1000000);for(const kind of ['visits','encounters'])wrong[kind]=wrong[kind].map(r=>({...r,accountId:'usr_otheraccount0001'}));
  assert.equal(cycle(1060000,wrong).visits[0].startedAt,1060000);
  assert.equal(connectionSummary(wrong.encounters,{accountId,now:2000000}).length,0);
});
test('connections union overlapping device sessions, clip to the requested period and keep one-point observations',()=>{
  const base=cycle(1000000).encounters[0];
  const rows=[{...base,lastSeenAt:1065000,observedAt:1065000},{...base,startedAt:1035000,lastSeenAt:1095000,observedAt:1095000},
    {...base,userId:'usr_friend00000002',displayName:'Single'}];
  const summary=connectionSummary(rows,{accountId,since:1025000,now:1085000});
  assert.equal(summary.length,1);assert.equal(summary[0].duration,60000);assert.equal(summary[0].count,1);
  assert.equal(connectionSummary(rows,{accountId,now:2000000}).find(r=>r.name==='Single').duration,0);
  assert.equal(connectionSummary(rows,{accountId,now:2000000,query:'friend'})[0].name,'Friend');
  assert.equal(connectionSummary(rows,{accountId,now:2000000,worldId:'wrld_otherworld000'}).length,0);
  const graph=connectionGraph(summary,accountId);assert.equal(graph.edges[0].undirected,true);assert.equal(graph.nodes.length,2);
});
test('new record kinds validate temporal bounds, ownership and instance evidence and discard raw fields',()=>{
  const data=cycle(Date.now()-60000);
  for(const kind of ['visits','encounters'])for(const row of data[kind]) {
    const normalized=normalizeRecord(kind,{...row,authToken:'SECRET',email:'SECRET'});
    assert.ok(!JSON.stringify(normalized).includes('SECRET'));
    assert.throws(()=>normalizeRecord(kind,{...row,lastSeenAt:row.startedAt-1}));
  }
  const e=data.encounters[0];
  assert.throws(()=>normalizeRecord('encounters',{...e,userId:accountId}));
  assert.throws(()=>normalizeRecord('encounters',{...e,otherInstanceId:'456'}));
  assert.throws(()=>normalizeRecord('encounters',{...e,location:location('private')}));
});
