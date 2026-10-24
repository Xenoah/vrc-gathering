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
  const d = await db(), tx = d.transaction(['friends', 'events', 'worlds', 'runs'], 'readwrite');
  const done = complete(tx);
  records.forEach(v => tx.objectStore('friends').put(v));
  events.forEach(v => tx.objectStore('events').add(v));
  worlds.forEach(v => tx.objectStore('worlds').put(v));
  if (run) tx.objectStore('runs').add(run);
  await done;
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
