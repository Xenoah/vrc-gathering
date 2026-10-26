// Continuity runs independently inside the service worker and the Node mock harness.
export const ACTIVITY_NAMESPACE = 'vrc.activity';
const validStart = (value, upper) => Number.isSafeInteger(value) && value > 0 && value <= upper;
export function continuityMetadata(previous, current) {
  const time = current.observedAt;
  const meta = previous?.extensions?.[ACTIVITY_NAMESPACE];
  // Legacy clients omit this namespace; mergeRecord preserves older extensions.
  // Only reuse continuity recorded for the snapshot we actually received.
  const old = meta?.observedAt === previous?.observedAt ? meta : {};
  const sameFriend = !!previous && previous.isFriend === current.isFriend;
  const samePresence = sameFriend && previous.presence === current.presence;
  const a = previous?.location || {}, b = current.location || {};
  const samePlace = samePresence && a.kind === b.kind && a.worldId === b.worldId;
  const sameInstance = samePlace && a.instanceId === b.instanceId;
  const prior = (key, same) => {
    if (!same) return time;
    // Legacy data has no independent continuity fields. StateFirstObservedAt
    // is conservative: display name or status edits could have reset it.
    const fallback = previous.stateFirstObservedAt || previous.observedAt;
    const since = validStart(old[key], previous.observedAt) ? old[key] :
      validStart(fallback, previous.observedAt) ? fallback : previous.observedAt;
    return Math.min(time, since);
  };
  return {
    observedAt: time,
    presenceSince: prior('presenceSince', samePresence),
    placeSince: prior('placeSince', samePlace),
    instanceSince: prior('instanceSince', sameInstance)
  };
}


export const VERSION = '0.17.1';
export const DEFAULTS = Object.freeze({ enabled: false, contact: '', pollSeconds: 180, retentionDays: 30, offlineRefreshMinutes: 60 });
export const USER_ID = /^(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/;
export const WORLD_ID = /^wrld_[a-zA-Z0-9-]{8,64}$/;
export const text = (v, max = 512) => typeof v === 'string' ? v.slice(0, max) : '';
export function settings(input = {}) {
  const number = (v, fallback, min, max) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.round(Number(v)))) : fallback;
  return { enabled: input.enabled === true, contact: text(input.contact, 180).trim(),
    pollSeconds: number(input.pollSeconds ?? 180, 180, 60, 3600),
    retentionDays: number(input.retentionDays ?? 30, 30, 1, 365),
    offlineRefreshMinutes: number(input.offlineRefreshMinutes ?? 60, 60, 30, 1440) };
}
export function validContact(v) {
  return typeof v === 'string' && /^[\x21-\x7e]{5,180}$/.test(v) &&
    (/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(v) || /^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_/?=#.%:+~-]+$/.test(v));
}
export function userAgentRule(id, browserUA, contact) {
  if (!validContact(contact)) throw new Error('連絡先のメールアドレスまたはHTTPSプロフィールURLを入力してください。');
  return { id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: `${browserUA} VRCFriendsObserver/${VERSION} ${contact}` }] },
    condition: { urlFilter: '|https://vrchat.com/api/1/', initiatorDomains: [id], resourceTypes: ['xmlhttprequest'], requestMethods: ['get'] } };
}
export function currentUser(raw, observedAt = Date.now()) {
  if (!raw || typeof raw.id !== 'string' || !USER_ID.test(raw.id) || raw.requiresTwoFactorAuth) throw new Error('LOGIN_REQUIRED');
  const ids = key => Array.isArray(raw[key]) ? [...new Set(raw[key].filter(id => typeof id === 'string' && USER_ID.test(id)))] : null;
  // Never retain the raw CurrentUser response: it can contain tokens, email and account details.
  // homeLocation is a preference, never evidence of the current location.
  const p=raw.presence&&(!raw.presence.id||raw.presence.id===raw.id)?raw.presence:null;
  const presenceInstance=typeof p?.instance==='string'&&(!p.instance.startsWith('wrld_')||p.instance.startsWith(p.world+':'))?p.instance.replace(/^wrld_[a-zA-Z0-9-]{8,64}:/,''):'';
  const ownLocation = typeof raw.location === 'string' && raw.location ? raw.location : WORLD_ID.test(raw.worldId) ? raw.worldId + (typeof raw.instanceId === 'string' && raw.instanceId ? ':' + raw.instanceId : '') : WORLD_ID.test(p?.world)?p.world+(presenceInstance?':'+presenceInstance:''):'';
  const own = friend({...raw,location:ownLocation},observedAt,WORLD_ID.test(ownLocation.split(':')[0]) ? 'online' : 'unknown');
  return { id: raw.id, displayName: text(raw.displayName, 128), self:{id:raw.id,displayName:own.displayName,presence:own.presence,location:own.presence==='online'?own.location:location('',own.presence),observedAt}, friends: ids('friends'),
    offlineFriends: ids('offlineFriends'), onlineFriends: ids('onlineFriends'), activeFriends: ids('activeFriends') };
}
export function location(value, presence = 'unknown') {
  const raw = text(value, 1024);
  if (presence === 'offline' || raw === 'offline') return { kind: 'offline', worldId: '', instanceId: '', access: '', region: '' };
  if (raw === 'private') return { kind: 'private', worldId: '', instanceId: '', access: '', region: '' };
  if (raw === 'traveling') return { kind: 'traveling', worldId: '', instanceId: '', access: '', region: '' };
  const colon = raw.indexOf(':');
  const worldId = colon < 0 ? raw : raw.slice(0, colon);
  if (!WORLD_ID.test(worldId)) return { kind: presence === 'active' ? 'web' : 'unknown', worldId: '', instanceId: '', access: '', region: '' };
  const instanceId = colon < 0 ? '' : raw.slice(colon + 1);
  const region = /~region\(([a-z0-9-]+)\)/i.exec(instanceId)?.[1] || '';
  let access = instanceId ? 'public' : 'unknown';
  if (/~group\(/.test(instanceId)) access = 'group-' + (/~groupAccessType\(([^)]+)\)/.exec(instanceId)?.[1] || 'unknown');
  else if (/~private\(/.test(instanceId)) access = /~canRequestInvite(?:~|$)/.test(instanceId) ? 'invite-plus' : 'invite';
  else if (/~friends\(/.test(instanceId)) access = 'friends';
  else if (/~hidden\(/.test(instanceId)) access = 'friends-plus';
  return { kind: 'world', worldId, instanceId, access, region };
}
export function friend(raw, observedAt, fallback = 'unknown') {
  if (!raw || typeof raw.id !== 'string' || !USER_ID.test(raw.id)) return null;
  const state = ['online', 'active', 'offline'].includes(raw.state) ? raw.state : fallback;
  const presence = raw.location === 'offline' || fallback === 'offline' ? 'offline' : state;
  return { id: raw.id, displayName: text(raw.displayName, 128) || raw.id, presence,
    status: text(raw.status, 40), statusDescription: text(raw.statusDescription, 512),
    platform: text(raw.platform || raw.last_platform, 80), location: location(raw.location, presence),
    observedAt, profileObservedAt: observedAt, isFriend: true };
}
export function rosterObservations(me, previous, observedAt) {
  if (!me.friends) return [];
  const old = new Map(previous.map(f => [f.id, f]));
  const offline = new Set(me.offlineFriends || []);
  const online = new Set(me.onlineFriends || []);
  const active = new Set(me.activeFriends || []);
  return me.friends.flatMap(id => {
    const prior = old.get(id);
    const presence = offline.has(id) ? 'offline' : online.has(id) ? 'online' : active.has(id) ? 'active' : 'unknown';
    // A presence-only roster does not refresh a previous world's observation time.
    if (prior?.isFriend && (presence === 'unknown' || (presence === 'online' && prior.presence === 'online'))) return [];
    return { id, displayName: prior?.displayName || id, status: prior?.status || '',
      statusDescription: prior?.statusDescription || '', platform: prior?.platform || '',
      location: location('', presence), presence, observedAt, profileObservedAt: prior?.profileObservedAt || null, isFriend: true };
  });
}
export const fingerprint = f => JSON.stringify([f.displayName, f.presence, f.status, f.statusDescription, f.platform, f.location, f.isFriend]);
export function reconcile(previous, observations, accountId, completedAt, fullRoster = null) {
  const old = new Map(previous.map(f => [f.id, f]));
  const all = new Map();
  for (const f of observations) if (f && (!all.has(f.id) || f.observedAt >= all.get(f.id).observedAt)) all.set(f.id, f);
  if (fullRoster) {
    const roster = new Set(fullRoster);
    for (const f of previous) if (f.isFriend && !roster.has(f.id) && !all.has(f.id)) all.set(f.id, { ...f, isFriend: false, presence: 'unknown', location: location(''), observedAt: completedAt });
  }
  const records = [], events = [];
  for (const f of all.values()) {
    const p = old.get(f.id);
    const changed = !p || fingerprint(p) !== fingerprint(f);
    const entry = { ...f, accountId, firstObservedAt: p?.firstObservedAt || f.observedAt,
      stateFirstObservedAt: changed ? f.observedAt : p.stateFirstObservedAt,
      // Distinguish continued presence/world from profile or status-message edits.
      // Namespaced extensions are preserved by the existing Sheets sync protocol.
      extensions: { ...p?.extensions, ...f.extensions,
        'vrc.activity': continuityMetadata(p, f) } };
    records.push(entry);
    if (changed) events.push({ accountId, userId: f.id, displayName: f.displayName,
      observedAt: f.observedAt, previousObservedAt: p?.observedAt || null,
      kind: !p ? 'first' : !f.isFriend ? 'roster-removed' : 'changed',
      previous: p ? eventState(p) : null, current: eventState(entry) });
  }
  return { records, events };
}
export function eventState(f) {
  return { displayName: f.displayName, presence: f.presence, status: f.status, statusDescription: f.statusDescription,
    platform: f.platform, location: f.location, isFriend: f.isFriend };
}
export function retryDelay(header, now, failures = 1) {
  const seconds = typeof header === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(header) ? Number(header) * 1000 : NaN;
  const date = header ? Date.parse(header) - now : NaN;
  const requested = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.max(0, date) : 0;
  // Honor Retry-After even if it exceeds our ordinary backoff cap.
  return Math.max(requested, Math.min(6 * 3600000, 60000 * 2 ** Math.min(failures, 9)));
}
export const jitter = (seconds, random = Math.random) => Math.round(seconds * 1000 * (0.9 + random() * 0.2));
export function csv(rows) {
  const cell = value => {
    let s = String(value ?? '');
    if (/^[\s\uFEFF]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
export function world(raw, accountId, observedAt) {
  if (!raw || !WORLD_ID.test(raw.id)) throw new Error('ワールド応答の形式が変わりました。');
  return { accountId, id: raw.id, name: text(raw.name, 256), authorName: text(raw.authorName, 128),
    capacity: Number.isFinite(raw.capacity) ? raw.capacity : null, observedAt, retryAt: observedAt + 86400000,
    traits:{tags:Array.isArray(raw.tags)?raw.tags.filter(v=>typeof v==='string').slice(0,50).map(v=>text(v,100)):[],
      platforms:Array.isArray(raw.unityPackages)?[...new Set(raw.unityPackages.map(v=>v?.platform).filter(v=>['standalonewindows','android','ios'].includes(v)))]:[],
      releaseStatus:text(raw.releaseStatus,40),visits:Number.isSafeInteger(raw.visits)&&raw.visits>=0?raw.visits:null,favorites:Number.isSafeInteger(raw.favorites)&&raw.favorites>=0?raw.favorites:null} };
}
