import { USER_ID, location } from './core.js';
import { logInstanceId } from './sync-format.js';

const SECOND=1000,DAY=86400000;
const person=/^(.*?)\s+\((usr_[a-zA-Z0-9-]{8,64})\)\s*$/;
const cleanName=v=>v.trim().slice(0,128);

// Read only presence-related messages. Raw log text, chat and authentication data
// are never part of an exported record.
export function logLine(line,{offsetMinutes=540,format='pc'}={}){
  let at,body;
  if(format==='pc'){
    const m=/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s+(?:Log|Warning|Error)\s+-\s+(.*)$/.exec(line);
    if(!m)return null;
    const parts=m.slice(1,7).map(Number),utc=Date.UTC(parts[0],parts[1]-1,parts[2],parts[3],parts[4],parts[5],Number((m[7]||'').padEnd(3,'0'))),d=new Date(utc);
    if(d.getUTCFullYear()!==parts[0]||d.getUTCMonth()!==parts[1]-1||d.getUTCDate()!==parts[2]||parts[3]>23||parts[4]>59||parts[5]>59)return null;
    at=utc-offsetMinutes*60000;body=m[8];
  }else{
    // Optional Android logcat export in epoch format. This does not imply that
    // the Quest release client actually emits all required presence messages.
    const m=/^\s*(\d{10}\.\d{3,6})\s+\d+\s+\d+\s+[VDIWEF]\s+Unity\s*:\s*(.*)$/.exec(line);
    if(!m)return null;at=Math.floor(Number(m[1])*1000);body=m[2];
  }
  let match;
  if((match=/^\[(?:Behaviour|RoomManager)\] Joining (wrld_[a-zA-Z0-9-]{8,64}:[^\s]+)\s*$/.exec(body))){const place=location(match[1]);return {at,type:'world',location:place};}
  if((match=/^\[(?:Behaviour|RoomManager)\] Entering Room: (.*)$/.exec(body)))return {at,type:'world-name',name:match[1].slice(0,256)};
  if((match=/^\[(?:Behaviour|NetworkManager)\] OnPlayer(Joined|Left) (.+)$/.exec(body))){const p=person.exec(match[2]);return {at,type:match[1]==='Joined'?'join':'leave',userId:p?.[2]||'',name:cleanName(p?.[1]||match[2])};}
  if(/^\[(?:Behaviour|NetworkManager)\] OnPlayerLeftRoom\s*$/.test(body))return {at,type:'self-left'};
  if(/^VRCApplication: (?:OnApplicationQuit|HandleApplicationQuit) at /.test(body))return {at,type:'quit'};
  if((match=/^(?:\[(?:Behaviour|APIUser)\]\s*)?User Authenticated: (.+)$/.exec(body))){const p=person.exec(match[1]);if(p)return {at,type:'account',userId:p[2],name:cleanName(p[1])};}
  if((match=/^\[(?:Behaviour|Player)\] Initialized PlayerAPI "(.+)" is local\s*$/.exec(body)))return {at,type:'self-name',name:cleanName(match[1])};
  return {at,type:'clock'};
}

export async function logSourceId(name,firstLine,format='pc'){
  const bytes=new TextEncoder().encode(format+'\n'+name+'\n'+firstLine);
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return 'log_'+[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
}

export function createLogParser({accountId,sourceId,format='pc',offsetMinutes=540,now=Date.now()}={}){
  if(!USER_ID.test(accountId||'')||!/^log_[a-f0-9]{64}$/.test(sourceId||'')||!['pc','logcat'].includes(format)||!Number.isInteger(offsetMinutes)||Math.abs(offsetMinutes)>840)throw Error('ログの読み込み設定が不正です。');
  let place=null,worldName='',pendingName='',lastAt=0,lineNumber=0,ownerVerified=false,selfName='',ambiguous=0,ignored=0;
  const rows=[],active=new Map();
  const key=p=>p.userId||'name:'+p.name;
  function close(row,at,reason){row.lastSeenAt=Math.max(row.startedAt,at);row.endedAt=row.lastSeenAt;row.observedAt=row.lastSeenAt;row.endReason=reason;}
  function closeAll(at,reason){for(const row of active.values())close(row,at,reason);active.clear();}
  return {
    feed(line){
      lineNumber++;const e=logLine(line,{format,offsetMinutes});if(!e)return;
      if(!Number.isSafeInteger(e.at)||e.at<=0||e.at>now+300000)throw Error('ログの日時が未来になっています。タイムゾーンを確認してください。');
      if(e.at<lastAt){ignored++;return;}lastAt=e.at;
      if(e.type==='account'){
        if(e.userId!==accountId)throw Error('ログのログインアカウントが表示アカウントと異なります。保存を中止しました。');
        ownerVerified=true;selfName=e.name;return;
      }
      if(e.type==='self-name'){
        selfName=e.name;
        // Old logs may lack IDs. A local-player marker identifies only this
        // session's self entry; other equal names are not merged across logs.
        for(const [id,row] of active)if(!row.userId&&row.displayName===selfName){active.delete(id);rows.splice(rows.indexOf(row),1);}
        return;
      }
      if(e.type==='world-name'){pendingName=e.name;return;}
      if(e.type==='world'){closeAll(e.at,'world-change');place=e.location;place.instanceId=logInstanceId(place.instanceId);if(!place.instanceId)place=null;worldName=pendingName;pendingName='';return;}
      if(e.type==='self-left'||e.type==='quit'){closeAll(e.at,e.type);place=null;return;}
      if(e.type==='join'){
        if(e.userId===accountId||!e.userId&&e.name===selfName)return;
        if(!place||!e.name){ignored++;return;}
        const id=key(e);
        if(active.has(id)){if(!e.userId)ambiguous++;return;}
        const row={accountId,id:sourceId.slice(4)+'_'+lineNumber,sourceId,source:format==='pc'?'vrchat-output-log':'vrchat-logcat',device:format==='pc'?'pc':'quest',userId:e.userId,displayName:e.name,
          location:{...place},worldName,startedAt:e.at,lastSeenAt:e.at,endedAt:null,observedAt:e.at,endReason:'',accountBinding:ownerVerified?'log':'selected'};
        rows.push(row);active.set(id,row);if(rows.length>100000)throw Error('1ファイルの同席区間が上限を超えています。');return;
      }
      if(e.type==='leave'){
        if(e.userId===accountId){closeAll(e.at,'self-left');place=null;return;}
        let id=key(e),row=active.get(id);
        if(!row&&!e.userId){const matches=[...active].filter(([,r])=>r.displayName===e.name);if(matches.length===1)[id,row]=matches[0];else if(matches.length>1)ambiguous++;}
        if(row){close(row,e.at,'left');active.delete(id);}else ignored++;
      }
    },
    finish(){
      // No wall-clock extrapolation: a crash or missing exit stays explicitly open.
      for(const row of active.values()){row.lastSeenAt=Math.max(row.startedAt,lastAt);row.observedAt=row.lastSeenAt;}
      return {rows,lines:lineNumber,lastAt,ownerVerified,ambiguous,ignored,unidentified:rows.filter(r=>!r.userId).length,open:active.size};
    }
  };
}

function union(intervals){
  const out=[];
  for(const v of intervals.sort((a,b)=>a.start-b.start||a.end-b.end)){
    const prev=out[out.length-1];if(prev&&v.start<=prev.end){prev.end=Math.max(prev.end,v.end);prev.records.push(...v.records);}else out.push({...v,records:[...v.records]});
  }
  return out;
}
export function summarizeLogEncounters(records,{accountId,since=0,until=Date.now(),query='',worldId='',device='',relation='all',friends=[],sort='duration'}={}){
  const roster=new Set(friends.filter(f=>f.accountId===accountId&&f.isFriend).map(f=>f.id)),groups=new Map();
  for(const r of records){
    if(r.accountId!==accountId||r.startedAt>until||r.lastSeenAt<since||worldId&&r.location.worldId!==worldId||device&&r.device!==device)continue;
    const isFriend=roster.has(r.userId);
    if(relation==='friend'&&!isFriend||relation==='nonfriend'&&(!r.userId||isFriend)||relation==='unknown'&&r.userId)continue;
    if(query&&!`${r.displayName} ${r.userId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))continue;
    const id=r.userId||'unknown:'+r.id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(r);
  }
  const rows=[];
  for(const [id,items] of groups){
    items.sort((a,b)=>b.observedAt-a.observedAt);const places=new Map();
    for(const r of items){const place=r.location.worldId+':'+r.location.instanceId;if(!places.has(place))places.set(place,[]);places.get(place).push({start:Math.max(since,r.startedAt),end:Math.min(until,r.lastSeenAt),records:[r]});}
    const sessions=[...places.values()].flatMap(union).sort((a,b)=>b.start-a.start),times=union(sessions),total=times.reduce((n,v)=>n+v.end-v.start,0);
    rows.push({id,userId:items[0].userId,name:items[0].displayName,isFriend:roster.has(items[0].userId),duration:total,count:sessions.length,firstAt:items.reduce((n,r)=>Math.min(n,r.startedAt),Infinity),lastAt:items.reduce((n,r)=>Math.max(n,r.lastSeenAt),0),worlds:new Set(items.map(r=>r.location.worldId)).size,days:new Set(items.map(r=>Math.floor((r.startedAt+9*3600000)/DAY))).size,sessions,estimated:items.some(r=>r.source==='vrchat-instance-api'),open:items.some(r=>r.endedAt==null||['gap','unavailable','stopped'].includes(r.endReason))});
  }
  const compare={duration:(a,b)=>b.duration-a.duration,count:(a,b)=>b.count-a.count,first:(a,b)=>a.firstAt-b.firstAt,latest:(a,b)=>b.lastAt-a.lastAt,name:(a,b)=>a.name.localeCompare(b.name,'ja')}[sort];
  return rows.sort((a,b)=>(compare||(()=>0))(a,b)||a.id.localeCompare(b.id));
}

export const logDuration=ms=>ms<SECOND?'0秒':ms<60000?Math.floor(ms/SECOND)+'秒':(ms>=3600000?Math.floor(ms/3600000)+'時間':'')+Math.floor(ms/60000)%60+'分';
