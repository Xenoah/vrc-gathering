export function createUserNotesView({root,request,isOpen,sync=async()=>{}}) {
  const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;};
  const heading=el('div',null,'user-notes-heading'),title=el('h3','公式ユーザーノート'),button=el('button','公式ノートを再取得'),link=el('a','VRChatで編集 ↗');button.type='button';button.id='refreshUserNote';link.target='_blank';link.rel='noopener noreferrer';
  heading.append(title,button,link);const intro=el('p','VRChat公式プロフィールのノートを記録します。編集は公式サイトで行い、変更後に再取得してください。','muted'),body=el('p','未取得','user-note-text'),status=el('p','','user-note-status'),history=el('details'),summary=el('summary','ノートの変更履歴'),rows=el('div',null,'user-note-history'),more=el('button','さらに50件表示');body.id='userNoteText';status.id='userNoteStatus';status.setAttribute('role','status');more.type='button';more.hidden=true;history.append(summary,el('p','端末の保存期間内の履歴です。日時は編集時刻ではなく、拡張が内容を確認した時刻です。','muted'),rows,more);root.append(heading,intro,body,status,history);
  const date=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  let generation=0,timer,active=null,limit=50,entries=[],signature='',displayedAt=0;
  const current=ticket=>ticket===generation&&isOpen()&&root.isConnected;
  function display(result){
    if((result.record?.observedAt||0)<displayedAt)return;displayedAt=result.record?.observedAt||0;
    if(result.record)body.textContent=result.record.note||'公式ノートは未設定です（確認済み）。';else body.textContent='公式ノートはまだ取得していません。';
    const next=JSON.stringify(result.history||[]);entries=result.history||[];
    if(next!==signature){signature=next;renderHistory();}
  }
  function renderHistory(){rows.replaceChildren();summary.textContent=`ノートの変更履歴（${entries.length}件）`;for(const item of entries.slice(0,limit)){const row=el('article');row.append(el('p',date.format(item.changedAt)+' JST に確認','sub'),el('p',item.note||'公式ノートが空であることを確認','user-note-text'));rows.append(row);}if(!entries.length)rows.append(el('p','変更履歴はまだありません。','muted'));more.hidden=entries.length<=limit;}
  more.onclick=()=>{limit+=50;renderHistory();};
  async function load(force=false,attempt=0){const ticket=generation,owner=active;if(!owner||!current(ticket)||owner.demo)return;clearTimeout(timer);button.disabled=true;status.textContent='公式ノートを確認中…';
    try{
      const result=await request({type:'USER_NOTE',...owner,force});if(!current(ticket))return;
      if(result?.record!==undefined)display(result);
      if(!result?.ok)throw Error(result?.error||'公式ノートを取得できませんでした。');
      if(result.busy){status.textContent='収集・プロフィール取得の完了を待っています…';if(attempt<24)timer=setTimeout(()=>load(force,attempt+1),5000);else status.textContent='収集の完了後に「公式ノートを再取得」を押してください。';}
      else status.textContent=(result.cached?'保存済みの確認結果':'公式ノートを確認しました')+(result.checkedAt?' · '+date.format(result.checkedAt)+' JST':'')+(force&&result.cached?'（直近1分の確認を再利用）':'');
    }catch(error){if(current(ticket))status.textContent=error.message;}
    finally{if(current(ticket))button.disabled=false;}
  }
  async function stored(){const ticket=generation,owner=active;if(!owner||owner.demo||!current(ticket))return;try{const result=await request({type:'USER_NOTE',...owner,readOnly:true});if(current(ticket)&&result?.ok&&result.record!==undefined)display(result);}catch{}}
  button.onclick=()=>void load(true);
  return {show(accountId,userId,{demo=false}={}){generation++;clearTimeout(timer);active={accountId,userId,demo};limit=50;signature='';entries=[];displayedAt=0;body.textContent='保存済みの公式ノートを読み込み中…';status.textContent='';renderHistory();history.open=false;link.href='https://vrchat.com/home/user/'+encodeURIComponent(userId);button.disabled=demo;
      if(demo){body.textContent='デモでは公式ノートを取得しません。';return;}
      const ticket=generation;void stored().finally(()=>{if(current(ticket))void load();});void sync();
    },refresh(accountId){if(active?.accountId===accountId)void stored();},cancel(){generation++;clearTimeout(timer);active=null;}
  };
}
