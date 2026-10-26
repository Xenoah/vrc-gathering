import test from 'node:test';
import assert from 'node:assert/strict';
import {websiteOwnLocation,readOwnLocationCard} from '../extension/own-location-web.js';
import {currentUser} from '../extension/core.js';

const uid='usr_ownfixture0001',wid='wrld_webfixture001',me=currentUser({id:uid},1000);
const card={accountId:uid,worldId:wid,instanceId:'123~region(jp)~nonce(SECRET)',worldName:'Fixture world',token:'SECRET',friendCount:1};
const signal=()=>new AbortController().signal;
function harness(values=[card],tabs=[{id:1,url:'https://vrchat.com/home'}]){
  const requests=[];
  return {requests,chrome:{tabs:{query:async()=>tabs,get:async id=>tabs.find(t=>t.id===id)},scripting:{executeScript:async req=>{requests.push(req);return [{frameId:0,result:values[requests.length-1]}];}}}};
}
test('website capture is owner-bound, top-frame isolated and only returns sanitized current location',async()=>{
  const h=harness(),r=await websiteOwnLocation(h.chrome,me,signal());
  assert.equal(r.self.location.instanceId,'123~region(jp)');assert.equal(r.self.location.worldId,wid);
  assert.equal(r.self.extensions['vrc.location'].source,'vrchat-website');assert.equal(r.worldName,'Fixture world');
  assert.ok(!JSON.stringify(r).includes('SECRET'));assert.ok(!JSON.stringify(r).includes('friendCount'));
  assert.deepEqual(h.requests[0].target,{tabId:1,frameIds:[0]});assert.deepEqual(h.requests[0].args,[uid]);assert.equal(h.requests[0].world,'ISOLATED');assert.equal(h.requests[0].func,readOwnLocationCard);
});
test('explicit API locations, private, offline and traveling are not replaced by stale website data',async()=>{
  for(const location of ['private','offline','traveling',wid+':123']){
    const h=harness();assert.equal(await websiteOwnLocation(h.chrome,currentUser({id:uid,location},1000),signal()),null);assert.equal(h.requests.length,0);
  }
  const h=harness();assert.ok(await websiteOwnLocation(h.chrome,currentUser({id:uid,state:'active'},1000),signal()));
});
test('a known API world can get its missing instance from the matching own card only',async()=>{
  const h=harness(),known=currentUser({id:uid,location:wid},1000);
  assert.equal((await websiteOwnLocation(h.chrome,known,signal())).self.location.instanceId,'123~region(jp)');
  const mismatch=harness([{...card,worldId:'wrld_otherfixture01'}]);assert.equal(await websiteOwnLocation(mismatch.chrome,known,signal()),null);
});
test('website boundary rejects missing/invalid owner and instance, hostile origins and conflicting tabs',async()=>{
  for(const value of [null,{...card,accountId:'usr_otherfixture01'},{...card,worldId:'wrong'},{...card,instanceId:'private'},{...card,instanceId:'1'.repeat(1025)}]){
    const h=harness([value]);assert.equal(await websiteOwnLocation(h.chrome,me,signal()),null);
  }
  for(const url of ['https://vrchat.com.evil.test/home','http://vrchat.com/home','https://vrchat.com/home-fake','https://vrchat.com/api/1/auth/user']){
    const h=harness([card],[{id:1,url}]);assert.equal(await websiteOwnLocation(h.chrome,me,signal()),null);assert.equal(h.requests.length,0);
  }
  const tabs=[{id:1,url:'https://vrchat.com/home'},{id:2,url:'https://vrchat.com/home/user/'+uid}];
  const bad=harness([card,{...card,instanceId:'456'}],tabs);assert.equal(await websiteOwnLocation(bad.chrome,me,signal()),null);
  const good=harness([card,card],tabs);assert.equal((await websiteOwnLocation(good.chrome,me,signal())).self.location.instanceId,'123~region(jp)');
});
test('recheck stays on the original tab and missing scripting, closed tabs and aborts fail safely',async()=>{
  const h=harness();assert.ok(await websiteOwnLocation(h.chrome,me,signal(),1));
  assert.equal(await websiteOwnLocation({tabs:{}},me,signal()),null);
  h.chrome.tabs.get=async()=>{throw Error('closed');};assert.equal(await websiteOwnLocation(h.chrome,me,signal(),1),null);
  const controller=new AbortController();controller.abort();await assert.rejects(websiteOwnLocation(h.chrome,me,controller.signal));
});
