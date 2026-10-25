import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecord } from '../extension/sync-format.js';
import { gasHarness } from './helpers/gas.mjs';

const accountId='usr_profileaccount001',userId='usr_profilefriend001';
test('profiles sync explicit X URLs while excluding image data and legacy readers',()=>{
  const gas=gasHarness(),profile=normalizeRecord('profiles',{accountId,userId,observedAt:Date.now(),urls:['https://x.com/example'],bio:'SECRET_BIO',auth:'SECRET_AUTH'});
  assert.ok(!JSON.stringify(profile).includes('SECRET_'));
  for(const url of ['javascript:alert(1)','https://x.com/home','https://x.com/user/status/1','https://evil.test/user'])assert.throws(()=>normalizeRecord('profiles',{...profile.value,urls:[url]}));
  const hello=gas.request({protocol:2,action:'hello'});
  assert.equal(hello.kinds.length,19);assert.ok(!hello.kinds.some(kind=>kind.startsWith('image')));
  const push=gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[profile]});assert.equal(push.accepted,1);
  assert.equal(gas.table('VRCProfiles').length,2);
  assert.equal(gas.request({action:'pull',cursor:0,limit:100}).records.length,0);
  assert.equal(gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:hello.kinds}).records.length,1);
  for(const kind of ['images','imageChunks']){
    assert.throws(()=>normalizeRecord(kind,{accountId,observedAt:Date.now()}));
    const rejected=gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[{kind,value:{accountId,observedAt:Date.now()}}]});
    assert.equal(rejected.code,'SCHEMA');
  }
});
test('latest profile checks survive history retention and an empty result removes stale links',()=>{
  const gas=gasHarness(),hello=gas.request({protocol:2,action:'hello'}),old=Date.now()-90*86400000;
  const send=record=>gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[record]});
  assert.equal(send(normalizeRecord('profiles',{accountId,userId,observedAt:old,urls:['https://x.com/example']})).accepted,1);
  gas.context.pruneRecords();
  const pull=()=>gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:['profiles']});
  assert.equal(pull().records.length,1);
  assert.equal(send(normalizeRecord('profiles',{accountId,userId,observedAt:Date.now(),urls:[]})).accepted,1);
  assert.deepEqual(pull().records[0].value.urls,[]);assert.equal(gas.table('VRCProfiles').length,2);
});
