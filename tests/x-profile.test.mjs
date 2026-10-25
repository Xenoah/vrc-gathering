import test from 'node:test';
import assert from 'node:assert/strict';
import {xProfileURL,extractXProfiles,readXCache,writeXCache,X_CACHE_LIMIT,xCacheKey} from '../extension/x-profile.js';

test('X links accept explicit profiles and normalize Twitter, mobile, case and tracking parameters',()=>{
  for(const input of ['https://x.com/Test_User','http://twitter.com/Test_User/','https://www.twitter.com/Test_User?lang=ja','mobile.twitter.com/Test_User','https://m.x.com/Test_User#bio'])assert.equal(xProfileURL(input),'https://x.com/test_user');
  for(const input of ['@test_user','javascript:alert(1)','https://x.com.evil.test/test','https://evil.test/x.com/test','https://x.com@evil.test/test','https://evil@x.com/test','https://x.com:444/test','https://x.com/test/status/123','https://twitter.com/intent/tweet?url=a','https://x.com/i','https://x.com/search?q=name','https://x.com/abcdefghijklmnop','https://x.com/test/../other','https://x.com/te\nst','https://x.com/%74est','https://x.com/test\\','https://x.com/'])assert.equal(xProfileURL(input),'',input);
});
test('public bio link extraction never guesses handles or resolves third-party links',()=>{
  const raw={bioLinks:['https://twitter.com/First?utm_source=vrc','https://x.com/FIRST','javascript:evil','https://example.com/owner'],bio:'X: @no_guess\nhttps://x.com/Second。 Twitter：mobile.twitter.com/Third\nhttps://evil.test/path:x.com/not_owner https://x.com/Four/status/123',authToken:'SECRET',email:'SECRET'};
  assert.deepEqual(extractXProfiles(raw),['https://x.com/first','https://x.com/second','https://x.com/third']);
  assert.equal(extractXProfiles({bio:'@mentionのみ'}).length,0);
  assert.equal(extractXProfiles({bioLinks:Array.from({length:10},(_,i)=>'https://x.com/user'+i)}).length,5);
  assert.ok(!JSON.stringify(extractXProfiles(raw)).includes('SECRET'));
});
test('X cache is account-scoped, rejects future timestamps and unsafe links, and retains the newest 500',()=>{
  const now=100000,entry={accountId:'owner',userId:'friend',checkedAt:now,urls:['https://x.com/safe','javascript:evil']};
  let cache=writeXCache({},entry,now);
  assert.deepEqual(readXCache(cache,'owner','friend',now).urls,['https://x.com/safe']);
  assert.equal(readXCache(cache,'other','friend',now),null);assert.equal(readXCache(cache,'owner','friend',now-1),null);
  cache=Object.fromEntries(Array.from({length:X_CACHE_LIMIT},(_,i)=>{const v={...entry,userId:String(i)};return[xCacheKey(v.accountId,v.userId),v];}));
  cache=writeXCache(cache,entry,now);assert.equal(Object.keys(cache).length,X_CACHE_LIMIT);assert.ok(readXCache(cache,'owner','friend',now));
});
