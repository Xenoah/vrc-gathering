import { normalizeRecord, newerRecord } from './sync-format.js';
let opening;
export function db() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const req = indexedDB.open('vrc-friends-observer', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
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
  return result(d.transaction(store).objectStore(store).index('account').getAll(accountId));
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
export async function commit(records, events, worlds, run) {
  const rows = [...records.map(v => normalizeRecord('friends', v)), ...events.map(v => normalizeRecord('events', v)),
    ...worlds.map(v => normalizeRecord('worlds', v)), ...(run ? [normalizeRecord('runs', run)] : [])];
  await mergeSyncRecords(rows);
}
export async function exportSyncRecords() {
  const d = await db(), names = ['friends', 'events', 'worlds', 'runs'];
  const tx = d.transaction(names);
  const values = await Promise.all(names.map(name => result(tx.objectStore(name).getAll())));
  return values.flatMap((rows, i) => rows.map(value => normalizeRecord(names[i], value)));
}
export async function mergeSyncRecords(records) {
  // One transaction merges a downloaded batch. Replayed batches cannot duplicate history.
  const names = ['friends', 'events', 'worlds', 'runs'];
  const d = await db(), tx = d.transaction(names, 'readwrite'), done = complete(tx);
  try {
    const values = await Promise.all(names.map(name => result(tx.objectStore(name).getAll())));
    const maps = new Map(names.map((name, i) => [name, new Map(values[i].map(value => {
      const record = normalizeRecord(name, value); return [record.key, {record, localKey: value.key}];
    }))]));
    for (const record of records) {
      if (!maps.has(record.kind)) continue;
      const map = maps.get(record.kind), old = map.get(record.key);
      if (!newerRecord(record, old?.record)) continue;
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
  const d = await db(), tx = d.transaction(['events', 'runs', 'friends', 'worlds'], 'readwrite');
  const done = complete(tx), cutoff = now - retentionDays * 86400000;
  for (const name of ['events', 'runs', 'friends', 'worlds']) {
    const req = tx.objectStore(name).index('observed').openCursor(IDBKeyRange.upperBound(cutoff, true));
    req.onsuccess = () => { const cursor = req.result; if (cursor) { cursor.delete(); cursor.continue(); } };
  }
  await done;
}
export async function clearAll() {
  const d = await db(), tx = d.transaction(['friends', 'events', 'worlds', 'runs'], 'readwrite');
  const done = complete(tx);
  for (const name of ['friends', 'events', 'worlds', 'runs']) tx.objectStore(name).clear();
  await done;
}
export async function exportAccount(accountId) {
  const d = await db(), tx = d.transaction(['friends', 'events', 'worlds', 'runs']);
  const range = IDBKeyRange.bound([accountId, 0], [accountId, Number.MAX_SAFE_INTEGER]);
  const requests = ['friends', 'events', 'worlds', 'runs'].map(name => result(tx.objectStore(name).index(name === 'friends' || name === 'worlds' ? 'account' : 'accountTime').getAll(name === 'friends' || name === 'worlds' ? accountId : range)));
  const [friends, events, worlds, runs] = await Promise.all(requests);
  return { schema: 1, exportedAt: new Date().toISOString(), accountId, friends, events, worlds, runs };
}
