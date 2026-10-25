// Sessions record observations, not continuous tracking or inferred private locations.
export const observationGap = pollSeconds => Math.max(120, (Number(pollSeconds) || 180) * 2.2) * 1000;
const placeKey = value => JSON.stringify([value.presence,value.location]);
const latest = (a,b) => b.lastSeenAt-a.lastSeenAt || b.startedAt-a.startedAt;

export function reconcileConnections(previousVisits, previousEncounters, samples, friends, accountId, {pollSeconds=180,completedAt,roster=null}={}) {
  const gap=observationGap(pollSeconds), visits=new Map(), encounters=new Map();
  let visit=[...previousVisits].filter(v=>v.accountId===accountId&&!v.endedAt).sort(latest)[0];
  const self=samples.filter(s=>s?.id===accountId).sort((a,b)=>a.observedAt-b.observedAt);
  const visitIds=[];
  for(const sample of self) {
    const at=sample.observedAt;
    if(visit && at<visit.lastSeenAt)continue;
    if(visit && (at-visit.lastSeenAt>gap || placeKey(sample)!==placeKey(visit))) {
      visits.set(visit.startedAt,{...visit,endedAt:at,observedAt:at});visit=null;
    }
    visit={accountId,startedAt:visit?.startedAt || at,lastSeenAt:at,observedAt:at,endedAt:null,
      displayName:sample.displayName,presence:sample.presence,location:{...sample.location}};
    visits.set(visit.startedAt,visit);visitIds.push(visit.startedAt);
  }
  const active=new Map();
  for(const encounter of [...previousEncounters].sort(latest))if(encounter.accountId===accountId&&!encounter.endedAt&&!active.has(encounter.userId))active.set(encounter.userId,encounter);
  const close=(old,at)=>encounters.set(old.userId+':'+old.startedAt,{...old,endedAt:Math.max(at,old.lastSeenAt),observedAt:Math.max(at,old.observedAt)});
  const first=self[0],last=self.at(-1),end=completedAt || last?.observedAt;
  const stable=self.length>=2 && visitIds.length===self.length && visitIds.every(id=>id===visitIds[0]) &&
    first.presence==='online' && last.presence==='online' && first.location.kind==='world' &&
    placeKey(first)===placeKey(last) && last.observedAt-first.observedAt<=gap;
  const observed=new Map();
  for(const f of friends)if(!observed.has(f.id)||f.observedAt>observed.get(f.id).observedAt)observed.set(f.id,f);
  const matched=new Set();
  if(stable)for(const f of observed.values()) {
    if(f.id===accountId || !f.isFriend || roster && !roster.has(f.id) || f.presence!=='online' || f.location.kind!=='world' ||
      f.location.worldId!==first.location.worldId || f.observedAt<first.observedAt || f.observedAt>last.observedAt)continue;
    const relation=first.location.instanceId && f.location.instanceId===first.location.instanceId ? 'instance' : 'world';
    const old=active.get(f.id),at=f.observedAt;
    if(old && at<old.lastSeenAt)continue;
    const continues=old && old.visitStartedAt===visitIds[0] && old.relation===relation && old.otherInstanceId===f.location.instanceId &&
      old.location.worldId===first.location.worldId && old.location.instanceId===first.location.instanceId && at-old.lastSeenAt<=gap;
    if(old&&!continues)close(old,at);
    const entry={accountId,userId:f.id,displayName:f.displayName,startedAt:continues?old.startedAt:at,
      lastSeenAt:at,observedAt:at,endedAt:null,visitStartedAt:visitIds[0],relation,
      location:{...first.location},otherInstanceId:f.location.instanceId};
    encounters.set(f.id+':'+entry.startedAt,entry);matched.add(f.id);
  }
  for(const [id,old] of active)if(!matched.has(id) && end>=old.lastSeenAt &&
    (!stable || observed.has(id) || roster && !roster.has(id) || end-old.lastSeenAt>gap))close(old,end);
  return {visits:[...visits.values()],encounters:[...encounters.values()]};
}

// Multiple collectors can produce overlapping sessions. Union them before counting duration or visits.
export function unionSessions(rows, since=0, until=Date.now()) {
  const groups=new Map();
  for(const row of rows) {
    if(row.startedAt>until || row.lastSeenAt<since)continue;
    const key=JSON.stringify([row.location.worldId,row.location.instanceId,row.otherInstanceId || '',row.relation || 'self']);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({start:Math.max(since,row.startedAt),end:Math.min(until,row.lastSeenAt),row});
  }
  const merged=[];
  for(const intervals of groups.values()) {
    intervals.sort((a,b)=>a.start-b.start||a.end-b.end);
    let previous;
    for(const interval of intervals) {
      if(previous && interval.start<=previous.end)previous.end=Math.max(previous.end,interval.end);
      else {previous={...interval};merged.push(previous);}
    }
  }
  return merged.sort((a,b)=>b.end-a.end);
}

export function connectionSummary(encounters,{accountId,since=0,now=Date.now(),relation='instance',worldId='',query='',sort='duration'}={}) {
  const groups=new Map();
  for(const row of encounters) {
    if(row.accountId!==accountId || row.lastSeenAt<since || row.startedAt>now || relation!=='all' && row.relation!==relation || worldId && row.location.worldId!==worldId)continue;
    if(!groups.has(row.userId))groups.set(row.userId,[]);
    groups.get(row.userId).push(row);
  }
  const rows=[];
  for(const [id,records] of groups) {
    records.sort((a,b)=>b.observedAt-a.observedAt);
    const name=records[0].displayName;
    if(query && ![name,id].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))continue;
    const sessions=unionSessions(records,since,now),instanceSessions=unionSessions(records.filter(r=>r.relation==='instance'),since,now);
    rows.push({id,name,sessions,count:sessions.length,instanceCount:instanceSessions.length,
      duration:unionDuration(sessions),instanceDuration:unionDuration(instanceSessions),
      worlds:new Set(records.map(r=>r.location.worldId)),lastSeenAt:records.reduce((n,r)=>Math.max(n,r.lastSeenAt),0)});
  }
  const compare={duration:(a,b)=>b.duration-a.duration,count:(a,b)=>b.count-a.count,worlds:(a,b)=>b.worlds.size-a.worlds.size,
    latest:(a,b)=>b.lastSeenAt-a.lastSeenAt,name:(a,b)=>a.name.localeCompare(b.name,'ja')}[sort];
  return rows.sort((a,b)=>(compare || ((a,b)=>b.duration-a.duration))(a,b)||a.name.localeCompare(b.name,'ja'));
}

function unionDuration(sessions) {
  let total=0,end=-Infinity;
  for(const s of [...sessions].sort((a,b)=>a.start-b.start)) {total+=Math.max(0,s.end-Math.max(end,s.start));end=Math.max(end,s.end);}
  return total;
}

export function connectionGraph(rows,accountId,name='自分') {
  const ringCount=Math.ceil(Math.sqrt(rows.length/3)),extent=Math.max(300,ringCount*220+170);
  const nodes=[{id:accountId,name:name==='自分'?name:name+'（自分）',kind:'user',x:extent,y:extent,caption:rows.length+'人との観測',imageId:accountId}];
  const edges=[];let index=0,ring=1;
  while(index<rows.length) {
    const count=Math.min(6*ring,rows.length-index);
    for(let i=0;i<count;i++) {
      const row=rows[index++],angle=i/count*Math.PI*2-Math.PI/2;
      nodes.push({id:row.id,name:row.name,kind:'user',x:extent+Math.cos(angle)*220*ring,y:extent+Math.sin(angle)*220*ring,
        caption:row.count+'回 · '+row.worlds.size+'ワールド',imageId:row.id,connection:row});
      edges.push({id:accountId+'>'+row.id,from:accountId,to:row.id,count:row.count,connection:row,undirected:true});
    }
    ring++;
  }
  return {nodes,edges,width:extent*2,height:extent*2};
}
