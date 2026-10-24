// This protocol is also installed in Apps Script as gas/Protocol.gs.
export const SYNC_BATCH_SIZE = 100;
export const SYNC_KINDS = ['friends', 'events', 'worlds', 'runs', 'accounts'];
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
  } else {
    value = { accountId, observedAt, displayName: str(input.displayName,128) || accountId };
    key = accountId;
  }
  return { kind, key: kind + ':' + accountId + ':' + key, value };
}
export function newerRecord(next, previous) {
  return !previous || next.value.observedAt > previous.value.observedAt ||
    (next.value.observedAt === previous.value.observedAt && canonical(next.value) > canonical(previous.value));
}
