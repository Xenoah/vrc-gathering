import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/x-followers-parser.js';
import {followerRecords,mergeFollowerCache,bestFollowerMetric,followerText} from '../extension/x-followers.js';
import {normalizeRecord} from '../extension/sync-format.js';
import {sortFriends} from '../extension/insights.js';
import {userStatus} from '../extension/user-status.js';
import {gasHarness} from './helpers/gas.mjs';
import {createSettingsBackup,resolveSettingsBackup} from '../extension/settings-backup.js';
const accountId='usr_followowner001',userId='usr_followfriend001',now=Date.now();
const metric=(followers,url='https://x.com/example',observedAt=now)=>normalizeRecord('xFollowers',{accountId,url,followers,observedAt,approximate:false,source:'x-profile'});

test('displayed X counts distinguish exact zero, rounded units and invalid values',()=>{
  const parse=globalThis.VRCFollowerParser.count;
  for(const [input,count,approximate] of [['0',0,false],['1,234',1234,false],['1.2K',1200,true],['２．５万',25000,true],['1.3M',1300000,true],['1億',100000000,true]])assert.deepEqual(parse(input),{followers:count,approximate},input);
  for(const input of ['','-1','1,23','1.2','NaN','1e9','1 following','9007199254740992','1.2.3K'])assert.equal(parse(input),null,input);
  assert.equal(globalThis.VRCFollowerParser.profile('/User_1/'),'https://x.com/user_1');
  for(const path of ['/home','/i','/example/status/1','/example/followers','/example%2fother'])assert.equal(globalThis.VRCFollowerParser.profile(path),'');
});
test('follower cache merges newer observations and keeps account and linked-profile boundaries',()=>{
  const first=metric(123),next=metric(456,first.value.url,now+1);
  let cache=mergeFollowerCache({},[first,next],now+1);cache=mergeFollowerCache(cache,[first],now+1);
  assert.equal(followerRecords(cache,now+1)[0].value.followers,456);
  const profiles={[accountId+'/'+userId]:{accountId,userId,urls:[first.value.url,'https://x.com/second'],checkedAt:now}};
  cache=mergeFollowerCache(cache,[metric(1000,'https://x.com/second')],now+1);
  assert.equal(bestFollowerMetric(profiles,cache,accountId,userId,now+1).followers,1000);
  assert.equal(bestFollowerMetric(profiles,cache,'usr_otherowner001',userId,now+1),null);
  profiles[accountId+'/'+userId].urls=[];assert.equal(bestFollowerMetric(profiles,cache,accountId,userId,now+1),null);
  assert.equal(followerText({...next.value,approximate:true}),'約456');assert.equal(followerText(null),'未取得');
});
test('follower sorts keep unknown values last in both directions, and zero is known',()=>{
  const rows=['unknown','zero','small','large'].map(id=>({id,displayName:id})),counts=new Map([['zero',0],['small',100],['large',10000]]);
  assert.deepEqual(sortFriends(rows,'followers-desc',new Map(),counts).map(v=>v.id),['large','small','zero','unknown']);
  assert.deepEqual(sortFriends(rows,'followers-asc',new Map(),counts).map(v=>v.id),['zero','small','large','unknown']);
});
test('offline presence overrides a cached Join Me or busy status',()=>{
  for(const status of ['join me','active','ask me','busy'])assert.equal(userStatus({presence:'offline',status}).key,'offline');
  assert.equal(userStatus({presence:'online',status:'join me'}).key,'join');
  assert.equal(userStatus({presence:'online',status:'new-status'}).key,'unknown');
});
test('GAS round-trips follower metrics separately from profile links and preserves latest counts',()=>{
  const gas=gasHarness(),hello=gas.request({protocol:2,action:'hello'}),record=metric(123456);
  const push=r=>gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records:[r]});
  assert.equal(push(record).accepted,1);assert.equal(gas.table('VRCXFollowers').length,2);
  assert.equal(push(metric(5,record.value.url,now-1000)).accepted,1);
  const rows=gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:['xFollowers']}).records;
  assert.equal(rows[0].value.followers,123456);assert.equal(gas.request({action:'pull',cursor:0,limit:100}).records.length,0);
  for(const update of [{followers:-1},{followers:1.5},{approximate:'false'},{url:'https://evil.test/example'},{source:'invented'}])assert.throws(()=>normalizeRecord('xFollowers',{...record.value,...update}));
});
test('settings backup carries the X opt-in and preserves existing preferences for older backups',()=>{
  const backup=createSettingsBackup({xFollowerSettings:{enabled:true}});
  assert.equal(resolveSettingsBackup(backup).xFollowerSettings.enabled,true);
  delete backup.settings.xFollowers;assert.equal(resolveSettingsBackup(backup).xFollowerSettings,undefined);
});
