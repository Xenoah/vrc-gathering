import { decodeChecks } from './sync-format.js';
import { gapLimit } from './observation-series.js';

export const DAY=86400000;
const intersects=(s,a,b)=>s.startedAt<b&&s.lastSeenAt>=a;
const union=rows=>{const out=[];for(const s of [...rows].sort((a,b)=>a.start-b.start)){const last=out.at(-1);if(last&&s.start<=last.end)last.end=Math.max(last.end,s.end);else out.push({...s});}return out;};
const duration=rows=>union(rows).reduce((n,s)=>n+Math.max(0,s.end-s.start),0);
const locationKey=s=>s.state.presence==='online'&&s.state.location.kind==='world'?s.state.location.worldId+':'+s.state.location.instanceId:'';
export function scopedSegments(data,{accountId,since=0,until=Date.now(),userId='',worldId=''}={}){
  const grouped=new Map();
  for(const s of data.segments||[]){if(s.accountId!==accountId||!intersects(s,since,until)||userId&&s.userId!==userId||worldId&&s.state.location.worldId!==worldId)continue;
    if(!grouped.has(s.userId))grouped.set(s.userId,[]);grouped.get(s.userId).push(s);}
  const out=[];
  for(const rows of grouped.values()){
    const normalized=[];
    for(const s of rows.sort((a,b)=>a.startedAt-b.startedAt||a.observedAt-b.observedAt)){
      const next={...s,start:Math.max(since,s.startedAt),end:Math.min(until,s.lastSeenAt)},last=normalized.at(-1);
      if(last&&next.start<=last.end){
        if(locationKey(last)&&locationKey(last)===locationKey(next)&&last.state.isFriend===next.state.isFriend){last.end=Math.max(last.end,next.end);last.lastSeenAt=Math.max(last.lastSeenAt,next.lastSeenAt);if(next.observedAt>=last.observedAt){last.state=next.state;last.observedAt=next.observedAt;}continue;}
        last.end=Math.min(last.end,next.start-1);if(last.end<last.start)normalized.pop();
      }
      normalized.push(next);
    }
    out.push(...normalized);
  }
  return out;
}
export function crowdSeries(data,{accountId,since,until,worldId='',binMinutes=15}={}){
  const step=binMinutes*60000,bins=new Map(),names=new Map((data.worlds||[]).map(w=>[w.id,w.name]));
  for(const s of data.crowd||[]){if(s.accountId!==accountId||worldId&&s.worldId!==worldId||!intersects(s,since,until))continue;
    for(const at of decodeChecks(s.startedAt,s.checks)){if(at<since||at>=until)continue;const bucket=Math.floor(at/step)*step,key=s.worldId+':'+bucket;
      if(!bins.has(key))bins.set(key,new Map());const collectors=bins.get(key),id=s.collectorId+':'+s.complete;
      if(!collectors.has(id))collectors.set(id,{worldId:s.worldId,at:bucket,name:names.get(s.worldId)||s.worldId,peak:0,sum:0,samples:0,lastAt:0,last:0,complete:s.complete});
      const b=collectors.get(id);b.peak=Math.max(b.peak,s.count);b.sum+=s.count;b.samples++;if(at>=b.lastAt){b.lastAt=at;b.last=s.count;}
    }
  }
  return [...bins.values()].map(c=>{const b=[...c.values()].sort((a,b)=>Number(b.complete)-Number(a.complete)||b.samples-a.samples||b.lastAt-a.lastAt)[0];return {...b,mean:b.sum/b.samples};}).sort((a,b)=>a.at-b.at||a.worldId.localeCompare(b.worldId));
}
export function crowdRanking(series){
  const groups=new Map();for(const b of series){if(!groups.has(b.worldId))groups.set(b.worldId,[]);groups.get(b.worldId).push(b);}
  return [...groups].map(([id,rows])=>{const last=rows.at(-1),previous=rows.at(-2);return {id,name:last.name,current:last.last,peak:Math.max(...rows.map(r=>r.peak)),samples:rows.reduce((n,r)=>n+r.samples,0),complete:last.complete,
    previous:previous?.last??null,delta:previous&&previous.complete===last.complete?last.last-previous.last:null,at:last.lastAt};}).sort((a,b)=>(b.delta??-Infinity)-(a.delta??-Infinity)||b.current-a.current||a.id.localeCompare(b.id));
}
export function pairConnections(data,options={}){
  const rooms=new Map(),pairs=new Map(),segments=scopedSegments(data,{...options,userId:''});
  for(const s of segments){const l=s.state.location;if(!s.state.isFriend||s.state.presence!=='online'||l.kind!=='world'||!l.instanceId)continue;
    const key=l.worldId+':'+l.instanceId;if(!rooms.has(key))rooms.set(key,[]);rooms.get(key).push(s);}
  for(const rows of rooms.values()){
    const active=[];
    for(const s of rows.sort((a,b)=>a.start-b.start)){
      for(let i=active.length-1;i>=0;i--)if(active[i].end<s.start)active.splice(i,1);
      for(const other of active){if(other.userId===s.userId||options.userId&&other.userId!==options.userId&&s.userId!==options.userId)continue;
        const ids=[s.userId,other.userId].sort(),key=ids.join('>');
        if(!pairs.has(key)){if(pairs.size>=100000)throw Error('同席ペアが10万組を超えます。期間・ワールド・ユーザーを絞り込んでください。');pairs.set(key,{id:key,from:ids[0],to:ids[1],names:{[s.userId]:s.state.displayName,[other.userId]:other.state.displayName},intervals:[],worlds:new Set(),lastSeenAt:0});}
        const p=pairs.get(key),end=Math.min(s.end,other.end);p.intervals.push({start:s.start,end});p.worlds.add(s.state.location.worldId);p.lastSeenAt=Math.max(p.lastSeenAt,end);
      }
      active.push(s);
    }
  }
  return [...pairs.values()].map(p=>{const intervals=union(p.intervals);return {...p,name:p.names[p.from]+' ↔ '+p.names[p.to],count:intervals.length,duration:duration(intervals),worlds:p.worlds.size,intervals};}).sort((a,b)=>b.duration-a.duration||b.count-a.count||a.id.localeCompare(b.id));
}
export function pairGraph(pairs,{limit=200}={}){
  const people=new Map();for(const p of pairs)for(const id of [p.from,p.to]){if(!people.has(id))people.set(id,{id,name:p.names[id],score:0,neighbors:new Set()});const v=people.get(id);v.score+=p.duration;v.neighbors.add(id===p.from?p.to:p.from);}
  const communities=new Map();let community=0;
  for(const id of people.keys())if(!communities.has(id)){const pending=[id];communities.set(id,community);while(pending.length){const key=pending.pop();for(const neighbor of people.get(key).neighbors)if(!communities.has(neighbor)){communities.set(neighbor,community);pending.push(neighbor);}}community++;}
  const chosen=[...people.values()].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit),extent=Math.max(350,Math.ceil(Math.sqrt(chosen.length/3))*210),nodes=[];
  chosen.forEach((p,i)=>{const ring=Math.floor(Math.sqrt(i/6))+1,angle=i*2.3999632297;nodes.push({id:p.id,name:p.name,kind:'user',imageId:p.id,x:extent+Math.cos(angle)*ring*190,y:extent+Math.sin(angle)*ring*190,
    caption:p.neighbors.size+'人 · グループ '+(communities.get(p.id)+1),community:communities.get(p.id),color:['#48c9dd','#bf93ff','#efbd68','#ee8db5','#7dd6ad'][communities.get(p.id)%5]});});
  const ids=new Set(nodes.map(n=>n.id)),edges=pairs.filter(p=>ids.has(p.from)&&ids.has(p.to)).map(p=>({...p,undirected:true}));
  return {nodes,edges,width:extent*2,height:extent*2,totalUsers:people.size,communities:community};
}
export function qualitySummary(data,{accountId,since,until,pollSeconds=180}={}){
  const observations=new Map(),windows=[],gaps=[],streams=new Map();
  for(const s of data.coverage||[]){if(s.accountId!==accountId||!intersects(s,since,until))continue;
    for(const at of decodeChecks(s.startedAt,s.checks))if(at>=since&&at<until)observations.set(s.collectorId+':'+at,{...s,at});
    if(['complete','partial'].includes(s.outcome))windows.push({start:Math.max(since,s.startedAt),end:Math.min(until,s.lastSeenAt)});
  }
  for(const row of observations.values()){if(!streams.has(row.collectorId))streams.set(row.collectorId,[]);streams.get(row.collectorId).push(row);}
  for(const rows of streams.values()){rows.sort((a,b)=>a.at-b.at);for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i];if(['complete','partial'].includes(a.outcome)&&['complete','partial'].includes(b.outcome)&&b.at-a.at<=gapLimit(a.pollSeconds||pollSeconds))windows.push({start:a.at,end:b.at});if(b.at-a.at>gapLimit(a.pollSeconds||pollSeconds)||['error','paused'].includes(a.outcome))gaps.push({start:a.at,end:b.at,duration:b.at-a.at,reason:a.reason||'観測間隔の空白'});}const last=rows.at(-1);if(last&&until-last.at>gapLimit(last.pollSeconds||pollSeconds))gaps.push({start:last.at,end:until,duration:until-last.at,reason:last.reason||'最後の確認後は不明'});}
  if(!observations.size&&until>since)gaps.push({start:since,end:until,duration:until-since,reason:'この期間の観測なし'});
  else {const first=[...observations.values()].reduce((at,r)=>Math.min(at,r.at),Infinity);if(first-since>gapLimit(pollSeconds))gaps.unshift({start:since,end:first,duration:first-since,reason:'記録開始前／確認なし'});}
  const rows=[...observations.values()],covered=duration(windows),availableSince=(data.coverage||[]).filter(s=>s.accountId===accountId).reduce((n,s)=>Math.min(n,s.startedAt),Infinity);
  return {samples:rows.length,complete:rows.filter(s=>s.outcome==='complete').length,partial:rows.filter(s=>s.outcome==='partial').length,errors:rows.filter(s=>s.outcome==='error').length,
    pauses:rows.filter(s=>s.outcome==='paused').length,coveredMs:covered,unknownMs:Math.max(0,until-since-covered),coverage:(until>since?covered/(until-since):0),gaps,availableSince:Number.isFinite(availableSince)?availableSince:null};
}
export function replaySnapshot(data,at,options){
  const rows=scopedSegments(data,{...options,since:options.since||0,until:at+1}).filter(s=>s.start<=at&&s.end>=at&&s.state.isFriend&&s.state.location.kind!=='traveling'),places=new Map();
  const labels={private:'プライベート',offline:'現実世界',web:'Web／アプリ',unknown:'所在不明'},names=new Map((data.worlds||[]).map(w=>[w.id,w.name]));
  for(const s of rows){const l=s.state.location,id=l.kind==='world'?l.worldId:'state:'+l.kind;if(!places.has(id))places.set(id,{id,kind:l.kind,name:names.get(id)||labels[l.kind]||l.kind,users:new Set(),currentUsers:new Set(),members:[],moves:0});const n=places.get(id);if(n.users.has(s.userId))continue;n.users.add(s.userId);n.currentUsers.add(s.userId);n.members.push({id:s.userId,name:s.state.displayName});}
  const edges=new Map(),byUser=new Map(),seenMoves=new Set();
  for(const s of data.segments||[])if(s.accountId===options.accountId&&s.state.isFriend&&(!options.userId||s.userId===options.userId)){const key=s.userId+':'+s.collectorId;if(!byUser.has(key))byUser.set(key,[]);byUser.get(key).push(s);}
  const placeId=s=>s.state.location.kind==='world'?s.state.location.worldId:'state:'+s.state.location.kind;
  for(const stream of byUser.values()){stream.sort((a,b)=>a.startedAt-b.startedAt);for(let i=1;i<stream.length;i++){const a=stream[i-1],b=stream[i];if(b.startedAt>at||b.startedAt<Math.max(options.since||0,at-600000)||a.collectorId!==b.collectorId||a.endedAt!==b.startedAt||a.endReason!=='changed'||b.startedAt-a.lastSeenAt>gapLimit(a.pollSeconds)||[a,b].some(s=>s.state.location.kind==='traveling'))continue;
    const from=placeId(a),to=placeId(b);if(from===to||options.worldId&&![from,to].includes(options.worldId))continue;
    for(const s of [a,b]){const id=placeId(s);if(!places.has(id))places.set(id,{id,kind:s.state.location.kind,name:names.get(id)||labels[s.state.location.kind]||s.state.location.kind,users:new Set(),currentUsers:new Set(),members:[],moves:0});}
    const move=b.userId+':'+b.startedAt+':'+from+'>'+to;if(seenMoves.has(move))continue;seenMoves.add(move);
    const id=from+'>'+to;if(!edges.has(id))edges.set(id,{id,from,to,count:0,name:places.get(from).name+' → '+places.get(to).name});edges.get(id).count++;
  }}
  const nodes=[...places.values()],extent=Math.max(320,Math.ceil(Math.sqrt(nodes.length/3))*210);nodes.forEach((n,i)=>{const ring=Math.floor(Math.sqrt(i/6))+1,angle=i*2.3999632297;n.x=extent+Math.cos(angle)*ring*190;n.y=extent+Math.sin(angle)*ring*190;n.caption=n.users.size+'人（観測間を補間）';});
  return {nodes,edges:[...edges.values()],width:extent*2,height:extent*2,users:rows.length,at};
}
export function followerChanges(data,{accountId,since,until,userId=''}={}){
  const allowed=userId?new Set((data.profiles||[]).filter(p=>p.accountId===accountId&&p.userId===userId).flatMap(p=>p.urls)):null,groups=new Map();
  for(const s of data.followerHistory||[]){if(s.accountId!==accountId||allowed&&!allowed.has(s.url)||!intersects(s,since,until))continue;
    if(!groups.has(s.url))groups.set(s.url,[]);for(const at of decodeChecks(s.startedAt,s.checks))if(at>=since&&at<until)groups.get(s.url).push({at,value:s.followers,approximate:s.approximate});}
  return [...groups].filter(([,points])=>points.length).map(([url,points])=>{points.sort((a,b)=>a.at-b.at);const unique=[...new Map(points.map(p=>[p.at,p])).values()],first=unique[0],last=unique.at(-1);return {url,name:'@'+url.slice(14),points:unique,current:last.value,delta:unique.length>1?last.value-first.value:null,approximate:unique.some(p=>p.approximate),samples:unique.length,at:last.at};}).sort((a,b)=>b.current-a.current);
}
export function traitSummary(data,options){
  const worlds=new Map((data.worlds||[]).map(w=>[w.id,w])),groups=new Map();
  for(const s of scopedSegments(data,options)){const w=worlds.get(s.state.location.worldId);if(!w||s.state.presence!=='online')continue;
    const labels=[...(w.traits?.tags||[]).map(t=>'タグ：'+t),...(w.traits?.platforms||[]).map(t=>'対応端末：'+({standalonewindows:'Windows',android:'Android',ios:'iOS'}[t]||t)),'作者：'+(w.authorName||'未取得'),'定員：'+(w.capacity==null?'未取得':w.capacity<=16?'16人以下':w.capacity<=40?'17〜40人':'41人以上')];
    for(const name of labels){if(!groups.has(name))groups.set(name,{name,worlds:new Set(),users:new Set(),intervals:[],visits:0});const g=groups.get(name);g.worlds.add(w.id);g.users.add(s.userId);g.intervals.push({start:s.start,end:s.end});g.visits++;}
  }
  return [...groups.values()].map(g=>({...g,worlds:g.worlds.size,users:g.users.size,duration:duration(g.intervals),intervals:undefined})).sort((a,b)=>b.users-a.users||b.worlds-a.worlds);
}
export function eventComparison(data,event,options){
  const width=event.end-event.start;if(width<=0)return [];
  return [['前',event.start-width,event.start],['期間中',event.start,event.end],['後',event.end,event.end+width]].map(([name,since,until])=>{
    const end=Math.min(options.until,until),scope={...options,since,until:end,worldId:event.worldId||options.worldId};if(end<=since)return {name,pending:true,users:null,samples:0,peak:null};
    const segments=scopedSegments(data,scope).filter(s=>s.state.presence==='online'&&s.state.location.kind==='world'),crowd=crowdSeries(data,scope),quality=qualitySummary(data,scope);
    return {name,pending:end<until,users:new Set(segments.map(s=>s.userId)).size,samples:quality.samples,peak:crowd.length?Math.max(...crowd.map(c=>c.peak)):null,coverage:quality.coverage};
  });
}
export function scheduledBoundary(now,schedule){const offset=9*3600000,day=Math.floor((now+offset)/DAY)*DAY-offset;if(schedule!=='weekly')return day;return day-((new Date(day+offset).getUTCDay()+6)%7)*DAY;}
export function reportSummary(data,options){
  const quality=qualitySummary(data,options),crowd=crowdRanking(crowdSeries(data,options)),pairs=pairConnections(data,options),followers=followerChanges(data,options);
  return {quality:{samples:quality.samples,complete:quality.complete,partial:quality.partial,errors:quality.errors,coverage:quality.coverage,availableSince:quality.availableSince},
    worlds:crowd.slice(0,8).map(w=>({name:w.name,peak:w.peak,delta:w.delta})),pairs:pairs.slice(0,8).map(p=>({name:p.name,count:p.count,duration:p.duration})),followers:followers.slice(0,8).map(f=>({name:f.name,current:f.current,delta:f.delta,approximate:f.approximate}))};
}
