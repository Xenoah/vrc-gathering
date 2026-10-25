import { normalizeRecord, mergeRecord, canonical, RESEARCH_KINDS, ARCHIVE_KINDS } from './sync-format.js';
import { expandRuns } from './observation-series.js';
let opening;
export function db() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const req = indexedDB.open('vrc-friends-observer', 4);
    req.onupgradeneeded = event => {
      const d = req.result;
      if (event.oldVersion < 1) {
      const friends = d.createObjectStore('friends', { keyPath: ['accountId', 'id'] });
      friends.createIndex('account', 'accountId');
      friends.createIndex('observed', 'observedAt');
      const events = d.createObjectStore('events', { keyPath: 'key', autoIncrement: true });
      events.createIndex('accountTime', ['accountId', 'observedAt']);
      events.createIndex('observed', 'observedAt');
      const worlds = d.createObjectStore('worlds', { keyPath: ['accountId', 'id'] });
      worlds.createIndex('account', 'accountId');
      worlds.createIndex('observed', 'observedAt');
      const runs = d.createObjectStore('runs', { keyPath: 'key', autoIncrement: true });
      runs.createIndex('accountTime', ['accountId', 'observedAt']);
      runs.createIndex('observed', 'observedAt');
      }
      if (event.oldVersion < 2) {
        const images = d.createObjectStore('imageCache', {keyPath:'key'});
        images.createIndex('account', 'accountId');
      }
      if (event.oldVersion < 3) {
        for(const name of ['visits','encounters']) {
          const store=d.createObjectStore(name,{keyPath:name==='visits'?['accountId','startedAt']:['accountId','userId','startedAt']});
          store.createIndex('account','accountId');store.createIndex('observed','observedAt');
        }
      }
      if(event.oldVersion<4){
        for(const name of ['research','archiveCache']){
          const store=d.createObjectStore(name,{keyPath:'key'});store.createIndex('account','value.accountId');store.createIndex('observed','value.observedAt');store.createIndex('accountTime',['value.accountId','value.observedAt']);
          if(name==='research'){store.createIndex('active',['value.accountId','open']);store.createIndex('kind','kind');}else store.createIndex('cached','cachedAt');
        }
      }
    };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); opening = null; }; resolve(req.result); };
    req.onerror = () => { opening = null; reject(req.error); };
  });
  return opening;
}
const result = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存が中断されました。')); });
export async function list(store, accountId) {
  const d = await db();
  const s=d.transaction(store).objectStore(store);
  return result(s.index(s.indexNames.contains('account')?'account':'accountTime').getAll(s.indexNames.contains('account')?accountId:IDBKeyRange.bound([accountId,0],[accountId,Number.MAX_SAFE_INTEGER])));
}
export async function activeSeries(accountId){const d=await db();return result(d.transaction('research').objectStore('research').index('active').getAll([accountId,1]));}
export async function researchKind(kind,accountId){const d=await db(),rows=await result(d.transaction('research').objectStore('research').index('kind').getAll(kind));return accountId?rows.filter(r=>r.value.accountId===accountId):rows;}
export async function readResearch(accountId,since=0){
  const d=await db(),tx=d.transaction(['research','archiveCache']),range=IDBKeyRange.bound([accountId,since],[accountId,Number.MAX_SAFE_INTEGER]);
  const batches=await Promise.all(['research','archiveCache'].map(name=>result(tx.objectStore(name).index('accountTime').getAll(range)))),records=new Map();
  for(const r of batches.flat())if(RESEARCH_KINDS.includes(r.kind))records.set(r.key,mergeRecord(r,records.get(r.key)));return [...records.values()];
}
export async function timeline(store, accountId, { before = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) {
  const d = await db();
  const range = IDBKeyRange.bound([accountId, 0], [accountId, before]);
  return new Promise((resolve, reject) => {
    const items = [];
    const req = d.transaction(store).objectStore(store).index('accountTime').openCursor(range, 'prev');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { const c = req.result; if (!c || items.length >= limit) return resolve(items); items.push(c.value); c.continue(); };
  });
}
export async function commit(records, events, worlds, run, connections = {visits:[],encounters:[]},research=[]) {
  const rows = [...records.map(v => normalizeRecord('friends', v)), ...events.map(v => normalizeRecord('events', v)),
    ...worlds.map(v => normalizeRecord('worlds', v)), ...(run ? [normalizeRecord('runs', run)] : []),
    ...connections.visits.map(v=>normalizeRecord('visits',v)),...connections.encounters.map(v=>normalizeRecord('encounters',v)),...research];
  await mergeSyncRecords(rows);
}
export async function exportSyncRecords() {
  const d = await db(), names = ['friends', 'events', 'worlds', 'runs', 'visits', 'encounters'];
  const tx = d.transaction(names);
  const values = await Promise.all(names.map(name => result(tx.objectStore(name).getAll())));
  const research=await result(d.transaction('research').objectStore('research').getAll());
  return [...values.flatMap((rows, i) => rows.map(value => normalizeRecord(names[i], value))),...research.map(r=>normalizeRecord(r.kind,r.value))];
}
export async function mergeSyncRecords(records) {
  // One transaction merges a downloaded batch. Replayed batches cannot duplicate history.
  const names = ['friends', 'events', 'worlds', 'runs', 'visits', 'encounters'];
  const d = await db(), tx = d.transaction([...names,'research'], 'readwrite'), done = complete(tx);
  try {
    const values = await Promise.all(names.map(name => result(tx.objectStore(name).getAll())));
    const maps = new Map(names.map((name, i) => [name, new Map(values[i].map(value => {
      const record = normalizeRecord(name, value); return [record.key, {record, localKey: value.key}];
    }))]));
    for (let record of records) {
      if(RESEARCH_KINDS.includes(record.kind)){
        const store=tx.objectStore('research'),old=await result(store.get(record.key)),merged=mergeRecord(record,old);
        if(!old||canonical(old.value)!==canonical(merged.value))store.put({...normalizeRecord(merged.kind,merged.value),open:merged.value.endedAt===null?1:0});continue;
      }
      if (!maps.has(record.kind)) continue;
      const map = maps.get(record.kind), old = map.get(record.key);
      record = mergeRecord(record, old?.record);
      if (old && canonical(record.value) === canonical(old.record.value)) continue;
      const value = {...record.value};
      if (old?.localKey != null) value.key = old.localKey;
      const request = tx.objectStore(record.kind).put(value);
      const entry = {record, localKey: old?.localKey};
      map.set(record.key, entry);
      if (record.kind === 'events' || record.kind === 'runs') {
        // Await the generated local key so repeated records in this batch update the same row.
        entry.localKey = await result(request);
      }
    }
    await done;
  } catch (error) {
    try { tx.abort(); } catch {}
    await done.catch(() => {});
    throw error;
  }
}
export async function prune(retentionDays, now = Date.now()) {
  const d = await db(), tx = d.transaction(['events', 'runs', 'friends', 'worlds', 'visits', 'encounters','research','archiveCache'], 'readwrite');
  const done = complete(tx), cutoff = now - retentionDays * 86400000;
  for (const name of ['events', 'runs', 'friends', 'worlds', 'visits', 'encounters','research']) {
    const req = tx.objectStore(name).index('observed').openCursor(IDBKeyRange.upperBound(cutoff, true));
    req.onsuccess = () => { const cursor = req.result; if (cursor) { if(name!=='research'||!ARCHIVE_KINDS.includes(cursor.value.kind))cursor.delete(); cursor.continue(); } };
  }
  const old=tx.objectStore('archiveCache').index('cached').openCursor(IDBKeyRange.upperBound(now-86400000,true));old.onsuccess=()=>{const c=old.result;if(c){c.delete();c.continue();}};
  await done;
}
export async function clearAll() {
  const d = await db(), tx = d.transaction(['friends', 'events', 'worlds', 'runs', 'imageCache', 'visits', 'encounters','research','archiveCache'], 'readwrite');
  const done = complete(tx);
  for (const name of ['friends', 'events', 'worlds', 'runs', 'imageCache', 'visits', 'encounters','research','archiveCache']) tx.objectStore(name).clear();
  await done;
}
export async function exportAccount(accountId,{includeResearch=true,since=0}={}) {
  const d = await db(), tx = d.transaction(['friends', 'events', 'worlds', 'runs', 'visits', 'encounters']);
  const range = IDBKeyRange.bound([accountId, 0], [accountId, Number.MAX_SAFE_INTEGER]);
  const requests = ['friends', 'events', 'worlds', 'runs'].map(name => result(tx.objectStore(name).index(name === 'friends' || name === 'worlds' ? 'account' : 'accountTime').getAll(name === 'friends' || name === 'worlds' ? accountId : range)));
  for(const name of ['visits','encounters'])requests.push(result(tx.objectStore(name).index('account').getAll(accountId)));
  const [friends, events, worlds, runs, visits, encounters] = await Promise.all(requests);
  const records=new Map();
  for(const [kind,values] of Object.entries({friends,events,worlds,runs,visits,encounters}))for(const v of values){const r=normalizeRecord(kind,v);records.set(r.key,r);}
  for(const r of await list('archiveCache',accountId))if(!RESEARCH_KINDS.includes(r.kind))records.set(r.key,mergeRecord(r,records.get(r.key)));
  if(includeResearch)for(const r of await readResearch(accountId,since))records.set(r.key,r);
  const out={schema:1,exportedAt:new Date().toISOString(),accountId};
  for(const kind of ['friends','events','worlds','runs','visits','encounters',...RESEARCH_KINDS])out[kind]=[...records.values()].filter(r=>r.kind===kind).map(r=>r.value);
  out.runs=expandRuns(out.runs);return out;
}
export async function mergeArchiveRecords(records){
  const d=await db(),tx=d.transaction('archiveCache','readwrite'),done=complete(tx),store=tx.objectStore('archiveCache');
  for(const r of records){const old=await result(store.get(r.key)),merged=mergeRecord(r,old);store.put({...normalizeRecord(merged.kind,merged.value),cachedAt:Date.now()});}await done;
}

// Images and source URLs stay in this store; export/sync only use the observation stores above.
export async function enqueueImages(accountId, candidates, now = Date.now()) {
  const d=await db(),tx=d.transaction('imageCache','readwrite'),done=complete(tx),store=tx.objectStore('imageCache');
  for(const candidate of candidates.filter(Boolean)) {
    const key=accountId+':'+candidate.kind+':'+candidate.id;
    const existing=await result(store.get(key));
    store.put({...existing,...candidate,key,accountId,lastSeenAt:now,...(existing?.url!==candidate.url?{retryAt:0,failures:0}:{})});
  }
  await done;
}
export async function cachedImages(accountId) {
  const d=await db(),store=d.transaction('imageCache').objectStore('imageCache');
  return result(accountId?store.index('account').getAll(accountId):store.getAll());
}
export async function updateCachedImage(key, update) {
  const d=await db(),tx=d.transaction('imageCache','readwrite'),done=complete(tx),store=tx.objectStore('imageCache');
  const value=update(await result(store.get(key)));
  if(value)store.put(value);
  await done;
}
export async function clearImageCache() {
  const d=await db(),tx=d.transaction('imageCache','readwrite'),done=complete(tx);tx.objectStore('imageCache').clear();await done;
}
export async function trimImageCache(maxBytes,maxCount,cutoff) {
  const d=await db(),tx=d.transaction('imageCache','readwrite'),done=complete(tx),store=tx.objectStore('imageCache');
  const rows=(await result(store.getAll())).sort((a,b)=>(b.lastSeenAt||0)-(a.lastSeenAt||0));
  let bytes=0,count=0;
  for(const row of rows){if((row.lastSeenAt||0)<cutoff || count>=maxCount || bytes+(row.bytes||0)>maxBytes){store.delete(row.key);continue;}bytes+=row.bytes||0;count++;}
  await done;
}
