import { DEFAULTS, VERSION, settings, validContact, userAgentRule, currentUser, friend, rosterObservations, reconcile, retryDelay, jitter, world, WORLD_ID, USER_ID } from './core.js';
import { list, commit, prune, clearAll, exportSyncRecords, mergeSyncRecords, enqueueImages, cachedImages, updateCachedImage, trimImageCache, clearImageCache, activeSeries, researchKind, exportAccount, mergeArchiveRecords } from './db.js';
import { createImageCollector, imageCandidate, IMAGE_ORIGINS, IMAGE_CACHE_BYTES, IMAGE_CACHE_COUNT } from './image-cache.js';
import { createSync, syncSettings, createAccountUpdater, CLOUD_ORIGINS, serverRetryDeadline } from './sync.js';
import { resolveSettingsBackup } from './settings-backup.js';
import { reconcileConnections } from './connections.js';
import { extractXProfiles, readXCache, writeXCache, X_CACHE_TTL, xProfileURL, xProfileObservation } from './x-profile.js';
import { normalizeRecord, mergeRecord, logInstanceId } from './sync-format.js';
import { createFollowerCollector, followerTargets, X_QUEUE_ALARM } from './x-follower-collector.js';
import { X_FOLLOWER_ORIGINS, followerRecords, mergeFollowerCache } from './x-followers.js';
import { collectionSeries, stopSeries, updateSeries, compressRun } from './observation-series.js';
import { officialNote, noteChanges, noteChecks, NOTE_SCAN_INTERVAL, NOTE_CACHE_TTL } from './user-notes.js';
import { reportSummary, scheduledBoundary, DAY } from './research-model.js';
import {instanceRoster,reconcileInstancePresence,sameInstance,instanceViewState} from './instance-presence.js';
import {xConcurrency,validateXConcurrency,xScope,xAccountId,validateXScope,xBulkScope,validateXBulkScope} from './x-follower-settings.js';
import {createFriendDiscovery,X_DISCOVERY_ALARM} from './x-friend-discovery.js';

const updateAccounts = createAccountUpdater(chrome.storage.local);
let collectorPromise,activeReports,noteGeneration=0;
function collector(){return collectorPromise||=(async()=>{const saved=await chrome.storage.local.get('collectorId');if(saved.collectorId)return saved.collectorId;const id='col_'+crypto.randomUUID().replaceAll('-','');await chrome.storage.local.set({collectorId:id});return id;})();}
async function recordStop(reason,accountId){if(!accountId)return;const config=await configuration(),collectorId=await collector(),previous=await activeSeries(accountId),at=previous.filter(r=>r.value.collectorId===collectorId).reduce((at,r)=>Math.max(at,r.value.lastSeenAt+1),Date.now());await mergeSyncRecords([...stopSeries(previous,{accountId,collectorId,at,pollSeconds:config.pollSeconds,reason}),...reconcileInstancePresence(previous,{at,available:false,reason:reason==='paused'?'stopped':'unavailable'},{accountId,collectorId,pollSeconds:config.pollSeconds})]);}
async function makeReports({accountId='',viewId='',force=false}={}){
  if(profileResetting)return {ok:false,error:'データを整理中です。'};
  if(activeReports)return {ok:true,busy:true};
  activeReports=(async()=>{
    let saved=0;const views=await researchKind('views',accountId),prior=await researchKind('reports',accountId);
    for(const {value:view} of views){if(view.deleted||viewId&&view.id!==viewId||!viewId&&view.schedule==='none')continue;
      const until=force&&view.filters.rangeMode==='custom'?view.filters.until:force?Date.now():scheduledBoundary(Date.now(),view.schedule),since=force&&view.filters.rangeMode==='custom'?view.filters.since:until-view.filters.days*DAY,id='rpt_'+view.id+'_'+until;
      if(!force&&prior.some(r=>r.value.id===id))continue;
      const data=await exportAccount(view.accountId,{since}),cache=(await chrome.storage.local.get('xProfileCache')).xProfileCache||{};
      data.profiles=Object.values(cache).map(p=>({...p,observedAt:p.checkedAt}));
      const summary=reportSummary(data,{accountId:view.accountId,since,until,userId:view.filters.userId,worldId:view.filters.worldId});
      await mergeSyncRecords([normalizeRecord('reports',{accountId:view.accountId,id,viewId:view.id,title:view.title,filters:view.filters,since,until,summary,observedAt:Date.now()})]);saved++;
    }
    await chrome.storage.local.set({researchState:{lastReportAt:Date.now(),reportsSaved:saved,error:''}});if(saved)void syncQuietly();return {ok:true,saved};
  })().catch(async error=>{await chrome.storage.local.set({researchState:{error:error.message}});throw error;}).finally(()=>{activeReports=null;});return activeReports;
}
let profileWrites=Promise.resolve(),followerWrites=Promise.resolve(),followerObservations=Promise.resolve(),followerGeneration=0;
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
const cloud = createSync({ storage:chrome.storage.local, exportRecords:exportCollected, mergeRecords:mergeCollected, mergeArchiveRecords, updateAccounts, hasPermission:()=>chrome.permissions.contains({origins:CLOUD_ORIGINS}) });
const CLOUD_ALARM = 'vrc-observer-cloud';
async function runCloud(options){const outcome=await cloud.sync(options);if(!outcome.skipped&&(await chrome.storage.local.get('cloudSync')).cloudSync?.enabled)await chrome.alarms.create(CLOUD_ALARM,{periodInMinutes:outcome.pending?1:5});return outcome;}
const syncQuietly = () => runCloud().catch(() => {});

const ALARM = 'vrc-observer-next', MAINTENANCE = 'vrc-observer-prune';
const API = 'https://vrchat.com/api/1';
let activeRun = null, controller = null, activeProfile = null, profileController = null, profileResetting = false;
const followerQueue=createFollowerCollector({storage:chrome.storage.local,tabs:chrome.tabs,alarms:chrome.alarms,
  concurrency:async()=>xConcurrency((await chrome.storage.local.get('xFollowerSettings')).xFollowerSettings?.concurrency),
  allowed:async()=>!profileResetting&&(await chrome.storage.local.get('xFollowerSettings')).xFollowerSettings?.enabled===true&&await chrome.permissions.contains({origins:X_FOLLOWER_ORIGINS}),
  latest:async jobs=>{
    const saved=await chrome.storage.local.get(['xFollowerCache','xProfileCache']),records=followerRecords(saved.xFollowerCache),values={};
    const metrics=new Map(records.map(r=>[r.value.accountId+'/'+r.value.url,r.value.observedAt]));
    for(const job of jobs){const accounts=job.accounts?.length?job.accounts:Object.values(saved.xProfileCache||{}).filter(p=>readXCache(saved.xProfileCache,p?.accountId,p?.userId)?.urls.includes(job.url)).map(p=>p.accountId);
      values[job.url]=accounts.length?Math.min(...accounts.map(id=>metrics.get(id+'/'+job.url)||0)):0;}
    return values;
  },
  isKnown:async url=>{const cache=(await chrome.storage.local.get('xProfileCache')).xProfileCache||{};return Object.values(cache).some(e=>readXCache(cache,e?.accountId,e?.userId)?.urls.includes(url));}});
const friendDiscovery=createFriendDiscovery({storage:chrome.storage.local,alarms:chrome.alarms,
  allowed:async()=>!profileResetting&&(await chrome.storage.local.get('xFollowerSettings')).xFollowerSettings?.enabled===true&&await chrome.permissions.contains({origins:X_FOLLOWER_ORIGINS}),
  roster:async(accountId,signal)=>{
    if(activeProfile||activeRun)return {ok:true,busy:true};
    const abort=new AbortController(),cancel=()=>abort.abort();signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();profileController=abort;
    activeProfile=(async()=>{
      const config=await configuration();if(!validContact(config.contact))throw Error('収集設定で連絡先を保存してください。');
      await imageCollector.idle();abort.signal.throwIfAborted();await ensureUA(config);
      const me=await identity(abort.signal,'フレンド名簿を確認中',{quiet:true});
      if(me.id!==accountId)throw new ApiError('表示アカウントとVRChatのログインアカウントが異なります。',403);
      if(!Array.isArray(me.friends))throw Error('フレンド名簿を確認できませんでした。');
      return {ok:true,ids:me.friends};
    })().catch(async error=>{
      if(error.status===429){const s=await state();await patchState({cooldownUntil:Math.max(s.cooldownUntil||0,Date.now()+retryDelay(error.retryAfter,Date.now(),1))});}
      return {ok:false,error:error.message};
    }).finally(()=>{signal.removeEventListener('abort',cancel);activeProfile=null;profileController=null;});
    return activeProfile;
  },
  profiles:async()=>(await chrome.storage.local.get('xProfileCache')).xProfileCache||{},
  lookupBatch:lookupFriendXProfiles,
  targets:async(accountId,ids)=>{const saved=await chrome.storage.local.get(['xProfileCache','xFollowerCache']);return followerTargets(saved.xProfileCache,saved.xFollowerCache,accountId,ids);},
  deliver:(targets,batchId)=>followerQueue.enqueue(targets,{batchId})});
async function collectFollowers({accountId,userId,force=false}){
  if(!USER_ID.test(accountId||'')||userId&&!USER_ID.test(userId))throw Error('対象ユーザーが不正です。');
  const config=(await chrome.storage.local.get('xFollowerSettings')).xFollowerSettings||{};
  if(!userId&&xBulkScope(config.bulkScope)==='friends'){
    if(!validContact((await configuration()).contact))throw Error('収集設定で連絡先を保存してください。');
    const queue=(await chrome.storage.local.get('xFollowerQueue')).xFollowerQueue;
    if(queue?.retryAt>Date.now())throw Error('Xの制限による待機中です。時間を空けて再開してください。');
    const result=await friendDiscovery.start(accountId);await followerQueue.resume();void friendDiscovery.tick();return result;
  }
  const friends=await list('friends',accountId),saved=await chrome.storage.local.get(['xProfileCache','xFollowerCache']);
  const ids=userId?friends.filter(f=>f.id===userId).map(f=>f.id):friends.filter(f=>f.isFriend).map(f=>f.id);
  if(userId&&!ids.length)throw Error('記録済みのユーザーを選択してください。');
  const all=followerTargets(saved.xProfileCache,saved.xFollowerCache,accountId,ids),targets=userId&&!force?all.filter(t=>Date.now()-t.observedAt>=60000):all;
  if(!targets.length)return {ok:true,skipped:true,reason:all.length?'fresh':'no-links'};
  return followerQueue.enqueue(targets,{single:!!userId,force});
}
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
async function request(path, signal, progress, {quiet=false,instancePath=''}={}) {
  if (!(instancePath&&path===instancePath&&/^\/instances\/wrld_[a-zA-Z0-9-]{8,64}:[a-zA-Z0-9_%().~-]{1,3072}$/.test(path) || path === '/auth/user' || /^\/auth\/user\/friends\?n=100&offset=\d+&offline=(true|false)$/.test(path) || /^\/worlds\/wrld_[a-zA-Z0-9-]{8,64}$/.test(path) || /^\/userNotes\?n=100&offset=\d+$/.test(path) || /^\/users\/(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/.test(path) || /^\/profile\/(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/.test(path))) throw new ApiError('許可されていないAPIパスです。');
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
  try { const me=currentUser(raw,Date.now());me.self.location.instanceId=logInstanceId(me.self.location.instanceId);return me; } catch { throw new ApiError('ログインまたは2段階認証をvrchat.comで完了してください。', 401); }
}
async function readOwnInstance(signal,accountId,{quiet=false}={}){
  const before=await identity(signal,'自分の現在地を確認中',{quiet});
  if(accountId&&before.id!==accountId)throw new ApiError(quiet?'表示アカウントとVRChatのログインアカウントが異なります。':'取得中にアカウントが切り替わりました。この巡回は保存せず、停止します。',403);
  const own=before.self,reason={offline:'現実世界（ゲーム未接続）です。',web:'Web／アプリに接続中です。',traveling:'移動中です。次回の取得で確認します。',private:'現在地はプライベートのため、インスタンスを特定できません。'}[own.location.kind]||'現在のインスタンスを確認できません。';
  let snapshot={at:Date.now(),available:false,reason},worlds=[];
  if(own.presence==='online'&&own.location.kind==='world'&&own.location.instanceId){
    // The path is derived exclusively from this fresh authenticated identity.
    const path='/instances/'+own.location.worldId+':'+encodeURIComponent(own.location.instanceId);
    try{
      const raw=await request(path,signal,'In Instanceの参加者一覧を取得中',{quiet,instancePath:path});snapshot=instanceRoster(raw,own,Date.now());
      if(raw?.world?.id===own.location.worldId)worlds=[world(raw.world,before.id,snapshot.at)];
    }catch(error){
      if(signal.aborted||[401,429].includes(error.status))throw error;
      snapshot={at:Date.now(),available:false,reason:'現在地を記録しました。参加者一覧は取得できません'+(error.status?'（HTTP '+error.status+'）':'（通信または応答エラー）')+'。'};
    }
  }
  const after=await identity(signal,'自分の現在地とアカウントを再確認中',{quiet});
  if(after.id!==before.id)throw new ApiError('取得中にアカウントが切り替わりました。この取得は保存しません。',403);
  if(snapshot.available&&(!sameInstance(own.location,after.self.location)||after.self.presence!=='online'||after.self.observedAt-own.observedAt>120000))snapshot={at:Date.now(),available:false,reason:'一覧取得中に現在地が変わったか、確認間隔が空きました。'};
  signal.throwIfAborted();return {before,after,snapshot,worlds};
}
async function pages(offline, offset, maximum, signal, me) {
  const observations = [], images = [], profiles = [];
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
      const profile=xProfileObservation(item,me.id,observedAt);if(profile)profiles.push(normalizeRecord('profiles',profile));
    }
    offset += raw.length;
    if (raw.length < 100) { complete = true; offset = 0; break; }
  }
  return { observations, images, profiles, complete, nextOffset: offset };
}
async function collectUserNotes(signal,accountId,meta) {
  const prior=meta.noteScan||{},at=Date.now();
  if(!prior.offset&&!prior.pending?.length&&at-(prior.completedAt||0)<NOTE_SCAN_INTERVAL)return {samples:[],profiles:[],scan:prior};
  const scan={...prior,seen:[...(prior.seen||[])],pending:[...(prior.pending||[])],attemptedAt:at,error:''},samples=[],profiles=[];
  try{
    if(prior.offset||at-(prior.completedAt||0)>=NOTE_SCAN_INTERVAL){
      let offset=prior.offset||0;if(!offset)scan.seen=[];
      for(let page=0;page<2;page++){
        if(offset>50000)throw Error('公式ノートの一覧が大きいため取得を中断しました。');
        const raw=await request(`/userNotes?n=100&offset=${offset}`,signal,'公式ユーザーノートを取得中：'+(offset+1)+'件目から');
        if(!Array.isArray(raw)||raw.length>100)throw Error('公式ノート一覧の応答形式が不正です。');
        const rows=raw.map(r=>officialNote(r,accountId,Date.now()));samples.push(...rows);scan.seen.push(...rows.map(r=>r.userId));offset+=raw.length;
        if(raw.length<100){
          const seen=new Set(scan.seen),saved=await researchKind('userNotes',accountId);
          scan.pending=[...new Set([...scan.pending.filter(id=>!seen.has(id)),...saved.filter(r=>r.value.note&&!seen.has(r.value.userId)).map(r=>r.value.userId)])];
          offset=0;scan.completedAt=Date.now();scan.seen=[];break;
        }
      }
      scan.offset=offset;
    }
    // Missing from a mutable paginated list is not proof of deletion. Confirm individually.
    if(scan.pending.length){const userId=scan.pending[0];try{const raw=await request('/users/'+userId,signal,'公式ノートの変更を確認中');samples.push(officialNote(raw,accountId,Date.now(),{targetId:userId}));const profile=xProfileObservation(raw,accountId);if(profile)profiles.push(normalizeRecord('profiles',profile));}catch(error){if(signal.aborted||[401,403,429].includes(error.status))throw error;scan.error=error.message;}scan.pending.shift();}
    return {samples,profiles,scan};
  }catch(error){if(signal.aborted||[401,403,429].includes(error.status))throw error;return {samples:[],profiles:[],scan:{...prior,attemptedAt:at,error:error.message}};}
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
    const images=[...onlinePage.images],profiles=[...onlinePage.profiles];
    const observations = [...rosterObservations(me, previous, observedAt), ...onlinePage.observations];
    const nextMeta = { ...meta, displayName: me.displayName, onlineOffset: onlinePage.nextOffset };
    if (meta.offlineOffset || !meta.offlineCompletedAt || startedAt - meta.offlineCompletedAt > config.offlineRefreshMinutes * 60000) {
      const offlinePage = await pages(true, meta.offlineOffset || 0, 5, signal, me);
      observations.push(...offlinePage.observations);images.push(...offlinePage.images);profiles.push(...offlinePage.profiles);
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
    const notes=await collectUserNotes(signal,accountId,meta);nextMeta.noteScan=notes.scan;profiles.push(...notes.profiles);
    const own=await readOwnInstance(signal,accountId),instanceSnapshot=own.snapshot,finalMe=own.after;
    worlds.push(...own.worlds);
    signal.throwIfAborted();
    const completedAt = Date.now(), roster = finalMe.friends ? new Set(finalMe.friends) : null;
    const allowed = observations.filter(f => !roster || roster.has(f.id));
    const changes = reconcile(previous, allowed, accountId, completedAt, finalMe.friends);
    const run = { accountId, observedAt: completedAt, startedAt, completedAt, onlineComplete: onlinePage.complete,
      onlineOffset: nextMeta.onlineOffset, offlineOffset: nextMeta.offlineOffset || 0, observedCount: changes.records.length,
      changedCount: changes.events.length, worldNamesPending: Math.max(0, pendingWorlds.length - 5) };
    const [previousVisits,previousEncounters]=await Promise.all([list('visits',accountId),list('encounters',accountId)]);
    const connections=reconcileConnections(previousVisits,previousEncounters,[me.self,own.before.self,finalMe.self],allowed,accountId,{pollSeconds:config.pollSeconds,completedAt,roster});
    const collectorId=await collector(),research=collectionSeries(await activeSeries(accountId),{accountId,collectorId,pollSeconds:config.pollSeconds,samples:[...changes.records,me.self,own.before.self,finalMe.self],completedAt,rosterSize:roster?.size||0,complete:onlinePage.complete&&!(meta.onlineOffset||0)});
    const compactRun=compressRun(await list('runs',accountId),run,collectorId,config.pollSeconds);
    const instanceRecords=reconcileInstancePresence(await activeSeries(accountId),instanceSnapshot,{accountId,collectorId,pollSeconds:config.pollSeconds});
    await commit(changes.records, changes.events, worlds, compactRun, connections,[...research,...noteChanges(await researchKind('userNotes',accountId),notes.samples),...instanceRecords]);
    const linkRecords=profiles.filter(r=>!roster||roster.has(r.value.userId));if(linkRecords.length)await mergeProfiles(linkRecords);
    await chrome.storage.local.set({instanceCollectionState:instanceViewState(finalMe,instanceSnapshot,[...worlds,...cached.values()].find(w=>w.id===finalMe.self.location.worldId)?.name||'')});
    if((await chrome.storage.local.get('imageCacheSettings')).imageCacheSettings?.enabled)await enqueueImages(accountId,images.filter(v=>v&&(v.kind==='world'||!roster||roster.has(v.id))),completedAt);
    nextMeta.lastSuccessAt = completedAt;
    await updateAccounts(accounts => ({...accounts, [accountId]:{...accounts[accountId], ...nextMeta}}));
    await prune(config.retentionDays);
    const remaining = [notes.scan.error?'公式ノート：'+notes.scan.error:notes.scan.offset?'公式ノートの続き '+notes.scan.offset+'件目〜':notes.scan.pending?.length?'公式ノートの個別確認 '+notes.scan.pending.length+'件':'',!onlinePage.complete ? `オンラインの続き ${nextMeta.onlineOffset}件目〜` : '', nextMeta.offlineOffset ? `名簿の続き ${nextMeta.offlineOffset}件目〜` : '', run.worldNamesPending ? `ワールド名 ${run.worldNamesPending}件` : ''].filter(Boolean);
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
    await recordStop(status?'HTTP '+status:'取得・保存失敗',accountId||before.accountId).catch(()=>{});
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
  await recordStop('paused',(await state()).accountId).catch(()=>{});
  imageCollector.resume();
  await chrome.alarms.clear(ALARM);
  await patchState({ phase: 'paused', message: '収集を停止しています。', nextRunAt: null });
  await chrome.action.setBadgeText({ text: '' });
}
async function collectOwnInstance({accountId=''}) {
  if(typeof accountId!=='string'||accountId&&!USER_ID.test(accountId))throw Error('アカウントIDが不正です。');
  if(profileResetting)throw Error('記録を削除中です。');
  if(activeRun||activeProfile)return {ok:true,busy:true};
  const abort=new AbortController();profileController=abort;
  activeProfile=(async()=>{
    const config=await configuration(),s=await state();
    if(!validContact(config.contact))throw Error('収集設定で連絡先を保存してください。');
    if(s.cooldownUntil>Date.now())throw Error('APIの待機時間中です。時間を空けて再取得してください。');
    if(Date.now()-(s.lastOwnStartedAt||0)<60000)throw Error('現在地の手動取得は前回開始から60秒以上空けてください。');
    await patchState({lastOwnStartedAt:Date.now()});
    await imageCollector.idle();abort.signal.throwIfAborted();await ensureUA(config);
    const own=await readOwnInstance(abort.signal,accountId,{quiet:true}),id=own.after.id,collectorId=await collector(),completedAt=Date.now();
    const previous=await activeSeries(id),visits=await list('visits',id),samples=[own.before.self,own.after.self];
    const connections=reconcileConnections(visits,[],samples,[],id,{pollSeconds:config.pollSeconds,completedAt});
    const research=[...updateSeries(previous,samples.map(f=>({kind:'segments',at:f.observedAt,userId:id,state:{...f,isFriend:true}})),{accountId:id,collectorId,pollSeconds:config.pollSeconds}),
      ...reconcileInstancePresence(previous,own.snapshot,{accountId:id,collectorId,pollSeconds:config.pollSeconds})];
    abort.signal.throwIfAborted();
    await commit([],[],own.worlds,null,connections,research);
    const worlds=[...own.worlds,...await list('worlds',id)];
    const result=instanceViewState(own.after,own.snapshot,worlds.find(w=>w.id===own.after.self.location.worldId)?.name||'');
    await updateAccounts(accounts=>({...accounts,[id]:{...accounts[id],displayName:own.after.displayName}}));
    await chrome.storage.local.set({instanceCollectionState:result});
    await patchState({accountId:id,accountName:own.after.displayName});
    void syncQuietly();return {ok:true,instance:result};
  })().catch(async error=>{
    if(error.status===429||error.retryAfter!=null){const s=await state();await patchState({cooldownUntil:Math.max(s.cooldownUntil||0,Date.now()+retryDelay(error.retryAfter,Date.now(),1))});}
    return {ok:false,error:abort.signal.aborted?'現在地の取得を中止しました。':error.message};
  }).finally(()=>{activeProfile=null;profileController=null;});
  return activeProfile;
}
async function lookupFriendXProfiles(accountId,jobs,signal) {
  if(!USER_ID.test(accountId)||!Array.isArray(jobs)||jobs.length>10||jobs.some(j=>!USER_ID.test(j.userId)))throw Error('プロフィールの取得対象が不正です。');
  if(profileResetting)return {ok:false,status:403,error:'記録を削除中です。'};
  if(activeProfile||activeRun)return {ok:true,busy:true};
  const abort=new AbortController(),cancel=()=>abort.abort();signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();profileController=abort;
  activeProfile=(async()=>{
    const config=await configuration();if(!validContact(config.contact))throw new ApiError('収集設定で連絡先を保存してください。',403);
    await imageCollector.idle();abort.signal.throwIfAborted();await ensureUA(config);
    const before=await identity(abort.signal,'Xリンク確認のアカウント確認',{quiet:true});
    if(before.id!==accountId||!Array.isArray(before.friends))throw new ApiError('表示アカウントとVRChatのログイン・フレンド名簿を確認してください。',403);
    const cache=(await chrome.storage.local.get('xProfileCache')).xProfileCache||{},results=[],records=[];
    for(const {userId} of jobs){
      abort.signal.throwIfAborted();
      if(!before.friends.includes(userId)){results.push({userId,ok:true,skipped:true});continue;}
      const cached=readXCache(cache,accountId,userId);
      if(cached&&Date.now()-cached.checkedAt<X_CACHE_TTL){results.push({userId,ok:true,profile:cached});continue;}
      try{
        const raw=await request('/profile/'+userId,abort.signal,'フレンドの公開Xリンクを取得中',{quiet:true});
        if(raw?.id!==userId||!Array.isArray(raw.bioLinks)&&typeof raw.bio!=='string')throw Error('公開プロフィールのリンク情報を確認できませんでした。');
        const profile={accountId,userId,urls:extractXProfiles(raw),checkedAt:Date.now()};
        records.push(normalizeRecord('profiles',{...profile,observedAt:profile.checkedAt}));results.push({userId,ok:true,profile});
      }catch(error){if(abort.signal.aborted||[401,403,429].includes(error.status))throw error;results.push({userId,ok:false,error:error.message});}
    }
    const after=await identity(abort.signal,'Xリンク確認のアカウント再確認',{quiet:true});
    if(after.id!==accountId||!Array.isArray(after.friends))throw new ApiError('取得中にアカウントまたは名簿を確認できなくなったため、この組のプロフィールを保存しませんでした。',403);
    abort.signal.throwIfAborted();
    const current=new Set(after.friends),valid=records.filter(r=>current.has(r.value.userId));
    if(valid.length){await mergeProfiles(valid);void syncQuietly();}
    return {ok:true,results:results.map(r=>current.has(r.userId)?r:{userId:r.userId,ok:true,skipped:true})};
  })().catch(async error=>{
    if(error.status===429||error.retryAfter!=null){const s=await state();await patchState({cooldownUntil:Math.max(s.cooldownUntil||0,Date.now()+retryDelay(error.retryAfter,Date.now(),1))});}
    return {ok:false,status:error.status||0,error:abort.signal.aborted?'プロフィールの取得を中止しました。':error.message};
  }).finally(()=>{signal.removeEventListener('abort',cancel);activeProfile=null;profileController=null;});
  return activeProfile;
}
async function lookupXProfile({accountId,userId,force=false},{requireFriend=false,signal}={}) {
  if(typeof accountId!=='string'||typeof userId!=='string'||!USER_ID.test(accountId)||!USER_ID.test(userId))throw Error('ユーザーIDが不正です。');
  const cache=(await chrome.storage.local.get('xProfileCache')).xProfileCache||{},profile=readXCache(cache,accountId,userId);
  if(profileResetting)throw Error('記録を削除しています。完了してから開き直してください。');
  if(profile && Date.now()-profile.checkedAt<(force===true?60000:X_CACHE_TTL))return {ok:true,profile,cached:true};
  if(activeProfile || activeRun)return {ok:true,busy:true,profile};
  const abort=new AbortController(),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();profileController=abort;
  activeProfile=(async()=>{
    if(!requireFriend&&!(await list('friends',accountId)).some(f=>f.id===userId))throw Error('このアカウントで記録されたユーザーを選択してください。');
    const config=await configuration();
    if(!validContact(config.contact))throw Error('プロフィールの取得には、収集設定で連絡先を保存してください。');
    await imageCollector.idle();abort.signal.throwIfAborted();await ensureUA(config);
    const me=await identity(abort.signal,'公開プロフィールのアカウント確認',{quiet:true});
    if(me.id!==accountId)throw new ApiError('表示アカウントとVRChatのログインアカウントが異なります。',403);
    if(requireFriend&&!Array.isArray(me.friends))throw new ApiError('フレンド名簿を確認できませんでした。',403);
    if(requireFriend&&!me.friends.includes(userId))return {ok:true,skipped:true};
    const raw=await request('/profile/'+userId,abort.signal,'公開プロフィールを取得中',{quiet:true});
    if(raw?.id!==userId)throw Error('プロフィールのユーザーIDが一致しません。');
    if(!Array.isArray(raw.bioLinks) && typeof raw.bio!=='string')throw Error('公開プロフィールからリンク情報を取得できませんでした。');
    const urls=extractXProfiles(raw);
    const after=await identity(abort.signal,'公開プロフィールのアカウント再確認',{quiet:true});
    if(after.id!==accountId)throw new ApiError('取得中にアカウントが切り替わったため、プロフィールを保存しませんでした。',403);
    abort.signal.throwIfAborted();
    const entry={accountId,userId,urls,checkedAt:Date.now()};
    await mergeProfiles([normalizeRecord('profiles',{...entry,observedAt:entry.checkedAt})]);
    void syncQuietly();
    return {ok:true,profile:entry};
  })().catch(async error=>{
    if(error.status===429 || error.retryAfter!=null){const s=await state();await patchState({cooldownUntil:Math.max(s.cooldownUntil||0,Date.now()+retryDelay(error.retryAfter,Date.now(),1))});}
    return {ok:false,profile,status:error.status||0,error:abort.signal.aborted?'プロフィールの取得を中止しました。':error.message};
  }).finally(()=>{signal?.removeEventListener('abort',cancel);activeProfile=null;profileController=null;});
  return activeProfile;
}
async function lookupUserNote({accountId,userId,force=false,readOnly=false}) {
  const epoch=noteGeneration;
  if(typeof accountId!=='string'||typeof userId!=='string'||!USER_ID.test(accountId)||!USER_ID.test(userId))throw Error('ユーザーIDが不正です。');
  const saved=await chrome.storage.local.get(['accountMeta','userNoteChecks']);
  if(!saved.accountMeta?.[accountId])throw Error('記録済みアカウントを選択してください。');
  const records=await researchKind('userNotes',accountId),record=records.find(r=>r.value.userId===userId)?.value||null;
  const history=(await researchKind('userNoteHistory',accountId)).filter(r=>r.value.userId===userId).map(r=>r.value).sort((a,b)=>b.changedAt-a.changedAt);
  const checkedAt=saved.userNoteChecks?.[accountId+':'+userId]||0,result={record,history,checkedAt};
  if(profileResetting||epoch!==noteGeneration)throw Error('記録を削除中です。');
  if(readOnly)return {ok:true,...result,local:true};
  if(record&&checkedAt<=Date.now()&&Date.now()-checkedAt<(force===true?60000:NOTE_CACHE_TTL))return {ok:true,...result,cached:true};
  if(activeProfile||activeRun)return {ok:true,...result,busy:true};
  const abort=new AbortController();profileController=abort;
  activeProfile=(async()=>{
    if(!record&&!(await list('friends',accountId)).some(f=>f.id===userId))throw Error('このアカウントで記録されたユーザーを選択してください。');
    const config=await configuration();if(!validContact(config.contact))throw Error('収集設定で連絡先を保存してください。');
    await imageCollector.idle();abort.signal.throwIfAborted();await ensureUA(config);
    const me=await identity(abort.signal,'公式ノートのアカウント確認',{quiet:true});if(me.id!==accountId)throw Error('表示アカウントとVRChatのログインアカウントが異なります。');
    const raw=await request('/users/'+userId,abort.signal,'公式ユーザーノートを取得中',{quiet:true}),sample=officialNote(raw,accountId,Date.now(),{targetId:userId});
    const after=await identity(abort.signal,'公式ノートのアカウント再確認',{quiet:true});if(after.id!==accountId)throw Error('取得中にアカウントが切り替わったため、ノートを保存しませんでした。');
    abort.signal.throwIfAborted();const changes=noteChanges(await researchKind('userNotes',accountId),[sample]);await mergeSyncRecords(changes);
    const profile=xProfileObservation(raw,accountId,sample.observedAt);if(profile)await mergeProfiles([normalizeRecord('profiles',profile)]);
    const cache=(await chrome.storage.local.get('userNoteChecks')).userNoteChecks||{};await chrome.storage.local.set({userNoteChecks:noteChecks(cache,accountId,userId,sample.observedAt)});void syncQuietly();
    return {ok:true,record:(await researchKind('userNotes',accountId)).find(r=>r.value.userId===userId)?.value||null,history:(await researchKind('userNoteHistory',accountId)).filter(r=>r.value.userId===userId).map(r=>r.value).sort((a,b)=>b.changedAt-a.changedAt),checkedAt:sample.observedAt};
  })().catch(async error=>{
    if(error.status===429||error.retryAfter!=null){const s=await state();await patchState({cooldownUntil:Math.max(s.cooldownUntil||0,Date.now()+retryDelay(error.retryAfter,Date.now(),1))});}
    return {ok:false,...result,error:abort.signal.aborted?'公式ノートの取得を中止しました。':error.message};
  }).finally(()=>{activeProfile=null;profileController=null;});return activeProfile;
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
  if(message.url!==url||!xProfileURL(url))return {ok:false};
  const generation=followerGeneration,saved=await chrome.storage.local.get(['xFollowerSettings','xProfileCache','accountMeta']);
  if(!saved.xFollowerSettings?.enabled||!await chrome.permissions.contains({origins:X_FOLLOWER_ORIGINS}))return {ok:false};
  const cache=saved.xProfileCache||{},owners=new Set();
  for(const entry of Object.values(cache)){const profile=readXCache(cache,entry?.accountId,entry?.userId);if(profile?.urls.includes(url))owners.add(profile.accountId);}
  // All-profile observations belong to an explicitly chosen dataset, not an inferred VRChat person.
  const target=xAccountId(saved.xFollowerSettings.accountId);
  if(xScope(saved.xFollowerSettings.scope)==='all'&&target&&saved.accountMeta?.[target])owners.add(target);
  if(!owners.size||profileResetting||generation!==followerGeneration)return {ok:false};
  const records=[...owners].map(accountId=>normalizeRecord('xFollowers',{accountId,url,followers:message.followers,approximate:message.approximate,source:'x-profile',observedAt:Date.now()}));
  for(const record of records){const v=record.value,previous=await activeSeries(v.accountId),collectorId=await collector();if(profileResetting||generation!==followerGeneration)return {ok:false};await mergeSyncRecords(updateSeries(previous,[{kind:'followerHistory',at:v.observedAt,url:v.url,followers:v.followers,approximate:v.approximate}],{accountId:v.accountId,collectorId,pollSeconds:180}));}
  if(profileResetting||generation!==followerGeneration)return {ok:false};
  await mergeFollowers(records);await followerQueue.observed(url,sender.tab.id);void syncQuietly();return {ok:true};
}
async function command(message) {
  if(message.type==='COLLECT_OWN_INSTANCE')return collectOwnInstance(message);
  if(message.type==='LOG_CONTEXT'){
    const saved=await chrome.storage.local.get(['accountMeta','logImportEpoch']);
    if(!saved.accountMeta?.[message.accountId])throw Error('記録済みの表示アカウントを選択してください。');
    return {ok:true,epoch:saved.logImportEpoch||0};
  }
  if(message.type==='IMPORT_LOG_ENCOUNTERS'){
    const saved=await chrome.storage.local.get(['accountMeta','logImportEpoch']);
    if(profileResetting||message.epoch!==(saved.logImportEpoch||0))throw Error('記録の削除・設定変更後のためログ取り込みを中止しました。');
    if(!saved.accountMeta?.[message.accountId]||!Array.isArray(message.records)||message.records.length>100)throw Error('ログの取り込み対象が不正です。');
    const rows=message.records.map(value=>{if(value.accountId!==message.accountId||!['vrchat-output-log','vrchat-logcat'].includes(value.source))throw Error('ログのアカウントまたは記録元が一致しません。');return normalizeRecord('instanceEncounters',value);});
    await mergeSyncRecords(rows);await chrome.storage.local.set({logImportState:{updatedAt:Date.now(),accountId:message.accountId}});
    void syncQuietly();return {ok:true,saved:rows.length};
  }
  if(message.type==='SAVE_RESEARCH'){
    if(!['annotations','views'].includes(message.kind))throw Error('保存する形式が不正です。');
    const accountId=message.value?.accountId;if(!(await chrome.storage.local.get('accountMeta')).accountMeta?.[accountId])throw Error('記録済みアカウントを選択してください。');
    const record=normalizeRecord(message.kind,{...message.value,id:message.value.id||'item_'+crypto.randomUUID().replaceAll('-',''),observedAt:Date.now()});
    await mergeSyncRecords([record]);void syncQuietly();return {ok:true,record};
  }
  if(message.type==='LOAD_ARCHIVE'){const result=await cloud.loadRange(message);if(result.skipped)throw Error('同期または設定変更中です。完了後に再試行してください。');return result;}
  if(message.type==='RUN_REPORTS')return makeReports({accountId:message.accountId,viewId:message.viewId,force:true});
  if(message.type==='USER_NOTE')return lookupUserNote(message);
  if(message.type==='X_PROFILE')return lookupXProfile(message);
  if(message.type==='COLLECT_X_FOLLOWERS')return collectFollowers(message);
  if(message.type==='PAUSE_X_FOLLOWERS'){await friendDiscovery.pause();return followerQueue.pause();}
  if(message.type==='RESUME_X_FOLLOWERS'){await followerQueue.resume();const result=await friendDiscovery.resume();void friendDiscovery.tick();return result;}
  if(message.type==='CLEAR_X_QUEUE'){await friendDiscovery.clear();await followerQueue.clear();return {ok:true};}
  if(message.type==='SAVE_X_FOLLOWERS'){
    const enabled=message.enabled===true,previous=(await chrome.storage.local.get('xFollowerSettings')).xFollowerSettings||{};
    const concurrency=message.concurrency===undefined?xConcurrency(previous.concurrency):validateXConcurrency(message.concurrency);
    const scope=message.scope===undefined?xScope(previous.scope):validateXScope(message.scope),accountId=message.accountId===undefined?xAccountId(previous.accountId):xAccountId(message.accountId);
    if(message.accountId!==undefined&&message.accountId!==''&&!accountId)throw Error('Xの保存先アカウントが不正です。');
    if(scope==='all'&&(!accountId||enabled&&!(await chrome.storage.local.get('accountMeta')).accountMeta?.[accountId]))throw Error('全員モードの保存先には、VRChatで取得済みのアカウントを選んでください。');
    if(enabled&&!await chrome.permissions.contains({origins:X_FOLLOWER_ORIGINS}))throw Error('Xへの接続を許可してください。');
    if(enabled!==previous.enabled||scope!==xScope(previous.scope)||accountId!==xAccountId(previous.accountId))followerGeneration++;
    const bulkScope=message.bulkScope===undefined?xBulkScope(previous.bulkScope):validateXBulkScope(message.bulkScope);
    const settings={enabled,concurrency,scope,accountId,bulkScope};
    await chrome.storage.local.set({xFollowerSettings:settings});
    if(!enabled){await friendDiscovery.pause();await followerQueue.pause();}
    await configureFollowerScript(enabled);if(enabled)void followerQueue.tick().catch(()=>{});return {ok:true,settings};
  }
  if (message.type === 'IMPORT_SETTINGS') {
    const current = await chrome.storage.local.get('cloudSync');
    const imported = resolveSettingsBackup(message.backup, current.cloudSync);
    const origins = [...(imported.cloudSync.enabled ? CLOUD_ORIGINS : []), ...(imported.imageCacheSettings.enabled ? IMAGE_ORIGINS : []),...(imported.xFollowerSettings?.enabled ? X_FOLLOWER_ORIGINS : [])];
    if (origins.length && !await chrome.permissions.contains({origins})) throw Error('設定の読み込みに必要な接続権限を許可してください。');
    await cloud.pause();
    try {
      await friendDiscovery.pause();await pause();
      if(imported.xFollowerSettings){followerGeneration++;await followerQueue.pause();await configureFollowerScript(imported.xFollowerSettings.enabled);}
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
    profileResetting=true;followerGeneration++;noteGeneration++;
    try {
      const logEpoch=(await chrome.storage.local.get('logImportEpoch')).logImportEpoch||0;
      await chrome.storage.local.set({logImportEpoch:logEpoch+1,logImportState:{},instanceCollectionState:{}});
      await friendDiscovery.clear();await followerQueue.clear();
      await pause();
      await cloud.pause();
      await followerObservations.catch(()=>{});
      await followerWrites;
      if(activeReports)await activeReports.catch(()=>{});
      const cloudSaved=await chrome.storage.local.get(['cloudSync','cloudState']),cloudConfig=cloudSaved.cloudSync || {},serverRetryAt=serverRetryDeadline(cloudSaved.cloudState);
      await chrome.storage.local.set({cloudSync:{...cloudConfig,enabled:false},cloudState:{phase:'disabled',serverRetryAt,retryAt:serverRetryAt,message:'ローカル記録の削除に伴い同期を停止しました。'},cloudDiagnostic:{},cloudCheckpoint:{cursor:0,receipts:{}}});
      await chrome.alarms.clear(CLOUD_ALARM);
      await clearAll();
      await chrome.storage.local.set({imageCacheSettings:{enabled:false},imageCacheState:{count:0,bytes:0,pending:0}});
      await chrome.alarms.clear(IMAGE_ALARM);
      const s = await state();
      // Clearing personal data must not clear server-imposed backoff or the rate-limit clock.
      await chrome.storage.local.set({ accountMeta: {}, xProfileCache: {}, xFollowerCache:{}, userNoteChecks:{}, state: { phase: 'paused', message: '保存データを削除しました。', cooldownUntil: s.cooldownUntil || 0,
        failures: s.failures || 0, lastRequestAt: s.lastRequestAt || 0, lastStartedAt: s.lastStartedAt || 0, lastOwnStartedAt:s.lastOwnStartedAt||0 } });
      return { ok: true };
    } finally { cloud.resume(); profileResetting=false; }
  }
  throw new Error('不明な操作です。');
}
let commandQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if(message.type==='X_FOLLOWERS_UNAVAILABLE'){
    if(sender.id!==chrome.runtime.id||sender.frameId!==0||!Number.isInteger(sender.tab?.id)||!['not-found','suspended'].includes(message.reason)||!message.url||xProfileURL(sender.url)!==message.url||!sender.url?.startsWith('https://x.com/'))return false;
    followerQueue.unavailable(sender.tab.id,message.url,message.reason).then(respond,()=>respond({ok:false}));return true;
  }
  if(message.type==='X_FOLLOWERS_BLOCKED'){
    if(sender.id!==chrome.runtime.id||sender.frameId!==0||!Number.isInteger(sender.tab?.id)||!sender.url?.startsWith('https://x.com/')||!['login','rate-limit'].includes(message.reason))return false;
    followerQueue.blocked(sender.tab.id,message.reason).then(async blocked=>{if(blocked)await friendDiscovery.pause('Xのログイン・利用制限を確認してから再開してください。');respond({ok:true});},()=>respond({ok:false}));return true;
  }
  if(message.type==='X_FOLLOWERS_OBSERVED'){
    const generation=followerGeneration;const work=followerObservations.catch(()=>{}).then(()=>generation===followerGeneration?acceptFollowerObservation(message,sender):{ok:false});followerObservations=work;work.then(respond,()=>respond({ok:false}));return true;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (message.type === 'SYNC' || message.type === 'TEST_SYNC' || message.type === 'X_PROFILE' || message.type === 'USER_NOTE' || message.type === 'COLLECT_OWN_INSTANCE') {
    command(message).then(respond, error => respond({ok:false,error:error.message}));
    return true;
  }
  commandQueue = commandQueue.then(() => command(message)).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onUpdated?.addListener((id,change)=>{if(change.status==='complete'||change.url)void followerQueue.tabChanged(id).catch(()=>{});});
chrome.tabs.onRemoved?.addListener(id=>{void followerQueue.tabChanged(id).catch(()=>{});});
chrome.action.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === X_DISCOVERY_ALARM) void friendDiscovery.tick().catch(()=>{});
  if (alarm.name === X_QUEUE_ALARM) void followerQueue.tick().catch(()=>{});
  if (alarm.name === ALARM) void run();
  if (alarm.name === IMAGE_ALARM) void cacheImagesQuietly();
  if (alarm.name === CLOUD_ALARM) void syncQuietly();
  if (alarm.name === 'vrc-observer-reports') void makeReports().catch(()=>{});
  if (alarm.name === MAINTENANCE) configuration().then(c => Promise.all([prune(c.retentionDays),trimImageCache(IMAGE_CACHE_BYTES,IMAGE_CACHE_COUNT,Date.now()-30*86400000)])).catch(() => {});
});
async function boot() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const followerSettings=(await chrome.storage.local.get('xFollowerSettings')).xFollowerSettings;
  if(followerSettings?.enabled)await configureFollowerScript(await chrome.permissions.contains({origins:X_FOLLOWER_ORIGINS}));
  void followerQueue.tick().catch(()=>{});void friendDiscovery.tick().catch(()=>{});
  const config = await configuration();
  await chrome.alarms.create('vrc-observer-reports',{periodInMinutes:60});
  void makeReports().catch(()=>{});
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
