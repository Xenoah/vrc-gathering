import {xProfileURL} from './x-profile.js';
import {followerText} from './x-followers.js';

export function createXProfileView({node,date,request,isOpen,getFollower=()=>null,followersEnabled=()=>false,enableFollowers=async()=>{},getQueue=()=>({})}) {
  let generation=0,timer,refresh=()=>{};
  function cancel(){generation++;clearTimeout(timer);}
  function show(holder,accountId,userId,{demo=false}={}) {
    cancel();const token=generation;
    const links=node('div',null,'x-profile-links'),status=node('p','公開プロフィールを確認中…','sub x-link-status'),button=node('button','Xリンクを更新');button.type='button';
    const followerButton=node('button','フォロワー数を更新'),followerStatus=node('p','','sub x-follower-status');followerButton.type='button';followerButton.hidden=true;let autoQueued=false;
    holder.replaceChildren(links,status,button,followerButton,followerStatus);
    const current=()=>token===generation && isOpen() && holder.isConnected;
    let rendered=[];
    refresh=()=>{if(!current())return;const q=getQueue();if(rendered.some(r=>r.url===q.active?.url))followerStatus.textContent='別タブでフォロワー数を確認中…';else if(rendered.some(r=>q.items?.some(j=>j.url===r.url)))followerStatus.textContent=q.phase==='paused'?'取得は停止中です。一覧の「再開」で続けられます。':'フォロワー数の更新待ちです。';else if(autoQueued&&rendered.some(r=>getFollower(accountId,r.url)))followerStatus.textContent='取得日時を付けて保存しています。';for(const {url,count} of rendered){const metric=getFollower(accountId,url);count.textContent='フォロワー：'+followerText(metric)+(metric?' · 確認 '+date(metric.observedAt):'');}};
    function display(entry) {
      if(!entry)return;
      links.replaceChildren();rendered=[];
      for(const candidate of entry.urls||[]) {const url=xProfileURL(candidate);if(!url)continue;const row=node('div',null,'x-profile-row'),link=node('a','X（Twitter） @'+url.split('/').at(-1)+' ↗'),count=node('span',null,'sub follower-count');link.href=url;link.target='_blank';link.rel='noopener noreferrer';row.append(link,count);links.append(row);rendered.push({url,count});}
      followerButton.hidden=!rendered.length;refresh();
      status.textContent=(links.childElementCount?'公開プロフィールのリンク · ':'公開プロフィールにXリンクは見つかりませんでした · ')+'確認 '+date(entry.checkedAt);
      if(rendered.length)status.textContent+=followersEnabled()?'。このユーザーのフォロワー数を別タブで更新します。':'。フォロワー数を取得するには、収集設定の「Xのフォロワー数」を有効にしてください。';
    }
    async function updateFollowers(force=false){if(!current()||!rendered.length)return;followerButton.disabled=true;autoQueued=true;try{if(force)await enableFollowers();if(!current()||!followersEnabled())return;const result=await request({type:'COLLECT_X_FOLLOWERS',accountId,userId,force});if(!current())return;if(!result?.ok)throw Error(result?.error||'取得を開始できませんでした。');followerStatus.textContent=result.skipped?(result.reason==='fresh'?'直近1分に確認済みです。':'取得対象のXリンクがありません。'):'別タブで順次更新します。';refresh();}catch(error){if(current())followerStatus.textContent=error.message;}finally{if(current())followerButton.disabled=false;}}
    followerButton.addEventListener('click',()=>void updateFollowers(true));
    async function load(force=false,attempt=0) {
      if(!current())return;button.disabled=true;
      try {
        const result=await request({type:'X_PROFILE',accountId,userId,force});
        if(!current())return;
        display(result?.profile);
        if(rendered.length&&followersEnabled()&&!autoQueued)void updateFollowers();
        if(!result?.ok)throw Error(result?.error||'プロフィールを取得できませんでした。');
        if(result.cached && force)status.textContent+='（直近の確認結果を表示）';
        if(result.busy){status.textContent='収集処理が終わるのを待っています…';if(attempt<24)timer=setTimeout(()=>load(force,attempt+1),5000);else status.textContent='収集が完了してから「Xリンクを更新」を押してください。';}
      } catch(error) {if(current())status.textContent=error.message;}
      finally {if(current())button.disabled=false;}
    }
    button.addEventListener('click',()=>{clearTimeout(timer);status.textContent='公開プロフィールを確認中…';void load(true);});
    if(demo){status.textContent='デモではプロフィールを取得しません。';button.disabled=true;followerButton.disabled=true;followerButton.hidden=true;}
    else void load();
  }
  return {show,cancel,refresh:()=>refresh()};
}
