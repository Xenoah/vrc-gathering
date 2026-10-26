import {readXCache,X_CACHE_TTL} from './x-profile.js';
import {xAccountId} from './x-follower-settings.js';

export const X_DISCOVERY_ALARM='vrc-x-friend-discovery';
const empty=()=>({schema:1,id:'',accountId:'',phase:'idle',paused:false,initialized:false,items:[],eligible:[],targets:null,cursor:0,total:0,checked:0,withLinks:0,withoutLinks:0,failed:0,skipped:0,errors:[],nextAt:0,current:'',message:''});
// The current item stays pending until its result is saved. Restarts can reuse a
// profile already written by the previous worker; delivery receipts avoid duplicate X jobs.
export function createFriendDiscovery({storage,alarms,allowed,roster,profiles,lookup,targets,deliver,now=()=>Date.now(),uuid=()=>crypto.randomUUID()}){
  let chain=Promise.resolve(),controller,epoch=0;
  const serial=work=>{const next=chain.then(work);chain=next.catch(()=>{});return next;};
  const read=async()=>{const q=(await storage.get('xFriendScan')).xFriendScan;return q?.schema===1?{...empty(),...q}:empty();};
  const save=q=>storage.set({xFriendScan:{...q,updatedAt:now()}});
  const wake=at=>alarms.create(X_DISCOVERY_ALARM,{when:Math.max(now()+1000,at||now()+30000)});
  async function pauseState(q,message){q.paused=true;q.phase='paused';q.current='';q.message=message;await save(q);await alarms.clear(X_DISCOVERY_ALARM);return q;}
  async function tick(){
    const q=await read();if(!q.accountId||q.paused||q.phase==='complete'){await alarms.clear(X_DISCOVERY_ALARM);return q;}
    await wake(now()+90000);const ticket=epoch;controller=new AbortController();const signal=controller.signal,live=()=>ticket===epoch&&!signal.aborted;
    try{
      if(!await allowed())return pauseState(q,'Xの取得設定・接続権限を確認して再開してください。');
      if(q.nextAt>now()){await wake(q.nextAt);return q;}
      if(!q.initialized){
        q.phase='running';q.message='VRChatの全フレンド名簿を確認中…';await save(q);
        const result=await roster(q.accountId,signal);if(!live())return;
        if(result.busy){q.phase='waiting';q.message='ほかのVRChat収集の完了を待っています。';await save(q);await wake();return q;}
        if(!result.ok)return pauseState(q,result.error||'名簿を確認できませんでした。');
        const ids=[...new Set(result.ids.filter(xAccountId))],cache=await profiles();if(!live())return;q.total=ids.length;
        const missing=[];for(const userId of ids){const p=readXCache(cache,q.accountId,userId,now());
          if(p&&now()-p.checkedAt<X_CACHE_TTL){q.checked++;if(p.urls.length){q.withLinks++;q.eligible.push(userId);}else q.withoutLinks++;}
          else missing.push({userId,checkedAt:p?.checkedAt||0,attempts:0});
        }
        q.items=missing.sort((a,b)=>a.checkedAt-b.checkedAt||a.userId.localeCompare(b.userId));q.initialized=true;await save(q);
      }
      for(let n=0;n<10&&q.items.length&&live();n++){
        const job=q.items[0];q.current=job.userId;q.phase='running';q.message='フレンドのXリンクを確認中…';await save(q);await wake(now()+90000);
        const result=await lookup(q.accountId,job.userId,signal);if(!live())return;
        if(result.busy){q.phase='waiting';q.message='ほかのVRChat収集の完了を待っています。';break;}
        if(!result.ok&&[401,403,429].includes(result.status))return pauseState(q,result.error);
        q.items.shift();q.current='';
        if(result.ok){q.checked++;if(result.skipped)q.skipped++;else if(result.profile?.urls?.length){q.withLinks++;q.eligible.push(job.userId);}else q.withoutLinks++;}
        else if(job.attempts<1){q.items.push({...job,attempts:job.attempts+1});}
        else{q.checked++;q.failed++;q.errors.push({userId:job.userId,message:result.error||'取得できませんでした。'});}
        await save(q);
      }
      if(!live())return;
      if(q.items.length){q.phase='waiting';q.current='';q.nextAt=now()+1000;await save(q);await wake(q.nextAt);return q;}
      if(!q.targets){q.targets=await targets(q.accountId,q.eligible);if(!live())return;q.phase='handoff';q.message='見つかったXプロフィールを取得待ちに追加中…';await save(q);}
      // Bounded chunks also allow queues larger than the X tab queue's capacity.
      for(let n=0;n<10&&q.cursor<q.targets.length&&live();n++){
        const part=q.targets.slice(q.cursor,q.cursor+100),result=await deliver(part,q.id+':'+q.cursor);if(!live())return;
        if(result.full){q.message='Xの取得待ちが減るのを待っています。';q.nextAt=now()+30000;await save(q);await wake(q.nextAt);return q;}
        if(result.paused)return pauseState(q,result.message||'X側の取得が停止しています。確認して再開してください。');
        q.cursor+=part.length;await save(q);
      }
      if(q.cursor<q.targets.length){await wake();return q;}
      q.phase='complete';q.current='';q.message=`リンク確認が完了しました。X ${q.targets.length}件を取得待ちに追加しました。`;await save(q);await alarms.clear(X_DISCOVERY_ALARM);return q;
    }catch(error){if(live()){q.phase='waiting';q.message='一時的なエラーのため再試行します。';q.nextAt=now()+60000;await save(q);await wake(q.nextAt);}}
    finally{if(ticket===epoch)controller=null;}
  }
  return {
    tick:()=>serial(tick),
    start:accountId=>serial(async()=>{
      if(!xAccountId(accountId))throw Error('表示アカウントを選択してください。');
      if(!await allowed())throw Error('Xの取得を有効にし、接続を許可してください。');
      const old=await read();if(old.accountId&&old.phase!=='complete'&&old.phase!=='idle'){
        if(old.accountId!==accountId)throw Error('別アカウントのフレンド確認が残っています。先に完了するか取得待ちをリセットしてください。');
        old.paused=false;old.phase='waiting';old.nextAt=now();await save(old);await wake(now());return {ok:true,scan:old};
      }
      const q={...empty(),accountId,id:uuid(),phase:'waiting',message:'全フレンドのXリンク確認を開始します。'};await save(q);await wake(now());return {ok:true,scan:q};
    }),
    pause:(message='フレンドのXリンク確認を停止しました。再開時は残りを処理します。')=>{epoch++;controller?.abort();return serial(async()=>{const q=await read();return !q.accountId||q.phase==='complete'?q:pauseState(q,message);});},
    resume:()=>serial(async()=>{const q=await read();if(!q.accountId||q.phase==='complete')return {ok:true};if(!await allowed())throw Error('Xの取得設定・接続権限を確認してください。');q.paused=false;q.phase='waiting';q.nextAt=now();await save(q);await wake(now());return {ok:true};}),
    clear:()=>{epoch++;controller?.abort();return serial(async()=>{await save(empty());await alarms.clear(X_DISCOVERY_ALARM);});}
  };
}
