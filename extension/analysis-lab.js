// Analytics use saved observations only. A missing observation is never an offline sample.
import { classifyActivity, ACTIVITY_LABELS } from './activity-analysis.js';
import { observationGap, connectionSummary, unionSessions } from './connections.js';
import { canonical } from './sync-format.js';

export const DAY = 86400000;
const HOUR = 3600000, JST = 9 * HOUR;
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export const jstDay = at => new Date(at + JST).toISOString().slice(0, 10);
const dayStart = at => Math.floor((at + JST) / DAY) * DAY - JST;
const hourOf = at => new Date(at + JST).getUTCHours();
const weekdayOf = at => new Date(at + JST).getUTCDay();
const inRange = (at, start, end) => Number.isFinite(at) && at >= start && at < end;
const worldOf = state => state?.isFriend !== false && state?.presence === 'online' && state?.location?.kind === 'world' ? state.location.worldId : '';
const descending = key => (a, b) => b[key] - a[key] || String(a.name || a.id).localeCompare(String(b.name || b.id), 'ja');
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * q;
  return sorted[Math.floor(position)] + (sorted[Math.ceil(position)] - sorted[Math.floor(position)]) * (position % 1);
};

export function mergeIntervals(intervals) {
  const sorted = intervals.filter(s => s.end >= s.start).map(s => ({start:s.start, end:s.end})).sort((a,b) => a.start-b.start || a.end-b.end), out = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push(s);
  }
  return out;
}
const elapsed = intervals => mergeIntervals(intervals).reduce((sum, s) => sum + s.end-s.start, 0);
function intersections(a,b) {
  const result=[];let i=0,j=0;
  while(i<a.length && j<b.length) {
    const start=Math.max(a[i].start,b[j].start),end=Math.min(a[i].end,b[j].end);
    if(end>start)result.push({start,end});
    if(a[i].end<=b[j].end)i++;else j++;
  }
  return result;
}

function scopeData(data, accountId, now) {
  const rows = name => (data[name] || []).filter(r => r.accountId === accountId && Number.isFinite(r.observedAt) && r.observedAt <= now);
  const latest = (items, key) => {
    const map = new Map();
    for (const item of items) {
      const id = key(item), old = map.get(id);
      if (!old || item.observedAt > old.observedAt || item.observedAt === old.observedAt && canonical(item) > canonical(old)) map.set(id, item);
    }
    return [...map.values()];
  };
  const friends = latest(rows('friends'), f => f.id);
  const events = latest((data.journeyEvents || data.events || []).filter(e => e.accountId === accountId && e.observedAt <= now), e => e.userId+':'+e.observedAt).sort((a,b) => a.observedAt-b.observedAt);
  const samples = new Map();
  function add(id, name, at, state, priority) {
    if (!id || !state || !Number.isSafeInteger(at) || at <= 0 || at > now) return;
    const key = id+':'+at, old = samples.get(key);
    if (!old || priority > old.priority) samples.set(key, {id, name:name || id, at, state, priority});
  }
  for (const e of events) { add(e.userId, e.previous?.displayName || e.displayName, e.previousObservedAt, e.previous, 1); add(e.userId, e.displayName, e.observedAt, e.current, 2); }
  for (const f of friends) add(f.id, f.displayName, f.observedAt, f, 3);
  return {friends, events, samples:[...samples.values()], visits:latest(rows('visits'), v => v.startedAt),
    encounters:latest(rows('encounters'), e => e.userId+':'+e.startedAt), runs:latest(rows('runs'), r => r.startedAt)};
}

function tally(items, key) {
  const counts = new Map();
  for (const item of items) { const name = key(item) || '不明'; counts.set(name, (counts.get(name) || 0)+1); }
  return [...counts].map(([name,count]) => ({name,count})).sort(descending('count'));
}

function period(source, start, end, {accountId, userId, worldId, pollSeconds}, names) {
  const relevant = state => !worldId || worldOf(state) === worldId;
  const samples = source.samples.filter(p => inRange(p.at,start,end) && (!userId || p.id===userId) && relevant(p.state));
  const allEvents = source.events.filter(e => inRange(e.observedAt,start,end) && (!userId || e.userId===userId));
  const events = allEvents.filter(e => relevant(e.current) || relevant(e.previous));
  const visits = source.visits.filter(v => v.presence==='online' && v.location?.kind==='world' && (!worldId || v.location.worldId===worldId) && v.startedAt<end && v.lastSeenAt>=start);
  const encounters = source.encounters.filter(e => (!userId || e.userId===userId) && (!worldId || e.location.worldId===worldId) && e.startedAt<end && e.lastSeenAt>=start);
  const sessions = unionSessions(visits,start,end);
  const connections = connectionSummary(encounters,{accountId,since:start,now:end,relation:'instance'});
  const daily = new Map();
  for (let at=dayStart(start); at<end; at+=DAY) daily.set(jstDay(at),{day:jstDay(at), observations:0, changes:0, moves:0, users:new Set(), selfDuration:0, companions:new Set()});
  const hourly = Array.from({length:24},(_,hour) => ({hour,observations:0,changes:0,moves:0,users:new Set(),selfDuration:0}));
  const weekdays = WEEKDAYS.map((name,day) => ({name,day,observations:0,changes:0,moves:0,users:new Set(),selfDuration:0}));
  const heatmap = Array.from({length:168},(_,i) => ({day:Math.floor(i/24),hour:i%24,observations:0,changes:0,users:new Set()}));
  const worlds = new Map(), people = new Map(), routes = new Map(), roundTrips = new Map();
  const world = id => {
    if (!worlds.has(id)) worlds.set(id,{id,name:names.get(id)||id,observations:0,users:new Set(),arrivals:0,departures:0,selfVisits:0,selfDuration:0,companions:new Set()});
    return worlds.get(id);
  };
  const person = (id,name) => {
    if (!people.has(id)) people.set(id,{id,name:name||id,observations:0,changes:0,moves:0,worlds:new Set(),days:new Set(),hours:new Set(),lastSeenAt:0});
    return people.get(id);
  };
  for (const p of samples) {
    const h=hourOf(p.at),d=weekdayOf(p.at),u=person(p.id,p.name);
    for (const bucket of [daily.get(jstDay(p.at)),hourly[h],weekdays[d],heatmap[d*24+h]]) { bucket.observations++; bucket.users.add(p.id); }
    u.observations++;u.days.add(jstDay(p.at));u.hours.add(h);
    if (p.at>=u.lastSeenAt) { u.name=p.name;u.lastSeenAt=p.at; }
    const id=worldOf(p.state);
    if(id) { const w=world(id);w.observations++;w.users.add(p.id);u.worlds.add(id); }
  }
  const changeFields = new Map(['接続状態','ワールド／所在','インスタンス','ステータス','メッセージ','表示名','プラットフォーム','名簿'].map(key => [key,0]));
  const previousRoute = new Map();
  for (const e of allEvents) {
    const from=worldOf(e.previous),to=worldOf(e.current),matches=relevant(e.current)||relevant(e.previous);
    if(!from||!to)previousRoute.delete(e.userId);
    else if(from!==to) {
      const prior=previousRoute.get(e.userId);
      if(matches && prior && prior.from===to && prior.to===from && prior.at<=e.previousObservedAt) {
        const id=e.userId+':'+to+'>'+from+'>'+to;
        if(!roundTrips.has(id))roundTrips.set(id,{id,userId:e.userId,name:e.displayName,route:(names.get(to)||to)+' → '+(names.get(from)||from)+' → '+(names.get(to)||to),count:0,lastSeenAt:0});
        const row=roundTrips.get(id);row.count++;row.lastSeenAt=e.observedAt;
      }
      previousRoute.set(e.userId,{from,to,at:e.observedAt});
    }
    if(!matches)continue;
    const a=e.previous,b=e.current,h=hourOf(e.observedAt),d=weekdayOf(e.observedAt),u=person(e.userId,e.displayName);
    if (e.kind!=='first') {
      u.changes++;
      for (const bucket of [daily.get(jstDay(e.observedAt)),hourly[h],weekdays[d],heatmap[d*24+h]]) bucket.changes++;
      const changes = [['接続状態',a?.presence,b?.presence],['ワールド／所在',JSON.stringify([a?.location?.kind,a?.location?.worldId]),JSON.stringify([b?.location?.kind,b?.location?.worldId])],
        ['インスタンス',a?.location?.instanceId,b?.location?.instanceId],['ステータス',a?.status,b?.status],['メッセージ',a?.statusDescription,b?.statusDescription],
        ['表示名',a?.displayName,b?.displayName],['プラットフォーム',a?.platform,b?.platform],['名簿',a?.isFriend,b?.isFriend]];
      for (const [key,from,to] of changes) if(from!==to) changeFields.set(key,changeFields.get(key)+1);
    }
    if (!from || !to) continue;
    if (from===to) continue;
    u.moves++;
    for (const bucket of [daily.get(jstDay(e.observedAt)),hourly[h],weekdays[d]]) bucket.moves++;
    if(!worldId || from===worldId) world(from).departures++;
    if(!worldId || to===worldId) world(to).arrivals++;
    const key=from+'>'+to;
    if(!routes.has(key)) routes.set(key,{id:key,from,to,name:(names.get(from)||from)+' → '+(names.get(to)||to),count:0,users:new Set(),nearby:0,lastSeenAt:0});
    const route=routes.get(key);route.count++;route.users.add(e.userId);route.lastSeenAt=e.observedAt;
    if(e.previousObservedAt>0 && e.observedAt>=e.previousObservedAt && e.observedAt-e.previousObservedAt<=observationGap(pollSeconds))route.nearby++;
  }
  const sessionsByWorld=new Map();
  for (const s of sessions) {const id=s.row.location.worldId;world(id).selfVisits++;if(!sessionsByWorld.has(id))sessionsByWorld.set(id,[]);sessionsByWorld.get(id).push(s);}
  for (const [id,ss] of sessionsByWorld) world(id).selfDuration=elapsed(ss);
  // Split unioned intervals at JST hour boundaries, so midnight and overlapping collectors do not inflate time.
  for (const s of mergeIntervals(sessions)) for(let at=s.start;at<s.end;) {
    const next=Math.min(s.end,Math.floor(at/HOUR)*HOUR+HOUR),duration=next-at;
    daily.get(jstDay(at)).selfDuration+=duration;hourly[hourOf(at)].selfDuration+=duration;weekdays[weekdayOf(at)].selfDuration+=duration;at=next;
  }
  for(const row of connections) for(const s of row.sessions) {
    world(s.row.location.worldId).companions.add(row.id);
    for(let at=dayStart(s.start);at<end && at<=s.end;at+=DAY) if(at+DAY>s.start && (at<s.end || s.start===s.end)) daily.get(jstDay(Math.max(at,start)))?.companions.add(row.id);
  }
  const serializeBucket = row => ({...row,users:row.users.size,...(row.companions?{companions:row.companions.size}:{})});
  const selfWorlds = [...worlds.values()].filter(w=>w.selfVisits).map(w=>{
    const own=[...sessionsByWorld.get(w.id)].sort((a,b)=>a.start-b.start),gaps=[];
    for(let i=1;i<own.length;i++)if(own[i].start>own[i-1].end)gaps.push(own[i].start-own[i-1].end);
    return {id:w.id,name:w.name,visits:own.length,returns:Math.max(0,own.length-1),duration:w.selfDuration,medianGap:quantile(gaps,.5)};
  }).sort(descending('duration'));
  const durations=sessions.map(s=>s.end-s.start).filter(n=>n>0), bins=[['時間未確認',0,0],['5分未満',0,5*60000],['5〜15分',5*60000,15*60000],['15〜30分',15*60000,30*60000],['30〜60分',30*60000,HOUR],['1〜3時間',HOUR,3*HOUR],['3時間以上',3*HOUR,Infinity]];
  const dwell=bins.map(([name,low,high],i)=>({name,count:i===0?sessions.filter(s=>s.end===s.start).length:durations.filter(n=>n>=low && n<high).length}));
  const selfLocations=new Map();
  for(const s of sessions) {const key=JSON.stringify([s.row.location.worldId,s.row.location.instanceId]);if(!selfLocations.has(key))selfLocations.set(key,[]);selfLocations.get(key).push(s);}
  for(const [key,ss] of selfLocations)selfLocations.set(key,mergeIntervals(ss));
  const together=[];
  const encounterLocations=new Map();
  for(const row of connections) for(const s of row.sessions) {
    const key=JSON.stringify([s.row.location.worldId,s.row.location.instanceId]);if(!encounterLocations.has(key))encounterLocations.set(key,[]);encounterLocations.get(key).push(s);
  }
  for(const [key,ss] of encounterLocations)together.push(...intersections(mergeIntervals(ss),selfLocations.get(key)||[]));
  const byConnectionWorld=new Map();
  for(const row of connections) {
    const groups=new Map();
    for(const s of row.sessions){const id=s.row.location.worldId;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(s);}
    for(const [id,ss] of groups) {
      if(!byConnectionWorld.has(id))byConnectionWorld.set(id,{id,name:names.get(id)||id,users:0,count:0,duration:0});
      const w=byConnectionWorld.get(id);w.users++;w.count+=ss.length;w.duration+=elapsed(ss);
    }
  }
  return {
    metrics:{observations:samples.length,users:new Set(samples.map(s=>s.id)).size,worlds:worlds.size,changes:events.filter(e=>e.kind!=='first').length,moves:[...routes.values()].reduce((n,r)=>n+r.count,0),selfVisits:sessions.length,selfDuration:elapsed(sessions),companions:connections.length},
    daily:[...daily.values()].map(serializeBucket),hourly:hourly.map(serializeBucket),weekdays:weekdays.map(serializeBucket),heatmap:heatmap.map(serializeBucket),
    worlds:[...worlds.values()].map(w=>({...w,users:w.users.size,companions:w.companions.size})).sort(descending('users')),
    people:[...people.values()].map(p=>({...p,worlds:[...p.worlds].sort(),days:p.days.size,hours:[...p.hours].sort((a,b)=>a-b)})).sort((a,b)=>b.worlds.length-a.worlds.length || b.observations-a.observations || a.id.localeCompare(b.id)),
    routes:[...routes.values()].map(r=>({...r,users:r.users.size})).sort(descending('count')),roundTrips:[...roundTrips.values()].sort(descending('count')),
    selfWorlds,dwell,dwellStats:{confirmed:durations.length,unconfirmed:sessions.length-durations.length,mean:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null,median:quantile(durations,.5),p90:quantile(durations,.9)},
    company:{together:elapsed(together),unconfirmed:Math.max(0,elapsed(sessions)-elapsed(together))},
    connections:connections.map(r=>({id:r.id,name:r.name,count:r.count,duration:r.duration,worlds:[...r.worlds],lastSeenAt:r.lastSeenAt})),
    connectionWorlds:[...byConnectionWorld.values()].sort(descending('users')),
    states:tally(samples,p=>ACTIVITY_LABELS[classifyActivity(p.state)]),platforms:tally(samples,p=>p.state.platform),
    access:tally(samples.filter(p=>worldOf(p.state)),p=>p.state.location.access),regions:tally(samples.filter(p=>worldOf(p.state)),p=>p.state.location.region),
    changeFields:[...changeFields].map(([name,count])=>({name,count})).sort(descending('count'))
  };
}

export function comparePeople(people, firstId, secondId, worldNames = new Map()) {
  const first=people.find(p=>p.id===firstId),second=people.find(p=>p.id===secondId);
  if(!first || !second || firstId===secondId)return null;
  const a=new Set(first.worlds),b=new Set(second.worlds),shared=[...a].filter(id=>b.has(id)).sort(),total=new Set([...a,...b]).size;
  return {first:first.name,second:second.name,shared:shared.map(id=>({id,name:worldNames.get(id)||id})),firstOnly:[...a].filter(id=>!b.has(id)),secondOnly:[...b].filter(id=>!a.has(id)),
    similarity:total?shared.length/total:null,sharedHours:first.hours.filter(h=>second.hours.includes(h))};
}

export function sharedWorldGraph(people, {limit=40,minShared=1}={}) {
  limit=Math.max(2,Math.min(80,Number(limit)||40));minShared=Math.max(1,Number(minShared)||1);
  const selected=people.filter(p=>p.worlds.length).slice(0,limit),byWorld=new Map(),pairs=new Map();
  selected.forEach((p,index)=>{for(const id of p.worlds){if(!byWorld.has(id))byWorld.set(id,[]);byWorld.get(id).push(index);}});
  for(const [world,indices] of byWorld)for(let i=0;i<indices.length;i++)for(let j=i+1;j<indices.length;j++) {
    const key=indices[i]+':'+indices[j];if(!pairs.has(key))pairs.set(key,{a:indices[i],b:indices[j],worlds:[]});pairs.get(key).worlds.push(world);
  }
  const ringCount=Math.ceil((Math.sqrt(1+4*selected.length/3)-1)/2),extent=Math.max(300,ringCount*220+170),nodes=[];
  let index=0,ring=1;
  while(index<selected.length){const count=Math.min(6*ring,selected.length-index);for(let i=0;i<count;i++) {
    const p=selected[index++],angle=i/count*Math.PI*2-Math.PI/2;
    nodes.push({id:p.id,name:p.name,kind:'user',caption:p.worlds.length+'ワールド',x:extent+Math.cos(angle)*220*ring,y:extent+Math.sin(angle)*220*ring});
  }ring++;}
  const edges=[...pairs.values()].filter(p=>p.worlds.length>=minShared).map(p=>({id:selected[p.a].id+'>'+selected[p.b].id,from:selected[p.a].id,to:selected[p.b].id,count:p.worlds.length,worlds:p.worlds,undirected:true}));
  const adjacent=new Map(nodes.map(n=>[n.id,[]]));for(const e of edges){adjacent.get(e.from).push(e.to);adjacent.get(e.to).push(e.from);}
  const seen=new Set(),groups=[];
  for(const n of nodes)if(!seen.has(n.id)){const ids=[],queue=[n.id];seen.add(n.id);while(queue.length){const id=queue.pop();ids.push(id);for(const to of adjacent.get(id))if(!seen.has(to)){seen.add(to);queue.push(to);}}groups.push(ids);}
  return {nodes,edges,groups:groups.sort((a,b)=>b.length-a.length),width:extent*2,height:extent*2,total:people.filter(p=>p.worlds.length).length,limit,minShared};
}

export function buildAnalysisReport(data, {accountId=data.accountId,now=Date.now(),since=now-7*DAY,until=now+1,userId='',worldId='',pollSeconds=180}={}) {
  until=Math.min(until,now+1);
  if(!Number.isFinite(since)||!Number.isFinite(until)||since>=until||until-since>366*DAY)throw Error('期間は開始日から366日以内で指定してください。');
  const options={accountId,userId,worldId,pollSeconds},source=scopeData(data,accountId,now),names=new Map((data.worlds||[]).filter(w=>!w.accountId||w.accountId===accountId).map(w=>[w.id,w.name]));
  const current=period(source,since,until,options,names),previous=period(source,since-(until-since),since,options,names);
  const worldIds=new Set([...current.worlds.map(w=>w.id),...previous.worlds.map(w=>w.id)]),curWorld=new Map(current.worlds.map(w=>[w.id,w])),prevWorld=new Map(previous.worlds.map(w=>[w.id,w]));
  const worldGrowth=[...worldIds].map(id=>{const value=curWorld.get(id)?.users||0,prior=prevWorld.get(id)?.users||0;return {id,name:names.get(id)||id,current:value,previous:prior,delta:value-prior,change:prior?(value-prior)/prior:null};}).sort(descending('delta'));
  const curConnections=new Map(current.connections.map(r=>[r.id,r])),prevConnections=new Map(previous.connections.map(r=>[r.id,r]));
  const connectionChanges=[...new Set([...curConnections.keys(),...prevConnections.keys()])].map(id=>{
    const a=curConnections.get(id),b=prevConnections.get(id);return {id,name:a?.name||b.name,current:a?.count||0,previous:b?.count||0,delta:(a?.count||0)-(b?.count||0),durationDelta:(a?.duration||0)-(b?.duration||0),cohort:a&&b?'両期間で観測':a?'今期のみ観測':'前期のみ観測'};
  }).sort(descending('delta'));
  const firstByUser=new Map();
  for(const e of source.encounters)if(e.relation==='instance' && (!userId||e.userId===userId) && (!worldId||e.location.worldId===worldId)) {
    if(!firstByUser.has(e.userId)||e.startedAt<firstByUser.get(e.userId).startedAt)firstByUser.set(e.userId,e);
  }
  const firstEncounters=[...firstByUser.values()].filter(e=>inRange(e.startedAt,since,until)).map(e=>({id:e.userId,name:e.displayName,at:e.startedAt,world:names.get(e.location.worldId)||e.location.worldId})).sort((a,b)=>b.at-a.at);
  const fresh=source.friends.filter(f=>f.isFriend && (!userId||f.id===userId) && (!worldId||worldOf(f)===worldId));
  const maxGap=observationGap(pollSeconds),freshness=tally(fresh,f=>now-f.observedAt<=maxGap?'有効期間内':now-f.observedAt<=DAY?'古い観測（24時間以内）':'古い観測（24時間超）');
  const runs=source.runs.filter(r=>inRange(r.completedAt,since,until)).sort((a,b)=>a.completedAt-b.completedAt),gaps=[];
  for(let i=1;i<runs.length;i++){const duration=runs[i].startedAt-runs[i-1].completedAt;if(duration>maxGap)gaps.push({start:runs[i-1].completedAt,end:runs[i].startedAt,duration});}
  const runDays=new Set(runs.map(r=>jstDay(r.completedAt))),currentWorlds=new Map();
  for(const f of fresh)if(worldOf(f) && now-f.observedAt<=maxGap){const id=worldOf(f);if(!currentWorlds.has(id))currentWorlds.set(id,{id,name:names.get(id)||id,users:0,instances:new Set()});const w=currentWorlds.get(id);w.users++;if(f.location.instanceId)w.instances.add(f.location.instanceId);}
  return {schema:1,generatedAt:now,accountId,timezone:'Asia/Tokyo',range:{since,until,previousSince:since-(until-since),previousUntil:since},filters:{userId,worldId},
    definitions:{observations:'変更履歴の前後状態と最新状態の観測点をユーザーID・日時で重複排除。収集回数や在室率ではありません。',duration:'最後に確認した時点までの推定時間。長い未観測期間を補間しません。単位はミリ秒。',comparison:'直前の同じ長さの期間と比較。保存期間や収集頻度の違いに影響されます。',similarity:'観測された共通ワールドの割合。交友関係や同席を意味しません。',selfScope:'ユーザー指定はフレンド・同席の集計に適用。自分の履歴と収集診断はアカウント全体。'},
    ...current,previousMetrics:previous.metrics,worldGrowth,connectionChanges,cohorts:tally(connectionChanges,r=>r.cohort),firstEncounters,
    currentWorlds:[...currentWorlds.values()].map(w=>({...w,instances:w.instances.size})).sort(descending('users')),
    quality:{freshness,runs:runs.length,completeRuns:runs.filter(r=>r.onlineComplete).length,runDays:runDays.size,days:current.daily.length,gaps:gaps.sort(descending('duration')),lastRunAt:source.runs.reduce((n,r)=>Math.max(n,r.completedAt),0),
      worldOnly:source.encounters.filter(e=>e.relation==='world' && e.startedAt<until && e.lastSeenAt>=since && (!userId||e.userId===userId) && (!worldId||e.location.worldId===worldId)).length},
    worldNames:Object.fromEntries(names)};
}

export { csv as analysisCSV } from './core.js';
