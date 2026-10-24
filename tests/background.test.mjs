import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const root=new URL('../extension/',import.meta.url);
const uid='usr_01234567-1111-2222-3333-012345678901',fid='usr_11111111-1111-2222-3333-012345678901',wid='wrld_01234567-1111-2222-3333-012345678901';
const owner={id:uid,displayName:'テスト本人',friends:[fid],onlineFriends:[fid],offlineFriends:[],activeFriends:[],authToken:'SECRET_AUTH',email:'SECRET_MAIL'};
const online={id:fid,displayName:'架空フレンド',status:'active',location:wid+':123~region(jp)',authToken:'SECRET_AUTH',friendKey:'SECRET_KEY'};

async function harness(handler){
  let now=Date.UTC(2026,9,24),closed=false;
  const events={},store={},alarms=new Map(),saved={friends:[],events:[],worlds:[],runs:[]},calls=[];
  const hook=name=>({addListener:fn=>{events[name]=fn;}});
  const storage={
    get:async key=>{const keys=Array.isArray(key)?key:[key];return structuredClone(Object.fromEntries(keys.filter(k=>k in store).map(k=>[k,store[k]])));},
    set:async values=>Object.assign(store,structuredClone(values)),setAccessLevel:async()=>{}
  };
  const chrome={storage:{local:storage},alarms:{create:async(n,v)=>alarms.set(n,v),get:async n=>alarms.get(n),clear:async n=>alarms.delete(n),onAlarm:hook('alarm')},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:hook('click')},
    runtime:{id:'testextension',getURL:p=>'chrome-extension://testextension/'+p,onMessage:hook('message'),onInstalled:hook('installed'),onStartup:hook('startup')},
    declarativeNetRequest:{updateDynamicRules:async v=>{saved.rules=v;}},tabs:{create:async()=>{}}};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({chrome,console,navigator:{userAgent:'TestChrome'},Date:Clock,Math,URL,AbortController,AbortSignal,DOMException,
    setTimeout:(fn,ms)=>{now+=ms;queueMicrotask(fn);return 1;},clearTimeout:()=>{},
    fetch:async(url,options)=>{if(closed)throw Error('closed');now+=50;calls.push({url,options,at:now});
      const response=handler(new URL(url),calls.length);return {ok:(response.status||200)<300,status:response.status||200,type:response.type||'basic',headers:new Headers({'Content-Type':'application/json',...(response.headers||{})}),json:async()=>structuredClone(response.body)};}});
  const dbExports={list:async(name,id)=>structuredClone(saved[name].filter(v=>v.accountId===id)),
    commit:async(f,e,w,r)=>{for(const v of f){saved.friends=saved.friends.filter(x=>!(x.accountId===v.accountId&&x.id===v.id));saved.friends.push(structuredClone(v));}saved.events.push(...structuredClone(e));saved.worlds.push(...structuredClone(w));if(r)saved.runs.push(structuredClone(r));},
    prune:async()=>{},clearAll:async()=>{for(const k of ['friends','events','worlds','runs'])saved[k]=[];}};
  const db=new vm.SyntheticModule(Object.keys(dbExports),function(){for(const[k,v]of Object.entries(dbExports))this.setExport(k,v);},{context});
  const core=new vm.SourceTextModule(await fs.readFile(new URL('core.js',root),'utf8'),{context});await core.link(()=>{});
  const bg=new vm.SourceTextModule(await fs.readFile(new URL('background.js',root),'utf8'),{context});
  await bg.link(spec=>spec==='./core.js'?core:db);await bg.evaluate();
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
