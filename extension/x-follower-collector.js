import { readXCache, xProfileURL } from './x-profile.js';
import { followerRecords } from './x-followers.js';

export const X_QUEUE_ALARM='vrc-x-follower-queue';
export const X_QUEUE_INTERVAL=15000;
export const X_QUEUE_TIMEOUT=60000;
const LIMIT=10000;
export function followerTargets(profiles,metrics,accountId,userIds,now=Date.now()){
  const allowed=new Set(userIds),seen=new Set(),values=new Map(followerRecords(metrics,now).filter(r=>r.value.accountId===accountId).map(r=>[r.value.url,r.value]));
  for(const entry of Object.values(profiles||{})){
    const profile=readXCache(profiles,accountId,entry?.userId,now);
    if(profile&&allowed.has(profile.userId))for(const url of profile.urls)seen.add(url);
  }
  return [...seen].map(url=>({url,observedAt:values.get(url)?.observedAt||0})).sort((a,b)=>a.observedAt-b.observedAt||a.url.localeCompare(b.url));
}
const empty=()=>({schema:1,items:[],active:null,paused:false,phase:'idle',total:0,success:0,failed:0,skipped:0,consecutiveFailures:0,nextAt:0,retryAt:0,message:'',updatedAt:0});
// Every operation is serialized and the queue is persisted before opening a tab.
// Alarms wake suspended MV3 workers; no queue state relies on a long-lived timer.
export function createFollowerCollector({storage,tabs,alarms,allowed,isKnown,now=()=>Date.now(),uuid=()=>crypto.randomUUID()}){
  let chain=Promise.resolve();
  const serial=work=>{const next=chain.then(work);chain=next.catch(()=>{});return next;};
  async function read(){const raw=(await storage.get('xFollowerQueue')).xFollowerQueue;if(raw?.schema!==1)return empty();return {...empty(),...raw,items:(raw.items||[]).filter(j=>xProfileURL(j?.url)===j.url).slice(0,LIMIT)};}
  const save=q=>storage.set({xFollowerQueue:{...q,updatedAt:now()}});
  const wake=at=>alarms.create(X_QUEUE_ALARM,{when:Math.max(now()+1000,at)});
  const marked=a=>a.url+'#vrc-gathering='+a.token;
  function owns(tab,a){return (tab?.pendingUrl||tab?.url)===marked(a);}
  async function close(a){if(!Number.isInteger(a?.tabId))return;try{const tab=await tabs.get(a.tabId);if(owns(tab,a)&&!tab.active&&!tab.pinned)await tabs.remove(a.tabId);}catch{}}
  async function finish(q,outcome,message,{keep=false}={}){
    const active=q.active;q.active=null;q[outcome]++;q.consecutiveFailures=outcome==='failed'?q.consecutiveFailures+1:0;q.message=message;
    q.phase='waiting';if(q.consecutiveFailures>=3){q.paused=true;q.items=q.items.map(j=>({...j,single:false}));q.phase='paused';q.message='3件続けて取得できなかったため停止しました。Xの表示状態を確認してから再開してください。';}
    await save(q);if(!keep)await close(active);
  }
  async function stop(q,message,{keep=false,retryAt=0}={}){
    const active=q.active;if(active)q.items.unshift({url:active.url,single:false});q.active=null;q.items=q.items.map(j=>({...j,single:false}));q.paused=true;q.phase='paused';q.message=message;q.retryAt=Math.max(q.retryAt||0,retryAt);await save(q);await alarms.clear(X_QUEUE_ALARM);if(!keep)await close(active);
  }
  async function run(q){
    if(!await allowed()){await stop(q,'Xの取得設定または接続権限が無効です。');return q;}
    if(q.active){const a=q.active;let tab;
      if(a.tabId==null){
        // Recover a tab created just before worker termination without touching existing user tabs.
        const matches=await tabs.query({url:'https://x.com/*'});tab=matches.find(t=>owns(t,a));if(tab){a.tabId=tab.id;await save(q);}
        else {q.active=null;q.items.unshift({url:a.url,single:a.single});await save(q);}
      }else try{tab=await tabs.get(a.tabId);}catch{}
      if(q.active){
        if(!tab){await stop(q,'取得用タブが閉じられたため停止しました。');return q;}
        const destination=tab.pendingUrl||tab.url||'';
        if(/^https:\/\/x\.com\/(?:i\/flow\/login|login|account\/access)(?:[/?#]|$)/i.test(destination)){await stop(q,'Xでログインまたはアカウントの確認が必要です。取得用タブを確認し、完了後に再開してください。',{keep:true});return q;}
        if(destination&&destination!=='about:blank'&&!owns(tab,a)){await stop(q,'取得用タブが別のページに移動したため停止しました。',{keep:true});return q;}
        if(now()>=a.deadline){await finish(q,'failed','@'+a.url.slice(14)+'：表示から数値を確認できませんでした。以前の値を保持します。');}
        else {if(tab.status==='complete')void tabs.sendMessage(a.tabId,{type:'X_FOLLOWERS_READ'}).catch(()=>{});await wake(a.deadline);return q;}
      }
    }
    if(q.retryAt>now()){q.phase='paused';q.paused=true;q.message='Xの制限を検出しました。'+new Date(q.retryAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+'（JST）'+' 以降に再開してください。';await save(q);return q;}
    let index=q.items.findIndex(j=>!q.paused||j.single);
    if(index<0){q.phase=q.items.length?'paused':'complete';if(!q.items.length)q.message='取得が完了しました。';await save(q);await alarms.clear(X_QUEUE_ALARM);return q;}
    if(q.nextAt>now()){q.phase='waiting';await save(q);await wake(q.nextAt);return q;}
    // Removed links are skipped; they do not become arbitrary browsing targets.
    while(index>=0){const [job]=q.items.splice(index,1);if(!await isKnown(job.url)){q.skipped++;index=q.items.findIndex(j=>!q.paused||j.single);continue;}
      q.active={...job,token:uuid(),tabId:null,startedAt:now(),deadline:now()+X_QUEUE_TIMEOUT};q.nextAt=now()+X_QUEUE_INTERVAL;q.phase='running';q.message='@'+job.url.slice(14)+' のプロフィールを確認中…';await save(q);await wake(q.active.deadline);
      try{const tab=await tabs.create({url:marked(q.active),active:false});if(!Number.isInteger(tab?.id))throw Error('tab');q.active.tabId=tab.id;await save(q);}
      catch{await finish(q,'failed','取得用タブを開けませんでした。');await wake(q.nextAt);}
      return q;
    }
    q.phase=q.items.length?'paused':'complete';await save(q);await alarms.clear(X_QUEUE_ALARM);return q;
  }
  return {
    enqueue:(targets,{single=false}={})=>serial(async()=>{
      if(!await allowed())throw Error('収集設定でXの取得を有効にし、Xへの接続を許可してください。');
      let q=await read();if(!q.active&&!q.items.length){const prior=q;q={...empty(),nextAt:prior.nextAt,retryAt:prior.retryAt};}
      const unique=[...new Set(targets.map(v=>xProfileURL(v.url)).filter(Boolean))];let added=0;
      for(const url of single?[...unique].reverse():unique){if(q.active?.url===url)continue;const existing=q.items.findIndex(j=>j.url===url);
        if(existing>=0){if(single){const [j]=q.items.splice(existing,1);q.items.unshift({...j,single:true});}continue;}
        if(q.items.length>=LIMIT)throw Error('取得待ちが上限に達しています。完了後にもう一度実行してください。');
        const job={url,single};if(single)q.items.unshift(job);else q.items.push(job);q.total++;added++;
      }
      if(!single&&q.retryAt<=now()){q.paused=false;q.consecutiveFailures=0;}await save(q);await run(q);return {ok:true,added,queue:q};
    }),
    tick:()=>serial(async()=>{const q=await read();if(q.active||q.items.length)return run(q);await alarms.clear(X_QUEUE_ALARM);return q;}),
    observed:(url,tabId)=>serial(async()=>{const q=await read();if(q.active?.url===url&&q.active.tabId===tabId){await finish(q,'success','@'+url.slice(14)+' を更新しました。');return run(q);}const index=q.items.findIndex(j=>j.url===url);if(index>=0){q.items.splice(index,1);q.success++;q.message='@'+url.slice(14)+' を開いたタブから更新しました。';await save(q);return run(q);}}),
    blocked:(tabId,reason)=>serial(async()=>{const q=await read();if(q.active?.tabId!==tabId)return;await stop(q,reason==='rate-limit'?'Xの利用制限を検出したため停止しました。時間を空けて再開してください。':'Xでログインまたは確認操作が必要です。取得用タブを確認してください。',{keep:true,retryAt:reason==='rate-limit'?now()+60000:0});}),
    pause:()=>serial(async()=>{const q=await read();await stop(q,'取得を停止しました。未処理のプロフィールは再開時に続けます。');return {ok:true};}),
    resume:()=>serial(async()=>{const q=await read();if(q.retryAt>now())throw Error('Xの制限による待機中です。1分以上空けて再開してください。');q.paused=false;q.consecutiveFailures=0;await save(q);await run(q);return {ok:true};}),
    clear:()=>serial(async()=>{const q=await read();await save(empty());await alarms.clear(X_QUEUE_ALARM);await close(q.active);}),
    tabChanged:tabId=>serial(async()=>{const q=await read();if(q.active?.tabId===tabId)return run(q);})
  };
}
