import { updateSeries } from './observation-series.js';
export function researchDemo(data,accountId,now=Date.now()){
  const rows=new Map(),start=now-6*3600000,users=data.friends.slice(0,12),worlds=data.worlds.slice(0,4),collectorId='demo_collector';
  for(let i=0;i<120;i++){
    if(i>=55&&i<65)continue;const at=start+i*180000,counts=new Map(),samples=[];
    users.forEach((f,j)=>{const w=worlds[(Math.floor(i/18)+Math.floor(j/3))%worlds.length];if(!w)return;counts.set(w.id,(counts.get(w.id)||0)+1);samples.push({kind:'segments',at,userId:f.id,state:{...f,isFriend:true,presence:'online',location:{kind:'world',worldId:w.id,instanceId:'demo-room'}}});});
    for(const w of worlds)samples.push({kind:'crowd',at,worldId:w.id,count:counts.get(w.id)||0,instances:1,complete:true});
    samples.push({kind:'coverage',at,outcome:i%30<3?'partial':'complete',reason:i%30<3?'online-pages':'',observedUsers:users.length,rosterSize:users.length,online:users.length,visible:users.length});
    if(i%12===0)samples.push({kind:'followerHistory',at,url:'https://x.com/demo',followers:1000+i*3,approximate:false});
    for(const r of updateSeries([...rows.values()].filter(r=>r.value.endedAt==null),samples,{accountId,collectorId,pollSeconds:180}))rows.set(r.key,r);
  }
  const out={...data};for(const kind of ['segments','crowd','coverage','followerHistory'])out[kind]=[...rows.values()].filter(r=>r.kind===kind).map(r=>r.value);
  out.annotations=[{id:'demo_event',accountId,title:'デモの交流会',start:start+2*3600000,end:start+3*3600000,worldId:worlds[0]?.id||'',note:'比較用のサンプル',tags:['交流会']}];out.views=[];out.reports=[];return out;
}
