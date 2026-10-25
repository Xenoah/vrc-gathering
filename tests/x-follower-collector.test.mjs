import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowerCollector,followerTargets,X_QUEUE_ALARM,X_QUEUE_INTERVAL,X_QUEUE_TIMEOUT} from '../extension/x-follower-collector.js';
const accountId='usr_testaccount01',userIds=['usr_friend0001','usr_friend0002','usr_friend0003','usr_friend0004'];
const url=n=>'https://x.com/'+n;
function harness(){
  let clock=Date.now(),enabled=true,seq=0,creates=0;const values={},pages=new Map(),alarms=new Map(),removed=[],probes=[];
  const storage={get:async key=>({[key]:structuredClone(values[key])}),set:async v=>Object.assign(values,structuredClone(v))};
  const tabs={create:async opts=>{creates++;const row={id:++seq,status:'loading',pinned:false,...opts};pages.set(row.id,row);return {...row};},get:async id=>{if(!pages.has(id))throw Error('closed');return {...pages.get(id)};},query:async()=>[...pages.values()],remove:async id=>{removed.push(id);pages.delete(id);},sendMessage:async(...args)=>{probes.push(args);return {ok:true};}};
  const deps={storage,tabs,alarms:{create:async(n,v)=>alarms.set(n,v),clear:async n=>alarms.delete(n)},allowed:async()=>enabled,isKnown:async u=>u!==url('removed'),now:()=>clock,uuid:()=>String(++seq)};
  return {collector:createFollowerCollector(deps),restart:()=>createFollowerCollector(deps),values,pages,alarms,removed,probes,advance:n=>{clock+=n;},enable:v=>{enabled=v;},get creates(){return creates;}};
}
test('bulk targets deduplicate links, isolate the account, and prefer missing then oldest observations',()=>{
  const now=Date.now(),profiles=Object.fromEntries(userIds.map((userId,i)=>[accountId+'/'+userId,{accountId,userId,checkedAt:now,urls:[url(['fresh','old','missing','missing'][i])]}]));
  profiles['usr_another0001/'+userIds[0]]={accountId:'usr_another0001',userId:userIds[0],checkedAt:now,urls:[url('private')]};
  const metric=(name,at)=>({accountId,url:url(name),followers:0,approximate:false,source:'x-profile',observedAt:at});
  const rows=followerTargets(profiles,{a:metric('fresh',now),b:metric('old',now-86400000)},accountId,userIds,now);
  assert.deepEqual(rows.map(v=>v.url),[url('missing'),url('old'),url('fresh')]);assert.equal(followerTargets(profiles,{},accountId,[userIds[1]],now).length,1);
});
test('one inactive tab at a time, minimum spacing, success advances and only owned background tabs close',async()=>{
  const h=harness(),q=h.collector;await q.enqueue([{url:url('one')},{url:url('two')}]);const first=h.values.xFollowerQueue.active;
  assert.equal(h.pages.size,1);assert.equal(h.pages.get(first.tabId).active,false);
  await q.observed(url('wrong'),first.tabId);assert.equal(h.values.xFollowerQueue.success,0);
  await q.observed(first.url,first.tabId);assert.equal(h.pages.size,0);assert.equal(h.values.xFollowerQueue.success,1);assert.equal(h.creates,1);
  h.advance(X_QUEUE_INTERVAL);await q.tick();const second=h.values.xFollowerQueue.active;h.pages.get(second.tabId).active=true;await q.observed(second.url,second.tabId);
  assert.equal(h.pages.size,1);assert.equal(h.values.xFollowerQueue.phase,'complete');assert.equal(h.values.xFollowerQueue.success,2);
});
test('single-user requests are prioritized and repeated requests never duplicate a queued profile',async()=>{
  const h=harness(),q=h.collector;await q.enqueue(['one','two','three'].map(n=>({url:url(n)})));await q.enqueue([{url:url('three')}],{single:true});await q.enqueue([{url:url('three')}],{single:true});
  assert.equal(h.values.xFollowerQueue.items[0].url,url('three'));assert.equal(h.values.xFollowerQueue.total,3);
  await q.pause();assert.equal(h.values.xFollowerQueue.phase,'paused');assert.equal(h.pages.size,0);await q.tick();assert.equal(h.creates,1);
  h.advance(X_QUEUE_INTERVAL);await q.enqueue([{url:url('four')}],{single:true});assert.equal(h.values.xFollowerQueue.active.url,url('four'));await q.observed(url('four'),h.values.xFollowerQueue.active.tabId);assert.equal(h.values.xFollowerQueue.phase,'paused');
  await q.resume();h.advance(X_QUEUE_INTERVAL);await q.tick();assert.equal(h.values.xFollowerQueue.active.url,url('one'));
});
test('persisted queue survives worker restart, probes a loaded tab, and recovers interrupted creation',async()=>{
  const h=harness();await h.collector.enqueue([{url:url('one')}]);const active=structuredClone(h.values.xFollowerQueue.active);h.pages.get(active.tabId).status='complete';
  await h.restart().tick();assert.equal(h.creates,1);assert.equal(h.probes.length,1);
  h.values.xFollowerQueue.active.tabId=null;await h.restart().tick();assert.equal(h.creates,1);assert.equal(h.values.xFollowerQueue.active.tabId,active.tabId);
});
test('timeouts preserve previous metrics, continue, and pause after three failures',async()=>{
  const h=harness();await h.collector.enqueue(['one','two','three','four'].map(n=>({url:url(n)})));
  for(let i=0;i<3;i++){h.advance(X_QUEUE_TIMEOUT);await h.collector.tick();}
  assert.equal(h.creates,3);assert.equal(h.values.xFollowerQueue.failed,3);assert.equal(h.values.xFollowerQueue.phase,'paused');assert.equal(h.values.xFollowerQueue.items.length,1);assert.equal(h.values.xFollowerCache,undefined);
});
test('login, rate limits, manual navigation and closed tabs pause without touching user tabs',async()=>{
  for(const change of ['login','navigate','close','rate-limit']){const h=harness();await h.collector.enqueue([{url:url('one')}]);const id=h.values.xFollowerQueue.active.tabId;
    if(change==='login')h.pages.get(id).url='https://x.com/i/flow/login';
    if(change==='navigate')h.pages.get(id).url='https://x.com/home';
    if(change==='close')h.pages.delete(id);
    if(change==='rate-limit')await h.collector.blocked(id,'rate-limit');else await h.collector.tabChanged(id);
    assert.equal(h.values.xFollowerQueue.phase,'paused',change);assert.equal(h.removed.length,0,change);assert.equal(h.values.xFollowerQueue.success,0);
    if(change==='rate-limit')await assert.rejects(()=>h.collector.resume(),/待機/);
  }
});
test('revocation, deletion, unsafe URLs and removed links do not trigger new browsing',async()=>{
  const h=harness();await h.collector.enqueue([{url:'https://evil.test/x.com/one'},{url:url('removed')}]);assert.equal(h.creates,0);assert.equal(h.values.xFollowerQueue.skipped,1);
  h.enable(false);await assert.rejects(()=>h.collector.enqueue([{url:url('one')}]),/許可/);h.enable(true);await h.collector.enqueue([{url:url('one')}]);h.enable(false);await h.collector.tick();assert.equal(h.values.xFollowerQueue.phase,'paused');assert.equal(h.pages.size,0);
  await h.collector.clear();assert.equal(h.values.xFollowerQueue.total,0);assert.equal(h.values.xFollowerQueue.items.length,0);assert.equal(h.alarms.has(X_QUEUE_ALARM),false);
});
test('a manually opened pending profile satisfies the job without opening or closing another tab',async()=>{
  const h=harness();await h.collector.enqueue(['one','two'].map(n=>({url:url(n)})));await h.collector.observed(url('two'),999);
  assert.equal(h.values.xFollowerQueue.success,1);assert.equal(h.values.xFollowerQueue.items.length,0);assert.equal(h.creates,1);assert.equal(h.removed.length,0);
});
test('a tab being navigated elsewhere is never closed even while its old URL still matches',async()=>{
  const h=harness();await h.collector.enqueue([{url:url('one')}]);const a=h.values.xFollowerQueue.active;h.pages.get(a.tabId).pendingUrl='https://example.org/';await h.collector.pause();assert.equal(h.pages.size,1);assert.equal(h.removed.length,0);
});
