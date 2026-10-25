import { readXCache, xProfileURL } from './x-profile.js';
import { followerRecords } from './x-followers.js';
import {DEFAULT_X_CONCURRENCY,xConcurrency} from './x-follower-settings.js';

export const X_QUEUE_ALARM='vrc-x-follower-queue';
export const X_QUEUE_INTERVAL=15000;
export const X_QUEUE_TIMEOUT=60000;
export const X_QUEUE_CONCURRENCY=DEFAULT_X_CONCURRENCY;
const LIMIT=10000;
export function followerTargets(profiles,metrics,accountId,userIds,now=Date.now()){
  const allowed=new Set(userIds),seen=new Set(),values=new Map(followerRecords(metrics,now).filter(r=>r.value.accountId===accountId).map(r=>[r.value.url,r.value]));
  for(const entry of Object.values(profiles||{})){
    const profile=readXCache(profiles,accountId,entry?.userId,now);
    if(profile&&allowed.has(profile.userId))for(const url of profile.urls)seen.add(url);
  }
  return [...seen].map(url=>({url,observedAt:values.get(url)?.observedAt||0,accounts:[accountId]})).sort((a,b)=>a.observedAt-b.observedAt||a.url.localeCompare(b.url));
}
export const activeFollowerJobs=q=>Array.isArray(q?.active)?q.active:q?.active?[q.active]:[];
const empty=()=>({schema:2,items:[],active:[],done:[],errors:[],retries:0,concurrency:DEFAULT_X_CONCURRENCY,paused:false,phase:'idle',total:0,success:0,failed:0,skipped:0,consecutiveFailures:0,nextAt:0,retryAt:0,message:'',updatedAt:0});
const timestamp=value=>Number.isSafeInteger(value)&&value>0?value:0;
// Missing counts always precede refreshes, including requests from a user detail.
// Interrupted attempts go behind untouched jobs in the same group.
const priority=(a,b)=>Number(!!a.observedAt)-Number(!!b.observedAt)||Number(!!a.attemptedAt)-Number(!!b.attemptedAt)||(a.observedAt||0)-(b.observedAt||0)||Number(!!b.single)-Number(!!a.single)||a.url.localeCompare(b.url);
// Every operation is serialized and the queue is persisted before opening a tab.
// Alarms wake suspended MV3 workers; no queue state relies on a long-lived timer.
export function createFollowerCollector({storage,tabs,alarms,allowed,isKnown,latest=async()=>({}),concurrency=async()=>DEFAULT_X_CONCURRENCY,now=()=>Date.now(),uuid=()=>crypto.randomUUID()}){
  let chain=Promise.resolve();
  const serial=work=>{const next=chain.then(work);chain=next.catch(()=>{});return next;};
  async function read(){
    const raw=(await storage.get('xFollowerQueue')).xFollowerQueue;
    if(![1,2].includes(raw?.schema))return empty();
    const seen=new Set(),valid=j=>j&&xProfileURL(j.url)===j.url&&!seen.has(j.url)&&seen.add(j.url);
    const active=activeFollowerJobs(raw).filter(valid),items=(raw.items||[]).filter(valid).slice(0,LIMIT);
    return {...empty(),...raw,schema:2,active,items,errors:(raw.errors||[]).filter(e=>xProfileURL(e.url)===e.url).slice(-LIMIT),done:[...new Set((raw.done||[]).filter(url=>xProfileURL(url)===url))].slice(-LIMIT)};
  }
  const save=q=>storage.set({xFollowerQueue:{...q,updatedAt:now()}});
  const wake=at=>alarms.create(X_QUEUE_ALARM,{when:Math.max(now()+1000,at)});
  const marked=a=>a.url+'#vrc-gathering='+a.token;
  function owns(tab,a){return (tab?.pendingUrl||tab?.url)===marked(a);}
  async function close(a){if(!Number.isInteger(a?.tabId))return;try{const tab=await tabs.get(a.tabId);if(owns(tab,a)&&!tab.active&&!tab.pinned)await tabs.remove(a.tabId);}catch{}}
  function complete(q,job,outcome){
    q.active=q.active.filter(a=>a.url!==job.url);q.items=q.items.filter(a=>a.url!==job.url);
    q.done=[...new Set([...q.done,job.url])].slice(-LIMIT);q[outcome]++;
    if(outcome==='success')q.errors=q.errors.filter(e=>e.url!==job.url);
    q.consecutiveFailures=outcome==='failed'?q.consecutiveFailures+1:0;
  }
  async function stop(q,message,{keepTabId=null,retryAt=0}={}){
    const active=q.active;q.active=[];
    q.items=[...q.items,...active.map(a=>({url:a.url,accounts:a.accounts,observedAt:a.observedAt,requestedAt:a.requestedAt,attemptedAt:now()}))].map(j=>({...j,single:false}));
    q.items.sort(priority);q.paused=true;q.phase='paused';q.message=message;q.retryAt=Math.max(q.retryAt||0,retryAt);
    await save(q);await alarms.clear(X_QUEUE_ALARM);
    for(const a of active)if(a.tabId!==keepTabId)await close(a);
  }
  async function finish(q,job,outcome,message){
    complete(q,job,outcome);q.message=message;
    if(outcome==='failed')q.errors=[...q.errors.filter(e=>e.url!==job.url),{url:job.url,message,at:now()}].slice(-LIMIT);
    await save(q);await close(job);
  }
  async function retryOrFinish(q,job,message){
    if((job.attempts||1)>=2)return finish(q,job,'failed',message);
    const {token,tabId,startedAt,deadline,...pending}=job;
    q.active=q.active.filter(a=>a.url!==job.url);q.items.push({...pending,attempts:job.attempts||1,attemptedAt:now()});
    q.retries=(q.retries||0)+1;q.message=message+' 未着手の対象を先に処理してから再試行します。';
    await save(q);await close(job);
  }
  const runnable=(q,j)=>!q.paused||j.single;
  async function schedule(q){
    const pending=q.items.some(j=>runnable(q,j));
    q.phase=q.active.length?'running':pending?'waiting':q.items.length?'paused':'complete';
    if(q.phase==='complete')q.message=q.failed?`全対象の処理が完了しました。${q.failed}件は数値を確認できませんでした。未確認一覧を参照してください。`:'全対象の取得が完了しました。';
    await save(q);
    const times=q.active.map(a=>a.deadline);
    if(pending&&q.active.length<q.concurrency)times.push(q.nextAt);
    if(times.length)await wake(Math.min(...times));else await alarms.clear(X_QUEUE_ALARM);
    return q;
  }
  async function run(q){
    // Keep a recovery alarm even if the worker stops or an awaited operation fails.
    if(q.active.length||q.items.some(j=>runnable(q,j)))await wake(now()+X_QUEUE_TIMEOUT);
    q.concurrency=xConcurrency(await concurrency());
    if(!await allowed()){await stop(q,'Xの取得設定または接続権限が無効です。');return q;}
    for(const a of [...q.active]){let tab;
      if(a.tabId==null){
        // Recover a tab created just before worker termination without touching existing user tabs.
        const matches=await tabs.query({url:'https://x.com/*'});tab=matches.find(t=>owns(t,a));if(tab){a.tabId=tab.id;await save(q);}
        else {q.active=q.active.filter(j=>j!==a);const {token,tabId,startedAt,deadline,...job}=a;q.items.push(job);await save(q);continue;}
      }else try{tab=await tabs.get(a.tabId);}catch{}
      if(q.active.includes(a)){
        if(!tab){await finish(q,a,'failed','@'+a.url.slice(14)+'：取得用タブが閉じられました。残りを続けます。');continue;}
        const destination=tab.pendingUrl||tab.url||'';
        if(/^https:\/\/x\.com\/(?:i\/flow\/login|login|account\/access)(?:[/?#]|$)/i.test(destination)){await stop(q,'Xでログインまたはアカウントの確認が必要です。取得用タブを確認し、完了後に再開してください。',{keepTabId:a.tabId});return q;}
        if(destination&&destination!=='about:blank'&&!owns(tab,a)&&xProfileURL(destination)!==a.url){await finish(q,a,'failed','@'+a.url.slice(14)+'：別ページへの移動を検出しました。残りを続けます。');continue;}
        if(now()>=a.deadline)await retryOrFinish(q,a,'@'+a.url.slice(14)+'：表示から数値を確認できませんでした。以前の値を保持します。');
        else if(tab.status==='complete')void tabs.sendMessage(a.tabId,{type:'X_FOLLOWERS_READ'}).catch(()=>{});
      }
    }
    if(q.retryAt>now()){q.phase='paused';q.paused=true;q.message='Xの制限を検出しました。'+new Date(q.retryAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+'（JST）'+' 以降に再開してください。';await save(q);return q;}
    if(q.nextAt>now()||q.active.length>=q.concurrency)return schedule(q);
    // Refresh timestamps at dispatch: a manual tab or Sheets sync may have supplied a count.
    const observations=await latest(q.items);
    for(const job of [...q.items]){
      job.observedAt=timestamp(Object.hasOwn(observations,job.url)?observations[job.url]:job.observedAt);
      if(job.requestedAt&&job.observedAt>job.requestedAt)complete(q,job,'success');
    }
    q.items.sort(priority);
    let index=q.items.findIndex(j=>runnable(q,j)),started=false;
    // Removed links are skipped; they do not become arbitrary browsing targets.
    while(index>=0&&q.active.length<q.concurrency){
      const [job]=q.items.splice(index,1);
      if(!await isKnown(job.url)){complete(q,job,'skipped');index=q.items.findIndex(j=>runnable(q,j));continue;}
      const a={...job,attempts:(job.attempts||0)+1,token:uuid(),tabId:null,startedAt:now(),deadline:now()+X_QUEUE_TIMEOUT};q.active.push(a);
      if(!started){q.nextAt=now()+X_QUEUE_INTERVAL;started=true;}
      q.phase='running';q.message='@'+job.url.slice(14)+' のプロフィールを確認中…';await save(q);await wake(a.deadline);
      try{const tab=await tabs.create({url:marked(a),active:false});if(!Number.isInteger(tab?.id))throw Error('tab');a.tabId=tab.id;await save(q);}
      catch{await retryOrFinish(q,a,'@'+job.url.slice(14)+'：取得用タブを開けませんでした。');break;}
      index=q.items.findIndex(j=>runnable(q,j));
    }
    return schedule(q);
  }
  return {
    enqueue:(targets,{single=false,force=false}={})=>serial(async()=>{
      if(!await allowed())throw Error('収集設定でXの取得を有効にし、Xへの接続を許可してください。');
      let q=await read();if(!q.active.length&&!q.items.length){const prior=q;q={...empty(),nextAt:prior.nextAt,retryAt:prior.retryAt};}
      const unique=new Map();for(const v of targets){const url=xProfileURL(v.url);if(url){const old=unique.get(url);unique.set(url,{observedAt:old?Math.min(old.observedAt,timestamp(v.observedAt)):timestamp(v.observedAt),accounts:[...new Set([...(old?.accounts||[]),...(v.accounts||[])])]});}}let added=0;
      for(const [url,{observedAt,accounts}] of unique){const existing=q.active.find(j=>j.url===url)||q.items.find(j=>j.url===url);
        if(existing){existing.accounts=[...new Set([...(existing.accounts||[]),...accounts])];existing.observedAt=Math.min(timestamp(existing.observedAt),observedAt);if(single)existing.single=true;continue;}
        if(q.done.includes(url)&&!(single&&force))continue;
        if(q.items.length>=LIMIT)throw Error('取得待ちが上限に達しています。完了後にもう一度実行してください。');
        q.done=q.done.filter(v=>v!==url);q.items.push({url,single,accounts,observedAt,requestedAt:now()});q.total++;added++;
      }
      if(!single&&q.retryAt<=now()){q.paused=false;q.consecutiveFailures=0;}await save(q);await run(q);return {ok:true,added,queue:q};
    }),
    tick:()=>serial(async()=>{const q=await read();if(q.active.length||q.items.length)return run(q);await alarms.clear(X_QUEUE_ALARM);return q;}),
    observed:(url,tabId)=>serial(async()=>{const q=await read(),job=q.active.find(j=>j.url===url)||q.items.find(j=>j.url===url);if(job){await finish(q,job,'success','@'+url.slice(14)+' を更新しました。');return run(q);}}),
    blocked:(tabId,reason)=>serial(async()=>{const q=await read();if(!q.active.some(j=>j.tabId===tabId))return;await stop(q,reason==='rate-limit'?'Xの利用制限を検出したため停止しました。時間を空けて再開してください。':'Xでログインまたは確認操作が必要です。取得用タブを確認してください。',{keepTabId:tabId,retryAt:reason==='rate-limit'?now()+60000:0});}),
    pause:()=>serial(async()=>{const q=await read();await stop(q,'取得を停止しました。未処理のプロフィールは再開時に続けます。');return {ok:true};}),
    resume:()=>serial(async()=>{const q=await read();if(q.retryAt>now())throw Error('Xの制限による待機中です。1分以上空けて再開してください。');q.paused=false;q.consecutiveFailures=0;await save(q);await run(q);return {ok:true};}),
    clear:()=>serial(async()=>{const q=await read();await save(empty());await alarms.clear(X_QUEUE_ALARM);for(const a of q.active)await close(a);}),
    tabChanged:tabId=>serial(async()=>{const q=await read();if(q.active.some(j=>j.tabId===tabId))return run(q);})
  };
}
