import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { continuityMetadata, observedDurations, formatObservedDuration, classifyActivity,
  buildActivityTimeline, changesByHour } from '../extension/activity-analysis.js';
import { reconcile } from '../extension/core.js';
import { normalizeRecord, mergeRecord } from '../extension/sync-format.js';

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
  assert.deepEqual(changed.extensions['vrc.activity'],{observedAt:31000,presenceSince:1000,placeSince:1000,instanceSince:1000});
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
test('newer legacy snapshots cannot inherit continuity for an older world through sync',()=>{
  const accountId='usr_account00000001', now=Date.now(), initial=state(now-7200000);
  const first=reconcile([], [initial], accountId, initial.observedAt).records[0];
  const legacy={...state(now-3600000,wid2),accountId,firstObservedAt:initial.observedAt};
  const merged=mergeRecord(normalizeRecord('friends',legacy),normalizeRecord('friends',first)).value;
  assert.equal(merged.extensions['vrc.activity'].observedAt,initial.observedAt);
  assert.equal(observedDurations(merged).place,0);
  assert.equal(observedDurations(merged).placeSince,legacy.observedAt);
  const next=reconcile([merged],[state(now,wid2)],accountId,now).records[0];
  assert.equal(observedDurations(next).placeSince,legacy.observedAt);
  assert.equal(observedDurations(next).place,3600000);
  // A newer observation from an upgraded device still keeps its valid origins.
  const synced=mergeRecord(normalizeRecord('friends',next),normalizeRecord('friends',merged)).value;
  assert.equal(observedDurations(synced).placeSince,legacy.observedAt);
});
test('exportable continuity origins use the same validated values as displayed durations',()=>{
  const f={...state(5000),stateFirstObservedAt:4000,extensions:{'vrc.activity':{
    observedAt:5000,presenceSince:1e100,placeSince:'not a timestamp',instanceSince:-20}}};
  const d=observedDurations(f);
  assert.equal(d.since,4000);assert.equal(d.placeSince,4000);assert.equal(d.instanceSince,4000);
  assert.equal(d.presence,1000);assert.equal(d.place,1000);assert.equal(d.instance,1000);
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
test('timeline search matches the current display name after a rename',()=>{
  const old=state(10000),current={...state(20000),displayName:'Renamed'};
  const events=[{userId:uid,displayName:old.displayName,observedAt:10000,current:old,kind:'first'}];
  const model=buildActivityTimeline([current],events,[],{now:30000,query:'renamed'});
  assert.equal(model.rows.length,1);assert.equal(model.rows[0].name,'Renamed');
});
test('unknown-only observations do not count as recorded activity',()=>{
  const unknown={...state(10000),presence:'unknown',location:{kind:'unknown',worldId:'',instanceId:''}};
  assert.equal(buildActivityTimeline([unknown],[],[],{now:20000,filter:'active'}).rows.length,0);
  assert.equal(buildActivityTimeline([unknown],[],[],{now:20000,filter:'all'}).rows.length,1);
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

test('the v0.4.0 proposal keeps v0.3.2 backups and storage schema usable',async()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(fs.readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
  const manifest=JSON.parse(fs.readFileSync(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  const {VERSION}=await import('../extension/core.js');
  const {validateSettingsBackup}=await import('../extension/settings-backup.js');
  assert.equal(pkg.version,'0.4.0');
  assert.equal(pkg.version,lock.version);
  assert.equal(pkg.version,lock.packages[''].version);
  assert.equal(pkg.version,manifest.version);
  assert.equal(pkg.version,VERSION);
  const previousBackup={format:'vrc-gathering-settings',schema:1,appVersion:'0.3.2',exportedAt:'2026-10-24T00:00:00Z',
    settings:{collection:{contact:'https://github.com/example',pollSeconds:180,retentionDays:30,offlineRefreshMinutes:60},
      sync:{enabled:false,endpoint:''},images:{enabled:false}}};
  assert.equal(validateSettingsBackup(previousBackup).appVersion,'0.3.2');
  const dbSource=fs.readFileSync(new URL('../extension/db.js',import.meta.url),'utf8');
  const syncSource=fs.readFileSync(new URL('../extension/sync-format.js',import.meta.url),'utf8');
  assert.ok(dbSource.includes("indexedDB.open('vrc-friends-observer', 2)"));
  assert.match(syncSource,/export const RECORD_SCHEMA = 2;/);
  assert.match(syncSource,/export const SYNC_PROTOCOL = 2;/);
});

test('A/B/C initial navigation does not overlay the v0.3.2 friends list or remove settings backup',()=>{
  const html=fs.readFileSync(new URL('../extension/dashboard.html',import.meta.url),'utf8');
  const script=fs.readFileSync(new URL('../extension/dashboard.js',import.meta.url),'utf8');
  const blocks=[...html.matchAll(/<section id="(home|analytics|friends|ranking|journey|history|settings|help)Panel"[^>]*>/g)];
  assert.equal(blocks.length,8);
  assert.deepEqual(blocks.filter(item=>!item[0].includes('hidden')).map(item=>item[1]),['home']);
  for(const name of ['friends','ranking','journey','history','settings','help'])
    assert.ok(html.includes('data-tab="'+name+'"'));
  for(const id of ['exportSettings','importSettings','settingsImportDialog','syncEndpoint','journeyPanel','activityWorld'])
    assert.ok(html.includes('id="'+id+'"'));
  assert.ok(script.includes('initializeSettingsBackup('));
  assert.ok(script.includes("'activityRange','activityFilter','activityWorld'"));
  assert.ok(script.includes('worldId:worldSelect.value'));
});

test('world filter includes only users observed in the selected world, not users in private state only',async()=>{
  const {demoData}=await import('../extension/demo.js');
  const demo=demoData();
  const chosen='wrld_demoobservatory';
  const model=buildActivityTimeline(demo.friends,demo.events,demo.worlds,{now:Date.now(),rangeMs:86400000,worldId:chosen});
  assert.ok(model.rows.length>0);
  assert.ok(model.rows.every(row=>row.segments.some(s=>s.worldId===chosen) ||
    row.points.some(p=>p.state.location?.worldId===chosen)));
});
