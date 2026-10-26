import { normalizeRecord, canonical, decodeChecks } from './sync-format.js';

export const MAX_CHECKS=1024;
export const gapLimit=seconds=>Math.max(120,seconds*2.2)*1000;
const month=at=>new Date(at).toISOString().slice(0,7);
export function encodeChecks(times){return times.slice(1).map((at,i)=>(at-times[i]).toString(36)).join('.');}
const subject=(kind,v)=>kind==='segments'?v.userId:kind==='crowd'?v.worldId:kind==='followerHistory'?v.url:'collection';
const payload=(kind,v)=>kind==='segments'?v.state:kind==='crowd'?{count:v.count,instances:v.instances,complete:v.complete}:kind==='followerHistory'?{followers:v.followers,approximate:v.approximate}:Object.fromEntries(['outcome','reason','observedUsers','rosterSize','online','web','offline','private','visible'].map(k=>[k,v[k]]));

export function updateSeries(previous, samples, {accountId,collectorId,pollSeconds=180}) {
  const active=new Map(),writes=new Map();
  for(const record of previous){const v=record.value;if(v.accountId!==accountId||v.collectorId!==collectorId||v.endedAt!=null)continue;
    const key=record.kind+':'+subject(record.kind,v),old=active.get(key);if(!old||v.lastSeenAt>old.value.lastSeenAt)active.set(key,record);}
  for(const sample of [...samples].sort((a,b)=>a.at-b.at)){
    const {kind,at,...fields}=sample;
    const next=normalizeRecord(kind,{...fields,accountId,collectorId,pollSeconds,observedAt:at,startedAt:at,lastSeenAt:at,endedAt:null,checks:''});
    const identity=kind+':'+subject(kind,next.value),old=active.get(identity);
    if(old&&at<=old.value.lastSeenAt)continue;
    const oldTimes=old?decodeChecks(old.value.startedAt,old.value.checks):[],checks=old?old.value.checks+(old.value.checks?'.':'')+(at-old.value.lastSeenAt).toString(36):'';
    const same=old&&canonical(payload(kind,old.value))===canonical(payload(kind,next.value));
    // Follower values are sparse manual observations, never continuous presence evidence.
    const gap=old&&kind!=='followerHistory'&&at-old.value.lastSeenAt>gapLimit(pollSeconds);
    const continuation=old&&(month(at)!==month(old.value.startedAt)||oldTimes.length>=MAX_CHECKS||checks.length>6000);
    let record=next;
    if(old&&same&&!gap&&!continuation&&old.value.pollSeconds===pollSeconds){
      record=normalizeRecord(kind,{...old.value,lastSeenAt:at,observedAt:at,checks});
    }else if(old){
      const closed=normalizeRecord(kind,{...old.value,endedAt:at,observedAt:at,endReason:gap?'gap':continuation?'continued':'changed'});writes.set(closed.key,closed);
    }
    active.set(identity,record);writes.set(record.key,record);
  }
  return [...writes.values()];
}

export function collectionSeries(previous,{accountId,collectorId,pollSeconds,samples,completedAt,rosterSize,complete}){
  const unique=new Map();for(const f of samples)if(!unique.has(f.id)||f.observedAt>unique.get(f.id).observedAt)unique.set(f.id,f);
  const peers=[...unique.values()].filter(f=>f.id!==accountId&&f.isFriend),worlds=new Map();
  for(const f of peers)if(f.presence==='online'&&f.location?.kind==='world'){
    if(!worlds.has(f.location.worldId))worlds.set(f.location.worldId,{count:0,instances:new Set()});const w=worlds.get(f.location.worldId);w.count++;if(f.location.instanceId)w.instances.add(f.location.instanceId);
  }
  // A complete scan can confirm that a previously seen world now has no observed friends.
  if(complete)for(const r of previous)if(r.kind==='crowd'&&r.value.collectorId===collectorId&&!r.value.endedAt&&!worlds.has(r.value.worldId))worlds.set(r.value.worldId,{count:0,instances:new Set()});
  const observations=samples.map(f=>({kind:'segments',at:f.observedAt,userId:f.id,...(f.id===accountId?{extensions:{'vrc.location':{source:f.extensions?.['vrc.location']?.source||'vrchat-api'}}}:{}),state:{...f,isFriend:f.id===accountId||f.isFriend===true}}));
  observations.push(...[...worlds].map(([worldId,w])=>({kind:'crowd',at:completedAt,worldId,count:w.count,instances:w.instances.size,complete})));
  observations.push({kind:'coverage',at:completedAt,outcome:complete?'complete':'partial',reason:complete?'':'online-pages',observedUsers:peers.length,rosterSize,
    online:peers.filter(f=>f.presence==='online').length,web:peers.filter(f=>f.presence==='active').length,offline:peers.filter(f=>f.presence==='offline').length,
    private:peers.filter(f=>f.location?.kind==='private').length,visible:peers.filter(f=>f.location?.kind==='world').length});
  return updateSeries(previous,observations,{accountId,collectorId,pollSeconds});
}

export function stopSeries(previous,{accountId,collectorId,at,pollSeconds,reason='paused'}){
  const writes=[];
  for(const r of previous)if(['segments','crowd'].includes(r.kind)&&r.value.accountId===accountId&&r.value.collectorId===collectorId&&r.value.endedAt==null&&r.value.lastSeenAt<=at)
    writes.push(normalizeRecord(r.kind,{...r.value,endedAt:at,observedAt:at,endReason:'stopped'}));
  return [...writes,...updateSeries(previous,[{kind:'coverage',at,outcome:reason==='paused'?'paused':'error',reason,observedUsers:0,rosterSize:0}],{accountId,collectorId,pollSeconds})];
}

function runSignature(run){const fields=Object.fromEntries(['accountId','onlineComplete','onlineOffset','offlineOffset','observedCount','changedCount','worldNamesPending'].map(k=>[k,run[k]]));fields.extensions=Object.fromEntries(Object.entries(run.extensions||{}).filter(([k])=>!['vrc.collector','vrc.run-series'].includes(k)));return canonical(fields);}
export function expandRuns(rows){
  return rows.flatMap(row=>{
    const series=row.extensions?.['vrc.run-series'];if(!series)return [row];
    try{const times=decodeChecks(row.startedAt,series.checks);if(times.length%2||times.at(-1)!==row.completedAt)return [row];
      const extensions={...row.extensions};delete extensions['vrc.run-series'];
      return Array.from({length:times.length/2},(_,i)=>({...row,startedAt:times[i*2],completedAt:times[i*2+1],observedAt:times[i*2+1],extensions}));
    }catch{return [row];}
  });
}
export function compressRun(rows,run,collectorId,pollSeconds){
  const prior=rows.filter(r=>r.accountId===run.accountId&&r.extensions?.['vrc.collector']?.id===collectorId).sort((a,b)=>b.completedAt-a.completedAt)[0];
  const next={...run,extensions:{...run.extensions,'vrc.collector':{id:collectorId}}};
  if(!prior||run.startedAt<=prior.completedAt||run.startedAt-prior.completedAt>gapLimit(pollSeconds)||month(run.startedAt)!==month(prior.startedAt)||runSignature(prior)!==runSignature(run))return next;
  const times=expandRuns([prior]).flatMap(r=>[r.startedAt,r.completedAt]);times.push(run.startedAt,run.completedAt);
  if(times.some((t,i)=>i&&t<=times[i-1])||times.length>MAX_CHECKS)return next;
  const checks=encodeChecks(times);if(checks.length>6000)return next;
  return {...next,startedAt:prior.startedAt,extensions:{...prior.extensions,...next.extensions,'vrc.run-series':{checks,count:times.length/2}}};
}
