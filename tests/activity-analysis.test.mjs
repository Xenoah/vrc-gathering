import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { continuityMetadata, observedDurations, formatObservedDuration, classifyActivity,
  buildActivityTimeline, changesByHour } from '../extension/activity-analysis.js';

const wid='wrld_01234567-1111-2222-3333-012345678901';
const wid2='wrld_11234567-1111-2222-3333-012345678901';
const uid='usr_01234567-1111-2222-3333-012345678901';
const state=(at,world=wid,instance='123')=>({
  id:uid,displayName:'Demo',isFriend:true,presence:'online',status:'active',
  observedAt:at,stateFirstObservedAt:at,location:{kind:'world',worldId:world,instanceId:instance}
});
const extend=(prev,next)=>({...next,extensions:{'vrc.activity':continuityMetadata(prev,next)}});

test('profile or status edits do not reset online/world continuity',()=>{
  const first=extend(null,state(1000));
  const changed=extend(first,{...first,observedAt:31000,status:'busy',stateFirstObservedAt:31000});
  assert.deepEqual(changed.extensions['vrc.activity'],{presenceSince:1000,placeSince:1000,instanceSince:1000});
  const durations=observedDurations(changed);
  assert.equal(durations.presence,30000);
  assert.equal(durations.place,30000);
  assert.equal(formatObservedDuration(30000),'1分未満');
  assert.equal(formatObservedDuration(3*3600000+12*60000),'3時間12分');
});
test('world and instance changes reset only the corresponding continuity',()=>{
  const a=extend(null,state(1000));
  const moved=extend(a,state(2*3600000,wid2));
  assert.equal(moved.extensions['vrc.activity'].presenceSince,1000);
  assert.equal(moved.extensions['vrc.activity'].placeSince,2*3600000);
  const instance=extend(moved,state(3*3600000,wid2,'abc'));
  assert.equal(instance.extensions['vrc.activity'].presenceSince,1000);
  assert.equal(instance.extensions['vrc.activity'].placeSince,2*3600000);
  assert.equal(instance.extensions['vrc.activity'].instanceSince,3*3600000);
  const offline=extend(instance,{...instance,observedAt:4*3600000,presence:'offline',
    location:{kind:'offline',worldId:'',instanceId:''}});
  assert.equal(offline.extensions['vrc.activity'].presenceSince,4*3600000);
  assert.equal(offline.extensions['vrc.activity'].placeSince,4*3600000);
});
test('older records fall back conservatively without future or negative durations',()=>{
  const previous={...state(5000),stateFirstObservedAt:4000};
  const current=extend(previous,{...previous,observedAt:8000});
  assert.equal(current.extensions['vrc.activity'].presenceSince,4000);
  assert.equal(observedDurations({...current,observedAt:1000}).presence,0);
  assert.equal(observedDurations({...current,isFriend:false}),null);
});
test('timeline has t as time, users as rows, and never paints beyond last observation',()=>{
  const first=state(12000);
  const privateState={...state(16000),location:{kind:'private',worldId:'',instanceId:''}};
  const newest={...privateState,observedAt:19000};
  const events=[
    {userId:uid,displayName:'Demo',observedAt:12000,previousObservedAt:null,previous:null,current:first,kind:'first'},
    {userId:uid,displayName:'Demo',observedAt:16000,previousObservedAt:14000,
      previous:{...state(14000),location:{kind:'world',worldId:wid,instanceId:'123'}},
      current:privateState,kind:'changed'}
  ];
  const plot=buildActivityTimeline([newest],events,[{id:wid,name:'星空'}],{now:20000,rangeMs:10000,pollSeconds:3});
  assert.equal(plot.rows.length,1);
  assert.equal(plot.rows[0].id,uid);
  const segments=plot.rows[0].segments;
  assert.ok(segments.some(s=>s.kind==='world'));
  assert.ok(segments.some(s=>s.kind==='private'));
  assert.ok(segments.every(s=>s.end<=19000));
  assert.ok(segments.every(s=>s.kind!=='world'||s.worldId===wid));
  assert.equal(buildActivityTimeline([newest],events,[],{now:20000,rangeMs:10000,filter:'world'}).rows.length,1);
  assert.equal(buildActivityTimeline([newest],events,[],{now:20000,rangeMs:10000,query:'星空'}).rows.length,0);
  assert.equal(buildActivityTimeline([newest],events,[{id:wid,name:'星空'}],{now:20000,rangeMs:10000,query:'星空'}).rows.length,1);
  assert.equal(classifyActivity(privateState),'private');
  assert.equal(classifyActivity({...privateState,isFriend:false}),'removed');
});
test('long gaps remain explicitly estimated and points are not extrapolated to now',()=>{
  const initial=state(10000), recent={...initial,observedAt:1000000};
  const plot=buildActivityTimeline([recent],[{userId:uid,observedAt:10000,current:initial,kind:'first'}],[],
    {now:2000000,rangeMs:2000000,pollSeconds:180});
  assert.equal(plot.rows[0].segments[0].confidence,'estimated');
  assert.equal(plot.rows[0].segments[0].end,1000000);
});
test('hour histogram counts changes and uses JST, not UTC and not first observations',()=>{
  const first=Date.UTC(2026,9,24,16,0); // 2026-10-25 01:00 JST
  const counts=changesByHour([
    {kind:'changed',observedAt:first},{kind:'roster-removed',observedAt:first+1000},
    {kind:'first',observedAt:first+2000},{kind:'changed',observedAt:first-7200000}
  ],first);
  assert.equal(counts[1],2);
  assert.equal(counts.reduce((a,b)=>a+b,0),2);
});
test('intelligence tabs and timeline mount remain part of the packaged dashboard',()=>{
  const html=fs.readFileSync(new URL('../extension/dashboard.html',import.meta.url),'utf8');
  const js=fs.readFileSync(new URL('../extension/dashboard.js',import.meta.url),'utf8');
  assert.match(html,/data-tab="home"/);
  assert.match(html,/data-tab="analytics"/);
  assert.match(html,/id="activityTimeline"/);
  assert.match(html,/観測上の継続/);
  assert.match(js,/function renderActivity\(\)/);
  assert.match(js,/function renderHome\(\)/);
});
