import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSeries, collectionSeries, stopSeries, compressRun, expandRuns } from '../extension/observation-series.js';
import { decodeChecks, normalizeRecord, mergeRecord } from '../extension/sync-format.js';
import { pairConnections, qualitySummary, replaySnapshot, followerChanges, crowdSeries, crowdRanking, traitSummary, eventComparison, scheduledBoundary, reportSummary } from '../extension/research-model.js';
import { gasHarness } from './helpers/gas.mjs';
const accountId='usr_account0001',userId='usr_friend0001',other='usr_friend0002',worldId='wrld_world0001',collectorId='collector_test01',pollSeconds=180,t=Date.UTC(2026,8,10),step=180000;
const state=(id=userId)=>({displayName:id,isFriend:true,presence:'online',status:'active',location:{kind:'world',worldId,instanceId:'one'}});
const options={accountId,collectorId,pollSeconds};
function stream(samples){const map=new Map();for(const sample of samples)for(const r of updateSeries([...map.values()],Array.isArray(sample)?sample:[sample],options))map.set(r.key,r);return [...map.values()];}
function data(records){const out={worlds:[{id:worldId,name:'World',authorName:'Author',capacity:20,traits:{tags:['social'],platforms:['standalonewindows']}}]};for(const r of records)(out[r.kind]||=[]).push(r.value);return out;}
const sample=(at,id=userId,s=state(id))=>({kind:'segments',at,userId:id,state:s});
const f={accountId,since:t,until:t+20*step};
test('unchanged state is one row; exact times and transitions survive compression',()=>{
  const times=Array.from({length:500},(_,i)=>t+i*step+(i%3)),records=stream(times.map(at=>sample(at)));
  assert.equal(records.length,1);assert.equal(records[0].value.sampleCount,500);assert.deepEqual(decodeChecks(t,records[0].value.checks),times);
  assert.ok(JSON.stringify(records).length<JSON.stringify(times.map(at=>sample(at))).length/10);
  const changed=updateSeries(records,[sample(times.at(-1)+step,userId,{...state(),status:'busy'})],options);assert.equal(changed.length,2);assert.equal(changed.find(r=>r.value.endedAt).value.endReason,'changed');
  const stopped=stopSeries(records,{...options,at:times.at(-1)+step,reason:'paused'});assert.equal(stopped[0].value.lastSeenAt,times.at(-1));assert.equal(stopped.at(-1).value.outcome,'paused');
});
test('gaps, collector boundaries and monthly bounds never infer unobserved presence',()=>{
  const records=stream([sample(t),sample(t+step),sample(t+10*step),sample(t+11*step)]);assert.equal(records.length,2);assert.equal(records[0].value.endReason,'gap');
  assert.equal(replaySnapshot(data(records),t+5*step,f).nodes.length,0);
  const otherCollector=updateSeries(records,[sample(t+step)],{...options,collectorId:'collector_test02'});assert.notEqual(otherCollector[0].key,records[0].key);
  const boundary=Date.UTC(2026,8,1);assert.equal(stream([sample(boundary-step),sample(boundary)]).length,2);
  assert.throws(()=>decodeChecks(t,'0'));assert.throws(()=>decodeChecks(t,'1.'.repeat(1024)+'1'));
});
test('compact runs reconstruct all original times and counts without changing old analyses',()=>{
  let rows=[];const original=[];for(let i=0;i<200;i++){const run={accountId,startedAt:t+i*step,completedAt:t+i*step+1000,observedAt:t+i*step+1000,observedCount:200,changedCount:0,onlineComplete:true,onlineOffset:0,offlineOffset:0,worldNamesPending:0};original.push(run);const r=compressRun(rows,run,collectorId,180);const n=rows.findIndex(v=>v.startedAt===r.startedAt);if(n<0)rows.push(r);else rows[n]=r;}
  assert.equal(compressRun(rows,{...original.at(-1),startedAt:t+200*step,completedAt:t+200*step+1000,observedAt:t+200*step+1000,extensions:{'example.metric':{count:1}}},collectorId,180).startedAt,t+200*step);
  assert.equal(rows.length,1);assert.deepEqual(expandRuns(rows).map(({extensions,...r})=>r),original);
  assert.deepEqual(expandRuns([original[0]]),[original[0]]);
  assert.equal(compressRun(rows,{...original.at(-1),startedAt:t+250*step,completedAt:t+250*step+1000,observedAt:t+250*step+1000},collectorId,180).startedAt,t+250*step);
});
test('partial scans do not infer zero crowd; full scans do',()=>{
  const first=collectionSeries([],{...options,samples:[{...state(),id:userId,observedAt:t}],completedAt:t,rosterSize:1,complete:true});
  const partial=collectionSeries(first,{...options,samples:[],completedAt:t+step,rosterSize:1,complete:false});assert.equal(partial.filter(r=>r.kind==='crowd').length,0);
  const full=collectionSeries(first,{...options,samples:[],completedAt:t+step,rosterSize:1,complete:true});assert.equal(full.find(r=>r.kind==='crowd'&&!r.value.endedAt).value.count,0);
  const series=crowdSeries(data([...first,...full]),f);assert.equal(crowdRanking(series)[0].current,0);
});
test('co-presence uses overlapping same-instance intervals, deduplicates devices and excludes private',()=>{
  const records=stream([sample(t),sample(t,other),sample(t+step),sample(t+step,other),sample(t+2*step),sample(t+2*step,other)]),d=data(records);
  d.segments.push({...d.segments[0],collectorId:'collector_test02'});const pairs=pairConnections(d,f);assert.equal(pairs.length,1);assert.equal(pairs[0].duration,2*step);
  assert.equal(pairConnections(d,{...f,userId:other}).length,1);
  d.segments.filter(s=>s.userId===other).forEach(s=>s.state.location.instanceId='other');assert.equal(pairConnections(d,f).length,0);
  d.segments.forEach(s=>s.state.location={kind:'private'});assert.equal(pairConnections(d,f).length,0);
});
test('coverage joins consecutive successful checks even when the statistics changed',()=>{
  const records=stream([{kind:'coverage',at:t,outcome:'complete',observedUsers:1},{kind:'coverage',at:t+step,outcome:'complete',observedUsers:2},{kind:'coverage',at:t+2*step,outcome:'paused',reason:'paused'},{kind:'coverage',at:t+10*step,outcome:'complete',observedUsers:2}]);
  const q=qualitySummary(data(records),f);assert.equal(q.samples,4);assert.equal(q.coveredMs,step);assert.equal(q.pauses,1);assert.ok(q.gaps.some(g=>g.reason==='paused'));assert.ok(q.coverage<1);
});
test('replay retains merged intervals and shows directional transitions, never traveling',()=>{
  const records=stream([sample(t),sample(t+step),sample(t+2*step,userId,{...state(),status:'busy'}),sample(t+3*step,userId,{...state(),status:'busy'}),sample(t+4*step,userId,{...state(),location:{kind:'world',worldId:'wrld_world0002',instanceId:'two'}})]);
  const g=replaySnapshot(data(records),t+4*step,f);assert.equal(g.edges.length,1);assert.equal(g.edges[0].from,worldId);assert.equal(g.edges[0].to,'wrld_world0002');assert.equal(g.nodes.find(n=>n.id===worldId).users.size,0);
  assert.equal(replaySnapshot(data(records),t+3*step,f).nodes[0].users.size,1);
  const multi=data([...records,...records.map(r=>({...r,value:{...r.value,collectorId:'collector_test02'}}))]);assert.equal(replaySnapshot(multi,t+4*step,f).edges[0].count,1);
  const conflicted=data(records);conflicted.segments.push({...records[0].value,collectorId:'collector_test03',startedAt:t,lastSeenAt:t+5*step,observedAt:t+5*step,checks:'',state:{...state(),location:{kind:'private'}}});assert.equal(replaySnapshot(conflicted,t+4*step,f).nodes.reduce((n,p)=>n+p.users.size,0),1);
});
test('follower histories distinguish unchanged checks, zero, approximate counts and missing windows',()=>{
  const records=stream([{kind:'followerHistory',at:t,url:'https://x.com/example',followers:0,approximate:false},{kind:'followerHistory',at:t+10*step,url:'https://x.com/example',followers:0,approximate:false},{kind:'followerHistory',at:t+11*step,url:'https://x.com/example',followers:1000,approximate:true}]);
  assert.equal(records.length,2);const result=followerChanges(data(records),f);assert.equal(result[0].delta,1000);assert.equal(result[0].samples,3);assert.equal(result[0].approximate,true);
  assert.equal(followerChanges(data(records),{...f,since:t+step,until:t+2*step}).length,0);
});
test('features, event comparison and report boundaries respect observed ranges',()=>{
  const records=stream([sample(t),sample(t+step),{kind:'coverage',at:t,outcome:'complete',observedUsers:1},{kind:'coverage',at:t+step,outcome:'complete',observedUsers:1}]),d=data(records);
  assert.ok(traitSummary(d,f).some(r=>r.name==='タグ：social'&&r.users===1));assert.ok(traitSummary(d,f).some(r=>r.name==='対応端末：Windows'));
  assert.equal(eventComparison(d,{start:t,end:t+step},f)[1].users,1);
  assert.equal(scheduledBoundary(Date.UTC(2026,9,25,10),'daily'),Date.UTC(2026,9,24,15));
  assert.equal(new Date(scheduledBoundary(Date.UTC(2026,9,25,10),'weekly')+9*3600000).getUTCDay(),1);
  assert.equal(reportSummary(d,f).quality.samples,2);
});
test('protocol preserves world traits and strips arbitrary fields from research records',()=>{
  const old=normalizeRecord('worlds',{accountId,id:worldId,observedAt:t,name:'World',traits:{tags:['social'],platforms:['standalonewindows']}}),next=normalizeRecord('worlds',{accountId,id:worldId,observedAt:t+step,name:'World'});assert.equal(mergeRecord(next,old).value.traits.tags[0],'social');
  const record=normalizeRecord('annotations',{accountId,id:'event_0001',observedAt:Date.now(),title:'Future',start:Date.now()+86400000,end:Date.now()+86400001,blob:'DO_NOT_SYNC'});assert.ok(!JSON.stringify(record).includes('DO_NOT_SYNC'));
});
test('monthly archives preserve keys, revisions, retry upserts, range paging and authentication',()=>{
  const gas=gasHarness();gas.properties.RETENTION_DAYS='0';const hello=gas.request({protocol:2,action:'hello'}),record=stream([sample(t),sample(t+step)])[0];record.value.endedAt=t+2*step;record.value.observedAt=t+2*step;
  const send=r=>gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[r]});assert.equal(send(record).accepted,1);gas.context.pruneRecords();assert.equal(gas.table('VRCUserSegments').length,1);assert.equal(gas.table('VRCArchives').length,2);
  const pull=extra=>gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:['segments'],...extra});const before=pull();assert.equal(before.records.length,1);assert.equal(send(record).accepted,1);assert.equal(pull().records[0].revision,before.records[0].revision);
  const updated=normalizeRecord('segments',{...record.value,observedAt:t+3*step,endedAt:t+3*step,endReason:'stopped'});assert.equal(send(updated).accepted,1);assert.equal(pull().records[0].value.endReason,'stopped');assert.equal(gas.table('VRCUserSegments').length,1);
  const latest=normalizeRecord('segments',{...updated.value,observedAt:t+4*step,endedAt:t+4*step,endReason:'gap'});assert.equal(gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[latest,record]}).accepted,2);assert.equal(pull().records[0].value.endReason,'gap');
  assert.equal(pull({action:'range',accountId,until:t+10*step}).code,'REQUEST');
  assert.equal(pull({action:'range',accountId,since:t,until:t+10*step}).records.length,1);assert.equal(pull({action:'range',accountId:other,since:t,until:t+10*step}).records.length,0);
  const opens=gas.opens;assert.equal(gas.request({action:'range',token:'bad'}).code,'AUTH');assert.equal(gas.opens,opens);
});
test('interrupted archive copies are retried without duplicate rows or lost records',()=>{
  const gas=gasHarness();gas.properties.RETENTION_DAYS='0';const hello=gas.request({protocol:2,action:'hello'}),r=normalizeRecord('reports',{accountId,id:'report_0001',title:'Report',observedAt:t+step,since:t-86400000,until:t,summary:{}});
  assert.equal(gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[r]}).accepted,1);
  const flush=gas.context.SpreadsheetApp.flush;let count=0;gas.context.SpreadsheetApp.flush=()=>{if(++count===1)throw Error('simulated interruption');};assert.throws(()=>gas.context.pruneRecords());gas.context.SpreadsheetApp.flush=flush;gas.context.pruneRecords();gas.context.pruneRecords();
  const total=[...gas.books.values()].flatMap(book=>book.get('VRCReports')?.slice(1)||[]);assert.equal(total.length,1);assert.equal(total[0][0],r.key);
});
test('archive metadata recovers after copy succeeded but manifest update failed',()=>{
  const gas=gasHarness();gas.properties.RETENTION_DAYS='0';const hello=gas.request({protocol:2,action:'hello'}),r=normalizeRecord('reports',{accountId,id:'report_0002',title:'Report',observedAt:t+step,since:t-86400000,until:t,summary:{}});
  gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[r]});
  const save=gas.context.saveArchive_;let count=0;gas.context.saveArchive_=(...args)=>{if(++count===2)throw Error('manifest failed');return save(...args);};assert.throws(()=>gas.context.pruneRecords());gas.context.saveArchive_=save;gas.context.pruneRecords();
  const result=gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:['reports']});assert.equal(result.records.length,1);assert.equal(gas.table('VRCArchives')[1][2],1);
});
test('archive shards roll over without dropping records or changing revisions',()=>{
  const gas=gasHarness();gas.properties.RETENTION_DAYS='0';const hello=gas.request({protocol:2,action:'hello'});
  const report=id=>normalizeRecord('reports',{accountId,id,title:id,observedAt:t+step,since:t-86400000,until:t,summary:{}});
  const push=r=>gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[r]});push(report('report_0010'));gas.context.pruneRecords();gas.table('VRCArchives')[1][2]=50000;push(report('report_0011'));gas.context.pruneRecords();assert.equal(gas.table('VRCArchives').length,3);
  const pull=gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:['reports']});assert.equal(pull.records.length,2);assert.notEqual(pull.records[0].revision,pull.records[1].revision);
});
