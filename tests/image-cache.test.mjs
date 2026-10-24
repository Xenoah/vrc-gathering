import test from 'node:test';
import assert from 'node:assert/strict';
import {imageSource,imageCandidate,createImageCollector,IMAGE_INPUT_BYTES,IMAGE_TTL} from '../extension/image-cache.js';
const source='https://api.vrchat.cloud/api/1/file/file_01234567-abcd-1234-abcd-012345678901/1/file';
function harness(fetcher,options={}){
  let clock=1000000000;const key='account:user:usr_user0001',rows=new Map([[key,{key,url:source,lastSeenAt:clock}]]),calls=[];
  const store={list:async()=>[...rows.values()],update:async(k,fn)=>{const value=fn(rows.get(k));if(value)rows.set(k,value);},trim:async(...args)=>calls.push(args)};
  const collector=createImageCollector({store,fetcher,transform:async blob=>blob,delay:async()=>{},now:()=>clock,...options});
  return {...collector,rows,key,calls,advance:ms=>{clock+=ms;}};
}
test('image sources are restricted and expiring signed URLs/credentials are never persisted',()=>{
  assert.equal(imageSource(source+'?token=secret#fragment'),source);
  for(const url of ['https://evil.test/file.png','http://api.vrchat.cloud/a','https://x:password@api.vrchat.cloud/api/1/file/file_01234567/1/file','https://api.vrchat.cloud/api/1/auth/user','https://files.vrchat.cloud/image?signature=secret','data:image/png;base64,AA','https://api.vrchat.cloud:8443/api/1/file/file_01234567/1/file'])assert.equal(imageSource(url),'');
  assert.deepEqual(imageCandidate({id:'usr_user0001',userIcon:'https://evil.test/icon',currentAvatarThumbnailImageUrl:source,authToken:'secret'},'user'),{kind:'user',id:'usr_user0001',url:source});
  assert.equal(imageCandidate({id:'bad',thumbnailImageUrl:source},'world'),null);
});
test('cache shares concurrent work, reuses stored bytes, refreshes by TTL and ignores deleted entries',async()=>{
  let requests=0;const h=harness(async()=>{requests++;return new Response(new Blob(['image'],{type:'image/png'}));});
  assert.equal(h.collect(),h.collect());await h.idle();assert.equal(requests,1);assert.equal(h.rows.get(h.key).blob.size,5);
  await h.collect();assert.equal(requests,1);h.advance(IMAGE_TTL+1);await h.collect();assert.equal(requests,2);
  const erased=harness(async()=>{erased.rows.clear();return new Response(new Blob(['image'],{type:'image/png'}));});await erased.collect();assert.equal(erased.rows.size,0);
  assert.deepEqual(h.calls[0].slice(0,2),[32*1024*1024,1000]);
});
test('oversize/unsupported responses and HTTP Retry-After do not store image bytes',async()=>{
  for(const response of [()=>new Response('html',{headers:{'Content-Type':'text/html'}}),()=>new Response('large',{headers:{'Content-Type':'image/png','Content-Length':String(IMAGE_INPUT_BYTES+1)}}),()=>new Response(new Uint8Array(IMAGE_INPUT_BYTES+1),{headers:{'Content-Type':'image/png'}})]){
    const h=harness(async()=>response());await h.collect();assert.equal(h.rows.get(h.key).blob,undefined);assert.ok(h.rows.get(h.key).retryAt>1000000000);}
  let calls=0;const h=harness(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'86400'}});});await h.collect();assert.equal(h.rows.get(h.key).retryAt,1000000000+86400000);h.advance(3600000);await h.collect();assert.equal(calls,1);
});
test('pause aborts active downloads and prevents repopulating a cleared cache',async()=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});
  const h=harness(async(url,{signal})=>{started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)));});
  const active=h.collect();await ready;await h.pause();await active;assert.equal(h.rows.get(h.key).blob,undefined);assert.deepEqual(await h.collect(),{skipped:true});
});
