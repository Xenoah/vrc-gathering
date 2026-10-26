import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { createSettingsBackup } from '../extension/settings-backup.js';
import { gasHarness,TOKEN } from './helpers/gas.mjs';
const root=new URL('../extension/',import.meta.url);
const uid='usr_01234567-1111-2222-3333-012345678901',fid='usr_11111111-1111-2222-3333-012345678901',wid='wrld_01234567-1111-2222-3333-012345678901';
const owner={id:uid,displayName:'テスト本人',friends:[fid],onlineFriends:[fid],offlineFriends:[],activeFriends:[],authToken:'SECRET_AUTH',email:'SECRET_MAIL'};
const online={id:fid,displayName:'架空フレンド',status:'active',location:wid+':123~region(jp)',authToken:'SECRET_AUTH',friendKey:'SECRET_KEY'};

async function harness(handler, allowCloud = true){
  let now=Date.UTC(2026,9,24),closed=false;
  const events={},store={},alarms=new Map(),saved={friends:[],events:[],worlds:[],runs:[],images:[],visits:[],encounters:[],research:[]},calls=[];
  const hook=name=>({addListener:fn=>{events[name]=fn;}});
  const storage={
    get:async key=>{const keys=Array.isArray(key)?key:[key];return structuredClone(Object.fromEntries(keys.filter(k=>k in store).map(k=>[k,store[k]])));},
    set:async values=>Object.assign(store,structuredClone(values)),setAccessLevel:async()=>{}
  };
  const scripts=new Map(),tabRows=new Map();let nextTabId=100;
  const tabs={create:async opts=>{const tab={id:++nextTabId,status:'loading',...opts};tabRows.set(tab.id,tab);return tab;},get:async id=>{if(!tabRows.has(id))throw Error('closed');return {...tabRows.get(id)};},query:async()=>[...tabRows.values()],remove:async id=>{tabRows.delete(id);},sendMessage:async()=>({ok:true}),onUpdated:hook('tabUpdated'),onRemoved:hook('tabRemoved')};
  const chrome={scripting:{getRegisteredContentScripts:async()=>[...scripts.values()],registerContentScripts:async rows=>rows.forEach(r=>scripts.set(r.id,r)),updateContentScripts:async rows=>rows.forEach(r=>scripts.set(r.id,r)),unregisterContentScripts:async({ids})=>ids.forEach(id=>scripts.delete(id))},permissions:{contains:async()=>allowCloud},storage:{local:storage},alarms:{create:async(n,v)=>alarms.set(n,v),get:async n=>alarms.get(n),clear:async n=>alarms.delete(n),onAlarm:hook('alarm')},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:hook('click')},
    runtime:{id:'testextension',getURL:p=>'chrome-extension://testextension/'+p,onMessage:hook('message'),onInstalled:hook('installed'),onStartup:hook('startup')},
    declarativeNetRequest:{updateDynamicRules:async v=>{saved.rules=v;}},tabs};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({chrome,console,navigator:{userAgent:'TestChrome'},Date:Clock,Math,URL,crypto,TextEncoder,AbortController,AbortSignal,DOMException,
    setTimeout:(fn,ms)=>{now+=ms;queueMicrotask(fn);return 1;},clearTimeout:()=>{},
    fetch:async(url,options)=>{if(closed)throw Error('closed');now+=50;calls.push({url,options,at:now});
      const response=await handler(new URL(url),calls.length,options);return {ok:(response.status||200)<300,status:response.status||200,type:response.type||'basic',headers:new Headers({'Content-Type':'application/json',...(response.headers||{})}),json:async()=>structuredClone(response.body)};}});
  const saveResearch=records=>{for(const r of records){saved.research=saved.research.filter(v=>v.key!==r.key);saved.research.push(structuredClone(r));}};
  const dbExports={activeSeries:async id=>structuredClone(saved.research.filter(r=>r.value.accountId===id&&r.value.endedAt===null)),researchKind:async(kind,id)=>structuredClone(saved.research.filter(r=>r.kind===kind&&(!id||r.value.accountId===id))),exportAccount:async accountId=>Object.fromEntries(['segments','crowd','coverage','followerHistory','worlds'].map(kind=>[kind,saved.research.filter(r=>r.kind===kind&&r.value.accountId===accountId).map(r=>r.value)])),mergeArchiveRecords:async()=>{},list:async(name,id)=>structuredClone(saved[name].filter(v=>v.accountId===id)),
    commit:async(f,e,w,r,connections={visits:[],encounters:[]},research=[])=>{saveResearch(research);for(const v of f){saved.friends=saved.friends.filter(x=>!(x.accountId===v.accountId&&x.id===v.id));saved.friends.push(structuredClone(v));}saved.events.push(...structuredClone(e));saved.worlds.push(...structuredClone(w));if(r){saved.runs=saved.runs.filter(v=>v.accountId!==r.accountId||v.startedAt!==r.startedAt);saved.runs.push(structuredClone(r));}for(const kind of ['visits','encounters'])for(const v of connections[kind]){saved[kind]=saved[kind].filter(x=>!(x.accountId===v.accountId&&x.startedAt===v.startedAt&&x.userId===v.userId));saved[kind].push(structuredClone(v));}},
    exportSyncRecords:async()=>[],mergeSyncRecords:async records=>saveResearch(records),enqueueImages:async(accountId,images)=>{saved.images.push(...images.filter(Boolean).map(v=>({...v,accountId})));},cachedImages:async()=>[],updateCachedImage:async()=>{},trimImageCache:async()=>{},clearImageCache:async()=>{saved.images=[];},prune:async()=>{},clearAll:async()=>{for(const k of ['friends','events','worlds','runs','visits','encounters','research'])saved[k]=[];}};
  const db=new vm.SyntheticModule(Object.keys(dbExports),function(){for(const[k,v]of Object.entries(dbExports))this.setExport(k,v);},{context});
  const core=new vm.SourceTextModule(await fs.readFile(new URL('core.js',root),'utf8'),{context});await core.link(()=>{});
  const format=new vm.SourceTextModule(await fs.readFile(new URL('sync-format.js',root),'utf8'),{context});await format.link(()=>{});
  const sync=new vm.SourceTextModule(await fs.readFile(new URL('sync.js',root),'utf8'),{context});await sync.link(()=>format);
  const images=new vm.SourceTextModule(await fs.readFile(new URL('image-cache.js',root),'utf8'),{context});await images.link(()=>{});
  const followerSettings=new vm.SourceTextModule(await fs.readFile(new URL('x-follower-settings.js',root),'utf8'),{context});await followerSettings.link(()=>{});
  const backup=new vm.SourceTextModule(await fs.readFile(new URL('settings-backup.js',root),'utf8'),{context});await backup.link(spec=>spec==='./core.js'?core:spec==='./x-follower-settings.js'?followerSettings:sync);
  const connections=new vm.SourceTextModule(await fs.readFile(new URL('connections.js',root),'utf8'),{context});await connections.link(()=>{});
  const xProfiles=new vm.SourceTextModule(await fs.readFile(new URL('x-profile.js',root),'utf8'),{context});await xProfiles.link(()=>{});
  const followers=new vm.SourceTextModule(await fs.readFile(new URL('x-followers.js',root),'utf8'),{context});await followers.link(spec=>spec==='./sync-format.js'?format:xProfiles);
  const followerQueue=new vm.SourceTextModule(await fs.readFile(new URL('x-follower-collector.js',root),'utf8'),{context});await followerQueue.link(spec=>spec==='./x-followers.js'?followers:spec==='./x-follower-settings.js'?followerSettings:xProfiles);
  const discovery=new vm.SourceTextModule(await fs.readFile(new URL('x-friend-discovery.js',root),'utf8'),{context});await discovery.link(spec=>spec==='./x-profile.js'?xProfiles:followerSettings);
  const series=new vm.SourceTextModule(await fs.readFile(new URL('observation-series.js',root),'utf8'),{context});await series.link(()=>format);
  const research=new vm.SourceTextModule(await fs.readFile(new URL('research-model.js',root),'utf8'),{context});await research.link(spec=>spec==='./sync-format.js'?format:series);
  const instancePresence=new vm.SourceTextModule(await fs.readFile(new URL('instance-presence.js',root),'utf8'),{context});await instancePresence.link(spec=>spec==='./core.js'?core:spec==='./sync-format.js'?format:series);
  const notes=new vm.SourceTextModule(await fs.readFile(new URL('user-notes.js',root),'utf8'),{context});await notes.link(()=>format);
  const bg=new vm.SourceTextModule(await fs.readFile(new URL('background.js',root),'utf8'),{context});
  await bg.link(spec=>spec==='./core.js'?core:spec==='./sync-format.js'?format:spec==='./sync.js'?sync:spec==='./image-cache.js'?images:spec==='./settings-backup.js'?backup:spec==='./connections.js'?connections:spec==='./x-profile.js'?xProfiles:spec==='./x-followers.js'?followers:spec==='./x-follower-collector.js'?followerQueue:spec==='./x-friend-discovery.js'?discovery:spec==='./observation-series.js'?series:spec==='./research-model.js'?research:spec==='./user-notes.js'?notes:spec==='./instance-presence.js'?instancePresence:spec==='./x-follower-settings.js'?followerSettings:db);await bg.evaluate();
  async function flush(){for(let i=0;i<15;i++)await new Promise(setImmediate);}
  await flush();
  const command=message=>new Promise(resolve=>events.message(message,{id:'testextension',url:'chrome-extension://testextension/dashboard.html'},resolve));
  const start=async()=>{assert.equal((await command({type:'SAVE',settings:{contact:'https://github.com/example'}})).ok,true);await command({type:'START'});await flush();};
  return {store,saved,calls,alarms,scripts,tabRows,command,start,flush,advance:ms=>{now+=ms;},stop:()=>{closed=true;},events};
}
const good=url=>({body:url.pathname.endsWith('/userNotes')?[]:url.pathname.includes('/users/')?{id:fid,displayName:online.displayName,note:''}:url.pathname.endsWith('/auth/user')?owner:url.pathname.endsWith('/friends')?(url.searchParams.get('offline')==='true'?[]:[online]):{id:wid,name:'架空ワールド',capacity:16,unityPackages:[{assetUrl:'SECRET_ASSET'}]}});

test('log import requires a known owner and reset epoch; invalid batches write nothing and need no API',async()=>{
  const h=await harness(good);h.store.accountMeta={[uid]:{displayName:'Fixture'}};
  const at=Date.UTC(2026,9,23),value={accountId:uid,id:'a'.repeat(64)+'_2',sourceId:'log_'+'a'.repeat(64),source:'vrchat-output-log',device:'pc',userId:fid,displayName:'Fixture visitor',location:{kind:'world',worldId:wid,instanceId:'123~nonce(SECRET)',access:'public',region:''},worldName:'Fixture',startedAt:at,lastSeenAt:at+60000,endedAt:null,observedAt:at+60000,endReason:'',accountBinding:'selected',raw:'SECRET'};
  const context=await h.command({type:'LOG_CONTEXT',accountId:uid});assert.equal(context.epoch,0);
  const command=records=>h.command({type:'IMPORT_LOG_ENCOUNTERS',accountId:uid,epoch:context.epoch,records});
  assert.equal((await command([value])).ok,true);assert.equal(h.saved.research.length,1);assert.ok(!JSON.stringify(h.saved.research).includes('SECRET'));assert.equal(h.calls.length,0);
  assert.equal((await command([value,{...value,accountId:'usr_other000001'}])).ok,false);assert.equal(h.saved.research.length,1);
  assert.equal((await command(Array(101).fill(value))).ok,false);assert.equal((await h.command({type:'LOG_CONTEXT',accountId:'usr_other000001'})).ok,false);
  let answered=false;assert.equal(h.events.message({type:'IMPORT_LOG_ENCOUNTERS',accountId:uid,epoch:0,records:[value]},{id:'testextension',url:'https://vrchat.com/'},()=>{answered=true;}),false);assert.equal(answered,false);
  await h.command({type:'CLEAR'});assert.equal(h.store.logImportEpoch,1);assert.equal((await command([value])).ok,false);assert.equal(h.saved.research.length,0);assert.equal(h.calls.length,0);h.stop();
});

test('In Instance collects only the fresh own location, including nonfriends, and keeps unavailable observations separate',async()=>{
  const peer='usr_instancepeer0001',place=wid+':123~region(jp)';let available=true;
  const h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:{...owner,location:place}}:url.pathname.includes('/instances/')?{body:{id:place,userCount:2,...(available?{users:[{id:uid,displayName:'Self'},{id:peer,displayName:'Nonfriend',authToken:'SECRET'}]}:{})}}:good(url));
  try{await h.start();const rows=()=>h.saved.research.filter(r=>r.kind==='instanceEncounters');assert.equal(rows().length,1);assert.equal(rows()[0].value.userId,peer);assert.equal(h.saved.friends.some(r=>r.id===peer),false);assert.equal(h.store.instanceCollectionState.available,true);assert.ok(!JSON.stringify(rows()).includes('SECRET'));
    h.advance(180000);await h.command({type:'POLL'});await h.flush();assert.equal(rows().length,1);assert.equal(rows()[0].value.sampleCount,2);const last=rows()[0].value.lastSeenAt;
    available=false;h.advance(180000);await h.command({type:'POLL'});await h.flush();assert.equal(rows()[0].value.endedAt,last);assert.equal(rows()[0].value.endReason,'unavailable');assert.equal(h.store.instanceCollectionState.available,false);
    const calls=h.calls.filter(c=>c.url.includes('/instances/'));assert.equal(calls.length,3);assert.ok(calls.every(c=>decodeURIComponent(c.url).endsWith(place)&&c.options.method==='GET'));
  }finally{h.stop();}
});
test('In Instance rejects a changed account/location and respects server backoff without exploring friend instances',async()=>{
  for(const mode of ['account','location','429','403']){
    let fetched=false;const place=wid+':123',h=await harness(url=>{
      if(url.pathname.endsWith('/auth/user'))return {body:{...owner,id:fetched&&mode==='account'?'usr_otherowner001':uid,location:fetched&&mode==='location'?wid+':456':place}};
      if(url.pathname.includes('/instances/')){fetched=true;return mode==='429'||mode==='403'?{status:Number(mode),headers:{'Retry-After':'3600'}}:{body:{id:place,userCount:2,users:[{id:uid,displayName:'Self'},{id:fid,displayName:'Friend'}]}};}
      return good(url);
    });
    try{await h.start();assert.equal(h.saved.research.filter(r=>r.kind==='instanceEncounters').length,0);assert.equal(h.calls.filter(c=>c.url.includes('/instances/')).length,1);
      if(mode==='account')assert.equal(h.saved.friends.length,0);
      if(mode==='429'){const count=h.calls.length;await h.command({type:'POLL'});await h.flush();assert.equal(h.calls.length,count);assert.ok(h.store.state.cooldownUntil);}
      if(mode==='403')assert.equal(h.store.state.phase,'ready');
    }finally{h.stop();}
  }
});

test('manual own-instance collection works while paused, initializes the account and never scans friends or another location',async()=>{
  const peer='usr_instancepeer0001',place=wid+':123~region(jp)';let available=true;
  const h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:{...owner,location:place+'~nonce(SECRET_NONCE)'}}:url.pathname.includes('/instances/')?{body:{location:place,userCount:3,...(available?{users:[{id:uid,displayName:'Self'},{id:fid,displayName:'Friend'},{id:peer,displayName:'Nonfriend'}]}:{}),world:{id:wid,name:'Own world',capacity:16,assetUrl:'SECRET'}}}:good(url));
  try{
    await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});
    const command={type:'COLLECT_OWN_INSTANCE',accountId:uid,location:wid+':999'};
    const result=await h.command(command);assert.equal(result.ok,true);assert.equal(result.instance.users.length,2);assert.equal(result.instance.users.find(u=>u.id===peer).isFriend,false);
    assert.equal(h.store.settings.enabled,false);assert.equal(h.saved.friends.length,0);assert.equal(h.saved.runs.length,0);assert.equal(h.saved.visits.length,1);assert.equal(h.saved.worlds[0].name,'Own world');assert.equal(h.saved.research.filter(r=>r.kind==='instanceEncounters').length,2);assert.equal(h.store.accountMeta[uid].displayName,owner.displayName);
    assert.equal(h.calls.length,3);assert.ok(h.calls.every(c=>c.url.endsWith('/auth/user')||decodeURIComponent(c.url).endsWith('/instances/'+place)));assert.ok(!JSON.stringify([h.saved,h.store.instanceCollectionState]).includes('SECRET'));
    const count=h.calls.length;assert.equal((await h.command(command)).ok,false);assert.equal(h.calls.length,count);
    h.advance(180000);await h.command(command);assert.equal(h.saved.visits.length,1);assert.equal(h.saved.research.filter(r=>r.kind==='instanceEncounters').length,2);assert.equal(h.saved.research.find(r=>r.kind==='instanceEncounters').value.sampleCount,2);
    available=false;h.advance(180000);const missing=await h.command(command);assert.equal(missing.ok,true);assert.equal(missing.instance.available,false);assert.equal(missing.instance.count,null);assert.equal(missing.instance.self.location.kind,'world');assert.equal(h.saved.visits.length,1);assert.ok(h.saved.research.filter(r=>r.kind==='instanceEncounters').every(r=>r.value.endReason==='unavailable'));
  }finally{h.stop();}
});

test('manual own collection records offline or unavailable rosters, rejects identity switches and preserves API backoff',async()=>{
  for(const mode of ['offline','private','403','500','account','location','wrong-selection','429']){
    let checked=0;const place=wid+':123',h=await harness(url=>{
      if(url.pathname.endsWith('/auth/user')){checked++;return {body:{...owner,id:mode==='account'&&checked>1?fid:uid,state:mode==='offline'?'offline':'online',location:['offline','private'].includes(mode)?mode:mode==='location'&&checked>1?wid+':456':place}};}
      if(url.pathname.includes('/instances/'))return ['403','500','429'].includes(mode)?{status:Number(mode),headers:{'Retry-After':mode==='429'?'3600':''}}:{body:{location:place,userCount:2,users:[{id:uid,displayName:'Self'},{id:fid,displayName:'Friend'}]}};
      throw Error('Unexpected path');
    });
    try{
      await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});const command={type:'COLLECT_OWN_INSTANCE',accountId:mode==='wrong-selection'?fid:uid},result=await h.command(command);
      assert.equal(result.ok,!['account','wrong-selection','429'].includes(mode),mode);assert.equal(h.saved.research.filter(r=>r.kind==='instanceEncounters').length,0,mode);
      if(['account','wrong-selection','429'].includes(mode))assert.equal(h.saved.visits.length,0);else assert.ok(h.saved.visits.length>0);
      if(['offline','private','wrong-selection'].includes(mode))assert.equal(h.calls.filter(c=>c.url.includes('/instances/')).length,0);
      if(mode==='429'){assert.ok(h.store.state.cooldownUntil);h.advance(61000);const count=h.calls.length;assert.equal((await h.command(command)).ok,false);assert.equal(h.calls.length,count);}
      if(mode==='location')assert.equal(h.saved.visits.at(-1).location.instanceId,'456');
    }finally{h.stop();}
  }
});

test('manual own collection is serialized with polling and discards an aborted request on reset',async()=>{
  let release;const h=await harness(async url=>url.pathname.endsWith('/auth/user')?{body:await new Promise(resolve=>{release=()=>resolve({...owner,location:wid+':123'});})}:good(url));
  try{await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});const pending=h.command({type:'COLLECT_OWN_INSTANCE',accountId:uid});await h.flush();
    assert.equal((await h.command({type:'COLLECT_OWN_INSTANCE',accountId:uid})).busy,true);const reset=h.command({type:'CLEAR'});await h.flush();release();assert.equal((await pending).ok,false);assert.equal((await reset).ok,true);assert.equal(h.saved.visits.length,0);assert.equal(h.saved.research.length,0);
  }finally{h.stop();}
});

test('ordinary collection discovers an own location that becomes available after the first identity check',async()=>{
  let identities=0;const place=wid+':123',h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:{...owner,...(++identities>1?{location:place}:{})}}:url.pathname.includes('/instances/')?{body:{location:place,userCount:2,users:[{id:uid,displayName:'Self'},{id:fid,displayName:'Friend'}]}}:good(url));
  try{await h.start();assert.equal(h.store.instanceCollectionState.available,true);assert.equal(h.store.instanceCollectionState.self.location.instanceId,'123');assert.equal(h.saved.research.filter(r=>r.kind==='instanceEncounters').length,1);assert.equal(h.saved.visits.at(-1).location.instanceId,'123');}finally{h.stop();}
});

test('full cycle stores normalized observations, GET-only, credentials handled by browser',async()=>{
  const h=await harness(good);await h.start();
  assert.equal(h.store.state.phase,'ready');assert.equal(h.saved.friends.length,1);assert.equal(h.saved.events.length,1);
  assert.equal(h.saved.friends[0].location.worldId,wid);assert.equal(h.saved.worlds[0].name,'架空ワールド');
  assert.ok(!JSON.stringify(h.saved).includes('SECRET_'));
  for(const call of h.calls){assert.equal(call.options.method,'GET');assert.equal(call.options.credentials,'include');assert.equal(call.options.redirect,'manual');}
  for(let i=1;i<h.calls.length;i++)assert.ok(h.calls[i].at-h.calls[i-1].at>=2200);
  assert.ok(h.alarms.has('vrc-observer-next'));h.stop();
});
test('401 pauses collection without overwriting earlier observations',async()=>{
  const h=await harness(()=>({status:401}));await h.start();assert.equal(h.store.settings.enabled,false);assert.equal(h.store.state.phase,'attention');
  assert.equal(h.saved.friends.length,0);assert.ok(!h.alarms.has('vrc-observer-next'));assert.equal(h.calls.length,1);h.stop();
});
test('429 cooldown survives pause/start and deleting data, with no extra HTTP requests',async()=>{
  const h=await harness(()=>({status:429,headers:{'Retry-After':'86400'}}));await h.start();
  const cooldown=h.store.state.cooldownUntil;assert.equal(h.store.state.phase,'waiting');assert.equal(h.calls.length,1);
  await h.command({type:'PAUSE'});await h.command({type:'START'});await h.flush();assert.equal(h.calls.length,1);
  await h.command({type:'CLEAR'});assert.equal(h.store.state.cooldownUntil,cooldown);
  await h.command({type:'START'});await h.flush();assert.equal(h.calls.length,1);h.stop();
});
test('account switches discard a full staged cycle and disable collection',async()=>{
  let identities=0;const h=await harness(url=>{if(url.pathname.endsWith('/auth/user'))return{body:++identities===1?owner:{...owner,id:'usr_22222222-1111-2222-3333-012345678901'}};return good(url);});
  await h.start();assert.equal(h.saved.friends.length,0);assert.equal(h.saved.events.length,0);assert.equal(h.store.settings.enabled,false);assert.match(h.store.state.message,/切り替わり/);h.stop();
});
test('mid-pagination failure commits no partial offline history',async()=>{
  const many=Array.from({length:100},(_,i)=>({...online,id:'usr_testfriend'+String(i).padStart(5,'0')}));
  const h=await harness(url=>url.pathname.endsWith('/friends')?(url.searchParams.get('offset')==='0'?{body:many}:{status:500}):good(url));
  await h.start();assert.equal(h.saved.friends.length,0);assert.equal(h.saved.runs.length,0);assert.equal(h.store.state.phase,'waiting');h.stop();
});
test('websites cannot send collection commands',async()=>{
  const h=await harness(good);let response=false;
  assert.equal(h.events.message({type:'START'},{id:'testextension',url:'https://vrchat.com/'},()=>{response=true;}),false);
  await h.flush();assert.equal(response,false);assert.equal(h.calls.length,0);h.stop();
});
test('immediate pause/restart respects minimum cycle interval',async()=>{
  const h=await harness(good);await h.start();const calls=h.calls.length;
  await h.command({type:'PAUSE'});await h.command({type:'START'});await h.flush();assert.equal(h.calls.length,calls);h.stop();
});

test('cloud configuration requires optional Google permissions and cannot alter collection settings',async()=>{
  const h=await harness(good,false);
  const response=await h.command({type:'SAVE_SYNC',settings:{enabled:true,endpoint:'https://script.google.com/macros/s/test/exec',token:'test_token_0123456789_abcdefghijklmnopqrstuvwxyz'}});
  assert.equal(response.ok,false);assert.match(response.error,/権限/);assert.equal(h.store.cloudSync,undefined);assert.equal(h.calls.length,0);h.stop();
});
test('cloud setup schedules sync, uses no VRChat cookies, and clearing local records disables sync',async()=>{
  const h=await harness((url,n,options)=>({body:JSON.parse(options.body).action==='hello'?{protocol:2,ok:true,datasetId:'test',protocols:[1,2],recordSchemas:[1,2],operations:['upsert'],kinds:['friends','events','worlds','runs','accounts','visits','encounters','profiles','xFollowers','segments','crowd','coverage','followerHistory','annotations','views','reports','userNotes','userNoteHistory','instanceEncounters'],retentionDays:0,maxBatch:100}:{protocol:2,ok:true,datasetId:'test',records:[],cursor:0,hasMore:false}}));
  const response=await h.command({type:'SAVE_SYNC',settings:{enabled:true,endpoint:'https://script.google.com/macros/s/test/exec',token:'test_token_0123456789_abcdefghijklmnopqrstuvwxyz'}});
  assert.equal(response.ok,true);await h.flush();assert.equal(h.store.cloudState.phase,'ready');
  assert.equal(h.calls.length,2);assert.equal(h.calls[0].options.credentials,'omit');assert.equal(h.calls[0].options.method,'POST');
  assert.ok(h.alarms.has('vrc-observer-cloud'));
  await h.command({type:'CLEAR'});assert.equal(h.store.cloudSync.enabled,false);assert.ok(!h.alarms.has('vrc-observer-cloud'));
  h.events.alarm({name:'vrc-observer-cloud'});await h.flush();assert.equal(h.calls.length,2);h.stop();
});

test('image collection is opt-in and candidates are queued only after the account check',async()=>{
  const source='https://api.vrchat.cloud/api/1/file/file_01234567-abcd-1234-abcd-012345678901/1/file';
  const handler=url=>{const response=good(url);if(Array.isArray(response.body))response.body=response.body.map(v=>({...v,userIcon:source}));else if(response.body.id===wid)response.body={...response.body,thumbnailImageUrl:source};return response;};
  const h=await harness(handler);await h.command({type:'SAVE_IMAGES',enabled:true});await h.start();
  assert.equal(h.saved.images.length,2);assert.ok(h.saved.images.every(r=>r.accountId===uid));assert.ok(!JSON.stringify(h.saved.friends).includes(source));
  await h.command({type:'CLEAR_IMAGES'});assert.equal(h.saved.images.length,0);h.stop();
  let identities=0;const switched=await harness(url=>url.pathname.endsWith('/auth/user')?{body:++identities===1?owner:{...owner,id:'usr_otheraccount0001'}}:handler(url));
  await switched.command({type:'SAVE_IMAGES',enabled:true});await switched.start();assert.equal(switched.saved.images.length,0);switched.stop();
  const denied=await harness(good,false);assert.equal((await denied.command({type:'SAVE_IMAGES',enabled:true})).ok,false);assert.equal(denied.store.imageCacheSettings,undefined);denied.stop();
});

test('connection test command uses saved settings and performs one hello without enabling sync',async()=>{
  const hello={protocol:2,ok:true,datasetId:'test',protocols:[1,2],recordSchemas:[1,2],operations:['upsert'],kinds:['friends','events','worlds','runs','accounts','visits','encounters','profiles','xFollowers','segments','crowd','coverage','followerHistory','annotations','views','reports','userNotes','userNoteHistory','instanceEncounters'],retentionDays:0,maxBatch:100};
  const h=await harness(()=>({body:hello}));
  await h.command({type:'SAVE_SYNC',settings:{enabled:false,endpoint:'https://script.google.com/macros/s/test/exec',token:'test_token_0123456789_abcdefghijklmnopqrstuvwxyz'}});
  assert.equal(h.calls.length,0);const response=await h.command({type:'TEST_SYNC'});assert.equal(response.connected,true);assert.equal(h.calls.length,1);
  assert.equal(JSON.parse(h.calls[0].options.body).action,'hello');assert.equal(h.calls[0].options.credentials,'omit');assert.equal(h.store.cloudSync.enabled,false);
  assert.equal(h.store.cloudDiagnostic.responseCode,'OK');assert.equal(h.store.cloudCheckpoint.cursor,0);h.stop();
});
test('manual sync, diagnostics, saving the key and local clearing cannot shorten a server Retry-After',async()=>{
  const h=await harness(()=>({status:429,headers:{'Retry-After':'3600'}})),settings={enabled:true,endpoint:'https://script.google.com/macros/s/test/exec',token:'test_token_0123456789_abcdefghijklmnopqrstuvwxyz'};
  await h.command({type:'SAVE_SYNC',settings});await h.flush();const deadline=h.store.cloudState.serverRetryAt;assert.ok(deadline);const count=h.calls.length;
  assert.equal((await h.command({type:'TEST_SYNC'})).retryAt,deadline);assert.equal((await h.command({type:'SYNC',force:true})).retrySource,'server');
  await h.command({type:'SAVE_SYNC',settings:{...settings,token:'changed_token_0123456789_abcdefghijklmnopqrstuvwxyz'}});await h.flush();assert.equal(h.store.cloudState.serverRetryAt,deadline);assert.equal(h.calls.length,count);
  await h.command({type:'CLEAR'});assert.equal(h.store.cloudState.serverRetryAt,deadline);assert.equal(h.store.cloudSync.enabled,false);h.stop();
});
test('a connection test with missing Google permission does not call fetch',async()=>{
  const h=await harness(good,false);await h.command({type:'SAVE_SYNC',settings:{enabled:false,endpoint:'https://script.google.com/macros/s/test/exec',token:'test_token_0123456789_abcdefghijklmnopqrstuvwxyz'}});
  const response=await h.command({type:'TEST_SYNC'});assert.equal(response.diagnostic.responseCode,'PERMISSION');assert.equal(h.calls.length,0);h.stop();
});

test('settings import pauses collection, preserves observations and cooldowns, and restores all preferences',async()=>{
  const h=await harness(good);await h.start();const records=JSON.stringify(h.saved.friends), count=h.calls.length;
  const endpoint='https://script.google.com/macros/s/test/exec',token='backup_test_key_0123456789_abcdefghijklmnopqrstuvwxyz';
  h.store.cloudSync={enabled:true,endpoint,token};h.store.cloudState={serverRetryAt:Date.now()+86400000,retryAt:Date.now()+86400000};
  h.store.cloudCheckpoint={cursor:71,receipts:{retained:1}};h.store.state.cooldownUntil=Date.now()+86400000;
  const deadline=h.store.cloudState.serverRetryAt,cooldown=h.store.state.cooldownUntil;
  const backup=createSettingsBackup({settings:{contact:'https://github.com/restored',pollSeconds:600,retentionDays:7,offlineRefreshMinutes:180},cloudSync:h.store.cloudSync,imageCacheSettings:{enabled:true}});
  const result=await h.command({type:'IMPORT_SETTINGS',backup});await h.flush();
  assert.equal(result.ok,true);assert.equal(h.store.settings.enabled,false);assert.equal(h.store.settings.contact,'https://github.com/restored');assert.equal(h.store.settings.pollSeconds,600);
  assert.equal(h.store.cloudSync.token,token);assert.equal(h.store.cloudSync.enabled,true);assert.equal(h.store.imageCacheSettings.enabled,true);
  assert.equal(h.store.cloudCheckpoint.cursor,71);assert.equal(h.store.cloudState.serverRetryAt,deadline);assert.equal(h.store.state.cooldownUntil,cooldown);
  assert.equal(JSON.stringify(h.saved.friends),records);assert.equal(h.calls.length,count);assert.ok(!h.alarms.has('vrc-observer-next'));
  assert.ok(h.alarms.has('vrc-observer-cloud'));assert.ok(h.alarms.has('vrc-observer-images'));h.stop();
});
test('invalid imports and denied permissions change no settings or records',async()=>{
  const h=await harness(good,false);await h.start();const before=JSON.stringify(h.store),records=JSON.stringify(h.saved.friends);
  const invalid=createSettingsBackup({});invalid.settings.collection.retentionDays=0;
  assert.equal((await h.command({type:'IMPORT_SETTINGS',backup:invalid})).ok,false);
  const denied=createSettingsBackup({imageCacheSettings:{enabled:true}});
  assert.equal((await h.command({type:'IMPORT_SETTINGS',backup:denied})).ok,false);
  assert.equal(JSON.stringify(h.store),before);assert.equal(JSON.stringify(h.saved.friends),records);h.stop();
});
test('importing another endpoint without a key disables sync and resets only its checkpoint',async()=>{
  const h=await harness(good);
  h.store.cloudSync={enabled:true,endpoint:'https://script.google.com/macros/s/old/exec',token:'old_test_key_0123456789_abcdefghijklmnopqrstuvwxyz'};
  h.store.cloudCheckpoint={cursor:99,receipts:{old:1}};
  const backup=createSettingsBackup({cloudSync:{enabled:true,endpoint:'https://script.google.com/macros/s/new/exec'}});
  const response=await h.command({type:'IMPORT_SETTINGS',backup});
  assert.equal(response.ok,true);assert.equal(response.needsToken,true);assert.equal(h.store.cloudSync.token,'');assert.equal(h.store.cloudSync.enabled,false);
  assert.equal(h.store.cloudCheckpoint.cursor,0);assert.ok(!h.alarms.has('vrc-observer-cloud'));assert.equal(h.calls.length,0);h.stop();
});

test('self visits and same-instance evidence commit with friends without adding self to rankings',async()=>{
  const handler=url=>url.pathname.endsWith('/auth/user')?{body:{...owner,state:'online',location:wid+':123~region(jp)',homeLocation:'wrld_notcurrent0001'}}:good(url);
  const h=await harness(handler);await h.start();
  assert.equal(h.saved.visits.length,1);assert.equal(h.saved.encounters.length,1);
  assert.equal(h.saved.visits[0].accountId,uid);assert.equal(h.saved.encounters[0].userId,fid);assert.equal(h.saved.encounters[0].relation,'instance');
  assert.equal(h.saved.friends.length,1);assert.ok(!JSON.stringify(h.saved).includes('SECRET_'));
  h.advance(180000);await h.command({type:'POLL'});await h.flush();
  assert.equal(h.saved.encounters.length,1);assert.ok(h.saved.encounters[0].lastSeenAt>h.saved.encounters[0].startedAt);
  await h.command({type:'CLEAR'});assert.equal(h.saved.visits.length,0);assert.equal(h.saved.encounters.length,0);h.stop();
});
test('account changes discard own visits and all co-presence evidence as well as friend observations',async()=>{
  let count=0;
  const h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:{...owner,id:++count===1?uid:'usr_switchedaccount01',state:'online',location:wid+':123~region(jp)'}}:good(url));
  await h.start();assert.equal(h.saved.visits.length,0);assert.equal(h.saved.encounters.length,0);assert.equal(h.saved.friends.length,0);h.stop();
});

test('X profile lookup caches only explicit links without refreshing presence or collection state',async()=>{
  let links=['https://twitter.com/VRChat?source=vrc'];
  const h=await harness(url=>url.pathname.includes('/profile/')?{body:{id:fid,bioLinks:links,bio:'SECRET_BIO',email:'SECRET_EMAIL'}}:good(url));
  await h.start();await h.command({type:'PAUSE'});const before=JSON.stringify(h.saved),phase=h.store.state.phase;
  const result=await h.command({type:'X_PROFILE',accountId:uid,userId:fid});
  assert.equal(result.ok,true);assert.deepEqual([...result.profile.urls],['https://x.com/vrchat']);
  assert.equal(JSON.stringify(h.saved),before);assert.equal(h.store.state.phase,phase);assert.equal(h.store.settings.enabled,false);assert.ok(!h.alarms.has('vrc-observer-next'));
  assert.ok(!JSON.stringify(h.store.xProfileCache).includes('SECRET'));
  const count=h.calls.length;await h.command({type:'X_PROFILE',accountId:uid,userId:fid});await h.command({type:'X_PROFILE',accountId:uid,userId:fid,force:true});assert.equal(h.calls.length,count);
  h.advance(61000);links=[];const removed=await h.command({type:'X_PROFILE',accountId:uid,userId:fid,force:true});assert.deepEqual([...removed.profile.urls],[]);
  for(let i=1;i<h.calls.length;i++)assert.ok(h.calls[i].at-h.calls[i-1].at>=2200);
  assert.ok(h.calls.every(c=>c.options.method==='GET'));
  await h.command({type:'CLEAR'});assert.deepEqual(h.store.xProfileCache,{});h.stop();
});
test('X lookup rejects unknown IDs, a different login account, and a mismatched profile',async()=>{
  let changed=false,wrongProfile=false,missingFields=false;
  const h=await harness(url=>url.pathname.endsWith('/auth/user')&&changed?{body:{...owner,id:fid}}:url.pathname.includes('/profile/')?{body:{id:wrongProfile?uid:fid,...(!missingFields?{bioLinks:[]}:{})}}:good(url));
  await h.start();let count=h.calls.length;
  assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:'../../auth/user'})).ok,false);
  assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:'usr_unknown0001'})).ok,false);assert.equal(h.calls.length,count);
  changed=true;assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).ok,false);assert.ok(!h.calls.slice(count).some(c=>c.url.includes('/profile/')));
  changed=false;wrongProfile=true;assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).ok,false);
  wrongProfile=false;missingFields=true;assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).ok,false);assert.equal(h.store.xProfileCache,undefined);h.stop();
});
test('X lookup discards an account switch after fetching and honors Retry-After',async()=>{
  let mode='',identities=0,limitStatus=429;
  const h=await harness(url=>{
    if(mode==='switch'&&url.pathname.endsWith('/auth/user'))return{body:++identities===1?owner:{...owner,id:fid}};
    if(url.pathname.includes('/profile/'))return mode==='limit'?{status:limitStatus,headers:{'Retry-After':'86400'}}:{body:{id:fid,bioLinks:['https://x.com/example']}};
    return good(url);
  });
  await h.start();mode='switch';assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).ok,false);assert.equal(h.store.xProfileCache,undefined);
  mode='limit';for(const status of [429,503]){limitStatus=status;h.store.state.cooldownUntil=0;
    assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).ok,false);assert.ok(h.store.state.cooldownUntil);
    const count=h.calls.length;assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).ok,false);assert.equal(h.calls.length,count);
  }h.stop();
});
test('clearing data aborts an in-flight profile and prevents cache resurrection',async()=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const h=await harness(async url=>{if(url.pathname.includes('/profile/')){entered();await gate;return{body:{id:fid,bioLinks:['https://x.com/example']}};}return good(url);});
  await h.start();const fetching=h.command({type:'X_PROFILE',accountId:uid,userId:fid});await started;
  const clearing=h.command({type:'CLEAR'});await h.flush();
  assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).ok,false);
  release();assert.equal((await fetching).ok,false);assert.equal((await clearing).ok,true);
  assert.deepEqual(h.store.xProfileCache,{});assert.equal(h.saved.friends.length,0);h.stop();
});
test('scheduled collection waits for the profile lookup and uses the same rate-limit clock',async()=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const h=await harness(async url=>{if(url.pathname.includes('/profile/')){entered();await gate;return{body:{id:fid,bioLinks:[]}};}return good(url);});
  await h.start();h.advance(61000);const fetching=h.command({type:'X_PROFILE',accountId:uid,userId:fid});await started;
  const count=h.calls.length;h.events.alarm({name:'vrc-observer-next'});await h.flush();assert.equal(h.calls.length,count);
  release();assert.equal((await fetching).ok,true);await h.flush();assert.ok(h.saved.runs.length>=2);
  for(let i=1;i<h.calls.length;i++)assert.ok(h.calls[i].at-h.calls[i-1].at>=2200);h.stop();
});


test('the real worker exports and restores X profiles through the GAS sync adapter',async()=>{
  const gas=gasHarness();gas.properties.RETENTION_DAYS='0';
  const h=await harness((url,count,options)=>url.hostname==='script.google.com'?{body:gas.request(JSON.parse(options.body))}:url.pathname.includes('/profile/')?{body:{id:fid,bioLinks:['https://x.com/example'],bio:'SECRET_BIO'}}:good(url));
  await h.start();await h.command({type:'X_PROFILE',accountId:uid,userId:fid});await h.flush();
  h.store.cloudSync={enabled:true,endpoint:'https://script.google.com/macros/s/test_deployment/exec',token:TOKEN};
  const uploaded=await h.command({type:'SYNC',force:true});assert.equal(uploaded.ok,true);assert.equal(gas.table('VRCProfiles').length,2);
  assert.ok(!JSON.stringify(gas.table('VRCProfiles')).includes('SECRET_BIO'));
  h.store.xProfileCache={};h.store.cloudCheckpoint={cursor:0,receipts:{}};h.advance(61000);
  const restored=await h.command({type:'SYNC',force:true});assert.equal(restored.ok,true);
  assert.deepEqual(h.store.xProfileCache[uid+'/'+fid].urls,['https://x.com/example']);
  h.stop();
});

test('X header counts require opt-in, a top-level X sender and an already linked profile',async()=>{
  const h=await harness(good);await h.start();
  const now=h.store.accountMeta[uid].lastSuccessAt;
  h.store.xProfileCache={[uid+'/'+fid]:{accountId:uid,userId:fid,checkedAt:now,urls:['https://x.com/example']}};
  const message={type:'X_FOLLOWERS_OBSERVED',url:'https://x.com/example',followers:12345,approximate:false};
  const sender={id:'testextension',url:'https://x.com/Example',frameId:0,tab:{id:1}};
  const observe=(changes={},origin=sender)=>new Promise(resolve=>h.events.message({...message,...changes},origin,resolve));
  assert.equal((await observe()).ok,false);assert.equal(h.store.xFollowerCache,undefined);
  assert.equal((await h.command({type:'SAVE_X_FOLLOWERS',enabled:true})).ok,true);
  assert.equal(h.scripts.get('vrc-x-followers').matches[0],'https://x.com/*');
  for(const invalid of [{...sender,frameId:1},{...sender,id:'other'},{...sender,url:'https://evil.test/Example'},{...sender,url:'https://x.com/Example/status/1'}])assert.equal((await observe({},invalid)).ok,false);
  for(const invalid of [{url:'https://x.com/other'},{followers:-1},{followers:Infinity},{approximate:'yes'}])assert.equal((await observe(invalid)).ok,false);
  const calls=h.calls.length;assert.equal((await observe()).ok,true);await h.flush();
  assert.equal(h.store.xFollowerCache['xFollowers:'+uid+':example'].followers,12345);assert.equal(h.calls.length,calls);
  assert.equal((await h.command({type:'SAVE_X_FOLLOWERS',enabled:false})).ok,true);assert.equal(h.scripts.size,0);assert.equal((await observe({followers:99})).ok,false);
  await h.command({type:'CLEAR'});assert.deepEqual(h.store.xFollowerCache,{});h.stop();
});

test('all-profile mode stores unlinked header counts in the chosen account without inventing VRChat links',async()=>{
  const h=await harness(good),other='usr_secondscope001';h.store.accountMeta={[uid]:{displayName:'Owner'},[other]:{displayName:'Other'}};
  const message={type:'X_FOLLOWERS_OBSERVED',url:'https://x.com/unlinked',followers:42,approximate:false},sender={id:'testextension',url:message.url,frameId:0,tab:{id:10}},observe=(changes={},origin=sender)=>new Promise(resolve=>h.events.message({...message,...changes},origin,resolve));
  try{
    await h.command({type:'SAVE_X_FOLLOWERS',enabled:true});assert.equal((await observe()).ok,false);
    for(const changes of [{scope:'bad',accountId:uid},{scope:'all',accountId:''},{scope:'all',accountId:'usr_unregistered01'}])assert.equal((await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,...changes})).ok,false);
    assert.equal((await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,scope:'all',accountId:uid})).ok,true);
    assert.equal((await observe()).ok,true);assert.equal(h.store.xFollowerCache['xFollowers:'+uid+':unlinked'].followers,42);assert.equal(h.store.xFollowerCache['xFollowers:'+other+':unlinked'],undefined);assert.equal(h.store.xProfileCache,undefined);assert.equal(h.saved.friends.length,0);assert.equal(h.tabRows.size,0);assert.equal(h.calls.length,0);
    h.advance(61000);await observe();assert.equal(h.saved.research.filter(r=>r.kind==='followerHistory').length,1);assert.equal(h.saved.research[0].value.sampleCount,2);
    for(const invalid of [{...sender,frameId:1},{...sender,url:'https://example.com/unlinked'},{...sender,url:'https://x.com/unlinked/status/1'}])assert.equal((await observe({},invalid)).ok,false);
    assert.equal((await observe({url:'https://x.com/home'},{...sender,url:'https://x.com/home'})).ok,false);assert.equal((await observe({followers:-1})).ok,false);
    await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,accountId:other});await h.command({type:'SAVE_X_FOLLOWERS',enabled:true});assert.equal(h.store.xFollowerSettings.scope,'all');assert.equal(h.store.xFollowerSettings.accountId,other);h.advance(61000);await observe({followers:99});assert.equal(h.store.xFollowerCache['xFollowers:'+other+':unlinked'].followers,99);assert.equal(h.store.xFollowerCache['xFollowers:'+uid+':unlinked'].followers,42);
    await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,scope:'linked'});assert.equal((await observe({followers:100})).ok,false);assert.equal(h.store.xFollowerCache['xFollowers:'+other+':unlinked'].followers,99);
    h.store.xProfileCache={[uid+'/'+fid]:{accountId:uid,userId:fid,checkedAt:h.saved.research.at(-1).value.observedAt,urls:[message.url]}};h.advance(61000);await observe({followers:101});assert.equal(h.store.xFollowerCache['xFollowers:'+uid+':unlinked'].followers,101);assert.equal(h.store.xFollowerCache['xFollowers:'+other+':unlinked'].followers,99);
    await h.command({type:'SAVE_X_FOLLOWERS',enabled:false,scope:'all'});assert.equal((await observe()).ok,false);
  }finally{h.stop();}
});

test('unlinked X counts synchronize through the existing GAS table without user-profile associations',async()=>{
  const gas=gasHarness(),h=await harness((url,n,options)=>url.hostname==='script.google.com'?{body:gas.request(JSON.parse(options.body))}:good(url));
  try{
    h.store.accountMeta={[uid]:{displayName:'Owner'}};await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,scope:'all',accountId:uid});
    const message={type:'X_FOLLOWERS_OBSERVED',url:'https://x.com/unlinked',followers:123,approximate:true};
    const result=await new Promise(resolve=>h.events.message(message,{id:'testextension',url:message.url,frameId:0,tab:{id:10}},resolve));assert.equal(result.ok,true);await h.flush();
    h.store.cloudSync={enabled:true,endpoint:'https://script.google.com/macros/s/test_deployment/exec',token:TOKEN};assert.equal((await h.command({type:'SYNC',force:true})).ok,true);assert.equal(gas.table('VRCXFollowers').length,2);assert.ok(!gas.table('VRCProfiles')?.slice(1).length);
    h.store.xFollowerCache={};h.store.cloudCheckpoint={cursor:0,receipts:{}};h.advance(61000);assert.equal((await h.command({type:'SYNC',force:true})).ok,true);assert.equal(h.store.xFollowerCache['xFollowers:'+uid+':unlinked'].followers,123);assert.equal(h.store.xProfileCache,undefined);
  }finally{h.stop();}
});

test('the worker sends follower metrics to GAS and restores them without collecting images',async()=>{
  const gas=gasHarness(),h=await harness((url,n,options)=>url.hostname==='script.google.com'?{body:gas.request(JSON.parse(options.body))}:good(url));
  await h.start();h.store.xFollowerCache={['xFollowers:'+uid+':example']:{accountId:uid,url:'https://x.com/example',followers:25000,approximate:true,source:'x-profile',observedAt:h.store.accountMeta[uid].lastSuccessAt}};
  h.store.cloudSync={enabled:true,endpoint:'https://script.google.com/macros/s/test_deployment/exec',token:TOKEN};
  assert.equal((await h.command({type:'SYNC',force:true})).ok,true);assert.equal(gas.table('VRCXFollowers').length,2);
  h.store.xFollowerCache={};h.store.cloudCheckpoint={cursor:0,receipts:{}};h.advance(61000);
  assert.equal((await h.command({type:'SYNC',force:true})).ok,true);assert.equal(h.store.xFollowerCache['xFollowers:'+uid+':example'].followers,25000);h.stop();
});

test('collection stores compact series, pause boundaries and scheduled reports without duplicate periods',async()=>{
  const h=await harness(good);try{
    await h.start();assert.ok(h.saved.research.some(r=>r.kind==='segments'&&r.value.userId===uid));assert.ok(h.saved.research.some(r=>r.kind==='crowd'));assert.ok(h.saved.research.some(r=>r.kind==='coverage'));
    const count=h.saved.research.filter(r=>r.kind==='segments').length;h.advance(180000);assert.equal((await h.command({type:'POLL'})).ok,true);await h.flush();assert.ok(h.saved.research.filter(r=>r.kind==='segments').length<=count+2);
    const accountId=uid;const view=await h.command({type:'SAVE_RESEARCH',kind:'views',value:{accountId,title:'Daily',filters:{days:7,tool:'pairs'},schedule:'daily'}});assert.equal(view.ok,true);
    await h.events.alarm({name:'vrc-observer-reports'});await h.flush();const reports=h.saved.research.filter(r=>r.kind==='reports');assert.equal(reports.length,1);await h.events.alarm({name:'vrc-observer-reports'});await h.flush();assert.equal(h.saved.research.filter(r=>r.kind==='reports').length,1);
    assert.equal((await h.command({type:'RUN_REPORTS',accountId,viewId:view.record.value.id})).ok,true);assert.equal(h.saved.research.filter(r=>r.kind==='reports').length,2);assert.ok(h.saved.research.filter(r=>r.kind==='reports').some(r=>r.value.summary.quality.samples>=1));
    await h.command({type:'PAUSE'});assert.ok(h.saved.research.some(r=>r.kind==='coverage'&&r.value.outcome==='paused'));
  }finally{h.stop();}
});

test('bulk follower collection opens known X pages in priority order and single-user refresh uses no X API',async()=>{
  const h=await harness(good);try{
    await h.start();const now=h.store.accountMeta[uid].lastSuccessAt;
    h.store.xProfileCache={[uid+'/'+fid]:{accountId:uid,userId:fid,checkedAt:now,urls:['https://x.com/newcount','https://x.com/oldcount']}};
    h.store.xFollowerCache={['xFollowers:'+uid+':oldcount']:{accountId:uid,url:'https://x.com/oldcount',followers:10,approximate:false,source:'x-profile',observedAt:now-86400000}};
    // Another VRChat account's synced count must not mark this owner's target as collected.
    h.store.xFollowerCache.other={accountId:'usr_otheraccount01',url:'https://x.com/newcount',followers:99,approximate:false,source:'x-profile',observedAt:now+1000};
    assert.equal((await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid})).ok,false);
    await h.command({type:'SAVE_X_FOLLOWERS',enabled:true});const calls=h.calls.length;
    const batch=await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid});assert.equal(batch.ok,true);assert.equal(batch.added,2);assert.equal(h.store.xFollowerQueue.active[0].url,'https://x.com/newcount');
    const id=h.store.xFollowerQueue.active[0].tabId,sender={id:'testextension',url:h.tabRows.get(id).url,frameId:0,tab:{id}};
    const observed=await new Promise(resolve=>h.events.message({type:'X_FOLLOWERS_OBSERVED',url:'https://x.com/newcount',followers:123,approximate:false},sender,resolve));assert.equal(observed.ok,true);assert.equal(h.store.xFollowerQueue.success,1);assert.equal(h.tabRows.size,1);
    assert.ok(h.saved.research.some(r=>r.kind==='followerHistory'&&r.value.followers===123));
    h.advance(16000);h.events.alarm({name:'vrc-x-follower-queue'});await h.flush();assert.equal(h.store.xFollowerQueue.active[0].url,'https://x.com/oldcount');assert.equal(h.calls.length,calls);
    await h.command({type:'PAUSE_X_FOLLOWERS'});assert.equal(h.tabRows.size,0);assert.equal(h.store.xFollowerQueue.phase,'paused');
    await h.command({type:'CLEAR'});assert.equal(h.store.xFollowerQueue.items.length,0);assert.equal(h.store.xFollowerQueue.active.length,0);
  }finally{h.stop();}
});

test('worker persists one-to-ten concurrency, keeps it on automatic enable, and rejects invalid settings without mutation',async()=>{
  const h=await harness(good);try{
    await h.start();const before=h.calls.length;
    for(const value of [1,10,4]){const result=await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,concurrency:value});assert.equal(result.ok,true);assert.equal(h.store.xFollowerSettings.concurrency,value);}
    await h.command({type:'SAVE_X_FOLLOWERS',enabled:true});assert.equal(h.store.xFollowerSettings.concurrency,4);
    for(const value of [0,11,2.5,'3',null])assert.equal((await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,concurrency:value})).ok,false);
    assert.equal(h.store.xFollowerSettings.concurrency,4);assert.equal(h.calls.length,before);
    const now=h.store.accountMeta[uid].lastSuccessAt;h.store.xProfileCache={[uid+'/'+fid]:{accountId:uid,userId:fid,checkedAt:now,urls:['https://x.com/a','https://x.com/b','https://x.com/c','https://x.com/d','https://x.com/e']}};
    await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid});assert.equal(h.store.xFollowerQueue.active.length,4);
    await h.command({type:'SAVE_X_FOLLOWERS',enabled:false,concurrency:2});assert.equal(h.store.xFollowerQueue.phase,'paused');assert.equal(h.tabRows.size,0);assert.equal(h.store.xFollowerSettings.concurrency,2);
  }finally{h.stop();}
});

test('official notes are collected as confirmed change points, and missing list rows require an individual empty confirmation',async()=>{
  let text='公式ノート',listed=true,missingField=false;
  const h=await harness(url=>url.pathname.endsWith('/userNotes')?{body:listed?[{id:'unt_note000001',userId:uid,targetUserId:fid,note:text,createdAt:'2026-01-01T00:00:00Z',targetUser:{displayName:online.displayName}}]:[]}:url.pathname.includes('/users/')?{body:{id:fid,...(!missingField?{note:text}:{})}}:good(url));
  try{
    await h.start();const notes=()=>h.saved.research.filter(r=>r.kind==='userNotes'),history=()=>h.saved.research.filter(r=>r.kind==='userNoteHistory');assert.equal(notes()[0].value.note,'公式ノート');assert.equal(history().length,1);
    h.advance(31*60000);await h.command({type:'POLL'});await h.flush();assert.equal(history().length,1);
    text='変更後';h.advance(31*60000);await h.command({type:'POLL'});await h.flush();assert.equal(history().length,2);assert.equal(notes()[0].value.note,text);
    listed=false;missingField=true;h.advance(31*60000);await h.command({type:'POLL'});await h.flush();assert.equal(notes()[0].value.note,text);assert.equal(history().length,2);assert.ok(h.store.accountMeta[uid].noteScan.error);
    missingField=false;text='';h.advance(31*60000);await h.command({type:'POLL'});await h.flush();assert.equal(notes()[0].value.note,'');assert.equal(history().length,3);
    assert.ok(h.calls.filter(c=>new URL(c.url).pathname.includes('user')).every(c=>c.options.method==='GET'));
  }finally{h.stop();}
});
test('official note pagination continues on the next poll without losing earlier pages or repeating history',async()=>{
  const samples=Array.from({length:205},(_,i)=>({id:'unt_note0000'+i,userId:uid,targetUserId:'usr_target0000'+i,note:'Note '+i,createdAt:'2026-01-01T00:00:00Z'}));
  const h=await harness(url=>url.pathname.endsWith('/userNotes')?{body:samples.slice(Number(url.searchParams.get('offset')),Number(url.searchParams.get('offset'))+100)}:good(url));
  try{await h.start();assert.equal(h.store.accountMeta[uid].noteScan.offset,200);assert.equal(h.saved.research.filter(r=>r.kind==='userNotes').length,200);h.advance(61000);await h.command({type:'POLL'});await h.flush();assert.equal(h.store.accountMeta[uid].noteScan.offset,0);assert.equal(h.saved.research.filter(r=>r.kind==='userNoteHistory').length,205);assert.equal(h.store.accountMeta[uid].noteScan.seen.length,0);}finally{h.stop();}
});
test('official note detail checks enforce identity, retain saved content on failure, use cached results and never write the VRChat API',async()=>{
  let text='詳細ノート',wrongOwner=false,missing=false;const h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:wrongOwner?{...owner,id:'usr_anotheraccount01'}:owner}:url.pathname.includes('/users/')?{body:{id:fid,...(!missing?{note:text}:{}),authToken:'SECRET'}}:good(url));
  try{
    h.store.accountMeta={[uid]:{displayName:'Owner'}};h.saved.friends.push({accountId:uid,id:fid});await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});
    const message={type:'USER_NOTE',accountId:uid,userId:fid};const first=await h.command(message);assert.equal(first.ok,true);assert.equal(first.record.note,text);assert.equal(h.calls.length,3);assert.ok(!JSON.stringify(first).includes('SECRET'));
    assert.equal((await h.command(message)).cached,true);assert.equal(h.calls.length,3);assert.equal((await h.command({...message,readOnly:true})).record.note,text);
    h.advance(61000);missing=true;const failed=await h.command({...message,force:true});assert.equal(failed.ok,false);assert.equal(failed.record.note,text);
    missing=false;wrongOwner=true;const wrong=await h.command({...message,force:true});assert.equal(wrong.ok,false);assert.match(wrong.error,/アカウント/);assert.equal(h.saved.research.filter(r=>r.kind==='userNoteHistory').length,1);
    assert.ok(h.calls.every(c=>c.options.method==='GET'));await h.command({type:'CLEAR'});assert.equal(h.saved.research.filter(r=>r.kind==='userNotes').length,0);assert.deepEqual(Object.keys(h.store.userNoteChecks),[]);
  }finally{h.stop();}
});
test('official notes reject switched identity after fetching and honor rate limiting without erasing the snapshot',async()=>{
  let identities=0,mode='switch';const h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:++identities===2&&mode==='switch'?{...owner,id:'usr_anotheraccount01'}:owner}:url.pathname.includes('/users/')?mode==='rate'?{status:429,headers:{'Retry-After':'120'},body:{}}:{body:{id:fid,note:'Never save'}}:good(url));
  try{h.store.accountMeta={[uid]:{displayName:'Owner'}};h.saved.friends.push({accountId:uid,id:fid});await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});const msg={type:'USER_NOTE',accountId:uid,userId:fid};assert.equal((await h.command(msg)).ok,false);assert.equal(h.saved.research.filter(r=>r.kind==='userNotes').length,0);mode='rate';assert.equal((await h.command(msg)).ok,false);assert.ok(h.store.state.cooldownUntil);const count=h.calls.length;await h.command(msg);assert.equal(h.calls.length,count);}finally{h.stop();}
});

test('all-friends X collection discovers links from the authenticated roster even before friend rows exist',async()=>{
 const missing='usr_uncachedfriend01',noX='usr_nolinkfriend01',bad='usr_failedfriend01',ids=[fid,missing,noX,bad];
 const h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:{...owner,friends:ids}}:url.pathname.includes('/profile/')?url.pathname.endsWith(bad)?{status:500}:{body:{id:url.pathname.split('/').at(-1),bioLinks:url.pathname.endsWith(noX)?[]:['https://twitter.com/'+(url.pathname.endsWith(fid)?'freshfixture':'missingfixture')],bio:'@do_not_guess',authToken:'SECRET'}}:good(url));
 try{
  await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});
  await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,bulkScope:'friends'});
  assert.equal((await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,bulkScope:'invalid'})).ok,false);
  assert.equal(h.store.xFollowerSettings.bulkScope,'friends');
  assert.equal((await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid})).ok,true);await h.flush();
  h.advance(1000);h.events.alarm({name:'vrc-x-friend-discovery'});await h.flush();
  assert.equal(h.saved.friends.length,0);assert.equal(h.store.xFriendScan.total,4);assert.equal(h.store.xFriendScan.phase,'complete');assert.equal(h.store.xFriendScan.withLinks,2);assert.equal(h.store.xFriendScan.withoutLinks,1);assert.equal(h.store.xFriendScan.failed,1);
  assert.equal(h.store.xFollowerQueue.total,2);assert.equal(h.store.xFollowerQueue.active.length,2);assert.equal(h.calls.filter(c=>c.url.endsWith('/profile/'+bad)).length,2);
  assert.ok(!JSON.stringify(h.store).includes('SECRET'));assert.ok(h.calls.every(c=>c.options.method==='GET'));
  for(let i=1;i<h.calls.length;i++)assert.ok(h.calls[i].at-h.calls[i-1].at>=2200);
  const calls=h.calls.length;await h.command({type:'CLEAR_X_QUEUE'});assert.equal(h.store.xFriendScan.phase,'idle');assert.equal(h.store.xFollowerQueue.items.length,0);assert.equal(h.tabRows.size,0);assert.equal(Object.keys(h.store.xProfileCache).length,3);assert.equal(h.calls.length,calls);
 }finally{h.stop();}
});
test('all-friends discovery pauses on account switches, missing roster, and rate limits without saving guessed links',async()=>{
 for(const mode of ['account','roster','limit','removed']){
  let auth=0;const h=await harness(url=>{
   if(url.pathname.endsWith('/auth/user')){auth++;return {body:{...owner,...(mode==='roster'?{friends:null}:mode==='account'&&auth>1?{id:'usr_anotherowner01'}:mode==='removed'&&auth>1?{friends:[]}: {})}};}
   if(url.pathname.includes('/profile/'))return {status:429,headers:{'Retry-After':'3600'}};
   return good(url);
  });
  try{await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,bulkScope:'friends'});await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid});await h.flush();
   assert.equal(h.store.xFriendScan.phase,mode==='removed'?'complete':'paused');assert.equal(Object.keys(h.store.xProfileCache||{}).length,0);assert.equal(h.tabRows.size,0);
   if(mode==='limit'){assert.ok(h.store.state.cooldownUntil>h.store.state.lastRequestAt);const before=h.calls.length;await h.command({type:'RESUME_X_FOLLOWERS'});await h.flush();assert.equal(h.calls.length,before);assert.equal(h.store.xFriendScan.phase,'paused');}
   if(mode==='removed')assert.equal(h.store.xFriendScan.skipped,1);
  }finally{h.stop();}
 }
});
test('stopping all-friend discovery aborts the pending request and disable prevents automatic resume',async()=>{
 let started,release;const began=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 const h=await harness(async url=>{if(url.pathname.includes('/profile/')){started();await hold;return {body:{id:fid,bioLinks:['https://x.com/fixture']}};}return good(url);});
 try{await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,bulkScope:'friends'});await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid});await began;
  const stopping=h.command({type:'SAVE_X_FOLLOWERS',enabled:false});await h.flush();release();assert.equal((await stopping).ok,true);assert.equal(h.store.xFriendScan.phase,'paused');assert.equal(h.store.xFriendScan.items.length,1);assert.equal(Object.keys(h.store.xProfileCache||{}).length,0);
  h.events.alarm({name:'vrc-x-friend-discovery'});await h.flush();assert.equal(h.store.xFriendScan.checked,0);
 }finally{release();h.stop();}
});

test('normal profile-bearing responses cache X links without extra requests and never turn omitted fields into no-link results',async()=>{
 let fields={bio:'Fixture https://twitter.com/bio_fixture',bioLinks:['https://x.com/link_fixture']};
 const h=await harness(url=>url.pathname.endsWith('/friends')?{body:url.searchParams.get('offline')==='true'?[]:[{...online,...fields}]}:good(url));
 try{await h.start();const p=()=>h.store.xProfileCache?.[uid+'/'+fid];assert.deepEqual(p().urls,['https://x.com/link_fixture','https://x.com/bio_fixture']);assert.equal(h.calls.filter(c=>c.url.includes('/profile/')).length,0);
  const calls=h.calls.length;assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).cached,true);assert.equal(h.calls.length,calls);
  const previous=structuredClone(p());fields={bio:''};h.advance(61000);await h.command({type:'POLL'});await h.flush();assert.deepEqual(p(),previous);
  fields={bio:'',bioLinks:[]};h.advance(61000);await h.command({type:'POLL'});await h.flush();assert.deepEqual(p().urls,[]);assert.ok(p().checkedAt>previous.checkedAt);
 }finally{h.stop();}
});
test('opportunistic links are discarded with an interrupted collection or account switch',async()=>{
 for(const mode of ['account','page']){let auth=0;const many=Array.from({length:100},(_,i)=>({...online,id:'usr_fixture'+String(i).padStart(6,'0'),bio:'',bioLinks:['https://x.com/fixture']}));
  const h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:{...owner,id:mode==='account'&&++auth>1?'usr_wrongowner001':uid}}:url.pathname.endsWith('/friends')?mode==='page'&&url.searchParams.get('offset')!=='0'?{status:500}:{body:mode==='page'?many:[{...online,bio:'',bioLinks:['https://x.com/fixture']}]}:good(url));
  try{await h.start();assert.equal(Object.keys(h.store.xProfileCache||{}).length,0);}finally{h.stop();}
 }
});
test('an existing user-note profile fetch also supplies X links for later detail and bulk retrieval',async()=>{
 const h=await harness(url=>url.pathname.includes('/users/')?{body:{id:fid,displayName:'Fixture',note:'Fixture note',bio:'',bioLinks:['https://twitter.com/fixture'],authToken:'SECRET'}}:good(url));
 try{h.store.accountMeta={[uid]:{displayName:'Owner'}};h.saved.friends.push({accountId:uid,id:fid});await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});
  assert.equal((await h.command({type:'USER_NOTE',accountId:uid,userId:fid})).ok,true);assert.deepEqual(h.store.xProfileCache[uid+'/'+fid].urls,['https://x.com/fixture']);const count=h.calls.length;
  assert.equal((await h.command({type:'X_PROFILE',accountId:uid,userId:fid})).cached,true);assert.equal(h.calls.length,count);assert.equal(count,3);assert.ok(!JSON.stringify(h.store).includes('SECRET'));
 }finally{h.stop();}
});
test('ten uncached friends use twelve batch calls plus one roster call, while preserving spacing and account checks',async()=>{
 const ids=Array.from({length:10},(_,i)=>'usr_fixture'+String(i).padStart(6,'0'));
 const h=await harness(url=>url.pathname.endsWith('/auth/user')?{body:{...owner,friends:ids}}:url.pathname.includes('/profile/')?{body:{id:url.pathname.split('/').at(-1),bio:'',bioLinks:['https://x.com/f'+url.pathname.slice(-6)]}}:good(url));
 try{await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,bulkScope:'friends'});await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid});await h.flush();
  assert.equal(h.store.xFriendScan.phase,'complete');assert.equal(h.store.xFriendScan.withLinks,10);assert.equal(h.calls.length,13);assert.equal(h.calls.filter(c=>c.url.endsWith('/auth/user')).length,3);assert.equal(h.store.xFollowerQueue.total,10);
  for(let i=1;i<h.calls.length;i++)assert.ok(h.calls[i].at-h.calls[i-1].at>=2200);
 }finally{h.stop();}
});
test('batch account switches and mid-batch limits discard every staged link while retaining pending work',async()=>{
 for(const mode of ['switch','limit','missing']){const ids=[fid,'usr_fixturefriend02'];let fetched=0;
  const h=await harness(url=>{
   if(url.pathname.endsWith('/auth/user'))return {body:{...owner,id:mode==='switch'&&fetched===2?'usr_otherowner001':uid,friends:mode==='missing'&&fetched===2?null:ids}};
   if(url.pathname.includes('/profile/')){fetched++;return mode==='limit'&&fetched===2?{status:429,headers:{'Retry-After':'3600'}}:{body:{id:url.pathname.split('/').at(-1),bioLinks:['https://x.com/fixture']}};}return good(url);
  });
  try{await h.command({type:'SAVE',settings:{contact:'https://github.com/example'}});await h.command({type:'SAVE_X_FOLLOWERS',enabled:true,bulkScope:'friends'});await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid});await h.flush();assert.equal(h.store.xFriendScan.phase,'paused');assert.equal(h.store.xFriendScan.items.length,2);assert.equal(Object.keys(h.store.xProfileCache||{}).length,0);assert.equal(h.tabRows.size,0);}
  finally{h.stop();}
 }
});
test('unavailable X reports are bound to the active tab and canonical profile, never overwrite old counts',async()=>{
 const h=await harness(good);
 try{await h.start();const now=h.store.accountMeta[uid].lastSuccessAt,url='https://x.com/fixture';h.store.xProfileCache={[uid+'/'+fid]:{accountId:uid,userId:fid,checkedAt:now,urls:[url,'https://x.com/otherfixture']}};h.store.xFollowerCache={old:{accountId:uid,url,followers:123,approximate:false,source:'x-profile',observedAt:now}};
  await h.command({type:'SAVE_X_FOLLOWERS',enabled:true});await h.command({type:'COLLECT_X_FOLLOWERS',accountId:uid});const job=h.store.xFollowerQueue.active.find(j=>j.url===url),sender={id:'testextension',url:h.tabRows.get(job.tabId).url,frameId:0,tab:{id:job.tabId}},message={type:'X_FOLLOWERS_UNAVAILABLE',url,reason:'not-found'};
  for(const change of [{frameId:1},{url:'https://evil.example/fixture'},{id:'otherextension'}])assert.equal(h.events.message(message,{...sender,...change},()=>assert.fail('invalid sender responded')),false);
  const report=(m,s)=>new Promise(resolve=>h.events.message(m,s,resolve));assert.equal((await report({...message,url:'https://x.com/otherfixture'},{...sender,url:'https://x.com/otherfixture'})).ok,false);
  const old=structuredClone(h.store.xFollowerCache);assert.equal((await report(message,sender)).ok,true);assert.equal((await report(message,sender)).ok,false);assert.deepEqual(h.store.xFollowerCache,old);assert.equal(h.store.xFollowerQueue.unavailable,1);assert.equal(h.store.xFollowerQueue.skipped,1);assert.equal(h.store.xFollowerQueue.retries,0);assert.equal(h.store.xFollowerQueue.paused,false);assert.equal(h.store.xFollowerQueue.active.length,1);assert.match(h.store.xFollowerQueue.errors[0].message,/存在しない/);
 }finally{h.stop();}
});
