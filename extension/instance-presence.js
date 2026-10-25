import {USER_ID,location} from './core.js';
import {normalizeRecord,logInstanceId,decodeChecks} from './sync-format.js';
import {gapLimit,encodeChecks} from './observation-series.js';

export const sameInstance=(a,b)=>a?.kind==='world'&&b?.kind==='world'&&a.worldId===b.worldId&&!!logInstanceId(a.instanceId)&&logInstanceId(a.instanceId)===logInstanceId(b.instanceId);
export function instanceRoster(raw,own,at){
  const expected=own.location;
  if(own.presence!=='online'||expected?.kind!=='world'||!expected.instanceId)return {at,available:false,reason:'現在地を確認できません。'};
  const found=location(raw?.location||(typeof raw?.id==='string'&&raw.id.startsWith('wrld_')?raw.id:(raw?.worldId||'')+':'+(raw?.instanceId||raw?.id||'')));
  if(!sameInstance(found,expected)||!Array.isArray(raw?.users)||raw.users.length>1000)return {at,available:false,reason:'現在のインスタンスの参加者一覧がAPIから返されません。'};
  const users=new Map();
  for(const user of raw.users){
    if(!USER_ID.test(user?.id||'')||typeof user.displayName!=='string'||!user.displayName)return {at,available:false,reason:'参加者一覧の形式を確認できません。'};
    users.set(user.id,{id:user.id,displayName:user.displayName.slice(0,128)});
  }
  const count=Number.isInteger(raw.userCount)?raw.userCount:Number.isInteger(raw.n_users)?raw.n_users:null;
  const complete=count!==null&&count>=0&&count===users.size;
  return {at,available:true,complete,location:{...expected,instanceId:logInstanceId(expected.instanceId)},worldName:typeof raw.world?.name==='string'?raw.world.name.slice(0,256):'',users:[...users.values()].filter(v=>v.id!==own.id)};
}

export function reconcileInstancePresence(previous,snapshot,{accountId,collectorId,pollSeconds=180}){
  const at=snapshot.at,writes=[],active=new Map();
  for(const r of previous){const v=r.value;if(r.kind==='instanceEncounters'&&v.source==='vrchat-instance-api'&&v.accountId===accountId&&v.collectorId===collectorId&&v.endedAt==null)active.set(v.userId,v);}
  const close=(old,reason)=>{if(at<old.lastSeenAt)return;writes.push(normalizeRecord('instanceEncounters',{...old,endedAt:old.lastSeenAt,observedAt:at,endReason:reason}));};
  const seen=new Set();
  if(snapshot.available)for(const user of snapshot.users){
    const old=active.get(user.id);seen.add(user.id);if(old&&at<=old.lastSeenAt)continue;
    const times=old?decodeChecks(old.startedAt,old.checks):[],same=old&&sameInstance(old.location,snapshot.location),gap=old&&at-old.lastSeenAt>gapLimit(pollSeconds),boundary=old&&(times.length>=1024||encodeChecks([...times,at]).length>6000||new Date(at).toISOString().slice(0,7)!==new Date(old.startedAt).toISOString().slice(0,7));
    const continues=old&&same&&!gap&&!boundary&&old.pollSeconds===pollSeconds;
    if(old&&!continues)close(old,!same?'world-change':gap?'gap':'continued');
    const startedAt=continues?old.startedAt:at;
    writes.push(normalizeRecord('instanceEncounters',{accountId,id:continues?old.id:collectorId+'_'+startedAt+'_'+user.id,collectorId,sourceId:'',source:'vrchat-instance-api',device:'api',userId:user.id,displayName:user.displayName,location:snapshot.location,worldName:snapshot.worldName,startedAt,lastSeenAt:at,endedAt:null,observedAt:at,endReason:'',accountBinding:'api',pollSeconds,checks:continues?encodeChecks([...times,at]):''}));
  }
  for(const [id,old] of active)if(!seen.has(id))close(old,!snapshot.available?(snapshot.reason==='stopped'?'stopped':'unavailable'):!sameInstance(old.location,snapshot.location)?'world-change':snapshot.complete?'absent':'unavailable');
  return writes;
}
