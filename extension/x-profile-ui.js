import {xProfileURL} from './x-profile.js';

export function createXProfileView({node,date,request,isOpen}) {
  let generation=0,timer;
  function cancel(){generation++;clearTimeout(timer);}
  function show(holder,accountId,userId,{demo=false}={}) {
    cancel();const token=generation;
    const links=node('div',null,'x-profile-links'),status=node('p','公開プロフィールを確認中…','sub'),button=node('button','Xリンクを更新');button.type='button';
    holder.replaceChildren(links,status,button);
    const current=()=>token===generation && isOpen() && holder.isConnected;
    function display(entry) {
      if(!entry)return;
      links.replaceChildren();
      for(const candidate of entry.urls||[]) {const url=xProfileURL(candidate);if(!url)continue;const link=node('a','X（Twitter） @'+url.split('/').at(-1)+' ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';links.append(link);}
      status.textContent=(links.childElementCount?'公開プロフィールのリンク · ':'公開プロフィールにXリンクは見つかりませんでした · ')+'確認 '+date(entry.checkedAt);
    }
    async function load(force=false,attempt=0) {
      if(!current())return;button.disabled=true;
      try {
        const result=await request({type:'X_PROFILE',accountId,userId,force});
        if(!current())return;
        display(result?.profile);
        if(!result?.ok)throw Error(result?.error||'プロフィールを取得できませんでした。');
        if(result.cached && force)status.textContent+='（直近の確認結果を表示）';
        if(result.busy){status.textContent='収集処理が終わるのを待っています…';if(attempt<24)timer=setTimeout(()=>load(force,attempt+1),5000);else status.textContent='収集が完了してから「Xリンクを更新」を押してください。';}
      } catch(error) {if(current())status.textContent=error.message;}
      finally {if(current())button.disabled=false;}
    }
    button.addEventListener('click',()=>{clearTimeout(timer);status.textContent='公開プロフィールを確認中…';void load(true);});
    if(demo){status.textContent='デモではプロフィールを取得しません。';button.disabled=true;}
    else void load();
  }
  return {show,cancel};
}
