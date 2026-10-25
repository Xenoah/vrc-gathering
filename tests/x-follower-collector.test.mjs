import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowerCollector,followerTargets,X_QUEUE_ALARM,X_QUEUE_INTERVAL,X_QUEUE_TIMEOUT,X_QUEUE_CONCURRENCY} from '../extension/x-follower-collector.js';
const accountId='usr_testaccount01',userIds=['usr_friend0001','usr_friend0002','usr_friend0003','usr_friend0004'];
const url=n=>'https://x.com/'+n;
function harness(){
  let clock=Date.now(),enabled=true,seq=0,creates=0,limit=3,latestError=false,createError=false;const values={},observations={},pages=new Map(),alarms=new Map(),removed=[],probes=[];
  const storage={get:async key=>({[key]:structuredClone(values[key])}),set:async v=>Object.assign(values,structuredClone(v))};
  const tabs={create:async opts=>{creates++;if(createError)throw Error('creation failed');const row={id:++seq,status:'loading',pinned:false,...opts};pages.set(row.id,row);return {...row};},get:async id=>{if(!pages.has(id))throw Error('closed');return {...pages.get(id)};},query:async()=>[...pages.values()],remove:async id=>{removed.push(id);pages.delete(id);},sendMessage:async(...args)=>{probes.push(args);return {ok:true};}};
  const deps={storage,tabs,alarms:{create:async(n,v)=>alarms.set(n,v),clear:async n=>alarms.delete(n)},allowed:async()=>enabled,isKnown:async u=>u!==url('removed'),latest:async()=>{if(latestError)throw Error('temporary storage failure');return observations;},concurrency:async()=>limit,now:()=>clock,uuid:()=>String(++seq)};
  return {collector:createFollowerCollector(deps),restart:()=>createFollowerCollector(deps),values,observations,pages,alarms,removed,probes,advance:n=>{clock+=n;},enable:v=>{enabled=v;},setConcurrency:v=>{limit=v;},failLatest:v=>{latestError=v;},failCreate:v=>{createError=v;},get creates(){return creates;}};
}
test('bulk targets deduplicate links, isolate the account, and prefer missing then oldest observations',()=>{
  const now=Date.now(),profiles=Object.fromEntries(userIds.map((userId,i)=>[accountId+'/'+userId,{accountId,userId,checkedAt:now,urls:[url(['fresh','old','missing','missing'][i])]}]));
  profiles['usr_another0001/'+userIds[0]]={accountId:'usr_another0001',userId:userIds[0],checkedAt:now,urls:[url('private')]};
  const metric=(name,at)=>({accountId,url:url(name),followers:0,approximate:false,source:'x-profile',observedAt:at});
  const rows=followerTargets(profiles,{a:metric('fresh',now),b:metric('old',now-86400000)},accountId,userIds,now);
  assert.deepEqual(rows.map(v=>v.url),[url('missing'),url('old'),url('fresh')]);assert.equal(followerTargets(profiles,{},accountId,[userIds[1]],now).length,1);
});
const jobs=(...names)=>names.map(name=>({url:url(name)}));
const active=h=>h.values.xFollowerQueue.active;
const pending=h=>h.values.xFollowerQueue.items.map(j=>j.url);

test('three inactive tabs run concurrently, finish out of order and refill without exceeding the limit',async()=>{
  const h=harness(),q=h.collector;await q.enqueue(jobs('a','b','c','d','e','f'));
  assert.equal(X_QUEUE_CONCURRENCY,3);assert.equal(h.pages.size,3);assert.ok([...h.pages.values()].every(t=>!t.active));
  const [a,b,c]=structuredClone(active(h));
  await q.observed(url('wrong'),a.tabId);assert.equal(h.values.xFollowerQueue.success,0);
  await Promise.all([q.observed(c.url,c.tabId),q.observed(a.url,a.tabId),q.observed(c.url,c.tabId)]);
  assert.equal(h.values.xFollowerQueue.success,2);assert.equal(h.creates,3);assert.deepEqual(active(h).map(j=>j.url),[b.url]);
  h.advance(X_QUEUE_INTERVAL-1);await q.tick();assert.equal(h.creates,3);
  h.advance(1);await q.tick();assert.equal(h.creates,5);assert.equal(active(h).length,3);assert.equal(h.pages.size,3);
  h.pages.get(b.tabId).active=true;await q.observed(b.url,b.tabId);assert.ok(h.pages.has(b.tabId));
  h.advance(X_QUEUE_INTERVAL);await q.tick();assert.equal(h.creates,6);assert.equal(active(h).length,3);
  for(const job of [...active(h)])await q.observed(job.url,job.tabId);
  assert.equal(h.values.xFollowerQueue.phase,'complete');assert.equal(h.values.xFollowerQueue.success,6);assert.equal(h.pages.size,1);assert.equal(h.alarms.has(X_QUEUE_ALARM),false);
});
test('new missing profiles and repeated detail requests cannot be overtaken by known refreshes',async()=>{
  const h=harness(),q=h.collector;await q.enqueue(jobs('a','b','c'));
  await q.enqueue([{url:url('old'),observedAt:10},{url:url('recent'),observedAt:20}]);
  await q.enqueue([{url:url('recent'),observedAt:20}],{single:true});
  await q.enqueue(jobs('missing2','missing1'));
  for(const job of [...active(h)])await q.observed(job.url,job.tabId);
  h.advance(X_QUEUE_INTERVAL);await q.tick();assert.deepEqual(active(h).map(j=>j.url),[url('missing1'),url('missing2'),url('old')]);
  assert.deepEqual(pending(h),[url('recent')]);
});
test('bulk and automatic detail re-enqueue do not repeat completed jobs during the same batch, including after restart',async()=>{
  const h=harness();await h.collector.enqueue(jobs('a','b','c','d','e'));
  const a=active(h)[0];await h.collector.observed(a.url,a.tabId);
  const q=h.restart();assert.equal((await q.enqueue(jobs('a','b','c','d','e'))).added,0);
  assert.equal((await q.enqueue(jobs('a'),{single:true})).added,0);
  for(const job of [...active(h)])await q.observed(job.url,job.tabId);
  h.advance(X_QUEUE_INTERVAL);await q.tick();assert.deepEqual(active(h).map(j=>j.url),[url('d'),url('e')]);
  assert.equal(h.values.xFollowerQueue.total,5);assert.equal(h.creates,5);
});
test('freshly supplied counts satisfy pending work and legacy jobs re-sort using saved metrics',async()=>{
  const h=harness();h.values.xFollowerQueue={schema:1,items:jobs('known','missing','updated'),active:null,phase:'paused',paused:true};
  h.observations[url('known')]=Date.now()-1000;
  // A queued request has since been fulfilled by a different tab or a Sheets sync.
  h.values.xFollowerQueue.items[2].requestedAt=1;h.observations[url('updated')]=2;
  await h.collector.resume();assert.equal(h.values.xFollowerQueue.schema,2);
  assert.deepEqual(active(h).map(j=>j.url),[url('missing'),url('known')]);assert.equal(h.values.xFollowerQueue.success,1);assert.equal(h.creates,2);
});
test('pausing all slots preserves pending work and retries untouched profiles before interrupted ones',async()=>{
  const h=harness(),q=h.collector;await q.enqueue(jobs('a','b','c','d','e','f'));await q.pause();
  assert.equal(h.pages.size,0);assert.equal(active(h).length,0);await q.tick();assert.equal(h.creates,3);
  h.advance(X_QUEUE_INTERVAL);await q.resume();assert.deepEqual(active(h).map(j=>j.url),[url('d'),url('e'),url('f')]);
  assert.deepEqual(pending(h),[url('a'),url('b'),url('c')]);
});
test('a single requested profile can run while the bulk queue remains paused',async()=>{
  const h=harness(),q=h.collector;await q.enqueue(jobs('a','b','c','d'));await q.pause();h.advance(X_QUEUE_INTERVAL);
  await q.enqueue(jobs('single'),{single:true});assert.deepEqual(active(h).map(j=>j.url),[url('single')]);
  await q.observed(url('single'),active(h)[0].tabId);assert.equal(h.values.xFollowerQueue.phase,'paused');assert.equal(pending(h).length,4);
});
test('all active slots survive worker restart and interrupted tab creation is recovered without duplicates',async()=>{
  const h=harness();await h.collector.enqueue(jobs('a','b','c','d'));
  const before=structuredClone(active(h));for(const job of before)h.pages.get(job.tabId).status='complete';
  await h.restart().tick();assert.equal(h.creates,3);assert.equal(h.probes.length,3);
  for(const a of active(h))a.tabId=null;
  await h.restart().tick();assert.equal(h.creates,3);assert.deepEqual(active(h).map(j=>j.tabId),before.map(j=>j.tabId));
  // The old one-slot queue is migrated without reopening its existing tab.
  h.values.xFollowerQueue={...h.values.xFollowerQueue,schema:1,active:before[0],items:[]};
  await h.restart().tick();assert.equal(h.creates,3);assert.equal(active(h)[0].tabId,before[0].tabId);
});
test('a lost pre-creation reservation is recovered and duplicate queue entries are removed',async()=>{
  const h=harness();h.values.xFollowerQueue={schema:1,active:{url:url('a'),token:'lost',tabId:null,deadline:Date.now()+60000},items:jobs('a','b','b')};
  await h.collector.tick();assert.deepEqual(active(h).map(j=>j.url),[url('a'),url('b')]);assert.equal(h.creates,2);
});
test('timeouts retry once after untouched profiles and continue through repeated failures to completion',async()=>{
  const h=harness();await h.collector.enqueue(jobs('a','b','c','d'));h.advance(X_QUEUE_TIMEOUT);await h.collector.tick();
  assert.equal(h.values.xFollowerQueue.failed,0);assert.equal(h.values.xFollowerQueue.retries,3);assert.equal(active(h)[0].url,url('d'));assert.equal(h.values.xFollowerQueue.paused,false);
  await h.collector.observed(url('d'),active(h)[0].tabId);
  for(let i=0;i<4&&h.values.xFollowerQueue.phase!=='complete';i++){h.advance(X_QUEUE_TIMEOUT);await h.collector.tick();}
  assert.equal(h.values.xFollowerQueue.phase,'complete');assert.equal(h.values.xFollowerQueue.success,1);assert.equal(h.values.xFollowerQueue.failed,3);assert.equal(h.values.xFollowerQueue.errors.length,3);assert.equal(h.creates,7);assert.equal(h.pages.size,0);assert.equal(h.alarms.has(X_QUEUE_ALARM),false);assert.equal(h.values.xFollowerCache,undefined);
});
test('login and rate limits still pause every slot without closing active or pinned tabs',async()=>{
  for(const change of ['login','rate-limit']){
    const h=harness();await h.collector.enqueue(jobs('a','b','c','d'));const [a,b,c]=structuredClone(active(h)),id=a.tabId;
    h.pages.get(b.tabId).active=true;h.pages.get(c.tabId).pinned=true;
    if(change==='login')h.pages.get(id).url='https://x.com/i/flow/login';
    if(change==='navigate')h.pages.get(id).pendingUrl='https://example.org/';
    if(change==='close')h.pages.delete(id);
    if(change==='rate-limit')await h.collector.blocked(id,'rate-limit');else await h.collector.tabChanged(id);
    assert.equal(h.values.xFollowerQueue.phase,'paused',change);assert.equal(h.removed.length,0,change);assert.equal(active(h).length,0);assert.equal(pending(h).length,4);
    if(change==='rate-limit')await assert.rejects(()=>h.collector.resume(),/待機/);
  }
});
test('a blocked slot retains its page while the other owned background tabs close',async()=>{
  const h=harness();await h.collector.enqueue(jobs('a','b','c'));const a=active(h)[0];await h.collector.blocked(a.tabId,'login');
  assert.equal(h.pages.size,1);assert.ok(h.pages.has(a.tabId));assert.equal(h.removed.length,2);assert.equal(pending(h).length,3);
});
test('revocation, deletion, unsafe URLs and removed links do not trigger new browsing',async()=>{
  const h=harness();await h.collector.enqueue([{url:'https://evil.test/x.com/one'},{url:url('removed')}]);assert.equal(h.creates,0);assert.equal(h.values.xFollowerQueue.skipped,1);
  h.enable(false);await assert.rejects(()=>h.collector.enqueue(jobs('a')),/許可/);h.enable(true);await h.collector.enqueue(jobs('a','b','c'));h.enable(false);await h.collector.tick();assert.equal(h.values.xFollowerQueue.phase,'paused');assert.equal(h.pages.size,0);
  await h.collector.clear();assert.equal(h.values.xFollowerQueue.total,0);assert.equal(h.values.xFollowerQueue.items.length,0);assert.equal(h.alarms.has(X_QUEUE_ALARM),false);
});
test('manual observations satisfy queued and active jobs without closing the user tab or counting twice',async()=>{
  const h=harness();await h.collector.enqueue(jobs('a','b','c','d'));await h.collector.observed(url('d'),999);
  const a=active(h)[0];await h.collector.observed(a.url,999);await h.collector.observed(a.url,a.tabId);
  assert.equal(h.values.xFollowerQueue.success,2);assert.equal(pending(h).length,0);assert.equal(h.creates,3);assert.deepEqual(h.removed,[a.tabId]);
});
test('an explicit refresh can repeat a completed profile, but missing users remain ahead',async()=>{
  const h=harness();await h.collector.enqueue(jobs('a','b','c','d','e','f'));const a=active(h)[0];await h.collector.observed(a.url,a.tabId);
  await h.collector.enqueue([{url:a.url,observedAt:1}],{single:true,force:true});h.advance(X_QUEUE_INTERVAL);await h.collector.tick();assert.equal(active(h).at(-1).url,url('d'));assert.ok(pending(h).includes(a.url));
});

test('a timed-out single request leaves a paused bulk queue stopped with no stale running state',async()=>{
  const h=harness();await h.collector.enqueue(jobs('a','b','c','d'));await h.collector.pause();h.advance(X_QUEUE_INTERVAL);
  await h.collector.enqueue(jobs('single'),{single:true});h.advance(X_QUEUE_TIMEOUT);await h.collector.tick();
  assert.equal(h.values.xFollowerQueue.retries,1);assert.equal(h.values.xFollowerQueue.phase,'running');
  h.advance(X_QUEUE_TIMEOUT);await h.collector.tick();
  assert.equal(h.values.xFollowerQueue.phase,'paused');assert.equal(h.values.xFollowerQueue.failed,1);assert.equal(h.alarms.has(X_QUEUE_ALARM),false);
});

test('a bulk run passes eleven successes and three unreadable profiles without a global pause',async()=>{
  const h=harness(),names=Array.from({length:27},(_,i)=>'person'+String(i).padStart(2,'0')),bad=new Set(names.slice(11,14).map(url));
  await h.collector.enqueue(jobs(...names));let collector=h.collector;
  for(let round=0;round<60&&h.values.xFollowerQueue.phase!=='complete';round++){
    for(const a of [...active(h)])if(!bad.has(a.url))await collector.observed(a.url,a.tabId);
    assert.equal(h.values.xFollowerQueue.paused,false);h.advance(X_QUEUE_INTERVAL);if(round===5)collector=h.restart();await collector.tick();
  }
  assert.equal(h.values.xFollowerQueue.phase,'complete');assert.equal(h.values.xFollowerQueue.success,24);assert.equal(h.values.xFollowerQueue.failed,3);assert.equal(h.values.xFollowerQueue.total,27);assert.equal(h.creates,30);assert.equal(h.values.xFollowerQueue.items.length,0);
});

test('each concurrency setting from one to ten drains a large queue and survives restart',async()=>{
  for(let limit=1;limit<=10;limit++){
    const h=harness();h.setConcurrency(limit);await h.collector.enqueue(jobs(...Array.from({length:37},(_,i)=>'profile'+i)));
    assert.equal(active(h).length,limit);const collector=h.restart();
    for(let round=0;round<40&&h.values.xFollowerQueue.phase!=='complete';round++){
      assert.ok(active(h).length<=limit);for(const a of [...active(h)])await collector.observed(a.url,a.tabId);h.advance(X_QUEUE_INTERVAL);await collector.tick();
    }
    assert.equal(h.values.xFollowerQueue.success,37);assert.equal(h.creates,37);assert.equal(h.values.xFollowerQueue.phase,'complete');
  }
});

test('changing concurrency drains existing jobs when reducing and uses added slots when increasing',async()=>{
  const h=harness();h.setConcurrency(10);await h.collector.enqueue(jobs(...Array.from({length:25},(_,i)=>'profile'+i)));h.setConcurrency(1);await h.collector.tick();h.advance(X_QUEUE_INTERVAL);
  for(const a of active(h).slice(0,9))await h.collector.observed(a.url,a.tabId);
  assert.equal(h.creates,10);assert.equal(active(h).length,1);const last=active(h)[0];await h.collector.observed(last.url,last.tabId);assert.equal(h.creates,11);assert.equal(active(h).length,1);
  h.setConcurrency(7);h.advance(X_QUEUE_INTERVAL);await h.collector.tick();assert.equal(active(h).length,7);assert.equal(h.values.xFollowerQueue.concurrency,7);
});

test('a closed or navigated tab fails only that item and preserves tabs no longer owned',async()=>{
  for(const mode of ['close','navigate']){
    const h=harness();await h.collector.enqueue(jobs('a','b','c','d'));const a=active(h)[0];
    if(mode==='close')h.pages.delete(a.tabId);else h.pages.get(a.tabId).url='https://example.org/';
    await h.collector.tabChanged(a.tabId);assert.equal(h.values.xFollowerQueue.failed,1);assert.equal(h.values.xFollowerQueue.paused,false);assert.equal(h.values.xFollowerQueue.errors[0].url,a.url);assert.equal(h.removed.includes(a.tabId),false);
    h.advance(X_QUEUE_INTERVAL);await h.collector.tick();assert.ok(active(h).some(j=>j.url===url('d')));for(const j of [...active(h)])await h.collector.observed(j.url,j.tabId);assert.equal(h.values.xFollowerQueue.phase,'complete');
  }
});

test('same-profile redirects do not pause a batch; recovered alarms retry interrupted dispatch',async()=>{
  const h=harness();await h.collector.enqueue(jobs('a','b','c','d'));const a=active(h)[0];h.pages.get(a.tabId).url=a.url;await h.collector.tick();assert.equal(h.values.xFollowerQueue.paused,false);assert.ok(active(h).some(j=>j.url===a.url));await h.collector.observed(a.url,a.tabId);assert.equal(h.removed.includes(a.tabId),false);
  const failure=harness();failure.failLatest(true);await assert.rejects(()=>failure.collector.enqueue(jobs('a','b')),/storage/);assert.ok(failure.alarms.has(X_QUEUE_ALARM));failure.failLatest(false);failure.advance(X_QUEUE_TIMEOUT);await failure.restart().tick();assert.equal(active(failure).length,2);
});

test('tab creation failures are bounded and cannot strand later pending profiles',async()=>{
  const h=harness();h.failCreate(true);await h.collector.enqueue(jobs('a','b','c','d'));
  for(let i=0;i<10&&h.values.xFollowerQueue.phase!=='complete';i++){h.advance(X_QUEUE_TIMEOUT);await h.collector.tick();}
  assert.equal(h.values.xFollowerQueue.phase,'complete');assert.equal(h.values.xFollowerQueue.failed,4);assert.equal(h.creates,8);assert.equal(h.values.xFollowerQueue.errors.length,4);
});
