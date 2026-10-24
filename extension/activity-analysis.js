// Local, observation-based activity analysis. No hidden VRChat locations are inferred.
export const ACTIVITY_NAMESPACE = 'vrc.activity';

const validStart = (value, upper) =>
  Number.isSafeInteger(value) && value > 0 && value <= upper;

export function continuityMetadata(previous, current) {
  const time = current.observedAt;
  const old = previous?.extensions?.[ACTIVITY_NAMESPACE] || {};
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
    presenceSince: prior('presenceSince', samePresence),
    placeSince: prior('placeSince', samePlace),
    instanceSince: prior('instanceSince', sameInstance)
  };
}

export function formatObservedDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未確認';
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 1) return '1分未満';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  if (days) return String(days) + '日' + (hours ? String(hours) + '時間' : '');
  if (hours) return String(hours) + '時間' + (rest ? String(rest) + '分' : '');
  return String(rest) + '分';
}

export function observedDurations(friend) {
  if (!friend || friend.isFriend === false || !validStart(friend.observedAt, Number.MAX_SAFE_INTEGER)) return null;
  const meta = friend.extensions?.[ACTIVITY_NAMESPACE] || {};
  const observedAt = friend.observedAt;
  const start = key => validStart(meta[key], observedAt) ? meta[key] :
    validStart(friend.stateFirstObservedAt, observedAt) ? friend.stateFirstObservedAt : observedAt;
  const elapsed = key => Math.max(0, observedAt - start(key));
  return {
    presence: elapsed('presenceSince'),
    place: elapsed('placeSince'),
    instance: elapsed('instanceSince'),
    since: start('presenceSince'),
    placeSince: start('placeSince'),
    observedAt,
    estimated: true
  };
}

export function classifyActivity(state) {
  if (!state || state.isFriend === false) return 'removed';
  if (state.presence === 'offline') return 'offline';
  if (state.presence === 'active') return 'active';
  if (state.presence === 'online') {
    if (state.location?.kind === 'world') return 'world';
    if (state.location?.kind === 'private') return 'private';
    if (state.location?.kind === 'traveling') return 'traveling';
    return 'online-unknown';
  }
  return 'unknown';
}
export const ACTIVITY_LABELS = {
  world: 'ゲーム内：公開ワールド', private: 'ゲーム内：所在非公開',
  traveling: 'ゲーム内：移動中', 'online-unknown': 'ゲーム内：所在不明',
  active: 'Web／アプリ', offline: 'オフライン', removed: '名簿から消失', unknown: '不明'
};

export function buildActivityTimeline(friends, events, worlds, {
  now = Date.now(), rangeMs = 86400000, query = '', filter = 'all', pollSeconds = 180, limit = 120
} = {}) {
  const end = now, start = end - Math.max(60000, rangeMs);
  const worldNames = new Map(worlds.map(w => [w.id, w.name]));
  const people = new Map(), current = new Map(friends.map(f => [f.id, f]));
  const ensure = (id, name) => {
    if (!people.has(id)) people.set(id, {id, name: name || id, samples: []});
    const row = people.get(id);
    if (name && (!row.name || row.name === row.id)) row.name = name;
    return row;
  };
  function sample(id, name, at, state, priority) {
    if (!validStart(at, end) || !state || !id) return;
    ensure(id, name).samples.push({at, state, priority});
  }
  for (const event of events) {
    if (!event?.userId) continue;
    sample(event.userId, event.displayName, event.previousObservedAt, event.previous, 1);
    sample(event.userId, event.displayName, event.observedAt, event.current, 2);
  }
  for (const f of friends) sample(f.id, f.displayName, f.observedAt, f, 3);
  const q = query.trim().toLocaleLowerCase();
  const rows = [];
  const maxGap = Math.max(120, pollSeconds * 2.2) * 1000;
  for (const person of people.values()) {
    const byTime = new Map();
    for (const point of person.samples) if (!byTime.has(point.at) || byTime.get(point.at).priority < point.priority) byTime.set(point.at, point);
    const sorted = [...byTime.values()].sort((a,b) => a.at - b.at);
    const points = sorted.filter(s => s.at >= start && s.at <= end);
    if (!points.length && !(sorted.length >= 2 && sorted[0].at < start && sorted[sorted.length-1].at > start)) continue;
    const segments = [];
    for (let i=1; i<sorted.length; i++) {
      const a=sorted[i-1], b=sorted[i];
      if (b.at <= start || a.at >= end) continue;
      const from=Math.max(start,a.at), to=Math.min(end,b.at);
      if (to <= from) continue;
      const kind=classifyActivity(a.state);
      const worldId=kind === 'world' ? a.state.location.worldId : '';
      const confidence=classifyActivity(b.state) === kind &&
        (kind !== 'world' || b.state.location?.worldId === worldId) &&
        b.at - a.at <= maxGap ? 'bounded' : 'estimated';
      const previous=segments[segments.length-1];
      if (previous && previous.end===from && previous.kind===kind && previous.worldId===worldId && previous.confidence===confidence) {
        previous.end=to;
      } else segments.push({start:from,end:to,kind,worldId,confidence});
    }
    const active = points.length && points.some(p => classifyActivity(p.state) !== 'offline' && classifyActivity(p.state) !== 'removed');
    if (filter === 'active' && !active && !segments.some(s=>!['offline','removed','unknown'].includes(s.kind))) continue;
    if (filter === 'world' && !segments.some(s=>s.kind==='world') && !points.some(s=>classifyActivity(s.state)==='world')) continue;
    if (q && ![person.name,person.id,...segments.map(s=>worldNames.get(s.worldId)||s.worldId),
      ...points.map(p=>worldNames.get(p.state.location?.worldId)||'')].join(' ').toLocaleLowerCase().includes(q)) continue;
    const friend = current.get(person.id);
    rows.push({id:person.id,name:friend?.displayName || person.name,friend,points,segments,
      lastAt:sorted[sorted.length-1]?.at || 0,
      isOnline:friend?.presence === 'online' && friend?.isFriend &&
        end - friend.observedAt <= maxGap && end >= friend.observedAt,
      hasWorld:segments.some(s=>s.kind==='world')});
  }
  rows.sort((a,b)=>Number(b.isOnline)-Number(a.isOnline) || b.lastAt-a.lastAt || a.name.localeCompare(b.name,'ja'));
  const total=rows.length;
  return {start,end,rows:rows.slice(0,limit),total,truncated:total>limit,worldNames,maxGap};
}

export function changesByHour(events, since = 0) {
  const counts = Array.from({length:24},()=>0);
  const fmt = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',hourCycle:'h23'});
  for (const event of events) {
    if (!Number.isFinite(event.observedAt) || event.observedAt < since || !['changed','roster-removed'].includes(event.kind)) continue;
    const h=Number(fmt.format(event.observedAt));
    if (h >= 0 && h < 24) counts[h]++;
  }
  return counts;
}
