// This protocol is also installed in Apps Script as gas/Protocol.gs.
export const SYNC_PROTOCOL = 2;
export const RECORD_SCHEMA = 2;
export const SYNC_BATCH_SIZE = 100;
export const LEGACY_SYNC_KINDS = ['friends', 'events', 'worlds', 'runs', 'accounts'];
export const RESEARCH_KINDS = ['segments','crowd','coverage','followerHistory','annotations','views','reports'];
export const SYNC_KINDS = [...LEGACY_SYNC_KINDS, 'visits', 'encounters', 'profiles', 'xFollowers', ...RESEARCH_KINDS];
export const ARCHIVE_KINDS = ['profiles','xFollowers','annotations','views'];
export const HISTORY_KINDS = ['events','runs','visits','encounters','segments','crowd','coverage','followerHistory','reports'];
// Exact observation times, encoded as base-36 deltas rather than repeated state snapshots.
export function decodeChecks(startedAt, checks='') {
  if(typeof checks!=='string'||checks.length>6000)throw Error('SCHEMA');
  const times=[startedAt];
  if(checks)for(const part of checks.split('.')){
    if(!/^[0-9a-z]{1,11}$/.test(part)||times.length>=1024)throw Error('SCHEMA');
    const delta=parseInt(part,36),at=times[times.length-1]+delta;
    if(delta<=0||!Number.isSafeInteger(at))throw Error('SCHEMA');times.push(at);
  }
  return times;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function normalizeRecord(kind, input, now = Date.now()) {
  if (!SYNC_KINDS.includes(kind) || !input || typeof input !== 'object') throw Error('同期レコードの種類が不正です。');
  const id = v => typeof v === 'string' && /^(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/.test(v);
  const wid = v => typeof v === 'string' && /^wrld_[a-zA-Z0-9-]{8,64}$/.test(v);
  const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  const time = v => { if (!Number.isSafeInteger(v) || v <= 0 || v > now + 300000) throw Error('同期レコードの日時が不正です。'); return v; };
  const optionalTime = v => v == null ? null : time(v);
  const count=v=>{if(!Number.isSafeInteger(v)||v<0)throw Error('SCHEMA');return v;};
  const token=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(v);
  const loc = value => {
    const v = value || {}, kind = ['world','private','offline','traveling','web','unknown'].includes(v.kind) ? v.kind : 'unknown';
    if (kind === 'world' && !wid(v.worldId)) throw Error('ワールドIDが不正です。');
    return { kind, worldId: kind === 'world' ? v.worldId : '', instanceId: kind === 'world' ? str(v.instanceId, 1024) : '',
      access: kind === 'world' ? str(v.access, 40) : '', region: kind === 'world' ? str(v.region, 20) : '' };
  };
  const state = v => {
    if (!v || typeof v !== 'object') throw Error('状態データが不正です。');
    const presence = ['online','active','offline','unknown'].includes(v.presence) ? v.presence : 'unknown';
    return { displayName: str(v.displayName,128), presence, status: str(v.status,40), statusDescription: str(v.statusDescription,512),
      platform: str(v.platform,80), isFriend: v.isFriend === true, location: loc(presence === 'offline' ? {kind:'offline'} : v.location) };
  };
  if (!id(input.accountId)) throw Error('アカウントIDが不正です。');
  const accountId = input.accountId, observedAt = time(input.observedAt);
  let value, key;
  if (['segments','crowd','coverage','followerHistory'].includes(kind)) {
    if(!token(input.collectorId))throw Error('SCHEMA');
    const startedAt=time(input.startedAt),lastSeenAt=time(input.lastSeenAt),endedAt=optionalTime(input.endedAt),checks=input.checks||'',times=decodeChecks(startedAt,checks);
    if(startedAt>lastSeenAt||times[times.length-1]!==lastSeenAt||lastSeenAt>observedAt||endedAt!=null&&(endedAt<lastSeenAt||endedAt>observedAt))throw Error('SCHEMA');
    value={accountId,observedAt,collectorId:input.collectorId,startedAt,lastSeenAt,endedAt,checks,sampleCount:times.length,
      endReason:['changed','gap','stopped','continued'].includes(input.endReason)?input.endReason:'',pollSeconds:Number.isInteger(input.pollSeconds)&&input.pollSeconds>=60&&input.pollSeconds<=3600?input.pollSeconds:180};
    if(kind==='segments'){
      if(!id(input.userId))throw Error('SCHEMA');value.userId=input.userId;value.state=state(input.state);key=input.userId;
    }else if(kind==='crowd'){
      if(!wid(input.worldId))throw Error('SCHEMA');Object.assign(value,{worldId:input.worldId,count:count(input.count),instances:count(input.instances),complete:input.complete===true});key=input.worldId;
    }else if(kind==='coverage'){
      if(!['complete','partial','error','paused'].includes(input.outcome))throw Error('SCHEMA');
      Object.assign(value,{outcome:input.outcome,reason:str(input.reason,120),observedUsers:count(input.observedUsers||0),rosterSize:count(input.rosterSize||0),online:count(input.online||0),web:count(input.web||0),offline:count(input.offline||0),private:count(input.private||0),visible:count(input.visible||0)});key='collection';
    }else{
      if(typeof input.url!=='string'||!/^https:\/\/x\.com\/[a-z0-9_]{1,15}$/.test(input.url)||typeof input.approximate!=='boolean')throw Error('SCHEMA');
      Object.assign(value,{url:input.url,followers:count(input.followers),approximate:input.approximate,source:'x-profile'});key=input.url.slice(14);
    }
    key=input.collectorId+':'+key+':'+startedAt;
  } else if(kind==='annotations'||kind==='views'||kind==='reports'){
    if(!token(input.id))throw Error('SCHEMA');value={accountId,observedAt,id:input.id,title:str(input.title,160),deleted:input.deleted===true};key=input.id;
    if(kind==='annotations'){
      const planned=v=>{if(!Number.isSafeInteger(v)||v<=0||v>now+366*86400000)throw Error('SCHEMA');return v;};const start=planned(input.start),end=planned(input.end);if(end<start)throw Error('SCHEMA');
      Object.assign(value,{start,end,worldId:wid(input.worldId)?input.worldId:'',note:str(input.note,2000),tags:Array.isArray(input.tags)?[...new Set(input.tags.filter(v=>typeof v==='string').map(v=>v.slice(0,50)))].slice(0,20):[]});
    }else{
      const f=input.filters||{};
      value.filters={days:[1,7,30,90,365].includes(f.days)?f.days:7,userId:id(f.userId)?f.userId:'',worldId:wid(f.worldId)?f.worldId:'',tool:['crowd','pairs','quality','replay','followers','events','traits','reports'].includes(f.tool)?f.tool:'crowd',sort:['duration','count','latest','name'].includes(f.sort)?f.sort:'duration'};
      if(f.rangeMode==='custom'){const since=time(f.since),until=time(f.until);if(until<=since)throw Error('SCHEMA');Object.assign(value.filters,{rangeMode:'custom',since,until});}
      if(kind==='views')value.schedule=['none','daily','weekly'].includes(input.schedule)?input.schedule:'none';
      else{
        const since=time(input.since),until=time(input.until);if(until<=since||until>observedAt)throw Error('SCHEMA');
        value.since=since;value.until=until;value.viewId=token(input.viewId)?input.viewId:'';
        value.summary=extensions({'vrc.report':input.summary||{}})['vrc.report'];
      }
    }
  } else if (kind === 'friends') {
    if (!id(input.id)) throw Error('フレンドIDが不正です。');
    value = { ...state(input), accountId, id: input.id, observedAt, profileObservedAt: optionalTime(input.profileObservedAt),
      firstObservedAt: time(input.firstObservedAt || observedAt), stateFirstObservedAt: time(input.stateFirstObservedAt || observedAt) };
    key = input.id;
  } else if (kind === 'events') {
    if (!id(input.userId) || !['first','changed','roster-removed'].includes(input.kind)) throw Error('変更履歴が不正です。');
    value = { accountId, userId: input.userId, observedAt, displayName: str(input.displayName,128), kind: input.kind,
      previousObservedAt: optionalTime(input.previousObservedAt), previous: input.previous ? state(input.previous) : null, current: state(input.current) };
    key = input.userId + ':' + observedAt;
  } else if (kind === 'worlds') {
    if (!wid(input.id)) throw Error('ワールドIDが不正です。');
    value = { accountId, id: input.id, observedAt, name: str(input.name,256), authorName: str(input.authorName,128),
      capacity: Number.isFinite(input.capacity) ? input.capacity : null, retryAt: observedAt + 86400000 };
    if(input.traits&&typeof input.traits==='object')value.traits={tags:Array.isArray(input.traits.tags)?[...new Set(input.traits.tags.filter(v=>typeof v==='string').map(v=>v.slice(0,100)))].slice(0,50):[],
      platforms:Array.isArray(input.traits.platforms)?[...new Set(input.traits.platforms.filter(v=>['standalonewindows','android','ios'].includes(v)))]:[],
      releaseStatus:str(input.traits.releaseStatus,40),visits:Number.isSafeInteger(input.traits.visits)&&input.traits.visits>=0?input.traits.visits:null,favorites:Number.isSafeInteger(input.traits.favorites)&&input.traits.favorites>=0?input.traits.favorites:null};
    key = input.id;
  } else if (kind === 'runs') {
    const count = v => Number.isSafeInteger(v) && v >= 0 ? v : 0;
    value = { accountId, observedAt, startedAt: time(input.startedAt), completedAt: time(input.completedAt), onlineComplete: input.onlineComplete === true,
      onlineOffset: count(input.onlineOffset), offlineOffset: count(input.offlineOffset), observedCount: count(input.observedCount), changedCount: count(input.changedCount), worldNamesPending: count(input.worldNamesPending) };
    key = String(value.startedAt);
  } else if (kind === 'visits' || kind === 'encounters') {
    const startedAt=time(input.startedAt),lastSeenAt=time(input.lastSeenAt),endedAt=optionalTime(input.endedAt);
    if(startedAt>lastSeenAt || lastSeenAt>observedAt || endedAt!=null && (endedAt<lastSeenAt || endedAt>observedAt))throw Error('観測区間の日時が不正です。');
    value={accountId,observedAt,startedAt,lastSeenAt,endedAt,displayName:str(input.displayName,128),location:loc(input.location)};
    if(kind==='visits') {
      value.presence=['online','active','offline','unknown'].includes(input.presence)?input.presence:'unknown';
      if(value.presence==='offline')value.location=loc({kind:'offline'});
      key=String(startedAt);
    } else {
      if(!id(input.userId) || input.userId===accountId || !['instance','world'].includes(input.relation) || value.location.kind!=='world')throw Error('同席記録の形式が不正です。');
      const visitStartedAt=time(input.visitStartedAt),otherInstanceId=str(input.otherInstanceId,1024);
      if(visitStartedAt>startedAt || input.relation==='instance' && (!otherInstanceId || otherInstanceId!==value.location.instanceId))throw Error('同席先が一致しません。');
      Object.assign(value,{userId:input.userId,visitStartedAt,relation:input.relation,otherInstanceId});
      key=input.userId+':'+startedAt;
    }
  } else if(kind==='xFollowers') {
    if(typeof input.url!=='string'||!/^https:\/\/x\.com\/[a-z0-9_]{1,15}$/.test(input.url)||
      !Number.isSafeInteger(input.followers)||input.followers<0||typeof input.approximate!=='boolean'||input.source!=='x-profile')throw Error('SCHEMA');
    value={accountId,observedAt,url:input.url,followers:input.followers,approximate:input.approximate,source:input.source};key=input.url.slice(14);
  } else if(kind==='profiles') {
    if(!id(input.userId)||!Array.isArray(input.urls)||input.urls.length>5)throw Error('SCHEMA');
    const reserved=['home','i','intent','share','search','explore','notifications','messages','settings','login','logout','signup','account','compose','hashtag','tos','privacy','about','download','jobs','ads','oauth','communities','lists','topics','spaces','help','support'];
    const urls=[...new Set(input.urls)];
    if(urls.some(url=>typeof url!=='string'||!/^https:\/\/x\.com\/[a-z0-9_]{1,15}$/.test(url)||reserved.includes(url.slice(14))))throw Error('SCHEMA');
    value={accountId,userId:input.userId,observedAt,urls};key=input.userId;
  } else {
    value = { accountId, observedAt, displayName: str(input.displayName,128) || accountId };
    key = accountId;
  }
  if (input.extensions != null) value.extensions = extensions(input.extensions);
  return { kind, key: kind + ':' + accountId + ':' + key, schemaVersion:RECORD_SCHEMA, operation:'upsert', value };
}
export function newerRecord(next, previous) {
  return !previous || next.value.observedAt > previous.value.observedAt ||
    (next.value.observedAt === previous.value.observedAt && canonical(next.value) > canonical(previous.value));
}

// Extension namespaces are opt-in application data; raw API fields never flow into them.
export function extensions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('SCHEMA');
  function copy(value, depth) {
    if (depth > 4) throw Error('SCHEMA');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (Array.isArray(value)) return value.map(v=>copy(v,depth+1));
    if (!value || typeof value !== 'object') throw Error('SCHEMA');
    const out={};
    for (const [key,v] of Object.entries(value)) {
      if (['__proto__','constructor','prototype'].includes(key) || key.length>100) throw Error('SCHEMA');
      out[key]=copy(v,depth+1);
    }
    return out;
  }
  for (const key of Object.keys(input)) if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(key)) throw Error('SCHEMA');
  const value=copy(input,0);
  if (canonical(value).length>8000) throw Error('SCHEMA');
  return value;
}
export function normalizeEnvelope(input, now = Date.now()) {
  if (!input || !SYNC_KINDS.includes(input.kind) || ![1,2].includes(input.schemaVersion ?? 1) || (input.operation ?? 'upsert') !== 'upsert') throw Error('SCHEMA');
  const record=normalizeRecord(input.kind,input.value,now);
  if (input.key != null && input.key !== record.key) throw Error('SCHEMA');
  return record;
}
export function mergeRecord(next, previous) {
  if (!previous) return next;
  const newer=newerRecord(next,previous), other=newer?previous:next;let winner=newer?next:previous;
  if(winner.kind==='worlds'&&!winner.value.traits&&other.value.traits)winner={...winner,value:{...winner.value,traits:other.value.traits}};
  const extra={...other.value.extensions,...winner.value.extensions};
  return Object.keys(extra).length ? {...winner,value:{...winner.value,extensions:extensions(extra)}} : winner;
}
