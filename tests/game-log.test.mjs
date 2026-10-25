import test from 'node:test';
import assert from 'node:assert/strict';
import {createLogParser,logLine,logSourceId,summarizeLogEncounters} from '../extension/game-log.js';
import {normalizeRecord,mergeRecord,HISTORY_KINDS} from '../extension/sync-format.js';
import {gasHarness,TOKEN} from './helpers/gas.mjs';
import {createSync} from '../extension/sync.js';
const accountId='usr_logowner0001',visitor='usr_logvisitor001',world='wrld_logworld0001',sourceId='log_'+'a'.repeat(64),day='2026.01.01',base=Date.UTC(2026,0,1,1),now=Date.UTC(2026,0,2);
const line=(minute,body)=>`${day} 10:${String(minute).padStart(2,'0')}:00 Log - ${body}`;
function parse(lines,opts={}){const p=createLogParser({accountId,sourceId,now,...opts});for(const v of lines)p.feed(v);return p.finish();}
const join=(id=visitor,name='Visitor')=>`[Behaviour] OnPlayerJoined ${name} (${id})`;
const leave=(id=visitor,name='Visitor')=>`[Behaviour] OnPlayerLeft ${name} (${id})`;
const room=`[Behaviour] Joining ${world}:123~region(jp)~nonce(SECRET_NONCE)`;
const session=()=>parse([line(0,room),line(1,join()),line(11,leave())]).rows[0];

test('PC logs retain only own-instance intervals, exclude self and preserve Unicode names safely',()=>{
 const r=parse([line(0,`User Authenticated: Self (${accountId})`),line(0,'[Behaviour] Entering Room: Test world'),line(0,room),line(0,join(accountId,'Self')),line(1,join(visitor,'日本語 <img>')),line(2,'[Chat] SECRET_CHAT'),line(3,'[API] authToken=SECRET_TOKEN'),line(11,leave(visitor,'日本語 <img>'))]);
 assert.equal(r.rows.length,1);const v=r.rows[0];assert.equal(v.displayName,'日本語 <img>');assert.equal(v.worldName,'Test world');assert.equal(v.startedAt,base+60000);assert.equal(v.endedAt,base+660000);assert.equal(v.accountBinding,'log');assert.equal(v.endReason,'left');assert.ok(!JSON.stringify(r).includes('SECRET'));assert.equal(v.location.instanceId,'123~region(jp)');
});
test('rejoin, world change and quit close intervals without carrying the previous world name',()=>{
 const r=parse([line(0,'[Behaviour] Entering Room: First'),line(0,room),line(1,join()),line(2,join()),line(3,leave()),line(4,join()),line(5,`[Behaviour] Joining ${world}:124`),line(6,join()),line(7,'VRCApplication: OnApplicationQuit at 10.5')]);
 assert.equal(r.rows.length,3);assert.deepEqual(r.rows.map(v=>v.endReason),['left','world-change','quit']);assert.equal(r.rows[2].worldName,'');assert.equal(r.open,0);
});
test('missing exit stops at final log timestamp, never parser wall-clock; self leaving ends all',()=>{
 const open=parse([line(0,room),line(1,join()),line(5,'[Other] heartbeat')]);assert.equal(open.rows[0].endedAt,null);assert.equal(open.rows[0].lastSeenAt,base+300000);assert.equal(open.open,1);
 const exited=parse([line(0,room),line(1,join()),line(5,leave(accountId,'Self')),line(6,join())]);assert.equal(exited.rows.length,1);assert.equal(exited.rows[0].endReason,'self-left');
 assert.equal(parse([line(0,room),line(1,join()),line(5,'[Behaviour] OnPlayerLeftRoom')]).rows[0].endReason,'self-left');
});
test('old logs do not merge name-only identities across sessions and local-player markers exclude self',()=>{
 const r=parse([line(0,room),line(1,'[NetworkManager] OnPlayerJoined Old Self'),line(1,'[Player] Initialized PlayerAPI "Old Self" is local'),line(2,'[NetworkManager] OnPlayerJoined Name'),line(2,'[NetworkManager] OnPlayerJoined Name'),line(3,'[NetworkManager] OnPlayerLeft Name'),line(4,'[NetworkManager] OnPlayerJoined Name'),line(5,'[NetworkManager] OnPlayerLeft Name')]);
 assert.equal(r.rows.length,2);assert.equal(r.ambiguous,1);assert.ok(r.rows.every(v=>v.userId===''));assert.equal(summarizeLogEncounters(r.rows,{accountId,until:now}).length,2);
 const sameName=parse([line(0,room),line(1,join(visitor,'Name')),line(1,join('usr_logvisitor002','Name')),line(2,'[Behaviour] OnPlayerLeft Name')]);assert.equal(sameName.ambiguous,1);assert.equal(sameName.open,2);
});
test('missing worlds, invalid dates, backward timestamps and account mismatch cannot fabricate valid intervals',()=>{
 assert.equal(parse([line(1,join())]).rows.length,0);assert.equal(parse([line(0,'[Behaviour] Joining '+world+':bad'),line(1,join())]).rows.length,0);
 assert.equal(logLine('2026.02.30 10:00:00 Log - '+room),null);assert.equal(logLine('2026.01.01 25:00:00 Log - '+room),null);
 assert.throws(()=>parse([line(0,room),line(1,join()),line(2,'User Authenticated: Other (usr_logother0001)')]),/異なり/);
 const r=parse([line(0,room),line(3,join()),line(2,leave())]);assert.equal(r.rows[0].endedAt,null);assert.equal(r.ignored,1);
 assert.throws(()=>parse([line(0,room)],{now:base-600000}),/未来/);assert.throws(()=>parse([],{offsetMinutes:900}));
});
test('timezone rollover and optional epoch logcat parsing are explicit',()=>{
 assert.equal(logLine('2026.01.01 00:00:00 Log - '+room).at,Date.UTC(2025,11,31,15));assert.equal(logLine(line(0,room),{offsetMinutes:0}).at,base+9*3600000);
 const epoch=base/1000,r=parse([`${epoch}.123 12 13 I Unity : ${room}`,`${epoch+1}.123 12 13 I Unity : ${join()}`,`${epoch+61}.123 12 13 I Unity : ${leave()}`],{format:'logcat'});
 assert.equal(r.rows[0].device,'quest');assert.equal(r.rows[0].endedAt-r.rows[0].startedAt,60000);assert.equal(parse([`${epoch}.123 12 13 I Unity : ${room}`]).rows.length,0);
});
test('source fingerprints and row IDs remain stable on append; different sources and accounts stay separate',async()=>{
 assert.equal(await logSourceId('file','first'),await logSourceId('file','first'));assert.notEqual(await logSourceId('other','first'),await logSourceId('file','first'));
 const a=parse([line(0,room),line(1,join())]).rows[0],b=session();assert.equal(a.id,b.id);assert.equal(mergeRecord(normalizeRecord('instanceEncounters',a),normalizeRecord('instanceEncounters',b)).value.endedAt,b.endedAt);
 assert.notEqual(normalizeRecord('instanceEncounters',a).key,normalizeRecord('instanceEncounters',{...a,accountId:'usr_logowner0002'}).key);
});
test('summary unions duplicate/overlapping evidence, clips selected range, and filters using current roster only',()=>{
 const a=session(),b={...a,id:'otherrecord001',startedAt:base+120000,lastSeenAt:base+720000,endedAt:base+720000,observedAt:base+720000},c={...a,id:'otherrecord002',startedAt:base+120000,lastSeenAt:base+720000,endedAt:base+720000,observedAt:base+720000,location:{...a.location,instanceId:'999'}};
 const result=summarizeLogEncounters([a,b,c],{accountId,since:base+300000,until:base+600000});assert.equal(result.length,1);assert.equal(result[0].duration,300000);assert.equal(result[0].count,2);assert.equal(result[0].sessions[0].records.length,2);
 const friends=[{accountId,id:visitor,isFriend:true}];assert.equal(summarizeLogEncounters([a],{accountId,friends,relation:'nonfriend'}).length,0);assert.equal(summarizeLogEncounters([a],{accountId,friends,relation:'friend'}).length,1);assert.equal(summarizeLogEncounters([a],{accountId:'usr_logowner0002'}).length,0);
 assert.equal(summarizeLogEncounters([a],{accountId,query:'visitor',worldId:world,device:'pc'}).length,1);assert.equal(summarizeLogEncounters([a],{accountId,device:'quest'}).length,0);assert.equal(summarizeLogEncounters([{...a,userId:''}],{accountId,relation:'nonfriend'}).length,0);
});
test('schema strips extra fields and join tokens, validates intervals and closed evidence wins over partial replay',()=>{
 const a=session(),n=normalizeRecord('instanceEncounters',{...a,token:'SECRET',raw:'SECRET',location:{...a.location,instanceId:'123~region(jp)~nonce(SECRET)~unknown(SECRET)'}});assert.ok(!JSON.stringify(n).includes('SECRET'));assert.ok(HISTORY_KINDS.includes('instanceEncounters'));
 for(const value of [{...a,userId:accountId},{...a,source:'api'},{...a,device:'quest'},{...a,endedAt:a.startedAt},{...a,endReason:''},{...a,sourceId:'bad'},{...a,lastSeenAt:a.startedAt-1}])assert.throws(()=>normalizeRecord('instanceEncounters',value));
 const partial=normalizeRecord('instanceEncounters',{...a,endedAt:null,endReason:'',lastSeenAt:a.lastSeenAt+60000,observedAt:a.observedAt+60000});assert.deepEqual(mergeRecord(n,partial),mergeRecord(partial,n));assert.equal(mergeRecord(n,partial).value.endedAt,a.endedAt);
});
test('GAS stores, deduplicates, restores and expires log intervals with formula-safe display names',()=>{
 const gas=gasHarness();gas.properties.RETENTION_DAYS='0';const hello=gas.request({protocol:2,action:'hello'}),r=normalizeRecord('instanceEncounters',{...session(),displayName:'=1+1'}),send=records=>gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records});
 assert.ok(hello.kinds.includes('instanceEncounters'));assert.equal(send([r]).accepted,1);send([r]);const sheet=gas.table('VRCInstanceEncounters');assert.equal(sheet.length,2);assert.equal(sheet[1][sheet[0].indexOf('display_name')],"'=1+1");assert.equal(sheet[1][sheet[0].indexOf('source_id')],sourceId);
 const restored=gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:['instanceEncounters'],since:0});assert.equal(restored.records[0].value.userId,visitor);gas.properties.RETENTION_DAYS='1';gas.context.pruneRecords();assert.equal(gas.table('VRCInstanceEncounters').length,1);
});
test('older GAS leaves log records pending until upgrade, then restores the same row to an empty client',async()=>{
 const gas=gasHarness();gas.properties.RETENTION_DAYS='0';let upgraded=false;const at=Date.now()-60000,record=normalizeRecord('instanceEncounters',{...session(),startedAt:at-60000,lastSeenAt:at,endedAt:at,observedAt:at}),rows=new Map([[record.key,record]]),values={cloudSync:{enabled:true,endpoint:'https://script.google.com/macros/s/test/exec',token:TOKEN},settings:{retentionDays:30}};
 const storage={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])),set:async v=>Object.assign(values,structuredClone(v))};
 const sync=createSync({storage,exportRecords:async()=>[...rows.values()],mergeRecords:async rs=>rs.forEach(r=>rows.set(r.key,mergeRecord(r,rows.get(r.key)))),fetcher:async(url,options)=>{const body=JSON.parse(options.body),result=gas.request(body);if(body.action==='hello'&&!upgraded)result.kinds=result.kinds.filter(k=>k!=='instanceEncounters');return {ok:true,json:async()=>result};}});
 await sync.sync({force:true});assert.equal(values.cloudState.unsupported,1);upgraded=true;await sync.sync({force:true});assert.equal(values.cloudState.phase,'ready');assert.equal(gas.table('VRCInstanceEncounters').length,2);rows.clear();values.cloudCheckpoint={cursor:0,receipts:{}};await sync.sync({force:true});assert.equal(rows.size,1);assert.equal(rows.get(record.key).value.endedAt,record.value.endedAt);
});
