export const IMAGE_ORIGINS = ['https://api.vrchat.cloud/*', 'https://files.vrchat.cloud/*'];
export const IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
export const IMAGE_CACHE_COUNT = 1000;
export const IMAGE_TTL = 7 * 86400000;
export const IMAGE_INPUT_BYTES = 2 * 1024 * 1024;
const IMAGE_HOSTS = new Set(['vrchat.com','api.vrchat.cloud','files.vrchat.cloud']);

export function imageSource(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !IMAGE_HOSTS.has(url.hostname)) return '';
    if (url.hostname === 'files.vrchat.cloud') {
      // Expiring signed CDN URLs are only followed in memory, never retained as source references.
      if (url.search || !url.pathname.startsWith('/')) return '';
    } else if (!/^\/api\/1\/(?:file|image)\/file_[a-zA-Z0-9-]{8,64}\/\d+(?:\/(?:file|\d+))?$/.test(url.pathname)) return '';
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return ''; }
}
export function imageCandidate(raw, kind) {
  const fields = kind === 'user' ? ['userIcon','profilePicOverrideThumbnail','currentAvatarThumbnailImageUrl'] : ['thumbnailImageUrl','imageUrl'];
  const validId = kind === 'user' ? /^(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/ : /^wrld_[a-zA-Z0-9-]{8,64}$/;
  if (!validId.test(raw?.id || '')) return null;
  const url = fields.map(field => imageSource(raw[field])).find(Boolean);
  return url ? {kind, id:raw.id, url} : null;
}
export async function thumbnail(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 16777216) throw Error('Image dimensions exceed limit');
    const canvas = new OffscreenCanvas(128,128), context = canvas.getContext('2d');
    const side = Math.min(bitmap.width,bitmap.height);
    context.drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,128,128);
    return await canvas.convertToBlob({type:'image/png'});
  } finally { bitmap.close(); }
}
async function boundedBlob(response) {
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(type)) throw Error('Unsupported image type');
  if (Number(response.headers.get('Content-Length')) > IMAGE_INPUT_BYTES) throw Error('Image too large');
  const reader = response.body?.getReader();
  if (!reader) { const blob=await response.blob(); if(blob.size>IMAGE_INPUT_BYTES)throw Error('Image too large'); return blob; }
  const chunks=[]; let length=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>IMAGE_INPUT_BYTES)throw Error('Image too large');chunks.push(value);}
  } catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  return new Blob(chunks,{type});
}
export function createImageCollector({store,fetcher=(...args)=>fetch(...args),transform=thumbnail,now=()=>Date.now(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),canRun=()=>true}) {
  let active,suspended=false,controller;
  async function collect() {
    controller=new AbortController();
    const jobs=(await store.list()).filter(v=>v.url && (v.retryAt||0)<=now() && (!v.blob || v.cachedUrl!==v.url || now()-(v.fetchedAt||0)>=IMAGE_TTL))
      .sort((a,b)=>(b.lastSeenAt||0)-(a.lastSeenAt||0)).slice(0,12);
    let saved=0,failed=0;
    for(const [i,job] of jobs.entries()) {
      if(suspended || !await canRun())break;
      if(i)await delay(2200);
      if(suspended)break;
      try {
        if(imageSource(job.url)!==job.url)throw Error('Unsupported image source');
        const response=await fetcher(job.url,{method:'GET',credentials:'include',redirect:'follow',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!response.ok) {const error=Error('Image unavailable');const retry=response.headers.get('Retry-After');error.retryMs=/^\d+$/.test(retry||'')?Number(retry)*1000:Math.max(0,Date.parse(retry)-now())||0;throw error;}
        if(response.url){const url=new URL(response.url);if(url.protocol!=='https:'||!IMAGE_HOSTS.has(url.hostname))throw Error('Unsupported image destination');}
        const blob=await transform(await boundedBlob(response));
        if(!(blob instanceof Blob) || blob.size>128*128*4+4096)throw Error('Invalid thumbnail');
        controller.signal.throwIfAborted();
        await store.update(job.key,current=>current?.url===job.url?{...current,blob,bytes:blob.size,cachedUrl:job.url,fetchedAt:now(),retryAt:0,failures:0}:current);
        saved++;
      } catch(error) {
        if(controller.signal.aborted)break;
        failed++;
        await store.update(job.key,current=>current?.url===job.url?{...current,failures:(current.failures||0)+1,retryAt:now()+Math.max(error.retryMs||0,Math.min(86400000,300000*2**Math.min(current.failures||0,8)))}:current);
      }
    }
    await store.trim(IMAGE_CACHE_BYTES,IMAGE_CACHE_COUNT,now()-30*86400000);
    const rows=await store.list();
    return {saved,failed,count:rows.filter(r=>r.blob).length,bytes:rows.reduce((n,r)=>n+(r.bytes||0),0),pending:rows.filter(r=>!r.blob||r.cachedUrl!==r.url).length,updatedAt:now()};
  }
  return {collect(){if(suspended)return Promise.resolve({skipped:true});if(!active)active=collect().finally(()=>{active=null;});return active;},async idle(){await active?.catch(()=>{});},async pause(){suspended=true;controller?.abort();await active?.catch(()=>{});},resume(){suspended=false;}};
}
