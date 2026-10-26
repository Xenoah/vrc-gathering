import test from 'node:test';
import assert from 'node:assert/strict';
import {createFriendDiscovery,X_DISCOVERY_ALARM} from '../extension/x-friend-discovery.js';
import {followerTargets} from '../extension/x-follower-collector.js';
const account='usr_fixtureowner01',id=n=>'usr_fixture'+String(n).padStart(6,'0');
function harness(size=3){
  let now=Date.now(),seq=0;const values={},cache={},metrics={},alarms=new Map(),calls=[],deliveries=[],receipts=new Set(),ids=Array.from({length:size},(_,n)=>id(n));
  const deps={storage:{get:async k=>({[k]:structuredClone(values[k])}),set:async v=>Object.assign(values,structuredClone(v))},alarms:{create:async(n,v)=>alarms.set(n,v),clear:async n=>alarms.delete(n)},allowed:async()=>true,roster:async()=>({ok:true,ids}),profiles:async()=>cache,lookup:async(a,userId)=>{calls.push(userId);return {ok:true,profile:put(userId)};},targets:async(a,eligible)=>followerTargets(cache,metrics,a,eligible,now),deliver:async(rows,batchId)=>{if(!receipts.has(batchId)){deliveries.push(...rows);receipts.add(batchId);}return {ok:true};},now:()=>now,uuid:()=>String(++seq)};
  function put(userId,{age=0,urls=['https://x.com/f'+userId.slice(-6)]}={}){const p={accountId:account,userId,checkedAt:now-age,urls};cache[account+'/'+userId]=p;return p;}
  const make=()=>createFriendDiscovery({...deps,...Object.fromEntries(['roster','lookup','profiles','targets','deliver','allowed'].map(key=>[key,(...args)=>deps[key](...args)]))});return {q:make(),make,deps,values,cache,metrics,alarms,calls,deliveries,ids,put,advance:(ms=100000)=>now+=ms};
}
const scan=h=>h.values.xFriendScan;
test('all current friends including more than 500 reach the X queue, deduplicated and missing counts first',async()=>{
 const h=harness(1205);for(const userId of h.ids)h.put(userId);h.put(id(1),{urls:['https://x.com/f000000']});
 h.metrics.old={accountId:account,url:'https://x.com/f000000',followers:1,source:'x-profile',approximate:false,observedAt:Date.now()-1000};
 await h.q.start(account);await h.q.tick();assert.equal(scan(h).cursor,1000);assert.ok(h.alarms.has(X_DISCOVERY_ALARM));
 h.q=h.make();h.advance();await h.q.tick();assert.equal(scan(h).phase,'complete');assert.equal(scan(h).total,1205);assert.equal(scan(h).checked,1205);assert.equal(h.deliveries.length,1204);assert.equal(h.deliveries.at(-1).url,'https://x.com/f000000');assert.equal(h.calls.length,0);
});
test('missing links precede stale checks, fresh empty results are reused, failures retry once then finish',async()=>{
 const h=harness(5);h.put(id(0),{age:2*86400000});h.put(id(1),{urls:[]});h.put(id(2));
 h.deps.lookup=async(a,userId)=>{h.calls.push(userId);if(userId===id(3))return {ok:false,error:'fixture failure'};return {ok:true,profile:h.put(userId)};};
 await h.q.start(account);await h.q.tick();assert.deepEqual(h.calls,[id(3),id(4),id(0),id(3)]);assert.equal(scan(h).phase,'complete');assert.equal(scan(h).checked,5);assert.equal(scan(h).withLinks,3);assert.equal(scan(h).withoutLinks,1);assert.equal(scan(h).failed,1);assert.equal(scan(h).errors[0].userId,id(3));assert.equal(h.deliveries.length,3);
});
test('a busy collector is retried and removed friends are skipped rather than assigned a zero',async()=>{
 const h=harness(1);let busy=true;h.deps.roster=async()=>busy?{busy:true}:{ok:true,ids:h.ids};h.deps.lookup=async()=>({ok:true,skipped:true});
 await h.q.start(account);await h.q.tick();assert.equal(scan(h).initialized,false);assert.equal(scan(h).phase,'waiting');busy=false;h.advance();await h.q.tick();assert.equal(scan(h).skipped,1);assert.equal(scan(h).withoutLinks,0);assert.equal(h.deliveries.length,0);
});
test('authentication and rate limits pause without discarding the pending profile',async()=>{
 for(const status of [401,403,429]){const h=harness(1);h.deps.lookup=async()=>({ok:false,status,error:'blocked'});await h.q.start(account);await h.q.tick();assert.equal(scan(h).phase,'paused');assert.equal(scan(h).items.length,1);assert.equal(scan(h).checked,0);assert.equal(h.alarms.has(X_DISCOVERY_ALARM),false);h.deps.lookup=async(a,u)=>({ok:true,profile:h.put(u)});await h.q.resume();await h.q.tick();assert.equal(scan(h).phase,'complete');}
});
test('stop aborts an in-flight lookup, retains its pending item, and restart resumes it',async()=>{
 const h=harness(2);let entered;const began=new Promise(r=>entered=r);h.deps.lookup=async(a,u,signal)=>{entered();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({ok:false,error:'aborted'}),{once:true}));};
 await h.q.start(account);const tick=h.q.tick();await began;await h.q.pause();await tick;assert.equal(scan(h).checked,0);assert.equal(scan(h).items.length,2);assert.equal(scan(h).paused,true);
 h.q=h.make();await h.q.tick();assert.equal(scan(h).checked,0);h.deps.lookup=async(a,u)=>({ok:true,profile:h.put(u)});await h.q.resume();await h.q.tick();assert.equal(scan(h).checked,2);await h.q.pause();assert.equal(scan(h).phase,'complete');
});
test('restarting after saving a profile reuses it without losing the job or duplicating delivery',async()=>{
 const h=harness(1);await h.q.start(account);let throwOnce=true;const set=h.deps.storage.set;
 h.deps.storage.set=async values=>{if(throwOnce&&values.xFriendScan.checked===1){throwOnce=false;throw Error('worker stopped after saving profile');}return set(values);};
 await h.q.tick();h.q=h.make();h.advance();await h.q.tick();assert.equal(scan(h).phase,'complete');assert.equal(h.deliveries.length,1);
});
test('delivery receipts protect a replay after stopping between queue save and scan progress save',async()=>{
 const h=harness(2);let delivered;const handoff=new Promise(r=>delivered=r);let release;const blocked=new Promise(r=>release=r),send=h.deps.deliver;
 h.deps.deliver=async(...args)=>{await send(...args);delivered();await blocked;return {ok:true};};
 await h.q.start(account);const tick=h.q.tick();await handoff;const pause=h.q.pause();release();await pause;await tick;assert.equal(scan(h).cursor,0);
 h.deps.deliver=send;h.q=h.make();await h.q.resume();await h.q.tick();assert.equal(scan(h).phase,'complete');assert.equal(h.deliveries.length,2);
});
test('backpressure and X pauses keep all remaining targets; account switching requires resetting pending work',async()=>{
 const h=harness(1),send=h.deps.deliver;h.deps.deliver=async()=>({full:true});await h.q.start(account);await h.q.tick();assert.equal(scan(h).cursor,0);assert.equal(scan(h).phase,'handoff');
 await assert.rejects(h.q.start('usr_otherowner001'),/別アカウント/);h.deps.deliver=async()=>({paused:true,message:'login'});h.advance();await h.q.tick();assert.equal(scan(h).phase,'paused');h.deps.deliver=send;await h.q.resume();await h.q.tick();assert.equal(h.deliveries.length,1);await h.q.clear();assert.equal(scan(h).accountId,'');assert.equal(h.alarms.has(X_DISCOVERY_ALARM),false);
});
