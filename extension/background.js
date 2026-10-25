import { DEFAULTS, VERSION, settings, validContact, userAgentRule, currentUser, friend, rosterObservations, reconcile, retryDelay, jitter, world, WORLD_ID, USER_ID } from './core.js';
import { list, commit, prune, clearAll, exportSyncRecords, mergeSyncRecords, enqueueImages, cachedImages, updateCachedImage, trimImageCache, clearImageCache } from './db.js';
import { createImageCollector, imageCandidate, IMAGE_ORIGINS, IMAGE_CACHE_BYTES, IMAGE_CACHE_COUNT } from './image-cache.js';
import { createSync, syncSettings, createAccountUpdater, CLOUD_ORIGINS, serverRetryDeadline } from './sync.js';
import { resolveSettingsBackup } from './settings-backup.js';
import { reconcileConnections } from './connections.js';
import { extractXProfiles, readXCache, writeXCache, X_CACHE_TTL } from './x-profile.js';
import { normalizeRecord, mergeRecord } from './sync-format.js';
import { X_FOLLOWER_ORIGINS, followerRecords, mergeFollowerCache } from './x-followers.js';

const updateAccounts = createAccountUpdater(chrome.storage.local);
let profileWrites=Promise.resolve(),followerWrites=Promise.resolve(),followerGeneration=0;
function mergeFollowers(records){
  const work=followerWrites.then(async()=>{
    const saved=await chrome.storage.local.get('xFollowerCache');
    await chrome.storage.local.set({xFollowerCache:mergeFollowerCache(saved.xFollowerCache,records)});
  });followerWrites=work.catch(()=>{});return work;
}
function mergeProfiles(records){
  const work=profileWrites.then(async()=>{
    let cache=(await chrome.storage.local.get('xProfileCache')).xProfileCache||{};
    for(const record of records){const v=record.value,old=readXCache(cache,v.accountId,v.userId),prior=old?normalizeRecord('profiles',{...old,observedAt:old.checkedAt}):null,merged=mergeRecord(record,prior).value;
      cache=writeXCache(cache,{accountId:merged.accountId,userId:merged.userId,checkedAt:merged.observedAt,urls:merged.urls});}
    await chrome.storage.local.set({xProfileCache:cache});
  });profileWrites=work.catch(()=>{});return work;
}
async function exportCollected(options){
  const rows=await exportSyncRecords(options),cache=(await chrome.storage.local.get('xProfileCache')).xProfileCache||{};
  for(const entry of Object.values(cache)){const profile=readXCache(cache,entry?.accountId,entry?.userId);if(profile){const record=normalizeRecord('profiles',{...profile,observedAt:profile.checkedAt});if(!options?.keys||options.keys.includes(record.key))rows.push(record);}}
  const metrics=(await chrome.storage.local.get('xFollowerCache')).xFollowerCache;
  rows.push(...followerRecords(metrics).filter(r=>!options?.keys||options.keys.includes(r.key)));
  return rows;
}
async function mergeCollected(records){
  await mergeSyncRecords(records.filter(r=>!['profiles','xFollowers'].includes(r.kind)));
  const profiles=records.filter(r=>r.kind==='profiles');if(profiles.length)await mergeProfiles(profiles);
  const metrics=records.filter(r=>r.kind==='xFollowers');if(metrics.length)await mergeFollowers(metrics);
}
const cloud = createSync({ storage:chrome.storage.local, exportRecords:exportCollected, mergeRecords:mergeCollected, updateAccounts, hasPermission:()=>chrome.permissions.contains({origins:CLOUD_ORIGINS}) });
const CLOUD_ALARM = 'vrc-observer-cloud';
async function runCloud(options){const outcome=await cloud.sync(options);if(!outcome.skipped&&(await chrome.storage.local.get('cloudSync')).cloudSync?.enabled)await chrome.alarms.create(CLOUD_ALARM,{periodInMinutes:outcome.pending?1:5});return outcome;}
const syncQuietly = () => runCloud().catch(() => {});

const ALARM = 'vrc-observer-next', MAINTENANCE = 'vrc-observer-prune';
const API = 'https://vrchat.com/api/1';
let activeRun = null, controller = null, activeProfile = null, profileController = null, profileResetting = false;
const IMAGE_ALARM='vrc-observer-images';
const imageCollector=createImageCollector({store:{list:async()=>{const accountId=(await state()).accountId;return accountId?cachedImages(accountId):[];},update:updateCachedImage,trim:trimImageCache},
  canRun:async()=>!activeRun && !activeProfile && !((await state()).cooldownUntil>Date.now()) && (await configuration()).enabled && (await chrome.storage.local.get('imageCacheSettings')).imageCacheSettings?.enabled===true,
  fetcher:async(url,options)=>{
    const s=await state();if(s.cooldownUntil>Date.now())throw Error('API cooldown');
    const delay=Math.max(0,(s.lastRequestAt||0)+2200-Date.now());if(delay)await sleep(delay,options.signal);
    options.signal.throwIfAborted();await patchState({lastRequestAt:Date.now()});
    const response=await fetch(url,options);
    if(response.status===429){const s=await state();await patchState({cooldownUntil:Math.max(s.cooldownUntil||0,Date.now()+retryDelay(response.headers.get('Retry-After'),Date.now(),1))});}
    return response;
  }});
async function cacheImagesQuietly(){
  try{if(activeRun || activeProfile || !(await configuration()).enabled || !(await chrome.storage.local.get('imageCacheSettings')).imageCacheSettings?.enabled || !await chrome.permissions.contains({origins:IMAGE_ORIGINS}))return;
    const result=await imageCollector.collect();if(!result.skipped)await chrome.storage.local.set({imageCacheState:result});
  }catch{}
}
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
  const rule=userAgentRule(chrome.runtime.id,navigator.userAgent,config.contact),rules=[rule];
  if(await chrome.permissions.contains({origins:['https://api.vrchat.cloud/*']}))rules.push({...rule,id:2,condition:{...rule.condition,urlFilter:'|https://api.vrchat.cloud/api/1/'}});
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[1,2],addRules:rules});
}
async function request(path, signal, progress, {quiet=false}={}) {
  if (!(path === '/auth/user' || /^\/auth\/user\/friends\?n=100&offset=\d+&offline=(true|false)$/.test(path) || /^\/worlds\/wrld_[a-zA-Z0-9-]{8,64}$/.test(path) || /^\/profile\/(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/.test(path))) throw new ApiError('許可されていないAPIパスです。');
  signal.throwIfAborted();
  const s = await state();
  if (s.cooldownUntil > Date.now()) throw new ApiError('APIの待機時間中です。', 429, String((s.cooldownUntil - Date.now()) / 1000));
  const delay = Math.max(0, (s.lastRequestAt || 0) + 2200 - Date.now());
  if (delay) await sleep(delay, signal);
  signal.throwIfAborted();
  await patchState({ lastRequestAt: Date.now(), ...(!quiet?{phase:'running',message:progress}:{}) });
  // A persistent watchdog recovers if Chrome terminates this service worker mid-run.
  if(!quiet)await chrome.alarms.create(ALARM, { when: Date.now() + 90000 });
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
async function identity(signal, label, options) {
  const raw = await request('/auth/user', signal, label, options);
  try { return currentUser(raw,Date.now()); } catch { throw new ApiError('ログインまたは2段階認証をvrchat.comで完了してください。', 401); }
}
async function pages(offline, offset, maximum, signal, me) {
  const observations = [], images = [];
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
      observations.push(f);images.push(imageCandidate(item,'user'));
    }
    offset += raw.length;
    if (raw.length < 100) { complete = true; offset = 0; break; }
  }
  return { observations, images, complete, nextOffset: offset };
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
    const images=[...onlinePage.images];
    const observations = [...rosterObservations(me, previous, observedAt), ...onlinePage.observations];
    const nextMeta = { ...meta, displayName: me.displayName, onlineOffset: onlinePage.nextOffset };
    if (meta.offlineOffset || !meta.offlineCompletedAt || startedAt - meta.offlineCompletedAt > config.offlineRefreshMinutes * 60000) {
      const offlinePage = await pages(true, meta.offlineOffset || 0, 5, signal, me);
      observations.push(...offlinePage.observations);images.push(...offlinePage.images);
      nextMeta.offlineOffset = offlinePage.nextOffset;
      if (offlinePage.complete) nextMeta.offlineCompletedAt = Date.now();
    }
    const cached = new Map((await list('worlds', accountId)).map(w => [w.id, w]));
    const worldIds = [...new Set([me.self,...observations].map(f => f.location.worldId).filter(id => WORLD_ID.test(id)))];
    const pendingWorlds = worldIds.filter(id => !cached.has(id) || cached.get(id).retryAt < Date.now());
    const worlds = [];
    for (const id of pendingWorlds.slice(0, 5)) {
      try { const raw=await request('/worlds/' + id, signal, 'ワールド名を取得中（最大5件／巡回）');worlds.push(world(raw,accountId,Date.now()));images.push(imageCandidate(raw,'world')); }
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
    const [previousVisits,previousEncounters]=await Promise.all([list('visits',accountId),list('encounters',accountId)]);
    const connections=reconcileConnections(previousVisits,previousEncounters,[me.self,finalMe.self],allowed,accountId,{pollSeconds:config.pollSeconds,completedAt,roster});
    await commit(changes.records, changes.events, worlds, run, connections);
    if((await chrome.storage.local.get('imageCacheSettings')).imageCacheSettings?.enabled)await enqueueImages(accountId,images.filter(v=>v&&(v.kind==='world'||!roster||roster.has(v.id))),completedAt);
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
  if (activeProfile) return activeProfile.catch(()=>{}).then(run);
  controller = new AbortController();
  activeRun = imageCollector.idle().then(()=>collect(controller.signal)).catch(() => {}).finally(() => { activeRun = null; controller = null; void cacheImagesQuietly(); });
  return activeRun;
}
async function pause() {
  await chrome.storage.local.set({ settings: { ...await configuration(), enabled: false } });
  controller?.abort();
  profileController?.abort();
  await imageCollector.pause();
  if(activeProfile)await activeProfile.catch(()=>{});
  if (activeRun) await activeRun;
  imageCollector.resume();
  await chrome.alarms.clear(ALARM);
  await patchState({ phase: 'paused', message: '収集を停止しています。', nextRunAt: null });
  await chrome.action.setBadgeText({ text: '' });
}
async function lookupXProfile({accountId,userId,force=false}) {
  if(typeof accountId!=='string'||typeof userId!=='string'||!USER_ID.test(accountId)||!USER_ID.test(userId))throw Error('ユーザーIDが不正です。');
  const cache=(await chrome.storage.local.get('xProfileCache')).xProfileCache||{},profile=readXCache(cache,accountId,userId);
  if(profileResetting)throw Error('記録を削除しています。完了してから開き直してください。');
  if(profile && Date.now()-profile.checkedAt<(force===true?60000:X_CACHE_TTL))return {ok:true,profile,cached:true};
  if(activeProfile || activeRun)return {ok:true,busy:true,profile};
  const abort=new AbortController();profileController=abort;
  activeProfile=(async()=>{
    if(!(await list('friends',accountId)).some(f=>f.id===userId))throw Error('このアカウントで記録されたユーザーを選択してください。');
    const config=await configuration();
    if(!validContact(config.contact))throw Error('プロフィールの取得には、収集設定で連絡先を保存してください。');
    await imageCollector.idle();abort.signal.throwIfAborted();await ensureUA(config);
    const me=await identity(abort.signal,'公開プロフィールのアカウント確認',{quiet:true});
    if(me.id!==accountId)throw Error('表示アカウントとVRChatのログインアカウントが異なります。');
    const raw=await request('/profile/'+userId,abort.signal,'公開プロフィールを取得中',{quiet:true});
    if(raw?.id!==userId)throw Error('プロフィールのユーザーIDが一致しません。');
    if(!Array.isArray(raw.bioLinks) && typeof raw.bio!=='string')throw Error('公開プロフィールからリンク情報を取得できませんでした。');
    const urls=extractXProfiles(raw);
    const after=await identity(abort.signal,'公開プロフィールのアカウント再確認',{quiet:true});
    if(after.id!==accountId)throw Error('取得中にアカウントが切り替わったため、プロフィールを保存しませんでした。');
    abort.signal.throwIfAborted();
    const entry={accountId,userId,urls,checkedAt:Date.now()};
    await mergeProfiles([normalizeRecord('profiles',{...entry,observedAt:entry.checkedAt})]);
    void syncQuietly();
    return {ok:true,profile:entry};
  })().catch(async error=>{
    if(error.status===429 || error.retryAfter!=null){const s=await state();await patchState({cooldownUntil:Math.max(s.cooldownUntil||0,Date.now()+retryDelay(error.retryAfter,Date.now(),1))});}
    return {ok:false,profile,error:abort.signal.aborted?'プロフィールの取得を中止しました。':error.message};
  }).finally(()=>{activeProfile=null;profileController=null;});
  return activeProfile;
}
async function configureFollowerScript(enabled){
  const id='vrc-x-followers',registered=await chrome.scripting.getRegisteredContentScripts({ids:[id]});
  if(!enabled){if(registered.length)await chrome.scripting.unregisterContentScripts({ids:[id]});return;}
  const script={id,matches:X_FOLLOWER_ORIGINS,js:['x-followers-parser.js','x-followers-content.js'],runAt:'document_idle',allFrames:false,persistAcrossSessions:true};
  if(registered.length)await chrome.scripting.updateContentScripts([script]);else await chrome.scripting.registerContentScripts([script]);
}
async function acceptFollowerObservation(message,sender){
  if(sender.id!==chrome.runtime.id||sender.frameId!==0||!Number.isInteger(sender.tab?.id)||profileResetting)return {ok:false};
  let url;try{const page=new URL(sender.url);if(page.origin!=='https://x.com'||!/^\/[a-z0-9_]{1,15}\/?$/i.test(page.pathname))return {ok:false};url='https://x.com/'+page.pathname.replaceAll('/','').toLowerCase();}catch{return {ok:false};}
  if(message.url!==url)return {ok:false};
  const generation=followerGeneration,saved=await chrome.storage.local.get(['xFollowerSettings','xProfileCache']);
  if(!saved.xFollowerSettings?.enabled||!await chrome.permissions.contains({origins:X_FOLLOWER_ORIGINS}))return {ok:false};
  const cache=saved.xProfileCache||{},owners=new Set();
  for(const entry of Object.values(cache)){const profile=readXCache(cache,entry?.accountId,entry?.userId);if(profile?.urls.includes(url))owners.add(profile.accountId);}
  if(!owners.size||profileResetting||generation!==followerGeneration)return {ok:false};
  const records=[...owners].map(accountId=>normalizeRecord('xFollowers',{accountId,url,followers:message.followers,approximate:message.approximate,source:'x-profile',observedAt:Date.now()}));
  await mergeFollowers(records);void syncQuietly();return {ok:true};
}
async function command(message) {
  if(message.type==='X_PROFILE')return lookupXProfile(message);
  if(message.type==='SAVE_X_FOLLOWERS'){
    const enabled=message.enabled===true;
    if(enabled&&!await chrome.permissions.contains({origins:X_FOLLOWER_ORIGINS}))throw Error('Xへの接続を許可してください。');
    followerGeneration++;
    await configureFollowerScript(enabled);
    await chrome.storage.local.set({xFollowerSettings:{enabled}});return {ok:true};
  }
  if (message.type === 'IMPORT_SETTINGS') {
    const current = await chrome.storage.local.get('cloudSync');
    const imported = resolveSettingsBackup(message.backup, current.cloudSync);
    const origins = [...(imported.cloudSync.enabled ? CLOUD_ORIGINS : []), ...(imported.imageCacheSettings.enabled ? IMAGE_ORIGINS : []),...(imported.xFollowerSettings?.enabled ? X_FOLLOWER_ORIGINS : [])];
    if (origins.length && !await chrome.permissions.contains({origins})) throw Error('設定の読み込みに必要な接続権限を許可してください。');
    await cloud.pause();
    try {
      await pause();
      if(imported.xFollowerSettings){followerGeneration++;await configureFollowerScript(imported.xFollowerSettings.enabled);}
      if (imported.settings.contact) await ensureUA(imported.settings);
      else await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[1,2],addRules:[]});
      const saved = await chrome.storage.local.get(['cloudSync','cloudState']);
      const old = saved.cloudSync || {}, next = imported.cloudSync;
      const changed = next.endpoint !== old.endpoint || next.token !== old.token;
      const sameEndpoint = next.endpoint === old.endpoint;
      const serverRetryAt = sameEndpoint ? serverRetryDeadline(saved.cloudState) : 0;
      await chrome.storage.local.set({settings:imported.settings,cloudSync:next,imageCacheSettings:imported.imageCacheSettings,...(imported.xFollowerSettings?{xFollowerSettings:imported.xFollowerSettings}:{}),
        cloudState:{...(sameEndpoint ? saved.cloudState : {}),phase:next.enabled?'pending':'disabled',serverRetryAt,
          retryAt:Math.max(serverRetryAt,sameEndpoint ? saved.cloudState?.retryAt || 0 : 0),message:next.enabled?'設定を読み込みました。同期は有効です。':'設定を読み込みました。同期は無効です。'},
        ...(changed ? {cloudCheckpoint:{cursor:0,receipts:{}},cloudDiagnostic:{}} : {})});
      if (next.enabled) await chrome.alarms.create(CLOUD_ALARM,{periodInMinutes:5});
      else await chrome.alarms.clear(CLOUD_ALARM);
      if (imported.imageCacheSettings.enabled) await chrome.alarms.create(IMAGE_ALARM,{periodInMinutes:5});
      else await chrome.alarms.clear(IMAGE_ALARM);
      return {ok:true,needsToken:imported.needsToken};
    } finally { cloud.resume(); }
  }
  if(message.type==='SAVE_IMAGES'){
    const enabled=message.enabled===true;
    if(enabled&&!await chrome.permissions.contains({origins:IMAGE_ORIGINS}))throw Error('画像取得の追加接続権限を許可してください。');
    await chrome.storage.local.set({imageCacheSettings:{enabled}});
    if(enabled){const config=await configuration();if(validContact(config.contact))await ensureUA(config);imageCollector.resume();await chrome.alarms.create(IMAGE_ALARM,{periodInMinutes:5});void cacheImagesQuietly();}
    else{await imageCollector.pause();imageCollector.resume();await chrome.alarms.clear(IMAGE_ALARM);}
    return {ok:true};
  }
  if(message.type==='CLEAR_IMAGES'){
    await imageCollector.pause();
    try{await clearImageCache();await chrome.storage.local.set({imageCacheState:{count:0,bytes:0,pending:0}});return {ok:true};}
    finally{imageCollector.resume();}
  }
  if (message.type === 'TEST_SYNC') { return {ok:true,...await cloud.testConnection()}; }
  if (message.type === 'SYNC') { return {ok:true, ...await runCloud({force:message.force === true})}; }
  if (message.type === 'SAVE_SYNC') {
    await cloud.pause();
    let syncAfterSave=false;
    try {
      const saved=await chrome.storage.local.get(['cloudSync','cloudState']),old=saved.cloudSync || {};
      const config = syncSettings({...message.settings, token:message.settings?.token || old.token || ''});
      if (config.enabled && !await chrome.permissions.contains({origins:CLOUD_ORIGINS})) throw new Error('Googleへの同期権限を許可してください。');
      const changed = config.endpoint !== old.endpoint || config.token !== old.token;
      const serverRetryAt=config.endpoint===old.endpoint?serverRetryDeadline(saved.cloudState):0;
      await chrome.storage.local.set({cloudSync:config,cloudState:{phase:config.enabled?'pending':'disabled',serverRetryAt,retryAt:serverRetryAt> Date.now()?serverRetryAt:0,message:config.enabled?'同期設定を保存しました。':'同期は無効です。'},...(changed?{cloudCheckpoint:{cursor:0,receipts:{}},cloudDiagnostic:{phase:'idle',message:'設定を変更しました。保存済みの設定で接続テストを実行してください。'}}:{})});
      syncAfterSave=config.enabled;
      if (config.enabled) await chrome.alarms.create(CLOUD_ALARM,{periodInMinutes:5});
      else await chrome.alarms.clear(CLOUD_ALARM);
      return {ok:true};
    } finally { cloud.resume(); if(syncAfterSave)void syncQuietly(); }
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
    profileResetting=true;followerGeneration++;
    try {
      await pause();
      await cloud.pause();
      await followerWrites;
      const cloudSaved=await chrome.storage.local.get(['cloudSync','cloudState']),cloudConfig=cloudSaved.cloudSync || {},serverRetryAt=serverRetryDeadline(cloudSaved.cloudState);
      await chrome.storage.local.set({cloudSync:{...cloudConfig,enabled:false},cloudState:{phase:'disabled',serverRetryAt,retryAt:serverRetryAt,message:'ローカル記録の削除に伴い同期を停止しました。'},cloudDiagnostic:{},cloudCheckpoint:{cursor:0,receipts:{}}});
      await chrome.alarms.clear(CLOUD_ALARM);
      await clearAll();
      await chrome.storage.local.set({imageCacheSettings:{enabled:false},imageCacheState:{count:0,bytes:0,pending:0}});
      await chrome.alarms.clear(IMAGE_ALARM);
      const s = await state();
      // Clearing personal data must not clear server-imposed backoff or the rate-limit clock.
      await chrome.storage.local.set({ accountMeta: {}, xProfileCache: {}, xFollowerCache:{}, state: { phase: 'paused', message: '保存データを削除しました。', cooldownUntil: s.cooldownUntil || 0,
        failures: s.failures || 0, lastRequestAt: s.lastRequestAt || 0, lastStartedAt: s.lastStartedAt || 0 } });
      return { ok: true };
    } finally { cloud.resume(); profileResetting=false; }
  }
  throw new Error('不明な操作です。');
}
let commandQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if(message.type==='X_FOLLOWERS_OBSERVED'){
    acceptFollowerObservation(message,sender).then(respond,()=>respond({ok:false}));return true;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (message.type === 'SYNC' || message.type === 'TEST_SYNC' || message.type === 'X_PROFILE') {
    command(message).then(respond, error => respond({ok:false,error:error.message}));
    return true;
  }
  commandQueue = commandQueue.then(() => command(message)).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void run();
  if (alarm.name === IMAGE_ALARM) void cacheImagesQuietly();
  if (alarm.name === CLOUD_ALARM) void syncQuietly();
  if (alarm.name === MAINTENANCE) configuration().then(c => Promise.all([prune(c.retentionDays),trimImageCache(IMAGE_CACHE_BYTES,IMAGE_CACHE_COUNT,Date.now()-30*86400000)])).catch(() => {});
});
async function boot() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const followerSettings=(await chrome.storage.local.get('xFollowerSettings')).xFollowerSettings;
  if(followerSettings?.enabled)await configureFollowerScript(await chrome.permissions.contains({origins:X_FOLLOWER_ORIGINS}));
  const config = await configuration();
  if ((await chrome.storage.local.get('cloudSync')).cloudSync?.enabled) {
    if (!await chrome.alarms.get(CLOUD_ALARM)) await chrome.alarms.create(CLOUD_ALARM,{periodInMinutes:5});
  }
  if ((await chrome.storage.local.get('imageCacheSettings')).imageCacheSettings?.enabled && !await chrome.alarms.get(IMAGE_ALARM))await chrome.alarms.create(IMAGE_ALARM,{periodInMinutes:5});
  await prune(config.retentionDays);
  if (!await chrome.alarms.get(MAINTENANCE)) await chrome.alarms.create(MAINTENANCE, { delayInMinutes: 60 + Math.random() * 10, periodInMinutes: 60 });
  if (config.enabled && !await chrome.alarms.get(ALARM)) {
    const s = await state(); await schedule(Math.max(s.cooldownUntil || 0, Date.now() + 3000 + Math.random() * 7000));
  }
}
chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); void boot(); });
chrome.runtime.onStartup.addListener(() => { void boot(); });
void boot().catch(() => {});
