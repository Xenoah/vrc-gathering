// Generated from extension/sync-format.js; keep identical except export keywords.
// This protocol is also installed in Apps Script as gas/Protocol.gs.
const SYNC_PROTOCOL = 2;
const RECORD_SCHEMA = 2;
const SYNC_BATCH_SIZE = 100;
const LEGACY_SYNC_KINDS = ['friends', 'events', 'worlds', 'runs', 'accounts'];
const SYNC_KINDS = [...LEGACY_SYNC_KINDS, 'visits', 'encounters'];
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function normalizeRecord(kind, input, now = Date.now()) {
  if (!SYNC_KINDS.includes(kind) || !input || typeof input !== 'object') throw Error('同期レコードの種類が不正です。');
  const id = v => typeof v === 'string' && /^(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/.test(v);
  const wid = v => typeof v === 'string' && /^wrld_[a-zA-Z0-9-]{8,64}$/.test(v);
  const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  const time = v => { if (!Number.isSafeInteger(v) || v <= 0 || v > now + 300000) throw Error('同期レコードの日時が不正です。'); return v; };
  const optionalTime = v => v == null ? null : time(v);
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
  if (kind === 'friends') {
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
  } else {
    value = { accountId, observedAt, displayName: str(input.displayName,128) || accountId };
    key = accountId;
  }
  if (input.extensions != null) value.extensions = extensions(input.extensions);
  return { kind, key: kind + ':' + accountId + ':' + key, schemaVersion:RECORD_SCHEMA, operation:'upsert', value };
}
function newerRecord(next, previous) {
  return !previous || next.value.observedAt > previous.value.observedAt ||
    (next.value.observedAt === previous.value.observedAt && canonical(next.value) > canonical(previous.value));
}

// Extension namespaces are opt-in application data; raw API fields never flow into them.
function extensions(input) {
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
function normalizeEnvelope(input, now = Date.now()) {
  if (!input || !SYNC_KINDS.includes(input.kind) || ![1,2].includes(input.schemaVersion ?? 1) || (input.operation ?? 'upsert') !== 'upsert') throw Error('SCHEMA');
  const record=normalizeRecord(input.kind,input.value,now);
  if (input.key != null && input.key !== record.key) throw Error('SCHEMA');
  return record;
}
function mergeRecord(next, previous) {
  if (!previous) return next;
  const newer=newerRecord(next,previous), winner=newer?next:previous, other=newer?previous:next;
  const extra={...other.value.extensions,...winner.value.extensions};
  return Object.keys(extra).length ? {...winner,value:{...winner.value,extensions:extensions(extra)}} : winner;
}
