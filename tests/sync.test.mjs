import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSync,syncSettings,createAccountUpdater} from '../extension/sync.js';
import {canonical,normalizeRecord,newerRecord} from '../extension/sync-format.js';
import {demoData} from '../extension/demo.js';
import {gasHarness,TOKEN} from './helpers/gas.mjs';

const endpoint='https://script.google.com/macros/s/test_deployment/exec';
function fixture(){const d=demoData();return [...d.friends.map(v=>normalizeRecord('friends',v)),...d.events.map(v=>normalizeRecord('events',v)),...d.worlds.map(v=>normalizeRecord('worlds',{...v,accountId:d.accountId}))];}
function client(server,records=[],override){
  let clock=Date.now();
  const store={cloudSync:{enabled:true,endpoint,token:TOKEN},settings:{retentionDays:30}}, rows=new Map(records.map(r=>[r.key,r])),calls=[];
  const storage={get:async keys=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in store).map(k=>[k,store[k]]))),set:async value=>Object.assign(store,structuredClone(value))};
  const fetcher=async(url,options)=>{calls.push({url,options});if(override)return override(url,options);return {ok:true,json:async()=>server.request(JSON.parse(options.body))};};
  const service=createSync({storage,now:()=>clock,fetcher,exportRecords:async()=>structuredClone([...rows.values()]),mergeRecords:async records=>{for(const r of records)if(newerRecord(r,rows.get(r.key)))rows.set(r.key,structuredClone(r));}});
  return {...service,store,rows,calls,advance:ms=>{clock+=ms;}};
}

test('GAS protocol is generated from the same validator used by the extension',()=>{
  const source=fs.readFileSync(new URL('../extension/sync-format.js',import.meta.url),'utf8');
  const generated=fs.readFileSync(new URL('../gas/Protocol.gs',import.meta.url),'utf8');
  assert.equal(generated.split('\n').slice(1).join('\n'),source.replaceAll('export ',''));
});
test('sync settings restrict destinations and enforce a nonempty strong shared key',()=>{
  assert.throws(()=>syncSettings({enabled:true,endpoint:'http://example.com',token:TOKEN}));
  assert.throws(()=>syncSettings({enabled:true,endpoint,token:'short'}));
  assert.equal(syncSettings({enabled:true,endpoint,token:TOKEN}).endpoint,endpoint);
  assert.equal(syncSettings().enabled,false);
});
test('normalization removes secrets/local IDs, validates times and clears remembered private worlds',()=>{
  const r=fixture()[0], input={...r.value,key:50,authToken:'secret',email:'secret',location:{...r.value.location,kind:'private'}};
  const n=normalizeRecord('friends',input);
  assert.ok(!JSON.stringify(n).includes('secret'));assert.ok(!('key' in n.value));assert.equal(n.value.location.worldId,'');
  assert.throws(()=>normalizeRecord('friends',{...input,observedAt:Date.now()+600000}));
  assert.throws(()=>normalizeRecord('friends',{...input,accountId:'bad'}));
});
test('GAS rejects unauthenticated requests before opening the spreadsheet',()=>{
  const gas=gasHarness();assert.equal(gas.request({token:'wrong',action:'pull',cursor:0,limit:100}).code,'AUTH');assert.equal(gas.opens,0);
});
test('GAS writes idempotently, escapes formula cells and paginates without skipping records',()=>{
  const gas=gasHarness(), record=fixture()[0];record.value.displayName='=IMPORTXML("bad")';
  assert.equal(gas.request({action:'push',records:[record,record]}).accepted,2);assert.equal(gas.cells.length,2);
  assert.equal(gas.cells[1][5],"'=IMPORTXML(\"bad\")");
  const version=gas.cells[1][1];gas.request({action:'push',records:[record]});assert.equal(gas.cells[1][1],version);
  const rows=fixture().slice(1);gas.request({action:'push',records:rows});
  let cursor=0,collected=[];
  for(let i=0;i<50;i++){const page=gas.request({action:'pull',cursor,limit:2});assert.equal(page.ok,true);collected.push(...page.records);cursor=page.cursor;if(!page.hasMore)break;}
  assert.equal(new Set(collected.map(r=>r.key)).size,fixture().length);
  assert.equal(gas.request({action:'pull',cursor,limit:100}).records.length,0);
});
test('two clients exchange snapshots and history with account separation and no duplicate events',async()=>{
  const gas=gasHarness(), a=client(gas,fixture()), b=client(gas);
  await a.sync();await b.sync();assert.equal(b.rows.size,a.rows.size);
  const old=fixture()[0], newer={...old,value:{...old.value,observedAt:old.value.observedAt+1000,location:{kind:'private',worldId:'',instanceId:'',access:'',region:''}}};
  b.rows.set(newer.key,newer);b.advance(61000);await b.sync();a.advance(61000);await a.sync();
  assert.equal(a.rows.get(old.key).value.location.kind,'private');
  const other=normalizeRecord('friends',{...old.value,accountId:'usr_otheraccount0001'});a.rows.set(other.key,other);a.advance(61000);await a.sync();b.advance(61000);await b.sync();
  assert.ok(b.rows.has(other.key));assert.ok(b.rows.has(old.key));
  const count=gas.cells.length;b.advance(61000);await b.sync();assert.equal(gas.cells.length,count);
  for(const call of a.calls){assert.equal(call.options.credentials,'omit');assert.equal(call.options.method,'POST');assert.ok(!call.url.includes(TOKEN));}
});
test('a lost acknowledgement is retried safely and failures retain local records with backoff',async()=>{
  const gas=gasHarness();let lose=true;
  const a=client(gas,fixture(),async(url,options)=>{const body=JSON.parse(options.body), response=gas.request(body);if(lose){lose=false;throw Error('offline');}return{ok:true,json:async()=>response};});
  await assert.rejects(a.sync(),/offline/);assert.equal(a.rows.size,fixture().length);assert.equal(a.store.cloudState.phase,'error');
  const calls=a.calls.length;await a.sync({force:true});assert.equal(a.calls.length,calls);
  a.advance(61000);await a.sync();assert.equal(gas.cells.length,fixture().length+1);assert.equal(a.store.cloudState.phase,'ready');
});
test('simultaneous sync calls share one operation and malformed pages do not advance the cursor',async()=>{
  const gas=gasHarness(), a=client(gas,[],async()=>({ok:true,json:async()=>({ok:true,protocol:1,records:[],cursor:0,hasMore:true})}));
  const first=a.sync(),second=a.sync();assert.equal(first,second);await assert.rejects(first,/ページ情報/);
  assert.equal(a.store.cloudCheckpoint,undefined);assert.equal(a.calls.length,1);
});
test('old cloud observations are ignored according to local retention',async()=>{
  const gas=gasHarness(), record=fixture()[0];record.value.observedAt=Date.now()-3*86400000;record.value.firstObservedAt=record.value.observedAt;record.value.stateFirstObservedAt=record.value.observedAt;
  gas.request({action:'push',records:[record]});const a=client(gas);a.store.settings.retentionDays=1;await a.sync();assert.equal(a.rows.size,0);
});
test('retention deletes expired sheet rows without resetting incremental sequence',()=>{
  const gas=gasHarness(), record=fixture()[0];record.value.observedAt=Date.now()-3*86400000;
  gas.request({action:'push',records:[record]});const cursor=gas.request({action:'pull',cursor:0,limit:100}).cursor;
  gas.properties.RETENTION_DAYS='1';gas.context.pruneRecords();assert.equal(gas.cells.length,1);
  const page=gas.request({action:'pull',cursor,limit:100});assert.equal(page.ok,true);assert.equal(page.cursor,cursor);
});
test('sync settings changes can pause new work until active requests drain',async()=>{
  const gas=gasHarness(), a=client(gas,fixture());
  await a.pause();assert.deepEqual(await a.sync(),{skipped:true});assert.equal(a.calls.length,0);
  a.resume();await a.sync();assert.ok(a.calls.length>0);
});
test('pagination and batch splitting exchange more than one request of history',async()=>{
  const gas=gasHarness(), sample=fixture()[0], records=Array.from({length:235},(_,i)=>normalizeRecord('friends',{...sample.value,id:'usr_bulkfriend'+String(i).padStart(5,'0')}));
  const a=client(gas,records);await a.sync();assert.equal(a.store.cloudState.uploaded,235);
  const b=client(gas);await b.sync();assert.equal(b.rows.size,235);assert.equal(b.store.cloudState.phase,'ready');
  assert.ok(a.calls.filter(c=>JSON.parse(c.options.body).action==='push').every(c=>JSON.parse(c.options.body).records.length<=100));
});
test('HTTP Retry-After is respected even for manual sync',async()=>{
  const gas=gasHarness(), a=client(gas,fixture(),async()=>({ok:false,status:429,headers:new Headers({'Retry-After':'86400'})}));
  await assert.rejects(a.sync(),/429/);assert.ok(a.store.cloudState.retryAt-a.store.cloudState.lastAttemptAt>=86400000);
  a.advance(3600000);await a.sync({force:true});assert.equal(a.calls.length,1);
});
test('GAS validates a complete batch before writing and resolves equal-time conflicts deterministically',()=>{
  const gas=gasHarness(), record=fixture()[0];
  assert.equal(gas.request({action:'push',records:[record,{kind:'friends',value:{}}]}).ok,false);
  assert.equal(gas.cells.length,1);
  const a={...record,value:{...record.value,displayName:'A'}}, z={...record,value:{...record.value,displayName:'Z'}};
  gas.request({action:'push',records:[z,a]});
  const got=gas.request({action:'pull',cursor:0,limit:100}).records[0];assert.equal(got.value.displayName,'Z');
});

test('collection and sync account metadata updates serialize without losing either account',async()=>{
  let meta={};
  const storage={get:async()=>({accountMeta:structuredClone(meta)}),set:async value=>{meta=structuredClone(value.accountMeta);}};
  const update=createAccountUpdater(storage);
  await Promise.all([update(accounts=>({...accounts,local:{displayName:'Local'}})),update(accounts=>({...accounts,remote:{displayName:'Remote'}}))]);
  assert.deepEqual(Object.keys(meta).sort(),['local','remote']);
  await assert.rejects(update(()=>{throw Error('failed update');}));
  await update(accounts=>({...accounts,third:{displayName:'Third'}}));assert.equal(Object.keys(meta).length,3);
});
