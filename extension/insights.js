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
    if (last && observedAt < last.lastObservedAt) return; // A second device can carry an older previous snapshot.
    if (last?.identity === identity) { last.lastObservedAt = Math.max(last.lastObservedAt, observedAt); return; }
    nodes.push({ ...place, identity, observedAt, lastObservedAt: observedAt, previous });
  }
  for (const event of sorted) {
    append(event.previous, event.previousObservedAt, true);
    append(event.current, event.observedAt);
  }
  return { nodes: nodes.slice(-limit), total: nodes.length, truncated: nodes.length > limit };
}

const compareText = (a,b) => String(a||'').localeCompare(String(b||''),'ja');
export function sortFriends(rows, order, names = new Map()) {
  const presence={online:0,active:1,unknown:2,offline:3};
  const compare={name:(a,b)=>compareText(a.displayName,b.displayName),'name-desc':(a,b)=>compareText(b.displayName,a.displayName),
    latest:(a,b)=>b.observedAt-a.observedAt,oldest:(a,b)=>a.observedAt-b.observedAt,
    duration:(a,b)=>(a.stateFirstObservedAt||a.observedAt)-(b.stateFirstObservedAt||b.observedAt),
    world:(a,b)=>compareText(names.get(a.location?.worldId)||a.location?.worldId||a.location?.kind,names.get(b.location?.worldId)||b.location?.worldId||b.location?.kind),
    platform:(a,b)=>compareText(a.platform,b.platform),presence:(a,b)=>(presence[a.presence]??2)-(presence[b.presence]??2)}[order] || ((a,b)=>(presence[a.presence]??2)-(presence[b.presence]??2));
  return [...rows].sort((a,b)=>compare(a,b)||compareText(a.displayName,b.displayName)||compareText(a.id,b.id));
}
export function sortWorlds(rows, order) {
  const compare={count:(a,b)=>b.count-a.count,instances:(a,b)=>b.instances-a.instances,latest:(a,b)=>b.observedAt-a.observedAt,name:(a,b)=>compareText(a.name,b.name)}[order]||((a,b)=>b.count-a.count);
  return [...rows].sort((a,b)=>compare(a,b)||compareText(a.name,b.name)||compareText(a.id,b.id));
}
export const PLACE_LABELS = {private:'プライベート',offline:'現実世界',traveling:'移動中',web:'Web／アプリ',unknown:'所在不明',removed:'名簿から消失'};
export function worldNetwork(events, friends, worlds, {since=0,userId='',query='',order='moves',now=Date.now(),pollSeconds=180}={}) {
  const names=new Map(worlds.map(w=>[w.id,w.name])),people=new Map(friends.map(f=>[f.id,f.displayName])),grouped=new Map();
  for(const e of events){if(!people.has(e.userId))people.set(e.userId,e.displayName);if(!grouped.has(e.userId))grouped.set(e.userId,[]);grouped.get(e.userId).push(e);}
  const nodes=new Map(),edges=new Map(),users=new Set();
  const key=p=>p.kind==='world'?p.worldId:'state:'+p.kind;
  function place(p,uid,at){const id=key(p);if(!nodes.has(id))nodes.set(id,{id,kind:p.kind,name:p.kind==='world'?names.get(p.worldId)||p.worldId:PLACE_LABELS[p.kind],users:new Set(),currentUsers:new Set(),observedAt:0,moves:0});const n=nodes.get(id);n.users.add(uid);n.observedAt=Math.max(n.observedAt,at);return n;}
  for(const [uid,name] of people){if(userId && uid!==userId)continue;
    const journey=worldJourney(grouped.get(uid)||[],uid,{since,limit:Infinity});
    // Travel is a transient API state. Join the known endpoints without inventing an intervening world.
    const stops=journey.nodes.filter(p=>p.kind!=='traveling');
    for(const p of stops)place(p,uid,p.lastObservedAt);
    for(let i=1;i<stops.length;i++){
      const a=stops[i-1],b=stops[i],from=key(a),to=key(b),id=from+'>'+to;
      if(from===to && a.instanceId===b.instanceId)continue;
      if(!edges.has(id))edges.set(id,{id,from,to,transitions:[],users:new Set(),observedAt:0});
      const edge=edges.get(id);edge.users.add(uid);edge.observedAt=Math.max(edge.observedAt,b.observedAt);
      edge.transitions.push({userId:uid,displayName:name,previousAt:a.lastObservedAt,observedAt:b.observedAt,fromInstance:a.instanceId,toInstance:b.instanceId});
      nodes.get(from).moves++;if(from!==to)nodes.get(to).moves++;
    }
    if(stops.length)users.add(uid);
  }
  // Include users with a current snapshot but no change event in the chosen period.
  for(const f of friends){if(userId&&f.id!==userId||f.observedAt<since||destination(f).kind==='traveling')continue;const n=place(destination(f),f.id,f.observedAt);users.add(f.id);
    if(f.isFriend && f.presence==='online' && f.location?.kind==='world' && now-f.observedAt>=0 && now-f.observedAt<=Math.max(pollSeconds*2.2,120)*1000)n.currentUsers.add(f.id);
  }
  const q=query.trim().toLocaleLowerCase(),matches=n=>!q||[n.id,n.name,...[...n.users].map(id=>people.get(id)||id)].join(' ').toLocaleLowerCase().includes(q);
  const list=[...nodes.values()].filter(matches),visible=new Set(list.map(n=>n.id));
  const compare={moves:(a,b)=>b.moves-a.moves,current:(a,b)=>b.currentUsers.size-a.currentUsers.size,users:(a,b)=>b.users.size-a.users.size,latest:(a,b)=>b.observedAt-a.observedAt,name:(a,b)=>compareText(a.name,b.name)}[order]||((a,b)=>b.moves-a.moves);
  list.sort((a,b)=>compare(a,b)||compareText(a.name,b.name)||compareText(a.id,b.id));
  // Deterministic concentric layout; bounded work even for very large observation histories.
  let index=0,ring=0;const radiusStep=230;
  while(index<list.length){const count=ring?Math.min(6*ring,list.length-index):1;
    for(let j=0;j<count;j++){const angle=(j/count)*Math.PI*2-Math.PI/2;Object.assign(list[index++],{x:Math.cos(angle)*ring*radiusStep,y:Math.sin(angle)*ring*radiusStep});}ring++;
  }
  const extent=Math.max(300,(ring-1)*radiusStep+170);for(const n of list){n.x+=extent;n.y+=extent;}
  const links=[...edges.values()].filter(e=>visible.has(e.from)&&visible.has(e.to)).map(e=>({...e,count:e.transitions.length}));
  const shownUsers=new Set(list.flatMap(n=>[...n.users]));
  return {nodes:list,edges:links,people,userCount:shownUsers.size,totalUsers:users.size,width:extent*2,height:extent*2,transitionCount:links.reduce((s,e)=>s+e.count,0)};
}
