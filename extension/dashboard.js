import { DEFAULTS, csv, VERSION } from './core.js';
import { exportAccount } from './db.js';
import { demoData } from './demo.js';
import { rankWorlds, worldJourney } from './insights.js';

const $ = id => document.getElementById(id), isDemo = new URLSearchParams(location.search).get('demo') === '1';
const dateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const date = v => v ? dateFormat.format(v) : '未確認';
const iso = v => v ? new Date(v).toISOString() : '';
const presenceNames = { online:'ゲーム内', active:'Web／アプリ', offline:'オフライン', unknown:'不明' };
const statusNames = { active:'オンライン', 'join me':'Join Me', 'ask me':'Ask Me', busy:'取り込み中', offline:'オフライン' };
const accessNames = { public:'Public', friends:'Friends', 'friends-plus':'Friends+', invite:'Invite', 'invite-plus':'Invite+', 'group-public':'Group Public', 'group-plus':'Group+', 'group-members':'Group', 'group-unknown':'Group', unknown:'不明' };
let data = { friends:[], events:[], worlds:[] }, config = { ...DEFAULTS }, state = {}, selectedAccount = '', dirty = false, renderTimer, loaded = false, cloudConfig = {}, cloudState = {}, syncDirty = false;
const demo = isDemo ? demoData() : null;
function node(tag, content, className) { const el = document.createElement(tag); if (content != null) el.textContent = content; if (className) el.className = className; return el; }
function pill(label, cls = '') { return node('span', label, 'pill ' + cls); }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(renderTimer); renderTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
async function send(message) {
  if (isDemo) { toast('デモ画面では収集・設定変更は行いません。'); return false; }
  try { const response = await chrome.runtime.sendMessage(message); if (!response?.ok) throw new Error(response?.error || '拡張を再読み込みしてください。'); return true; }
  catch (e) { toast(e.message); return false; }
}
function tab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) { b.classList.toggle('selected', b.dataset.tab === name); b.setAttribute('aria-current', b.dataset.tab === name ? 'page' : 'false'); }
  for (const id of ['friends','ranking','journey','history','settings','help']) $(id + 'Panel').hidden = id !== name;
}
const worldName = id => data.worlds.find(w => w.id === id)?.name || id;
function place(f) { const l = f?.location; return l?.kind === 'world' ? worldName(l.worldId) : ({ private:'所在非公開', offline:'オフライン', traveling:'移動中', web:'ワールド情報なし', unknown:'所在不明' }[l?.kind] || '不明'); }
function stale(f) { return Date.now() - f.observedAt > Math.max(config.pollSeconds * 2.2, 120) * 1000; }
function summary(f) { return f ? `${presenceNames[f.presence] || f.presence} · ${place(f)}${f.statusDescription ? ' · ' + f.statusDescription : ''}` : '記録なし'; }
function shortId(s, n=24) { return s?.length > n ? s.slice(0,n) + '…' : s || '—'; }
function render() {
  const active = data.friends.filter(f => f.isFriend), fresh = active.filter(f => !stale(f));
  $('total').textContent = active.length.toLocaleString();
  $('online').textContent = fresh.filter(f => f.presence === 'online').length.toLocaleString();
  $('visible').textContent = fresh.filter(f => f.location.kind === 'world').length.toLocaleString();
  $('private').textContent = fresh.filter(f => f.location.kind === 'private').length.toLocaleString();
  $('stale').textContent = active.filter(stale).length.toLocaleString();
  const q = $('search').value.trim().toLocaleLowerCase(), filter = $('filter').value;
  const rows = data.friends.filter(f => {
    if (filter === 'removed' ? f.isFriend : !f.isFriend) return false;
    if (filter === 'stale' && !stale(f)) return false;
    if (filter === 'private' && f.location.kind !== 'private') return false;
    if (['online','active','offline'].includes(filter) && f.presence !== filter) return false;
    return !q || [f.displayName, f.id, place(f), f.statusDescription, f.location.instanceId].join(' ').toLocaleLowerCase().includes(q);
  }).sort((a,b) => ({online:0,active:1,unknown:2,offline:3}[a.presence] ?? 2) - ({online:0,active:1,unknown:2,offline:3}[b.presence] ?? 2) || a.displayName.localeCompare(b.displayName,'ja'));
  $('count').textContent = `${rows.length.toLocaleString()} 件`;
  $('empty').hidden = !!data.friends.length;
  const body = $('friendsBody'); body.replaceChildren();
  // Keep large rosters responsive. Search/export still use every stored row.
  for (const f of rows.slice(0,1000)) {
    const tr = node('tr'); tr.tabIndex = 0; tr.setAttribute('aria-label', `${f.displayName}の詳細`);
    tr.addEventListener('click', () => showDetail(f)); tr.addEventListener('keydown', e => { if(e.key === 'Enter') showDetail(f); });
    const nameCell = node('td'), wrap = node('div', null, 'friend-name'), avatar = node('span', [...f.displayName][0], 'avatar'), names = node('div');
    names.append(node('strong', f.displayName), node('span', f.platform || 'プラットフォーム未確認', 'sub')); wrap.append(avatar,names); nameCell.append(wrap);
    const statusCell = node('td'); statusCell.append(pill(presenceNames[f.presence] || '不明', f.presence));
    statusCell.append(node('span', f.status ? statusNames[f.status] || f.status : '', 'sub'));
    const placeCell = node('td'); placeCell.append(node('span', place(f), 'world-name'), node('span', shortId(f.location.instanceId,38), 'sub'));
    const typeCell = node('td'); typeCell.append(node('span', accessNames[f.location.access] || f.location.access || '—'), node('span', f.location.region?.toUpperCase() || '—', 'sub'));
    const timeCell = node('td'); timeCell.append(node('span', date(f.observedAt))); if(stale(f)) timeCell.append(node('span','古い観測','sub'));
    tr.append(nameCell,statusCell,placeCell,typeCell,timeCell); body.append(tr);
  }
  if (rows.length > 1000) { const tr=node('tr'),td=node('td','画面には先頭1,000件を表示しています。検索で絞り込むかCSVで全件を確認できます。');td.colSpan=5;tr.append(td);body.append(tr); }
  if (!rows.length && data.friends.length) { const tr=node('tr'),td=node('td','条件に一致するフレンドはいません。');td.colSpan=5;tr.append(td);body.append(tr); }
  renderHistory($('historyList'), data.events);
  renderInsights();
  renderCloud();
  const phases = { running:'取得中', ready:'収集中', paused:'停止中', waiting:'待機中', attention:'要確認' };
  $('phase').textContent = phases[state.phase] || '停止中'; $('phaseDot').className='status-dot ' + (state.phase || '');
  $('message').textContent = state.message || '収集設定を保存して開始してください。';
  $('nextRun').textContent = state.nextRunAt && config.enabled ? `次回 ${date(state.nextRunAt)}` : '';
  $('lastSuccess').textContent = `最終保存 ${date(data.lastSuccessAt || (selectedAccount === state.accountId ? state.lastSuccessAt : null))}`;
  $('start').textContent = config.enabled ? '収集を停止' : '収集を開始';
  $('refresh').disabled = isDemo || !config.enabled || state.phase === 'running' || state.cooldownUntil > Date.now();
  for(const id of ['exportCSV','exportJSON','exportEvents']) $(id).disabled = !selectedAccount;
}
function renderInsights() {
  const ranked = rankWorlds(data.friends, data.worlds, {pollSeconds:config.pollSeconds});
  const ranking = $('worldRanking'); ranking.replaceChildren();
  $('rankingCount').textContent = `${ranked.length} ワールド / ${ranked.reduce((n,w)=>n+w.count,0)} 人`;
  if(!ranked.length) ranking.append(node('p','現在集計できるワールドはありません。収集・同期を行い、新しい観測を取得してください。','empty muted'));
  for(const world of ranked) {
    const card=node('article',null,'world-card'), number=node('div',String(world.rank),'world-rank'), body=node('div'), heading=node('h3');
    const link=node('a',world.name); link.href='https://vrchat.com/home/world/'+encodeURIComponent(world.id);link.target='_blank';link.rel='noreferrer';heading.append(link);
    body.append(heading,node('span',`${world.instances} インスタンス · 最新観測 ${date(world.observedAt)}`,'muted'));
    const users=node('div',null,'world-users');
    for(const f of world.users){const button=node('button',f.displayName);button.addEventListener('click',()=>showDetail(f));users.append(button);}
    body.append(users);
    const score=node('div',null,'world-score');score.append(node('strong',world.count+' 人'),node('small','滞在中のフレンド'));
    card.append(number,body,score);ranking.append(card);
  }
  const previous=$('journeyUser').value, people=new Map(data.friends.map(f=>[f.id,f.displayName]));
  for(const e of data.journeyEvents || data.events) if(!people.has(e.userId))people.set(e.userId,e.displayName);
  $('journeyUser').replaceChildren(...[...people].sort((a,b)=>a[1].localeCompare(b[1],'ja')).map(([id,name])=>new Option(name,id)));
  if(people.has(previous))$('journeyUser').value=previous;
  renderJourney();
}
function renderJourney() {
  const days=Number($('journeyRange').value), userId=$('journeyUser').value;
  const journey=worldJourney(data.journeyEvents || data.events,userId,{since:days ? Date.now()-days*86400000 : 0});
  const flow=$('journeyFlow');flow.replaceChildren();
  $('journeySummary').textContent=journey.nodes.length ? `${journey.total} 地点の観測${journey.truncated?'（最新200地点を表示）':''}。左から右へ観測順に表示します。` : 'この期間の遷移記録はありません。フレンドと期間を選択してください。';
  const labels={private:'所在非公開',offline:'オフライン',traveling:'移動中',web:'Web／アプリ',unknown:'所在不明',removed:'名簿から消失'};
  for(const point of journey.nodes){
    const item=node('li',null,point.kind), time=node('time',date(point.observedAt));time.dateTime=new Date(point.observedAt).toISOString();
    item.append(time,node('h3',point.kind==='world'?worldName(point.worldId):labels[point.kind]));
    if(point.instanceId)item.append(node('span',point.instanceId,'sub'));
    if(point.lastObservedAt>point.observedAt)item.append(node('span','最終確認 '+date(point.lastObservedAt),'sub'));
    if(days && point.observedAt<Date.now()-days*86400000)item.append(node('span','範囲直前の観測','sub'));
    flow.append(item);
  }
}
function renderCloud() {
  $('syncStatus').textContent=isDemo?'デモ表示：クラウド同期は行いません。':cloudState.message || (cloudConfig.enabled?'クラウド同期：待機中':'クラウド同期：未設定／無効');
  $('syncTime').textContent=cloudState.lastSuccessAt?'最終同期 '+date(cloudState.lastSuccessAt):'';
  $('syncNow').disabled=isDemo || !cloudConfig.enabled || cloudState.phase==='syncing' || cloudState.retryAt>Date.now();
  if(cloudState.retryAt>Date.now())$('syncTime').textContent+=' · 再試行 '+date(cloudState.retryAt);
}
let viewSync;
function syncView(force=false) {
  if(isDemo || !cloudConfig.enabled)return Promise.resolve();
  if(!viewSync)viewSync=send({type:'SYNC',force}).then(()=>reload()).finally(()=>{viewSync=null;});
  return viewSync;
}
function renderHistory(container, events) {
  container.replaceChildren();
  if (!events.length) { container.append(node('p','変更履歴はまだありません。','empty muted')); return; }
  for(const e of events) {
    const row=node('article',null,'history-row'),time=node('div',date(e.observedAt)),name=node('strong',e.displayName),change=node('div',null,'change');
    time.append(node('span',e.previousObservedAt ? `前回 ${date(e.previousObservedAt)}` : '初回観測','sub'));
    const label=e.kind==='first'?'初回記録':e.kind==='roster-removed'?'名簿から消失':'状態変更';
    change.append(node('strong',label+' · '+summary(e.current)));
    if(e.previous) change.append(node('span','前：'+summary(e.previous),'sub'));
    row.append(time,name,change);container.append(row);
  }
}
function showDetail(f) {
  $('detailName').textContent=f.displayName;
  const fields=$('detailFields');fields.replaceChildren();
  const w=data.worlds.find(w=>w.id===f.location.worldId);
  const values=[['ユーザーID',f.id],['観測日時',date(f.observedAt)+(stale(f)?'（古い観測）':'')],['名前・状態文の取得',date(f.profileObservedAt)],['接続状態',presenceNames[f.presence]],['ステータス',statusNames[f.status]||f.status||'—'],['メッセージ',f.statusDescription||'—'],['プラットフォーム',f.platform||'—'],['ワールド',place(f)],['ワールドID',f.location.worldId||'—'],['インスタンスID',f.location.instanceId||'—'],['種類',accessNames[f.location.access]||f.location.access||'—'],['地域',f.location.region||'—'],['ワールド作者',w?.authorName||'未取得'],['ワールド定員',w?.capacity??'未取得'],['定員の取得日時',date(w?.observedAt)],['初回観測',date(f.firstObservedAt)],['現在の状態の初回観測',date(f.stateFirstObservedAt)]];
  for(const [k,v] of values)fields.append(node('dt',k),node('dd',v));
  const links=node('dd'),label=node('dt','公式サイト');
  const profile=node('a','プロフィールを開く ↗');profile.href='https://vrchat.com/home/user/'+encodeURIComponent(f.id);profile.target='_blank';profile.rel='noreferrer';links.append(profile);
  if(f.location.worldId){const link=node('a','　ワールドを開く ↗');link.href='https://vrchat.com/home/world/'+encodeURIComponent(f.location.worldId);link.target='_blank';link.rel='noreferrer';links.append(link);}
  fields.append(label,links);renderHistory($('detailHistory'),data.events.filter(e=>e.userId===f.id));$('detail').showModal();
}
let refreshQueue=Promise.resolve();
function reload() { refreshQueue=refreshQueue.then(load).catch(e=>toast('表示データを読み取れません：'+e.message));return refreshQueue; }
async function load() {
  if(isDemo){ data=demo;state=demo.state;config={...DEFAULTS,enabled:true};selectedAccount=demo.accountId;
    $('account').replaceChildren(new Option('デモアカウント',demo.accountId));$('demoFlag').hidden=false;
  } else {
    const saved=await chrome.storage.local.get(['settings','state','accountMeta','cloudSync','cloudState']);cloudConfig=saved.cloudSync||{};cloudState=saved.cloudState||{};config={...DEFAULTS,...saved.settings};state=saved.state||{};
    const accounts=saved.accountMeta||{};
    if(!selectedAccount || !accounts[selectedAccount])selectedAccount=state.accountId||Object.keys(accounts)[0]||'';
    $('account').replaceChildren(...Object.entries(accounts).map(([id,meta])=>new Option(meta.displayName||id,id)));
    if(!Object.keys(accounts).length)$('account').append(new Option('未取得',''));$('account').value=selectedAccount;
    if(selectedAccount){const savedData=await exportAccount(selectedAccount);const events=savedData.events.sort((a,b)=>b.observedAt-a.observedAt);data={friends:savedData.friends,events:events.slice(0,200),journeyEvents:events,worlds:savedData.worlds,lastSuccessAt:accounts[selectedAccount]?.lastSuccessAt};}
    else data={friends:[],events:[],worlds:[]};
  }
  if(!dirty){for(const id of ['contact','pollSeconds','retentionDays','offlineRefreshMinutes'])$(id).value=String(config[id]);}
  if(!syncDirty){$('syncEnabled').checked=cloudConfig.enabled===true;$('syncEndpoint').value=cloudConfig.endpoint||'';}
  loaded=true;render();
}
function download(filename,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
const stamp=()=>new Date().toISOString().replace(/[:.]/g,'-');
async function exportData(kind){
  try{
    const saved=isDemo?{schema:1,demo:true,exportedAt:new Date().toISOString(),...demo}:await exportAccount(selectedAccount);
    const prefix=(isDemo?'DEMO-':'')+'vrc-friends-'+stamp();
    if(kind==='json'){download(prefix+'.json',JSON.stringify({appVersion:VERSION,...saved},null,2),'application/json');return;}
    if(kind==='friends'){
      const names=new Map(saved.worlds.map(w=>[w.id,w.name]));
      const rows=[['account_id','user_id','display_name','is_friend','presence','status','status_description','platform','location_visibility','world_id','world_name','instance_id','instance_type','region','observed_at_utc','profile_observed_at_utc','first_observed_at_utc','state_first_observed_at_utc']];
      for(const f of saved.friends)rows.push([selectedAccount,f.id,f.displayName,f.isFriend,f.presence,f.status,f.statusDescription,f.platform,f.location.kind,f.location.worldId,names.get(f.location.worldId)||'',f.location.instanceId,f.location.access,f.location.region,iso(f.observedAt),iso(f.profileObservedAt),iso(f.firstObservedAt),iso(f.stateFirstObservedAt)]);
      download(prefix+'.csv',csv(rows),'text/csv;charset=utf-8');
    }else{
      const rows=[['account_id','user_id','display_name','kind','observed_at_utc','previous_observed_at_utc','previous_presence','current_presence','previous_location_visibility','current_location_visibility','previous_world_id','current_world_id','previous_instance_id','current_instance_id','previous_status','current_status','previous_status_description','current_status_description']];
      for(const e of saved.events)rows.push([selectedAccount,e.userId,e.displayName,e.kind,iso(e.observedAt),iso(e.previousObservedAt),e.previous?.presence,e.current?.presence,e.previous?.location?.kind,e.current?.location?.kind,e.previous?.location?.worldId,e.current?.location?.worldId,e.previous?.location?.instanceId,e.current?.location?.instanceId,e.previous?.status,e.current?.status,e.previous?.statusDescription,e.current?.statusDescription]);
      download(prefix+'-events.csv',csv(rows),'text/csv;charset=utf-8');
    }
  }catch(e){toast('書き出しに失敗しました：'+e.message);}
}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{tab(b.dataset.tab);void syncView();}));
$('emptySettings').addEventListener('click',()=>tab('settings'));
$('search').addEventListener('input',render);$('filter').addEventListener('change',render);
$('account').addEventListener('change',()=>{selectedAccount=$('account').value;void reload().then(()=>syncView());});
$('start').addEventListener('click',async()=>{if(await send({type:config.enabled?'PAUSE':'START'}))void reload();});
$('refresh').addEventListener('click',async()=>{if(await send({type:'POLL'}))toast('更新を開始しました。');});
$('settingsForm').addEventListener('input',()=>{dirty=true;$('settingsNotice').textContent='未保存';});
$('settingsForm').addEventListener('submit',async e=>{e.preventDefault();const values={};for(const id of ['contact','pollSeconds','retentionDays','offlineRefreshMinutes'])values[id]=$(id).value;
  if(Number(values.retentionDays)<config.retentionDays&&!confirm('保存期間を短くします。期間外の履歴が削除されます。続けますか？'))return;
  if(await send({type:'SAVE',settings:values})){dirty=false;$('settingsNotice').textContent='保存しました';await reload();}});
$('clear').addEventListener('click',async()=>{if(confirm('この端末の全アカウントの記録を削除し、収集・同期を停止します。スプレッドシートの記録は残り、同期を再開すると再取得されます。実行しますか？')&&await send({type:'CLEAR'})){selectedAccount='';await reload();toast('全記録を削除しました。');}});
$('closeDetail').addEventListener('click',()=>$('detail').close());
$('exportCSV').addEventListener('click',()=>exportData('friends'));$('exportJSON').addEventListener('click',()=>exportData('json'));$('exportEvents').addEventListener('click',()=>exportData('events'));
if(!isDemo){let timer;chrome.storage.onChanged.addListener(()=>{clearTimeout(timer);timer=setTimeout(()=>void reload(),200);});}
setInterval(()=>{if(loaded)render();},30000);
void reload().then(()=>syncView());

$('journeyUser').addEventListener('change',renderJourney);
$('journeyRange').addEventListener('change',renderJourney);
$('syncNow').addEventListener('click',()=>void syncView(true));
$('syncForm').addEventListener('input',()=>{syncDirty=true;$('syncNotice').textContent='未保存';});
$('syncForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(isDemo){toast('デモ画面では同期設定を保存しません。');return;}
  const settings={enabled:$('syncEnabled').checked,endpoint:$('syncEndpoint').value,token:$('syncToken').value};
  try {
    if(settings.enabled && !await chrome.permissions.request({origins:['https://script.google.com/*','https://script.googleusercontent.com/*']}))throw Error('Googleへの接続を許可すると同期を利用できます。');
    if(await send({type:'SAVE_SYNC',settings})) {syncDirty=false;$('syncToken').value='';$('syncNotice').textContent='保存しました';await reload();}
  }catch(error){toast(error.message);}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void syncView();});
window.addEventListener('focus',()=>void syncView());
