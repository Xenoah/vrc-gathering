import { createLogParser, logSourceId, summarizeLogEncounters, logDuration } from './game-log.js';
import { readResearch } from './db.js';
import { csv } from './core.js';
import { canonical, normalizeRecord, mergeRecord } from './sync-format.js';

const MAX_FILE=128*1024*1024;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const date=n=>n?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'short',timeStyle:'medium'}).format(n):'—';
async function sourceSetting(value){
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('vrc-game-log-inputs',1);r.onupgradeneeded=()=>r.result.createObjectStore('settings');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction('settings',value===undefined?'readonly':'readwrite'),store=tx.objectStore('settings'),r=value===undefined?store.get('source'):value===null?store.delete('source'):store.put(value,'source');let out;r.onsuccess=()=>{out=r.result;};tx.oncomplete=()=>resolve(out);tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}

export function createGameLogView({root,request,download,isDemo=false}){
  root.innerHTML=`<div class="intelligence-heading"><div><h2>全ユーザーの同席記録</h2><p>In Instanceの参加者一覧と、自分の参加・退出ログから同席を集計します。</p></div></div>
  <div class="log-inputs"><p><strong>In Instanceの自動収集</strong>：通常の収集と一緒に、自分の現在地についてAPIが返す参加者を記録します。非フレンドも対象です。Chromeで収集が動いている必要があります。</p><p id="instanceCollectionStatus" role="status"></p>
    <div class="log-actions"><button id="chooseLogFolder">ログフォルダーを選択</button><button id="resumeLogWatch">監視を再開</button><button id="stopLogWatch">監視を停止</button><button id="chooseLogFiles">ログファイルを取り込む</button><input id="logFiles" type="file" accept=".txt,.log" multiple hidden></div>
    <div class="log-actions"><label>形式 <select id="logFormat"><option value="pc">PC版のログ</option><option value="logcat">Quest／Androidのlogcat（取り込みのみ・実験）</option></select></label><label>PCログの時差（UTCからの分） <input id="logOffset" type="number" min="-840" max="840" step="15" value="540"></label></div>
    <label class="check-label"><input id="logOwnerConfirmed" type="checkbox">表示中のアカウントでプレイしたログです</label><p id="logImportStatus" role="status"></p>
    <details><summary>PC版の設定・Quest単体の制限</summary><ol><li>ダウンロードした拡張の <code>windows/Watch-VRChatLogs.ps1</code> をPowerShellで実行します。必要な参加・退出情報だけをドキュメント内の <code>VRCFriendsObserverLogs</code> にコピーします。<a href="setup/Watch-VRChatLogs.ps1" download="Watch-VRChatLogs.ps1">スクリプトを保存</a></li><li>「ログフォルダーを選択」で、そのフォルダーを選びます。ログの本人と表示アカウントが一致していることを確認してください。</li><li>この画面を開いている間は約15秒ごとに更新します。閉じていた間も、残っているログから後で取り込めます。元の <code>AppData/LocalLow/VRChat/VRChat/output_log_*.txt</code> をファイル選択で取り込むこともできます。</li></ol><p>QuestをPCに接続してPC版を遊ぶ場合はPCログを使います。Questで遊んでいる間も、別のPCでChromeの収集が動き、現在地と参加者一覧をAPIから取得できれば同席を観測できます。Quest単体のログ自動取得は未対応です。参加・退出とワールドIDを含むlogcatが取得できた環境のみ、epoch形式のファイルを取り込めます。PCを停止している間はこの拡張も収集しません。APIが全員の一覧を返すことは保証できません。</p><p>ログ本文・会話・画像は保存・送信しません。同席のユーザーID、表示名、場所、時刻だけを保存します。IDがない古いログは「ID未記録」とし、同名の別人を結び付けません。退出がない場合は最終ログまでを集計し、終了未確認と表示します。過去のSheets記録は「時系列・比較」で期間を指定して読み込むと、この集計にも反映されます（24時間キャッシュ）。</p></details>
  </div>
  <div class="log-filters"><label>期間 <select id="logRange"><option value="1">24時間</option><option value="7" selected>7日間</option><option value="30">30日間</option><option value="90">90日間</option><option value="0">保存済みすべて</option></select></label><label>対象 <select id="logRelation"><option value="all">全員</option><option value="nonfriend">現在の非フレンド</option><option value="friend">現在のフレンド</option><option value="unknown">ID未記録</option></select></label><label>記録元 <select id="logDevice"><option value="">すべて</option><option value="api">In Instance API</option><option value="pc">PCログ</option><option value="quest">Quest／Android</option></select></label><label>ワールド <select id="logWorld"><option value="">すべて</option></select></label><label>並べ替え <select id="logSort"><option value="duration">合計同席時間</option><option value="count">同席回数</option><option value="latest">最後の同席</option><option value="first">最初の同席</option><option value="name">名前</option></select></label><input id="logSearch" type="search" placeholder="ユーザー名・ID" aria-label="同席ユーザー検索"><button id="logSummaryCSV">集計CSV</button><button id="logSessionsCSV">区間CSV</button></div>
  <p id="logSummary" class="intelligence-summary" role="status"></p><div class="table-wrap"><table><thead><tr><th>ユーザー</th><th>現在の関係</th><th>同席回数</th><th>同席時間（観測・ログ）</th><th>最初の同席</th><th>最後の同席</th><th>ワールド数</th></tr></thead><tbody id="logBody"></tbody></table></div><button id="logMore" hidden>さらに100人表示</button><section id="logDetail" class="connections-detail" aria-live="polite"></section>`;
  const $=id=>root.querySelector('#'+id);
  let accountId='',friends=[],epoch=0,records=[],rows=[],selected='',limit=100,generation=0,loading=0,watch=null,watchTimer,busy=false,lastFiles=new Map();
  const status=text=>{$('logImportStatus').textContent=text;};
  const setBusy=value=>{busy=value;for(const id of ['chooseLogFolder','resumeLogWatch','chooseLogFiles'])$(id).disabled=value;};
  async function call(message){const r=await request(message);if(!r?.ok)throw Error(r?.error||'ログの保存に失敗しました。');return r;}
  function stop(message='監視を停止しました。'){generation++;clearTimeout(watchTimer);watchTimer=null;watch=null;status(message);}
  function context(){if(isDemo)throw Error('デモではログを取り込みません。');if(!accountId)throw Error('表示アカウントを選択してください。');if(!$('logOwnerConfirmed').checked)throw Error('ログの本人と表示アカウントが一致していることを確認してください。');return {accountId,format:$('logFormat').value,offsetMinutes:Number($('logOffset').value)};}
  async function parse(file,settings,ticket){
    if(file.size>MAX_FILE)throw Error(file.name+'：128MiBを超えています。');
    const firstLine=(await file.slice(0,8192).text()).split(/\r?\n/)[0].replace(/^\uFEFF/,'');
    const sourceId=await logSourceId(file.name,firstLine,settings.format),parser=createLogParser({...settings,sourceId}),reader=file.stream().getReader(),decoder=new TextDecoder();let rest='';
    try{for(;;){if(ticket!==generation)throw Error('ログの取り込みを中止しました。');const part=await reader.read();rest+=decoder.decode(part.value||new Uint8Array(),{stream:!part.done});const lines=rest.split('\n');rest=lines.pop();for(const line of lines)parser.feed(line.replace(/\r$/,'').replace(/^\uFEFF/,''));if(rest.length>65536)throw Error('ログの行が長すぎます。');if(part.done){if(rest&&!settings.handle)parser.feed(rest.replace(/\r$/,''));break;}await new Promise(resolve=>setTimeout(resolve,0));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return parser.finish();
  }
  async function importFiles(files,settings,ticket){
    if(busy)return;setBusy(true);let saved=0,matched=0,skipped=0,unverified=0,unidentified=0,open=0;const failures=[];
    try{
      const current=await call({type:'LOG_CONTEXT',accountId:settings.accountId});if(ticket!==generation)return;
      const existing=new Map((await readResearch(settings.accountId)).filter(r=>r.kind==='instanceEncounters').map(r=>[r.key,r]));
      for(const file of files){
        if(ticket!==generation)break;
        const stamp=file.size+':'+file.lastModified,key=settings.accountId+':'+settings.format+':'+settings.offsetMinutes+':'+file.name;
        if(lastFiles.get(key)===stamp){skipped++;continue;}
        status(file.name+' を読み込み中…');
        try{
          const result=await parse(file,settings,ticket);if(ticket!==generation)break;matched+=result.rows.length;if(!result.ownerVerified)unverified++;unidentified+=result.unidentified;open+=result.open;
          const changed=[];for(const value of result.rows){const r=normalizeRecord('instanceEncounters',value),old=existing.get(r.key),merged=mergeRecord(r,old);if(!old||canonical(old.value)!==canonical(merged.value)){changed.push(merged.value);existing.set(r.key,merged);}}
          for(let start=0;start<changed.length;start+=100){if(ticket!==generation)break;await call({type:'IMPORT_LOG_ENCOUNTERS',accountId:settings.accountId,epoch:current.epoch,records:changed.slice(start,start+100)});saved+=Math.min(100,changed.length-start);}
          if(ticket===generation)lastFiles.set(key,stamp);
        }catch(error){failures.push(file.name+'：'+error.message);}
      }
      if(ticket===generation){status(`同席 ${matched}区間／保存・更新 ${saved}件／変更なし ${skipped}ファイル${open?'／終了未確認 '+open+'区間':''}${unidentified?'／ID未記録 '+unidentified+'区間':''}${unverified?'／本人のIDをログで確認できない '+unverified+'ファイル（選択アカウントで保存）':''}${failures.length?'。'+failures.join(' / '):matched||skipped?'':'。参加・退出とワールドIDのあるログが見つかりません。'}`);await load();}
    }catch(error){if(ticket===generation)status(error.message);}finally{setBusy(false);}
  }
  async function poll(){
    const source=watch,ticket=generation;if(!source)return;if(busy){watchTimer=setTimeout(poll,1000);return;}
    try{
      if(accountId!==source.accountId||epoch!==source.epoch){stop('表示アカウントまたは保存状態が変わったため監視を停止しました。');return;}
      if(await source.handle.queryPermission({mode:'read'})!=='granted'){stop('フォルダーへのアクセス許可が必要です。「監視を再開」を押してください。');return;}
      const files=[];for await(const [name,handle] of source.handle.entries())if(handle.kind==='file'&&/^(?:output_log_|quest_log_).+\.txt$/i.test(name))files.push(await handle.getFile());
      files.sort((a,b)=>a.lastModified-b.lastModified);if(files.length>500)throw Error('対象が500ファイルを超えています。フォルダーを分けてください。');
      await importFiles(files,source,ticket);
    }catch(error){if(ticket===generation)stop(error.message);}
    finally{if(watch===source&&ticket===generation)watchTimer=setTimeout(poll,15000);}
  }
  $('chooseLogFolder').onclick=async()=>{try{const settings=context();if(!globalThis.showDirectoryPicker)throw Error('このブラウザーではフォルダー監視が使えません。ファイル取り込みを利用してください。');const handle=await showDirectoryPicker({id:'vrc-game-logs',mode:'read'});stop('監視を開始します。');watch={...settings,handle,epoch};await sourceSetting(watch);void poll();}catch(error){if(error.name!=='AbortError')status(error.message);}};
  $('resumeLogWatch').onclick=async()=>{try{const settings=context(),source=await sourceSetting();if(!source||source.accountId!==accountId||source.epoch!==epoch)throw Error('このアカウントのログフォルダーを選択してください。');if(await source.handle.requestPermission({mode:'read'})!=='granted')throw Error('フォルダーへのアクセスが許可されませんでした。');stop('監視を再開します。');watch={...source,...settings};void poll();}catch(error){status(error.message);}};
  $('stopLogWatch').onclick=()=>stop();
  for(const id of ['logFormat','logOffset','logOwnerConfirmed'])$(id).onchange=()=>stop('読み込み条件を変更しました。再開またはファイルを選択してください。');
  $('chooseLogFiles').onclick=()=>{try{context();$('logFiles').click();}catch(error){status(error.message);}};
  $('logFiles').onchange=async()=>{try{const settings=context();stop('ログを取り込みます。');const files=[...$('logFiles').files];$('logFiles').value='';await importFiles(files,settings,generation);}catch(error){status(error.message);}};
  function renderDetail(){const out=$('logDetail');out.replaceChildren();const row=rows.find(r=>r.id===selected);if(!row)return;out.append(el('h3',row.name+'との同席'));
    if(row.userId){const a=el('a','VRChatプロフィール ↗');a.href='https://vrchat.com/home/user/'+encodeURIComponent(row.userId);a.target='_blank';a.rel='noopener noreferrer';out.append(a,el('p',row.userId,'muted'));}
    const list=el('ol');for(const s of row.sessions.slice(0,200)){const r=s.records[0],item=el('li');item.append(el('strong',r.worldName||r.location.worldId),el('p',date(s.start)+' ～ '+date(s.end)+' JST · '+logDuration(s.end-s.start)+(s.records.some(v=>v.endedAt==null)?' · 終了未確認':'')),el('p',r.location.instanceId+' · '+[...new Set(s.records.map(v=>v.device==='api'?'In Instance API（観測区間）':v.device==='pc'?'PCログ':'Quest／Androidログ'))].join(' / '),'muted'));list.append(item);}out.append(list);}
  function render(){
    if(root.hidden)return;const since=Number($('logRange').value)?Date.now()-Number($('logRange').value)*86400000:0,worlds=new Map(records.map(r=>[r.location.worldId,r.worldName||r.location.worldId])),previous=$('logWorld').value;
    $('logWorld').replaceChildren(new Option('すべて',''),...[...worlds].map(([id,name])=>new Option(name,id)));if(worlds.has(previous))$('logWorld').value=previous;
    rows=summarizeLogEncounters(records,{accountId,since,friends,relation:$('logRelation').value,device:$('logDevice').value,worldId:$('logWorld').value,query:$('logSearch').value,sort:$('logSort').value});
    $('logSummary').textContent=`${rows.length}人 · ${rows.reduce((n,r)=>n+r.count,0)}同席区間 · 合計 ${logDuration(rows.reduce((n,r)=>n+r.duration,0))}（相手ごとの延べ時間）`;
    const body=$('logBody');body.replaceChildren();for(const r of rows.slice(0,limit)){const tr=el('tr'),name=el('td'),button=el('button',r.name);button.onclick=()=>{selected=r.id;renderDetail();};name.append(button);tr.append(name,...[r.userId?(r.isFriend?'フレンド':'非フレンド'):'ID未記録',r.count,logDuration(r.duration)+(r.estimated?' ※API観測':'')+(r.open?' ※終了未確認':''),date(r.firstAt),date(r.lastAt),r.worlds].map(v=>el('td',String(v))));body.append(tr);}if(!rows.length){const tr=el('tr'),td=el('td','この条件の同席記録はありません。');td.colSpan=7;tr.append(td);body.append(tr);}$('logMore').hidden=rows.length<=limit;renderDetail();
  }
  async function load(){if(root.hidden)return;if(isDemo||!accountId){records=[];render();return;}const ticket=++loading,owner=accountId;try{const all=await readResearch(owner);if(ticket!==loading||owner!==accountId)return;records=all.filter(r=>r.kind==='instanceEncounters').map(r=>r.value);render();}catch(error){status(error.message);}}
  for(const id of ['logRange','logRelation','logDevice','logWorld','logSort','logSearch'])$(id).addEventListener('input',()=>{limit=100;render();});
  $('logMore').onclick=()=>{limit+=100;render();};
  $('logSummaryCSV').onclick=()=>download('vrc-log-encounters-summary.csv',csv([['ユーザーID','表示名','現在のフレンド','同席回数','同席秒数','最初（JST）','最後（JST）','ワールド数','終了未確認を含む'],...rows.map(r=>[r.userId,r.name,r.isFriend,r.count,Math.floor(r.duration/1000),date(r.firstAt),date(r.lastAt),r.worlds,r.open])]),'text/csv;charset=utf-8');
  $('logSessionsCSV').onclick=()=>download('vrc-log-encounters-sessions.csv',csv([['ユーザーID','表示名','開始（JST）','終了／最終ログ（JST）','同席秒数','終了未確認','ワールドID','ワールド名','インスタンス','記録元'],...rows.flatMap(r=>r.sessions.map(s=>[r.userId,r.name,date(s.start),date(s.end),Math.floor((s.end-s.start)/1000),s.records.some(v=>v.endedAt==null),s.records[0].location.worldId,s.records[0].worldName,s.records[0].location.instanceId,[...new Set(s.records.map(v=>v.device))].join('/')]))]),'text/csv;charset=utf-8');
  return {update(data,owner,nextEpoch=0,apiStatus={}){if(owner!==accountId||epoch!==nextEpoch){stop('表示アカウントのログを選択してください。');$('logOwnerConfirmed').checked=false;lastFiles.clear();selected='';records=[];loading++;}accountId=owner;epoch=nextEpoch;friends=data.friends||[];$('instanceCollectionStatus').textContent=apiStatus.accountId===owner?date(apiStatus.at)+' JST · '+apiStatus.message:'現在地と参加者一覧は次回の通常収集で確認します。取得できない区間は埋めません。';void load();},render:load,stop,async clear(){stop();lastFiles.clear();await sourceSetting(null);}};
}
