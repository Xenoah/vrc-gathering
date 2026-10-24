import { WORLD_ID } from './core.js';

export function rankWorlds(friends, worlds, { now = Date.now(), pollSeconds = 180 } = {}) {
  const latest = new Map();
  for (const f of friends) if (!latest.has(f.id) || f.observedAt > latest.get(f.id).observedAt) latest.set(f.id, f);
  const names = new Map(worlds.map(w => [w.id, w.name]));
  const groups = new Map(), freshness = Math.max(pollSeconds * 2.2, 120) * 1000;
  for (const f of latest.values()) {
    if (!f.isFriend || f.presence !== 'online' || f.location?.kind !== 'world' || !WORLD_ID.test(f.location.worldId) ||
      !Number.isFinite(f.observedAt) || f.observedAt > now || now - f.observedAt > freshness) continue;
    const id = f.location.worldId;
    if (!groups.has(id)) groups.set(id, { id, name: names.get(id) || id, users: [], instances: new Set(), observedAt: 0 });
    const group = groups.get(id);
    group.users.push(f);
    if (f.location.instanceId) group.instances.add(f.location.instanceId);
    group.observedAt = Math.max(group.observedAt, f.observedAt);
  }
  const rows = [...groups.values()].map(g => ({ ...g, count: g.users.length, instances: g.instances.size }));
  rows.sort((a,b) => b.count - a.count || a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id));
  let rank = 0;
  return rows.map((g, i) => { if (!i || g.count !== rows[i-1].count) rank = i + 1; return { ...g, rank }; });
}

function destination(state) {
  if (!state || state.isFriend === false) return { kind: 'removed', worldId: '', instanceId: '' };
  if (state.presence === 'offline') return { kind: 'offline', worldId: '', instanceId: '' };
  const l = state.location || {};
  return l.kind === 'world' && WORLD_ID.test(l.worldId)
    ? { kind: 'world', worldId: l.worldId, instanceId: l.instanceId || '' }
    : { kind: ['private','traveling','web','offline'].includes(l.kind) ? l.kind : 'unknown', worldId: '', instanceId: '' };
}

export function worldJourney(events, userId, { since = 0, limit = 200 } = {}) {
  const sorted = events.filter(e => e.userId === userId && e.observedAt >= since).sort((a,b) => a.observedAt - b.observedAt);
  const nodes = [];
  function append(state, observedAt, previous = false) {
    if (!state || !observedAt) return;
    const place = destination(state), identity = JSON.stringify(place), last = nodes.at(-1);
    if (last?.identity === identity) { last.lastObservedAt = Math.max(last.lastObservedAt, observedAt); return; }
    nodes.push({ ...place, identity, observedAt, lastObservedAt: observedAt, previous });
  }
  for (const event of sorted) {
    append(event.previous, event.previousObservedAt, true);
    append(event.current, event.observedAt);
  }
  return { nodes: nodes.slice(-limit), total: nodes.length, truncated: nodes.length > limit };
}
