import test from 'node:test';
import assert from 'node:assert/strict';
import { officialNote,noteChanges,noteChecks } from '../extension/user-notes.js';
import { normalizeRecord,mergeRecord,ARCHIVE_KINDS,HISTORY_KINDS } from '../extension/sync-format.js';
import { gasHarness,TOKEN } from './helpers/gas.mjs';
import { createSync } from '../extension/sync.js';
const accountId='usr_notesaccount001',userId='usr_notesfriend001',at=Date.now()-10000;
const raw={id:'unt_note000001',userId:accountId,targetUserId:userId,note:'20250309 kakuteishinkoku_World',createdAt:new Date(at-1000).toISOString(),targetUser:{id:userId,displayName:'Friend'},token:'SECRET',userIcon:'SECRET'};
test('official list and individual note parsing preserves text and rejects absent fields, wrong owners and malformed data',()=>{
  const list=officialNote(raw,accountId,at);assert.equal(list.note,raw.note);assert.equal(list.createdAt,at-1000);assert.equal(list.noteId,raw.id);assert.ok(!JSON.stringify(list).includes('SECRET'));
  assert.equal(officialNote({id:userId,note:''},accountId,at,{targetId:userId}).note,'');
  for(const value of [null,{}, {...raw,userId:'usr_someotherowner'}, {...raw,note:null}, {...raw,note:'a'.repeat(8001)}, {...raw,id:'bad'}, {...raw,createdAt:'bad'}])assert.throws(()=>officialNote(value,accountId,at));
  assert.throws(()=>officialNote({id:userId},accountId,at,{targetId:userId}));assert.throws(()=>officialNote({id:accountId,note:'wrong'},accountId,at,{targetId:userId}));
  const body='  行1\r\n<script>alert(1)</script>  ';assert.equal(officialNote({...raw,note:body},accountId,at).note,body);
});
test('repeated checks update the same snapshot and only changed text adds history; explicit empty text records clearing',()=>{
  const first=noteChanges([],[officialNote(raw,accountId,at)]);assert.equal(first.length,2);const snapshot=first.find(r=>r.kind==='userNotes');
  const unchanged=noteChanges(first,[officialNote(raw,accountId,at+1)]);assert.equal(unchanged.length,1);assert.equal(unchanged[0].key,snapshot.key);assert.equal(unchanged[0].value.changedAt,at);assert.equal(unchanged[0].value.observedAt,at+1);
  const renamed=noteChanges(unchanged,[officialNote({...raw,targetUser:{displayName:'Rename'}},accountId,at+2)]);assert.equal(renamed.length,1);
  const edited=noteChanges(renamed,[officialNote({id:userId,note:'Changed'},accountId,at+3,{targetId:userId})]);assert.equal(edited.length,2);assert.equal(edited[0].value.createdAt,null);assert.equal(edited[0].value.noteId,'');
  const empty=noteChanges(edited,[officialNote({id:userId,note:''},accountId,at+4,{targetId:userId})]);assert.equal(empty.length,2);assert.equal(empty[0].value.note,'');assert.equal(empty[0].key,snapshot.key);
  assert.equal(noteChanges(empty,[officialNote(raw,accountId,at)]).length,0);assert.equal(noteChanges(empty,[officialNote({id:userId,note:''},accountId,at+5,{targetId:userId})]).length,1);
});
test('notes are account scoped, checks are bounded, and restoring an earlier value is another change',()=>{
  const first=noteChanges([],[officialNote(raw,accountId,at)]),edit=noteChanges(first,[officialNote({...raw,note:'B'},accountId,at+1)]),back=noteChanges(edit,[officialNote(raw,accountId,at+2)]);
  assert.equal(back.length,2);assert.notEqual(back[1].key,first[1].key);
  const other=noteChanges(first,[officialNote({...raw,userId:'usr_notesaccount002'},'usr_notesaccount002',at+3)]);assert.equal(other.length,2);assert.notEqual(other[0].key,first[0].key);
  let checks={};for(let i=0;i<510;i++)checks=noteChecks(checks,accountId,'usr_friend'+i,at+i);assert.equal(Object.keys(checks).length,500);assert.ok(checks[accountId+':usr_friend509']);
  assert.ok(ARCHIVE_KINDS.includes('userNotes'));assert.ok(HISTORY_KINDS.includes('userNoteHistory'));
});
test('GAS stores official snapshots and change-only history, escapes formula text and preserves cleared latest values after retention',()=>{
  const gas=gasHarness(),hello=gas.request({protocol:2,action:'hello'}),old=Date.now()-90*86400000;
  const first=noteChanges([],[officialNote({...raw,note:'=1+1',createdAt:new Date(old).toISOString()},accountId,old)]);
  const send=records=>gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records});assert.equal(send(first).accepted,2);const sheet=gas.table('VRCUserNotes');assert.equal(sheet[1][sheet[0].indexOf('note_text')],"'=1+1");send(first);assert.equal(sheet.length,2);assert.equal(gas.table('VRCUserNoteHistory').length,2);
  const deleted=noteChanges(first,[officialNote({id:userId,note:''},accountId,old+1,{targetId:userId})]);send(deleted);send(first);gas.context.pruneRecords();
  const records=gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:['userNotes','userNoteHistory'],since:Date.now()-86400000}).records;
  assert.equal(records.length,1);assert.equal(records[0].value.note,'');assert.equal(records[0].kind,'userNotes');assert.equal(gas.request({action:'pull',cursor:0,limit:100}).records.length,0);
});
test('older GAS keeps notes pending; upgrading sends both types and restores them to an empty client',async()=>{
  const gas=gasHarness();gas.properties.RETENTION_DAYS='0';let upgraded=false;const records=noteChanges([],[officialNote(raw,accountId,at)]),rows=new Map(records.map(r=>[r.key,r]));
  const values={cloudSync:{enabled:true,endpoint:'https://script.google.com/macros/s/test/exec',token:TOKEN},settings:{retentionDays:30}},storage={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])),set:async v=>Object.assign(values,structuredClone(v))};
  const sync=createSync({storage,exportRecords:async()=>[...rows.values()],mergeRecords:async rs=>rs.forEach(r=>rows.set(r.key,mergeRecord(r,rows.get(r.key)))),fetcher:async(url,options)=>{const body=JSON.parse(options.body),result=gas.request(body);if(body.action==='hello'&&!upgraded)result.kinds=result.kinds.filter(k=>!['userNotes','userNoteHistory'].includes(k));return {ok:true,json:async()=>result};}});
  await sync.sync({force:true});assert.equal(values.cloudState.unsupported,2);upgraded=true;await sync.sync({force:true});assert.equal(values.cloudState.phase,'ready');assert.equal(gas.table('VRCUserNotes').length,2);
  rows.clear();values.cloudCheckpoint={cursor:0,receipts:{}};await sync.sync({force:true});assert.equal(rows.size,2);assert.equal(rows.get(records[0].key).value.note,raw.note);
});
