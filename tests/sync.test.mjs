import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSync,syncSettings,createAccountUpdater,requestGas,serverRetryDeadline} from '../extension/sync.js';
import {canonical,normalizeRecord,newerRecord,mergeRecord,normalizeEnvelope} from '../extension/sync-format.js';
import {demoData} from '../extension/demo.js';
import {gasHarness,TOKEN} from './helpers/gas.mjs';

const endpoint='https://script.google.com/macros/s/test_deployment/exec';
function fixture(){const d=demoData();return [...d.friends.map(v=>normalizeRecord('friends',v)),...d.events.map(v=>normalizeRecord('events',v)),...d.worlds.map(v=>normalizeRecord('worlds',{...v,accountId:d.accountId}))];}
function client(server,records=[],override,options={}){
  let clock=Date.now();
  const store={cloudSync:{enabled:true,endpoint,token:TOKEN},settings:{retentionDays:30}}, rows=new Map(records.map(r=>[r.key,r])),calls=[];
  const storage={get:async keys=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in store).map(k=>[k,store[k]]))),set:async value=>Object.assign(store,structuredClone(value))};
  const fetcher=async(url,options)=>{calls.push({url,options});if(override)return override(url,options);return {ok:true,json:async()=>server.request(JSON.parse(options.body))};};
  const service=createSync({...options,storage,now:()=>clock,fetcher,exportRecords:async()=>structuredClone([...rows.values()]),mergeRecords:async records=>{for(const r of records)rows.set(r.key,structuredClone(mergeRecord(r,rows.get(r.key))));}});
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
  const a=client(gas,fixture(),async(url,options)=>{const body=JSON.parse(options.body), response=gas.request(body);if(lose&&body.action==='push'){lose=false;throw Error('offline');}return{ok:true,json:async()=>response};});
  await assert.rejects(a.sync(),/通信できません/);assert.equal(a.rows.size,fixture().length);assert.equal(a.store.cloudState.phase,'error');
  const calls=a.calls.length;const skipped=await a.sync();assert.equal(skipped.reason,'backoff');assert.equal(skipped.retrySource,'client');assert.equal(skipped.retryAt,a.store.cloudState.retryAt);assert.equal(a.calls.length,calls);
  await a.sync({force:true});assert.equal(gas.cells.length,fixture().length+1);assert.equal(a.store.cloudState.phase,'ready');
});
test('simultaneous sync calls share one operation and malformed pages do not advance the cursor',async()=>{
  const gas=gasHarness(), a=client(gas,[],async(url,options)=>({ok:true,json:async()=>{const body=JSON.parse(options.body);return body.action==='hello'?gas.request(body):{ok:true,protocol:2,datasetId:gas.request({protocol:2,action:'hello'}).datasetId,records:[],cursor:0,hasMore:true};}}));
  const first=a.sync(),second=a.sync();assert.equal(first,second);await assert.rejects(first,/ページ情報/);
  assert.equal(a.store.cloudCheckpoint,undefined);assert.equal(a.calls.length,2);
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
  await a.pause();assert.deepEqual(await a.sync(),{skipped:true,reason:'paused'});assert.equal(a.calls.length,0);
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


test('v2 capabilities, typed tables, stable dataset identity and legacy clients coexist',()=>{
  const gas=gasHarness(),hello=gas.request({protocol:2,action:'hello'});
  assert.equal(hello.protocol,2);assert.ok(hello.recordSchemas.includes(2));assert.equal(hello.datasetId,gas.request({protocol:2,action:'hello'}).datasetId);
  gas.request({action:'push',records:fixture()});
  assert.ok(gas.table('VRCFriends').length>1);assert.ok(gas.table('VRCEvents').length>1);assert.ok(gas.table('VRCWorlds').length>1);
  assert.equal(gas.table('VRCFriends')[0][11],'schema_version');assert.equal(gas.table('VRCFriends')[1][11],2);
  assert.equal(gas.request({protocol:2,datasetId:'wrong',action:'pull',cursor:0,limit:100}).code,'DATASET');
  assert.equal(gas.request({protocol:2,datasetId:hello.datasetId,action:'pull',cursor:0,limit:100}).records.length,fixture().length);
});
test('legacy table migration preserves keys/revisions and resumes idempotently without deleting originals',()=>{
  const gas=gasHarness(),records=fixture(),header=['key','version','kind','accountId','observedAt','displayName','presence','worldId','instanceId','worldName','payload'];
  const rows=records.map((r,i)=>[r.key,i+1,r.kind,r.value.accountId,r.value.observedAt,'','','','','',canonical(r.value)]);
  gas.seed('VRCRecords',[header,...rows]);gas.properties.SYNC_SEQUENCE='100';
  gas.context.setup();gas.context.setup();assert.equal(gas.cells.length,records.length+1);assert.equal(gas.table('VRCRecords').length,records.length+1);
  assert.equal(gas.request({action:'pull',cursor:100,limit:100}).cursor,100);
  assert.deepEqual(new Set(gas.request({action:'pull',cursor:0,limit:100}).records.map(r=>r.key)),new Set(records.map(r=>r.key)));
  // Simulate a timeout after copying some tables but before marking migration complete.
  gas.table('VRCSchema')[3][1]='false';gas.table('VRCEvents').splice(1);gas.context.setup();assert.equal(gas.cells.length,records.length+1);
  gas.request({action:'push',records:[normalizeRecord('friends',{...records[0].value,observedAt:Date.now()})]});assert.ok(gas.cells.some(r=>r[1]>100));
});
test('dataset change resets upload receipts and cursors and resynchronizes existing local records',async()=>{
  const gas=gasHarness(),a=client(gas,fixture());await a.sync();const old=a.store.cloudCheckpoint.datasetId;
  gas.properties.SPREADSHEET_ID='replacement-sheet';a.advance(61000);await a.sync();
  assert.notEqual(a.store.cloudCheckpoint.datasetId,old);assert.equal(gas.cells.length,fixture().length+1);assert.equal(a.store.cloudState.uploaded,fixture().length);
});
test('new clients fall back only on explicit legacy protocol rejection',async()=>{
  const gas=gasHarness(),a=client(gas,fixture(),async(url,options)=>{const body=JSON.parse(options.body);return {ok:true,json:async()=>body.protocol===2?{protocol:1,ok:false,code:'REQUEST'}:gas.request(body)};});
  await a.sync();assert.equal(a.store.cloudState.protocol,1);assert.match(a.store.cloudState.message,/旧GAS/);assert.equal(gas.cells.length,fixture().length+1);
  const b=client(gas,[],async()=>({ok:true,json:async()=>({protocol:1,ok:false,code:'AUTH'})}));await assert.rejects(b.sync(),/同期キー/);assert.equal(b.calls.length,1);
});
test('future schemas/operations are rejected atomically; namespaces survive legacy upserts and convergent merges',async()=>{
  const gas=gasHarness(),record=fixture()[0],extra=normalizeRecord(record.kind,{...record.value,extensions:{'example.notes':{label:'saved',tags:['a']}}});
  assert.equal(gas.request({action:'push',records:[record,{...record,schemaVersion:3}]}).code,'SCHEMA');assert.equal(gas.cells.length,1);
  assert.throws(()=>normalizeEnvelope({...record,operation:'delete'}),/SCHEMA/);
  assert.throws(()=>normalizeEnvelope({...record,key:'forged'}),/SCHEMA/);
  assert.throws(()=>normalizeRecord(record.kind,{...record.value,extensions:{bad:'unscoped'}}),/SCHEMA/);
  assert.throws(()=>normalizeRecord(record.kind,{...record.value,extensions:{'example.notes':'x'.repeat(8001)}}),/SCHEMA/);
  gas.request({action:'push',records:[extra]});
  const legacy={kind:record.kind,value:{...record.value,observedAt:record.value.observedAt+1,displayName:'Updated'}};
  gas.request({action:'push',records:[legacy]});const got=gas.request({action:'pull',cursor:0,limit:100}).records[0];
  assert.equal(got.value.extensions['example.notes'].label,'saved');assert.equal(got.value.displayName,'Updated');
  const a=normalizeRecord(record.kind,{...record.value,extensions:{'example.a':1}}),b=normalizeRecord(record.kind,{...record.value,extensions:{'example.b':2}});
  assert.equal(canonical(mergeRecord(a,b)),canonical(mergeRecord(b,a)));
  assert.throws(()=>mergeRecord(normalizeRecord(record.kind,{...record.value,extensions:{'example.a':'a'.repeat(4500)}}),normalizeRecord(record.kind,{...record.value,extensions:{'example.b':'b'.repeat(4500)}})),/SCHEMA/);
});

test('GAS expands sheet grids beyond the default 1000 rows during migration',()=>{
  const gas=gasHarness(),sample=fixture()[0];
  const header=['key','version','kind','accountId','observedAt','displayName','presence','worldId','instanceId','worldName','payload'];
  const records=Array.from({length:1200},(_,i)=>normalizeRecord('friends',{...sample.value,id:'usr_gridfriend'+String(i).padStart(5,'0')}));
  gas.seed('VRCRecords',[header,...records.map((r,i)=>[r.key,i+1,r.kind,r.value.accountId,r.value.observedAt,'','','','','',canonical(r.value)])]);
  gas.context.setup();assert.equal(gas.table('VRCFriends').length,1201);
});
test('copying a spreadsheet creates a new cursor domain and migration sequence survives removing the backup',()=>{
  const gas=gasHarness(),sample=fixture()[0];gas.request({action:'push',records:[sample]});
  const hello=gas.request({protocol:2,action:'hello'}),registry=structuredClone(gas.table('VRCSchema')),friends=structuredClone(gas.table('VRCFriends'));
  gas.properties.SPREADSHEET_ID='copied-sheet';gas.seed('VRCSchema',registry);gas.seed('VRCFriends',friends);
  assert.notEqual(gas.request({protocol:2,action:'hello'}).datasetId,hello.datasetId);
  const legacy=gasHarness(),header=['key','version','kind','accountId','observedAt','displayName','presence','worldId','instanceId','worldName','payload'];
  legacy.seed('VRCRecords',[header]);legacy.properties.SYNC_SEQUENCE='77';legacy.context.setup();
  // An empty legacy backup has no record revision from which to recover the retained cursor.
  legacy.properties.SYNC_SEQUENCE='0';assert.equal(legacy.request({action:'pull',cursor:77,limit:100}).cursor,77);
});


test('GAS setup identifies invalid properties while public errors disclose only CONFIG',()=>{
  const cases=[['SPREADSHEET_ID','',/SPREADSHEET_ID が未設定/],['SYNC_TOKEN','short-secret-15',/SYNC_TOKEN.*現在 15 文字/],['SYNC_TOKEN','x'.repeat(257),/現在 257 文字/],['RETENTION_DAYS','0',/RETENTION_DAYS.*1〜365/],['RETENTION_DAYS','1.5',/RETENTION_DAYS.*整数/]];
  for(const [name,value,expected] of cases){const gas=gasHarness();gas.properties[name]=value;assert.throws(()=>gas.context.setup(),expected);const result=gas.request({action:'hello'});assert.deepEqual(result,{protocol:2,ok:false,code:'CONFIG'});assert.equal(gas.opens,0);assert.ok(!JSON.stringify(gas.logs).includes('short-secret-15'));}
});
test('createSyncToken generates a valid key without printing it and does not overwrite valid existing keys',()=>{
  const gas=gasHarness();gas.properties.SYNC_TOKEN='short';const message=gas.context.createSyncToken(),key=gas.properties.SYNC_TOKEN;
  assert.match(key,/^[a-f0-9]{64}$/);assert.match(message,/生成・保存/);assert.ok(!message.includes(key));assert.ok(!JSON.stringify(gas.logs).includes(key));gas.context.setup();
  assert.match(gas.context.createSyncToken(),/上書きしません/);assert.equal(gas.properties.SYNC_TOKEN,key);
  delete gas.properties.SYNC_TOKEN;gas.context.createSyncToken();assert.notEqual(gas.properties.SYNC_TOKEN,key);
});
test('HTML and Google login redirects produce the dedicated public access guidance with sanitized diagnostics',async()=>{
  for(const response of [
    {ok:true,status:200,url:'https://script.google.com/macros/s/test/exec',headers:new Headers({'Content-Type':'text/html'})},
    {ok:true,status:200,url:'https://accounts.google.com/v3/signin?continue=secret',headers:new Headers({'Content-Type':'application/json'})},
    {ok:false,status:403,url:'https://script.google.com/macros/s/test/exec',headers:new Headers({'Content-Type':'text/html'})},
  ]){
    let parsed=false;const a=client(gasHarness(),[],async()=>({...response,json:async()=>{parsed=true;throw Error('must not parse');}}));
    await assert.rejects(a.sync(),/公開範囲が「全員」/);assert.equal(parsed,false);assert.equal(a.store.cloudState.lastResponse.responseCode,'PUBLIC_ACCESS');assert.equal(a.store.cloudState.lastResponse.httpStatus,response.status);assert.ok(!JSON.stringify(a.store.cloudState).includes('continue='));assert.match(a.store.cloudState.lastError,/新バージョン/);
  }
});
test('a connection test sends only hello, leaves records/checkpoints intact and stores safe response details',async()=>{
  const gas=gasHarness(),records=fixture();gas.request({action:'push',records});
  const a=client(gas,records,async(url,options)=>({ok:true,status:200,url:'https://script.googleusercontent.com/macros/echo?user_content_key=temporary_secret#fragment',headers:new Headers({'Content-Type':'application/json'}),json:async()=>gas.request(JSON.parse(options.body))}));
  a.store.cloudSync.enabled=false;
  const result=await a.testConnection();assert.equal(result.connected,true);assert.equal(a.calls.length,1);assert.equal(JSON.parse(a.calls[0].options.body).action,'hello');
  assert.equal(a.store.cloudCheckpoint,undefined);assert.equal(a.rows.size,records.length);assert.equal(gas.cells.length,records.length+1);
  assert.equal(a.store.cloudDiagnostic.finalUrl,'https://script.googleusercontent.com/macros/echo');assert.equal(a.store.cloudDiagnostic.httpStatus,200);assert.equal(a.store.cloudDiagnostic.responseCode,'OK');
  const text=JSON.stringify(a.store.cloudDiagnostic);assert.ok(!text.includes(TOKEN));assert.ok(!text.includes('temporary_secret'));
});
test('connection tests report missing permissions, invalid settings, wrong keys, legacy GAS and network failures',async()=>{
  const gas=gasHarness(),denied=client(gas,[],undefined,{hasPermission:async()=>false});
  assert.equal((await denied.testConnection()).diagnostic.responseCode,'PERMISSION');assert.equal(denied.calls.length,0);
  await assert.rejects(denied.sync({force:true}),/接続権限/);assert.equal(denied.calls.length,0);assert.equal(denied.store.cloudState.lastResponse.responseCode,'PERMISSION');
  const missing=client(gas);missing.store.cloudSync.token='short';assert.equal((await missing.testConnection()).diagnostic.responseCode,'SETTINGS');assert.equal(missing.calls.length,0);
  const wrong=client(gas);wrong.store.cloudSync.token='a'.repeat(32);assert.equal((await wrong.testConnection()).diagnostic.responseCode,'AUTH');assert.equal(wrong.calls.length,1);
  const old=client(gas,[],async()=>({ok:true,status:200,json:async()=>({protocol:1,ok:false,code:'REQUEST'})}));assert.equal((await old.testConnection()).diagnostic.phase,'legacy');assert.equal(old.calls.length,1);
  const offline=client(gas,[],async()=>{throw Error(TOKEN);});assert.equal((await offline.testConnection()).diagnostic.responseCode,'NETWORK');assert.ok(!JSON.stringify(offline.store.cloudDiagnostic).includes(TOKEN));
});
test('manual retries bypass client backoff but both probes and sync honor the server deadline',async()=>{
  const gas=gasHarness();let failure=true;
  const a=client(gas,[],async(url,options)=>failure?{ok:false,status:503,headers:new Headers({'Retry-After':'10'})}:{ok:true,json:async()=>gas.request(JSON.parse(options.body))});
  await assert.rejects(a.sync(),/503/);const deadline=a.store.cloudState.serverRetryAt;
  assert.equal((await a.sync({force:true})).retryAt,deadline);assert.equal((await a.testConnection()).reason,'backoff');assert.equal(a.calls.length,1);
  a.advance(11000);failure=false;assert.equal((await a.sync()).retrySource,'client');assert.equal((await a.testConnection()).connected,true);await a.sync({force:true});assert.equal(a.store.cloudState.phase,'ready');assert.equal(a.store.cloudState.lastError,'');
  const probe=client(gas,[],async()=>({ok:false,status:429,headers:new Headers({'Retry-After':'3600'})}));await probe.testConnection();assert.equal((await probe.sync({force:true})).retrySource,'server');assert.equal(probe.calls.length,1);
  assert.equal(serverRetryDeadline({retryAt:123,message:'同期サーバーに接続できません。HTTP 429'}),123);assert.equal(serverRetryDeadline({retryAt:123,message:'GASがJSONを返しませんでした。'}),0);
});
test('connection tests share active work and do not overlap synchronization',async()=>{
  const gas=gasHarness();let finish;const wait=new Promise(resolve=>{finish=resolve;});
  const a=client(gas,[],async(url,options)=>{await wait;return {ok:true,json:async()=>gas.request(JSON.parse(options.body))};});
  const first=a.testConnection();assert.equal(first,a.testConnection());assert.equal((await a.sync()).reason,'busy');finish();await first;assert.equal(a.calls.length,1);
  await a.pause();assert.equal((await a.testConnection()).reason,'paused');
});
