import { DEFAULTS, VERSION, settings, validContact, userAgentRule, currentUser, friend, rosterObservations, reconcile, retryDelay, jitter, world, WORLD_ID } from './core.js';
import { list, commit, prune, clearAll, exportSyncRecords, mergeSyncRecords } from './db.js';
import { createSync, syncSettings, createAccountUpdater } from './sync.js';

const updateAccounts = createAccountUpdater(chrome.storage.local);
const cloud = createSync({ storage:chrome.storage.local, exportRecords:exportSyncRecords, mergeRecords:mergeSyncRecords, updateAccounts });
const CLOUD_ALARM = 'vrc-observer-cloud';
const syncQuietly = () => cloud.sync().catch(() => {});

const ALARM = 'vrc-observer-next', MAINTENANCE = 'vrc-observer-prune';
const API = 'https://vrchat.com/api/1';
let activeRun = null, controller = null;
class ApiError extends Error {
  constructor(message, status = 0, retryAfter = null) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
async function configuration() { return settings((await chrome.storage.local.get('settings')).settings || DEFAULTS); }
async function state() { return (await chrome.storage.local.get('state')).state || {}; }
async function patchState(patch) { const next = { ...await state(), ...patch }; await chrome.storage.local.set({ state: next }); return next; }
async function schedule(when) {
  await chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 1000, when) });
  await patchState({ nextRunAt: Math.max(Date.now() + 1000, when) });
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});
async function ensureUA(config) {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [userAgentRule(chrome.runtime.id, navigator.userAgent, config.contact)] });
}
async function request(path, signal, progress) {
  if (!(path === '/auth/user' || /^\/auth\/user\/friends\?n=100&offset=\d+&offline=(true|false)$/.test(path) || /^\/worlds\/wrld_[a-zA-Z0-9-]{8,64}$/.test(path))) throw new ApiError('許可されていないAPIパスです。');
  signal.throwIfAborted();
  const s = await state();
  if (s.cooldownUntil > Date.now()) throw new ApiError('APIの待機時間中です。', 429, String((s.cooldownUntil - Date.now()) / 1000));
  const delay = Math.max(0, (s.lastRequestAt || 0) + 2200 - Date.now());
  if (delay) await sleep(delay, signal);
  signal.throwIfAborted();
  await patchState({ lastRequestAt: Date.now(), phase: 'running', message: progress });
  // A persistent watchdog recovers if Chrome terminates this service worker mid-run.
  await chrome.alarms.create(ALARM, { when: Date.now() + 90000 });
  let response;
  try {
    response = await fetch(API + path, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'manual',
      headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  } catch (err) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ApiError('通信できません。ネット接続・サイト権限・ChromeのCookie設定を確認してください。');
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw new ApiError('APIが別URLへ転送されました。仕様変更の可能性があります。収集を停止しました。', 403);
  if (!response.ok) {
    const messages = { 401: '同じChromeプロファイルのvrchat.comでログインし直してください。',
      403: 'アクセスが拒否されました。サイトで状態を確認してから再開してください。',
      429: 'アクセス制限を受けました。サーバー指定の時間とバックオフを守って待機します。' };
    throw new ApiError(messages[response.status] || `APIエラー HTTP ${response.status}`, response.status, response.headers.get('Retry-After'));
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new ApiError('JSON以外の応答です。vrchat.comのログイン状態を確認してください。', 403);
  try { return await response.json(); } catch { throw new ApiError('APIのJSONを読み取れませんでした。'); }
}
async function identity(signal, label) {
  const raw = await request('/auth/user', signal, label);
  try { return currentUser(raw); } catch { throw new ApiError('ログインまたは2段階認証をvrchat.comで完了してください。', 401); }
}
async function pages(offline, offset, maximum, signal, me) {
  const observations = [];
  let complete = false;
  const active = new Set(me.activeFriends || []), online = new Set(me.onlineFriends || []);
  for (let p = 0; p < maximum; p++) {
    const raw = await request(`/auth/user/friends?n=100&offset=${offset}&offline=${offline}`, signal,
      `${offline ? 'オフライン名簿' : 'オンライン情報'}を取得中：${offset + 1}件目から`);
    if (!Array.isArray(raw) || raw.length > 100) throw new ApiError('フレンド一覧の応答形式が変わりました。', 403);
    const observedAt = Date.now();
    for (const item of raw) {
      const fallback = offline ? 'offline' : online.has(item.id) ? 'online' : active.has(item.id) ? 'active' : 'online';
      const f = friend(item, observedAt, fallback);
      if (!f) throw new ApiError('不正なフレンドIDを受信しました。保存を中止しました。', 403);
      observations.push(f);
    }
    offset += raw.length;
    if (raw.length < 100) { complete = true; offset = 0; break; }
  }
  return { observations, complete, nextOffset: offset };
}
async function collect(signal) {
  const config = await configuration(), before = await state();
  if (!config.enabled) return;
  if (before.cooldownUntil > Date.now()) { await patchState({phase:'waiting',message:'APIの待機時間が終わると再開します。'}); await schedule(before.cooldownUntil + 1000); return; }
  if (Date.now() - (before.lastStartedAt || 0) < 60000) { await patchState({phase:'waiting',message:'前回の取得開始から60秒以上空けて再開します。'}); await schedule(before.lastStartedAt + 61000); return; }
  const startedAt = Date.now();
  let accountId = '';
  try {
    await ensureUA(config);
    await patchState({ phase: 'running', message: 'ログイン状態を確認中', lastStartedAt: startedAt });
    const me = await identity(signal, 'アカウントとフレンド名簿を確認中');
    accountId = me.id;
    const observedAt = Date.now();
    const previous = await list('friends', accountId);
    const allMeta = (await chrome.storage.local.get('accountMeta')).accountMeta || {};
    const meta = allMeta[accountId] || {};
    const onlinePage = await pages(false, meta.onlineOffset || 0, 20, signal, me);
    const observations = [...rosterObservations(me, previous, observedAt), ...onlinePage.observations];
    const nextMeta = { ...meta, displayName: me.displayName, onlineOffset: onlinePage.nextOffset };
    if (meta.offlineOffset || !meta.offlineCompletedAt || startedAt - meta.offlineCompletedAt > config.offlineRefreshMinutes * 60000) {
      const offlinePage = await pages(true, meta.offlineOffset || 0, 5, signal, me);
      observations.push(...offlinePage.observations);
      nextMeta.offlineOffset = offlinePage.nextOffset;
      if (offlinePage.complete) nextMeta.offlineCompletedAt = Date.now();
    }
    const cached = new Map((await list('worlds', accountId)).map(w => [w.id, w]));
    const worldIds = [...new Set(observations.map(f => f.location.worldId).filter(id => WORLD_ID.test(id)))];
    const pendingWorlds = worldIds.filter(id => !cached.has(id) || cached.get(id).retryAt < Date.now());
    const worlds = [];
    for (const id of pendingWorlds.slice(0, 5)) {
      try { worlds.push(world(await request('/worlds/' + id, signal, 'ワールド名を取得中（最大5件／巡回）'), accountId, Date.now())); }
      catch (error) {
        if (error.status !== 404) throw error;
        worlds.push({ accountId, id, name: '', authorName: '', capacity: null, observedAt: Date.now(), retryAt: Date.now() + 86400000 });
      }
    }
    // Verify identity again before writing: never attribute another browser account's response to the first.
    const finalMe = await identity(signal, 'アカウントを再確認して保存中');
    if (finalMe.id !== accountId) throw new ApiError('取得中にアカウントが切り替わりました。この巡回は保存せず、停止しました。', 403);
    signal.throwIfAborted();
    const completedAt = Date.now(), roster = finalMe.friends ? new Set(finalMe.friends) : null;
    const allowed = observations.filter(f => !roster || roster.has(f.id));
    const changes = reconcile(previous, allowed, accountId, completedAt, finalMe.friends);
    const run = { accountId, observedAt: completedAt, startedAt, completedAt, onlineComplete: onlinePage.complete,
      onlineOffset: nextMeta.onlineOffset, offlineOffset: nextMeta.offlineOffset || 0, observedCount: changes.records.length,
      changedCount: changes.events.length, worldNamesPending: Math.max(0, pendingWorlds.length - 5) };
    await commit(changes.records, changes.events, worlds, run);
    nextMeta.lastSuccessAt = completedAt;
    await updateAccounts(accounts => ({...accounts, [accountId]:{...accounts[accountId], ...nextMeta}}));
    await prune(config.retentionDays);
    const remaining = [!onlinePage.complete ? `オンラインの続き ${nextMeta.onlineOffset}件目〜` : '', nextMeta.offlineOffset ? `名簿の続き ${nextMeta.offlineOffset}件目〜` : '', run.worldNamesPending ? `ワールド名 ${run.worldNamesPending}件` : ''].filter(Boolean);
    await patchState({ phase: 'ready', message: remaining.length ? `保存完了。次回取得：${remaining.join('／')}` : '取得・保存が完了しました。',
      accountId, accountName: me.displayName, lastSuccessAt: completedAt, failures: 0, cooldownUntil: 0,
      lastRun: run, rosterCount: finalMe.friends?.length ?? null });
    await chrome.action.setBadgeText({ text: String((me.onlineFriends?.length || 0) + (me.activeFriends?.length || 0)) });
    await chrome.action.setBadgeBackgroundColor({ color: '#226e65' });
    void syncQuietly();
  } catch (error) {
    if (signal.aborted) return;
    const current = await state(), failures = (current.failures || 0) + 1;
    const status = Number(error.status) || 0;
    const stop = status === 401 || status === 403 || !validContact(config.contact);
    const cooldownUntil = stop ? current.cooldownUntil || 0 : Date.now() + retryDelay(error.retryAfter, Date.now(), failures) + Math.random() * 10000;
    if (stop) await chrome.storage.local.set({ settings: { ...await configuration(), enabled: false } });
    await patchState({ phase: stop ? 'attention' : 'waiting',
      message: error instanceof ApiError || !validContact(config.contact) ? error.message : '保存または内部処理に失敗しました。空き容量を確認してください。',
      failures, cooldownUntil, lastErrorAt: Date.now() });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ad5f24' });
  } finally {
    const latest = await configuration(), s = await state();
    if (latest.enabled) await schedule(Math.max(s.cooldownUntil || 0, Date.now() + jitter(latest.pollSeconds)));
    else { await chrome.alarms.clear(ALARM); await patchState({ nextRunAt: null }); }
  }
}
function run() {
  if (activeRun) return activeRun;
  controller = new AbortController();
  activeRun = collect(controller.signal).catch(() => {}).finally(() => { activeRun = null; controller = null; });
  return activeRun;
}
async function pause() {
  await chrome.storage.local.set({ settings: { ...await configuration(), enabled: false } });
  controller?.abort();
  if (activeRun) await activeRun;
  await chrome.alarms.clear(ALARM);
  await patchState({ phase: 'paused', message: '収集を停止しています。', nextRunAt: null });
  await chrome.action.setBadgeText({ text: '' });
}
async function command(message) {
  if (message.type === 'SYNC') { return {ok:true, ...await cloud.sync({force:message.force === true})}; }
  if (message.type === 'SAVE_SYNC') {
    await cloud.pause();
    try {
      const old = (await chrome.storage.local.get('cloudSync')).cloudSync || {};
      const config = syncSettings({...message.settings, token:message.settings?.token || old.token || ''});
      if (config.enabled && !await chrome.permissions.contains({origins:['https://script.google.com/*','https://script.googleusercontent.com/*']})) throw new Error('Googleへの同期権限を許可してください。');
      const changed = config.endpoint !== old.endpoint || config.token !== old.token;
      await chrome.storage.local.set({cloudSync:config, cloudState:{phase:config.enabled?'pending':'disabled',message:config.enabled?'同期設定を保存しました。':'同期は無効です。'}, ...(changed ? {cloudCheckpoint:{cursor:0,receipts:{}}} : {})});
      if (config.enabled) await chrome.alarms.create(CLOUD_ALARM,{periodInMinutes:5});
      else await chrome.alarms.clear(CLOUD_ALARM);
      return {ok:true};
    } finally { cloud.resume(); void syncQuietly(); }
  }
  if (message.type === 'SAVE') {
    const previous = await configuration(), next = settings({ ...previous, ...message.settings, enabled: previous.enabled });
    if (!validContact(next.contact)) throw new Error('連絡先のメールアドレスまたはHTTPSプロフィールURLを入力してください。');
    await ensureUA(next);
    await chrome.storage.local.set({ settings: next });
    await prune(next.retentionDays);
    return { ok: true };
  }
  if (message.type === 'START') {
    const config = await configuration();
    if (!validContact(config.contact)) throw new Error('先に設定欄の連絡先を保存してください。');
    await ensureUA(config);
    await chrome.storage.local.set({ settings: { ...config, enabled: true } });
    void run();
    return { ok: true };
  }
  if (message.type === 'PAUSE') { await pause(); return { ok: true }; }
  if (message.type === 'POLL') {
    const config = await configuration(), s = await state();
    if (!config.enabled) throw new Error('先に収集を開始してください。');
    if (activeRun) throw new Error('現在取得中です。');
    if (s.cooldownUntil > Date.now()) throw new Error('アクセス制限またはエラー後の待機中です。');
    if (Date.now() - (s.lastStartedAt || 0) < 60000) throw new Error('手動更新は前回開始から60秒以上空けてください。');
    void run(); return { ok: true };
  }
  if (message.type === 'CLEAR') {
    await pause();
    await cloud.pause();
    try {
      const cloudConfig = (await chrome.storage.local.get('cloudSync')).cloudSync || {};
      await chrome.storage.local.set({cloudSync:{...cloudConfig,enabled:false},cloudState:{phase:'disabled',message:'ローカル記録の削除に伴い同期を停止しました。'},cloudCheckpoint:{cursor:0,receipts:{}}});
      await chrome.alarms.clear(CLOUD_ALARM);
      await clearAll();
      const s = await state();
      // Clearing personal data must not clear server-imposed backoff or the rate-limit clock.
      await chrome.storage.local.set({ accountMeta: {}, state: { phase: 'paused', message: '保存データを削除しました。', cooldownUntil: s.cooldownUntil || 0,
        failures: s.failures || 0, lastRequestAt: s.lastRequestAt || 0, lastStartedAt: s.lastStartedAt || 0 } });
      return { ok: true };
    } finally { cloud.resume(); }
  }
  throw new Error('不明な操作です。');
}
let commandQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (message.type === 'SYNC') {
    command(message).then(respond, error => respond({ok:false,error:error.message}));
    return true;
  }
  commandQueue = commandQueue.then(() => command(message)).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void run();
  if (alarm.name === CLOUD_ALARM) void syncQuietly();
  if (alarm.name === MAINTENANCE) configuration().then(c => prune(c.retentionDays)).catch(() => {});
});
async function boot() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const config = await configuration();
  if ((await chrome.storage.local.get('cloudSync')).cloudSync?.enabled) {
    if (!await chrome.alarms.get(CLOUD_ALARM)) await chrome.alarms.create(CLOUD_ALARM,{periodInMinutes:5});
  }
  await prune(config.retentionDays);
  if (!await chrome.alarms.get(MAINTENANCE)) await chrome.alarms.create(MAINTENANCE, { delayInMinutes: 60 + Math.random() * 10, periodInMinutes: 60 });
  if (config.enabled && !await chrome.alarms.get(ALARM)) {
    const s = await state(); await schedule(Math.max(s.cooldownUntil || 0, Date.now() + 3000 + Math.random() * 7000));
  }
}
chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); void boot(); });
chrome.runtime.onStartup.addListener(() => { void boot(); });
void boot().catch(() => {});
