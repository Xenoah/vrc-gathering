import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { createSettingsBackup } from '../extension/settings-backup.js';
const root=new URL('../extension/',import.meta.url);
const uid='usr_01234567-1111-2222-3333-012345678901',fid='usr_11111111-1111-2222-3333-012345678901',wid='wrld_01234567-1111-2222-3333-012345678901';
const owner={id:uid,displayName:'テスト本人',friends:[fid],onlineFriends:[fid],offlineFriends:[],activeFriends:[],authToken:'SECRET_AUTH',email:'SECRET_MAIL'};
const online={id:fid,displayName:'架空フレンド',status:'active',location:wid+':123~region(jp)',authToken:'SECRET_AUTH',friendKey:'SECRET_KEY'};

async function harness(handler, allowCloud = true){
  let now=Date.UTC(2026,9,24),closed=false;
  const events={},store={},alarms=new Map(),saved={friends:[],events:[],worlds:[],runs:[],images:[],visits:[],encounters:[]},calls=[];
  const hook=name=>({addListener:fn=>{events[name]=fn;}});
  const storage={
    get:async key=>{const keys=Array.isArray(key)?key:[key];return structuredClone(Object.fromEntries(keys.filter(k=>k in store).map(k=>[k,store[k]])));},
    set:async values=>Object.assign(store,structuredClone(values)),setAccessLevel:async()=>{}
  };
  const chrome={permissions:{contains:async()=>allowCloud},storage:{local:storage},alarms:{create:async(n,v)=>alarms.set(n,v),get:async n=>alarms.get(n),clear:async n=>alarms.delete(n),onAlarm:hook('alarm')},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:hook('click')},
    runtime:{id:'testextension',getURL:p=>'chrome-extension://testextension/'+p,onMessage:hook('message'),onInstalled:hook('installed'),onStartup:hook('startup')},
    declarativeNetRequest:{updateDynamicRules:async v=>{saved.rules=v;}},tabs:{create:async()=>{}}};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({chrome,console,navigator:{userAgent:'TestChrome'},Date:Clock,Math,URL,AbortController,AbortSignal,DOMException,
    setTimeout:(fn,ms)=>{now+=ms;queueMicrotask(fn);return 1;},clearTimeout:()=>{},
    fetch:async(url,options)=>{if(closed)throw Error('closed');now+=50;calls.push({url,options,at:now});
      const response=await handler(new URL(url),calls.length,options);return {ok:(response.status||200)<300,status:response.status||200,type:response.type||'basic',headers:new Headers({'Content-Type':'application/json',...(response.headers||{})}),json:async()=>structuredClone(response.body)};}});
  const dbExports={list:async(name,id)=>structuredClone(saved[name].filter(v=>v.accountId===id)),
    commit:async(f,e,w,r,connections={visits:[],encounters:[]})=>{for(const v of f){saved.friends=saved.friends.filter(x=>!(x.accountId===v.accountId&&x.id===v.id));saved.friends.push(structuredClone(v));}saved.events.push(...structuredClone(e));saved.worlds.push(...structuredClone(w));if(r)saved.runs.push(structuredClone(r));for(const kind of ['visits','encounters'])for(const v of connections[kind]){saved[kind]=saved[kind].filter(x=>!(x.accountId===v.accountId&&x.startedAt===v.startedAt&&x.userId===v.userId));saved[kind].push(structuredClone(v));}},
    exportSyncRecords:async()=>[],mergeSyncRecords:async()=>{},enqueueImages:async(accountId,images)=>{saved.images.push(...images.filter(Boolean).map(v=>({...v,accountId})));},cachedImages:async()=>[],updateCachedImage:async()=>{},trimImageCache:async()=>{},clearImageCache:async()=>{saved.images=[];},prune:async()=>{},clearAll:async()=>{for(const k of ['friends','events','worlds','runs','visits','encounters'])saved[k]=[];}};
  const db=new vm.SyntheticModule(Object.keys(dbExports),function(){for(const[k,v]of Object.entries(dbExports))this.setExport(k,v);},{context});
  const core=new vm.SourceTextModule(await fs.readFile(new URL('core.js',root),'utf8'),{context});await core.link(()=>{});
  const format=new vm.SourceTextModule(await fs.readFile(new URL('sync-format.js',root),'utf8'),{context});await format.link(()=>{});
  const sync=new vm.SourceTextModule(await fs.readFile(new URL('sync.js',root),'utf8'),{context});await sync.link(()=>format);
  const images=new vm.SourceTextModule(await fs.readFile(new URL('image-cache.js',root),'utf8'),{context});await images.link(()=>{});
  const backup=new vm.SourceTextModule(await fs.readFile(new URL('settings-backup.js',root),'utf8'),{context});await backup.link(spec=>spec==='./core.js'?core:sync);
  const connections=new vm.SourceTextModule(await fs.readFile(new URL('connections.js',root),'utf8'),{context});await connections.link(()=>{});
  const xProfiles=new vm.SourceTextModule(await fs.readFile(new URL('x-profile.js',root),'utf8'),{context});await xProfiles.link(()=>{});
  const bg=new vm.SourceTextModule(await fs.readFile(new URL('background.js',root),'utf8'),{context});
  await bg.link(spec=>spec==='./core.js'?core:spec==='./sync.js'?sync:spec==='./image-cache.js'?images:spec==='./settings-backup.js'?backup:spec==='./connections.js'?connections:spec==='./x-profile.js'?xProfiles:db);await bg.evaluate();
  async function flush(){for(let i=0;i<15;i++)await new Promise(setImmediate);}
  await flush();
  const command=message=>new Promise(resolve=>events.message(message,{id:'testextension',url:'chrome-extension://testextension/dashboard.html'},resolve));
  const start=async()=>{assert.equal((await command({type:'SAVE',settings:{contact:'https://github.com/example'}})).ok,true);await command({type:'START'});await flush();};
  return {store,saved,calls,alarms,command,start,flush,advance:ms=>{now+=ms;},stop:()=>{closed=true;},events};
}
const good=url=>({body:url.pathname.endsWith('/auth/user')?owner:url.pathname.endsWith('/friends')?(url.searchParams.get('offline')==='true'?[]:[online]):{id:wid,name:'架空ワールド',capacity:16,unityPackages:[{assetUrl:'SECRET_ASSET'}]}});

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
  const h=await harness((url,n,options)=>({body:JSON.parse(options.body).action==='hello'?{protocol:2,ok:true,datasetId:'test',protocols:[1,2],recordSchemas:[1,2],operations:['upsert'],maxBatch:100}:{protocol:2,ok:true,datasetId:'test',records:[],cursor:0,hasMore:false}}));
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
  const hello={protocol:2,ok:true,datasetId:'test',protocols:[1,2],recordSchemas:[1,2],operations:['upsert'],maxBatch:100};
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
