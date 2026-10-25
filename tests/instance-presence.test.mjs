import test from 'node:test';
import assert from 'node:assert/strict';
import {currentUser,location} from '../extension/core.js';
import {instanceRoster,reconcileInstancePresence,sameInstance} from '../extension/instance-presence.js';
import {mergeRecord,decodeChecks} from '../extension/sync-format.js';
import {gasHarness} from './helpers/gas.mjs';
const accountId='usr_instanceowner001',userId='usr_instancepeer0001',collectorId='col_instancefixture001',place='wrld_instanceworld01:123~region(jp)',at=Date.now()-1200000,config={accountId,collectorId,pollSeconds:180},own={id:accountId,presence:'online',location:location(place)};
const raw={id:place,userCount:2,users:[{id:accountId,displayName:'Self'},{id:userId,displayName:'Visitor',authToken:'SECRET',email:'SECRET',userIcon:'SECRET'}],world:{name:'Test world',assetUrl:'SECRET'},nonce:'SECRET'};
const snapshot=(time=at,body=raw)=>instanceRoster(body,own,time);
test('instance API accepts only matching location and explicit users, and stores no unrelated profile data',()=>{
 const r=snapshot();assert.equal(r.available,true);assert.equal(r.complete,true);assert.equal(r.users.length,1);assert.ok(!JSON.stringify(r).includes('SECRET'));
 for(const body of [{...raw,id:place.replace('123','456')},{...raw,users:undefined},null,{...raw,users:[{id:'invalid',displayName:'Bad'}]}])assert.equal(snapshot(at,body).available,false);
 assert.equal(instanceRoster(raw,{...own,presence:'offline'},at).available,false);assert.equal(snapshot(at,{...raw,userCount:3}).complete,false);
 assert.equal(sameInstance({...own.location,instanceId:'invalid'}, {...own.location,instanceId:'different'}),false);
});
test('repeated observations update one interval with compact checks; absence stops at last confirmed presence',()=>{
 const first=reconcileInstancePresence([],snapshot(),config),next=reconcileInstancePresence(first,snapshot(at+180000),config);assert.equal(next.length,1);assert.equal(next[0].key,first[0].key);assert.equal(next[0].value.sampleCount,2);assert.deepEqual(decodeChecks(at,next[0].value.checks),[at,at+180000]);
 const end=reconcileInstancePresence(next,snapshot(at+360000,{...raw,userCount:1,users:[raw.users[0]]}),config);assert.equal(end[0].value.endedAt,at+180000);assert.equal(end[0].value.observedAt,at+360000);assert.equal(end[0].value.endReason,'absent');assert.equal(mergeRecord(next[0],end[0]).value.endReason,'absent');
});
test('unavailable or partial lists close observation continuity without claiming an exit, and stop/gaps do not extrapolate',()=>{
 const first=reconcileInstancePresence([],snapshot(),config);
 for(const s of [{at:at+180000,available:false},snapshot(at+180000,{...raw,users:[raw.users[0]]})]){const end=reconcileInstancePresence(first,s,config);assert.equal(end[0].value.endedAt,at);assert.equal(end[0].value.endReason,'unavailable');}
 const gap=reconcileInstancePresence(first,snapshot(at+800000),config);assert.equal(gap.length,2);assert.equal(gap[0].value.endReason,'gap');assert.equal(gap[0].value.endedAt,at);assert.equal(gap[1].value.startedAt,at+800000);
 assert.equal(reconcileInstancePresence(first,{at:at+1,available:false,reason:'stopped'},config)[0].value.endReason,'stopped');
 assert.equal(reconcileInstancePresence(first,snapshot(at-1),config).length,0);assert.equal(reconcileInstancePresence(first,{at:at+1,available:false},{...config,collectorId:'col_otherfixture01'}).length,0);
});
test('current-user presence can provide an explicit Quest location, never a home or another account location',()=>{
 const me=currentUser({id:accountId,displayName:'Self',presence:{id:accountId,world:'wrld_instanceworld01',instance:'123~region(jp)',platform:'android'},homeLocation:'wrld_homefixture001'},at);assert.equal(me.self.location.instanceId,'123~region(jp)');assert.equal(me.self.presence,'online');
 assert.equal(currentUser({id:accountId,location:'offline',presence:{world:'wrld_instanceworld01',instance:'123'}},at).self.location.kind,'offline');
 assert.equal(currentUser({id:accountId,presence:{id:userId,world:'wrld_instanceworld01',instance:'123'},homeLocation:'wrld_homefixture001'},at).self.location.kind,'unknown');
});
test('API observation intervals and check times survive GAS round-trip without extra rows',()=>{
 const gas=gasHarness(),hello=gas.request({protocol:2,action:'hello'}),first=reconcileInstancePresence([],snapshot(),config),next=reconcileInstancePresence(first,snapshot(at+180000),config),push=records=>gas.request({protocol:2,action:'push',datasetId:hello.datasetId,records});
 assert.equal(push(first).accepted,1);assert.equal(push(next).accepted,1);assert.equal(gas.table('VRCInstanceEncounters').length,2);
 const records=gas.request({protocol:2,action:'pull',datasetId:hello.datasetId,cursor:0,limit:100,kinds:['instanceEncounters'],since:0}).records;assert.equal(records[0].value.sampleCount,2);assert.equal(records[0].value.source,'vrchat-instance-api');assert.ok(!JSON.stringify(records).includes('SECRET'));
});
