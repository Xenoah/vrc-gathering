import { DEFAULTS, csv, VERSION } from './core.js';
import { observedDurations, formatObservedDuration, buildActivityTimeline, changesByHour, ACTIVITY_LABELS } from './activity-analysis.js';
import { exportAccount, cachedImages } from './db.js';
import { demoData } from './demo.js';
import { rankWorlds, worldJourney, worldNetwork, sortFriends, sortWorlds } from './insights.js';
import { createWorldNetworkView } from './world-network-view.js';
import { CLOUD_ORIGINS, serverRetryDeadline } from './sync.js';
import { IMAGE_ORIGINS } from './image-cache.js';
import { initializeGasGuide } from './setup-guide.js';
import { initializeSettingsBackup } from './settings-backup-ui.js';
import { createConnectionsView } from './connections-ui.js';
import { createResearchView } from './research-ui.js';
import { createAnalysisLab } from './analysis-lab-ui.js';
import { followerTargets, activeFollowerJobs } from './x-follower-collector.js';
import {xConcurrency,MAX_X_CONCURRENCY,xScope,xBulkScope} from './x-follower-settings.js';
import { X_FOLLOWER_ORIGINS, followerRecords, bestFollowerMetric, followerText } from './x-followers.js';
import { createUserNotesView } from './user-notes-ui.js';
import { createXProfileView } from './x-profile-ui.js';
import {createFollowerHistogram} from './x-follower-histogram-ui.js';
import { createGameLogView } from './game-log-ui.js';
import { buildAnalysisReport, DAY } from './analysis-lab.js';
import { lineChart, barChart, donutChart, columnChart } from './charts.js';
import { userStatus, USER_STATUSES } from './user-status.js';
import { initializeNavigationIcons } from './navigation-icons.js';

const $ = id => document.getElementById(id), isDemo = new URLSearchParams(location.search).get('demo') === '1';
const dateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const date = v => v ? dateFormat.format(v) : '未確認';
const iso = v => v ? new Date(v).toISOString() : '';
const presenceNames = { online:'ゲーム内', active:'Web／アプリ', offline:'現実世界', unknown:'不明' };
const accessNames = { public:'Public', friends:'Friends', 'friends-plus':'Friends+', invite:'Invite', 'invite-plus':'Invite+', 'group-public':'Group Public', 'group-plus':'Group+', 'group-members':'Group', 'group-unknown':'Group', unknown:'不明' };
let data = { friends:[], events:[], worlds:[] }, config = { ...DEFAULTS }, state = {}, selectedAccount = '', dirty = false, renderTimer, loaded = false, cloudConfig = {}, cloudState = {}, cloudDiagnostic = {}, syncPermissions = [], testingConnection = false, syncDirty = false, imageDirty = false, imageConfig = {}, imageRows = [], imageRevision = null, loadedImageRevision;
let logImportEpoch=0,instanceCollectionState={};
let xProfiles={},xMetrics={},xFollowerConfig={},xFollowerDirty=false,xFollowerQueue={},xFriendScan={},xSavedLimit=100,xSavedKey='';
const demo = isDemo ? demoData() : null;
initializeNavigationIcons();
function node(tag, content, className) { const el = document.createElement(tag); if (content != null) el.textContent = content; if (className) el.className = className; return el; }
const imageURLs=new Map(),imageElements=new Map();let currentGraph,detailAccount='';
const network=createWorldNetworkView({onSelect:showNetworkDetail,onLayoutChange:renderJourney,imageFor:(kind,id)=>imageElements.get(kind+':'+id)});
const connections=createConnectionsView({node,date,avatar,imageFor:(kind,id)=>imageElements.get(kind+':'+id)});
const analysisLab=createAnalysisLab({node,date,download,imageFor:(kind,id)=>imageElements.get(kind+':'+id)});
const research=createResearchView({root:$('researchPanel'),isDemo,imageFor:(kind,id)=>imageElements.get(kind+':'+id)});
const xProfileView=createXProfileView({node,date,request:message=>chrome.runtime.sendMessage(message),isOpen:()=>$('detail').open,getFollower:(accountId,url)=>xMetrics['xFollowers:'+accountId+':'+url.slice(14)],followersEnabled:()=>xFollowerConfig.enabled===true,enableFollowers:enableXFollowers,getQueue:()=>xFollowerQueue});
const xHistogram=createFollowerHistogram({root:$('xFollowerHistogram'),node,date,download});
const gameLog=createGameLogView({root:$('gameLogPanel'),request:message=>chrome.runtime.sendMessage(message),download,isDemo});
const userNotes=createUserNotesView({root:$('userNotes'),request:message=>chrome.runtime.sendMessage(message),isOpen:()=>$('detail').open,sync:syncView});
function avatar(kind,id,name) {
  const url=imageURLs.get(kind+':'+id);
  const privateClass=kind==='user'&&data.friends.some(f=>f.id===id&&f.location?.kind==='private')?' is-private':'';
  if(!url)return node('span',[...name||'?'][0],'avatar'+privateClass);
  const img=node('img',null,'avatar cached-avatar'+privateClass);img.src=url;img.alt='';img.width=36;img.height=36;img.loading='lazy';return img;
}
async function loadImages() {
  const revision=selectedAccount+':'+JSON.stringify(imageRevision);if(revision===loadedImageRevision)return;
  for(const url of imageURLs.values())URL.revokeObjectURL(url);imageURLs.clear();imageElements.clear();
  imageRows=isDemo||!selectedAccount?[]:await cachedImages(selectedAccount);loadedImageRevision=revision;
  for(const row of imageRows){if(!row.blob)continue;const key=row.kind+':'+row.id,url=URL.createObjectURL(row.blob);imageURLs.set(key,url);const img=new Image();img.onload=()=>{network.redraw();connections.redraw();analysisLab.redraw();research.redraw();};img.src=url;imageElements.set(key,img);}
}
function statusBadge(friend) { const status=userStatus(friend),badge=node('span',status.label,'user-status status-'+status.key);badge.style.setProperty('--user-status-color',status.color);return badge; }
$('statusLegend').replaceChildren(...Object.keys(USER_STATUSES).filter(key=>key!=='unknown').map(status=>statusBadge({status})));
function pill(label, cls = '') { return node('span', label, 'pill ' + cls); }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(renderTimer); renderTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
async function call(message,{rethrow=false}={}) {
  if(isDemo){toast('デモ画面では収集・設定変更は行いません。');return null;}
  try {const response=await chrome.runtime.sendMessage(message);if(!response?.ok)throw Error(response?.error || '拡張を再読み込みしてください。');return response;}
  catch(error){if(rethrow)throw error;toast(error.message);return null;}
}
async function send(message){return !!await call(message);}
function showSyncSkip(response) {
  if(!response?.skipped)return;
  const labels={disabled:'同期が無効です。設定を有効にして保存してください。',paused:'同期設定の更新中です。完了してから再試行してください。',busy:'同期または接続テストが実行中です。完了してから再試行してください。',throttled:'自動同期の実行間隔を空けています。'};
  toast(response.reason==='backoff'?`${response.retrySource==='server'?'サーバー指定の待機中':'自動再試行の待機中'}。次回再試行：${date(response.retryAt)}`:labels[response.reason] || '現在は同期できません。');
}

function tab(name) {
  document.body.dataset.activeTab=name;
  for (const b of document.querySelectorAll('[data-tab]')) { b.classList.toggle('selected', b.dataset.tab === name); b.setAttribute('aria-current', b.dataset.tab === name ? 'page' : 'false'); }
  for (const id of ['home','analytics','lab','research','connections','gameLog','friends','ranking','journey','history','settings','help']) $(id + 'Panel').hidden = id !== name;
  if (name === 'analytics' && loaded) renderActivity();
  if (name === 'gameLog' && loaded) gameLog.update(data,selectedAccount,logImportEpoch,instanceCollectionState);
  if (name === 'connections' && loaded) connections.update(data,selectedAccount,config);
  if (name === 'lab' && loaded) analysisLab.update(data,selectedAccount,config);
  research.update(data,selectedAccount,config);
  if (name === 'home' && loaded) renderHome();
  document.querySelector('[data-tab="'+name+'"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  window.scrollTo(0,0);
}
const worldName = id => data.worlds.find(w => w.id === id)?.name || id;
function place(f) { const l = f?.location; return l?.kind === 'world' ? worldName(l.worldId) : ({ private:'プライベート', offline:'現実世界', traveling:'移動中', web:'ワールド情報なし', unknown:'所在不明' }[l?.kind] || '不明'); }
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
  const metrics=new Map(data.friends.map(f=>[f.id,bestFollowerMetric(xProfiles,xMetrics,selectedAccount,f.id)]));
  const rows = sortFriends(data.friends.filter(f => {
    if (filter === 'removed' ? f.isFriend : !f.isFriend) return false;
    if (filter === 'stale' && !stale(f)) return false;
    if (filter === 'private' && f.location.kind !== 'private') return false;
    if (['online','active','offline'].includes(filter) && f.presence !== filter) return false;
    return !q || [f.displayName, f.id, place(f), f.statusDescription, f.location.instanceId].join(' ').toLocaleLowerCase().includes(q);
  }), $('friendSort').value, new Map(data.worlds.map(w=>[w.id,w.name])),new Map([...metrics].map(([id,v])=>[id,v?.followers])));
  $('count').textContent = `${rows.length.toLocaleString()} 件`;
  $('empty').hidden = !!data.friends.length;
  const body = $('friendsBody'); body.replaceChildren();
  // Keep large rosters responsive. Search/export still use every stored row.
  for (const f of rows.slice(0,1000)) {
    const tr = node('tr'); tr.tabIndex = 0; tr.setAttribute('aria-label', `${f.displayName}の詳細`);
    tr.addEventListener('click', () => showDetail(f)); tr.addEventListener('keydown', e => { if(e.key === 'Enter') showDetail(f); });
    const nameCell = node('td'), wrap = node('div', null, 'friend-name'), icon = avatar('user',f.id,f.displayName), names = node('div');
    names.append(node('strong', f.displayName), node('span', f.platform || 'プラットフォーム未確認', 'sub')); wrap.append(icon,names); nameCell.append(wrap);
    const statusCell = node('td'); statusCell.append(statusBadge(f));
    if(f.presence!=='offline')statusCell.append(node('span',presenceNames[f.presence]||'不明','sub'));
    const followerCell=node('td',followerText(metrics.get(f.id)),'follower-count'),metric=metrics.get(f.id);
    if(metric){followerCell.append(node('span',date(metric.observedAt),'sub'));followerCell.title=metric.url+' · Xプロフィールの表示値（確認時点）';}
    const placeCell = node('td'); placeCell.append(node('span', place(f), 'world-name'), node('span', shortId(f.location.instanceId,38), 'sub'));
    const typeCell = node('td'); typeCell.append(node('span', accessNames[f.location.access] || f.location.access || '—'), node('span', f.location.region?.toUpperCase() || '—', 'sub'));
    const durationCell = node('td'), duration = observedDurations(f);
    if (duration) {
      durationCell.append(node('span', (f.presence==='online'?'接続 ':'状態 ')+formatObservedDuration(duration.presence), 'duration-value'));
      if (f.presence==='online' && f.location?.kind==='world')
        durationCell.append(node('span','同一ワールド '+formatObservedDuration(duration.place),'duration-value-secondary'));
      if (stale(f)) durationCell.append(node('span','最終確認時点まで','sub'));
    } else durationCell.textContent = '—';
    durationCell.title = '観測された状態から算出。実際の開始時刻や未観測期間の継続は保証されません。';
    const timeCell = node('td'); timeCell.append(node('span', date(f.observedAt))); if(stale(f)) timeCell.append(node('span','古い観測','sub'));
    tr.append(nameCell,statusCell,followerCell,placeCell,typeCell,durationCell,timeCell); body.append(tr);
  }
  if (rows.length > 1000) { const tr=node('tr'),td=node('td','画面には先頭1,000件を表示しています。検索で絞り込むかCSVで全件を確認できます。');td.colSpan=7;tr.append(td);body.append(tr); }
  if (!rows.length && data.friends.length) { const tr=node('tr'),td=node('td','条件に一致するフレンドはいません。');td.colSpan=7;tr.append(td);body.append(tr); }
  renderHistory($('historyList'), data.events);
  renderInsights();
  renderHome();
  renderActivity();
  connections.update(data,selectedAccount,config);
  analysisLab.update(data,selectedAccount,config);
  research.update(data,selectedAccount,config);
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
function renderHome() {
  if($('homePanel').hidden)return;
  const fresh=data.friends.filter(f=>f.isFriend && !stale(f));
  const live=fresh.filter(f=>f.presence==='online').length;
  const ranked=rankWorlds(data.friends,data.worlds,{pollSeconds:config.pollSeconds});
  const title='ゲーム内 '+live+'人 / ワールド公開 '+ranked.reduce((n,w)=>n+w.count,0)+'人 / 最新観測ワールド '+ranked.length+'件。';
  $('homeSummary').textContent=title+' 数値は自分が観測できたフレンドのみの集計です。';
  renderHistory($('homeRecent'),data.events.slice(0,5));
  const now=Date.now(),report=buildAnalysisReport(data,{accountId:selectedAccount,now,since:now-7*DAY,until:now+1,pollSeconds:config.pollSeconds});
  for(const id of ['homeTrend','homePresence','homeWorlds','homeConnections','homeHours'])$(id).replaceChildren();
  const explore=options=>{tab('lab');analysisLab.explore(options);$('labPanel').scrollIntoView({block:'start'});};
  lineChart($('homeTrend'),report.daily,{label:'直近7日間の変更件数とワールド変更',series:[{key:'changes',label:'変更イベント'},{key:'moves',label:'ワールド変更'}],onSelect:row=>explore({day:row.day})});
  const active=data.friends.filter(f=>f.isFriend),counts=new Map([['ゲーム内',0],['Web／アプリ',0],['現実世界',0],['古い観測',0],['不明',0]]);
  for(const f of active){const name=stale(f)?'古い観測':presenceNames[f.presence]||'不明';counts.set(name,counts.get(name)+1);}
  donutChart($('homePresence'),[...counts].map(([name,count])=>({name,count})),{label:'フレンドの現在の状態',unit:'登録フレンド'});
  barChart($('homeWorlds'),ranked,{label:'現在の公開ワールド順位',moreLabel:'全件は「すべて」で確認できます。',limit:5,format:n=>n+'人',onSelect:row=>explore({worldId:row.id,section:'world'})});
  barChart($('homeConnections'),report.connections,{label:'同じインスタンスの重なり時間',moreLabel:'全件は「詳しく」で確認できます。',key:'duration',limit:5,format:v=>v?formatObservedDuration(v):'時間未確認',onSelect:row=>explore({userId:row.id,section:'people'})});
  columnChart($('homeHours'),report.hourly,{label:'日本時間0〜23時の変更イベント件数'});
}
const activityAxisFormat=new Intl.DateTimeFormat('ja-JP',{
  timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false
});
function renderActivity() {
  // Keep dashboard initialization and normal refreshes cheap while Analytics is hidden.
  if ($('analyticsPanel').hidden) return;
  const hours=Number($('activityRange').value)||24;
  const worldSelect=$('activityWorld');
  const previousWorld=worldSelect.value;
  const worlds=new Map(data.worlds.map(w=>[w.id,w.name||w.id]));
  for(const f of data.friends)if(f.location?.kind==='world')worlds.set(f.location.worldId,worlds.get(f.location.worldId)||f.location.worldId);
  for(const e of data.journeyEvents||data.events) {
    for(const entry of [e.previous,e.current])if(entry?.location?.kind==='world') {
      const id=entry.location.worldId; worlds.set(id,worlds.get(id)||id);
    }
  }
  worldSelect.replaceChildren(new Option('すべてのワールド',''),
    ...[...worlds].sort((a,b)=>a[1].localeCompare(b[1],'ja')).map(([id,name])=>new Option(name,id)));
  if(worlds.has(previousWorld))worldSelect.value=previousWorld;
  const timeline=buildActivityTimeline(data.friends,data.journeyEvents||data.events,data.worlds,{
    now:Date.now(),rangeMs:hours*3600000,filter:$('activityFilter').value,
    worldId:worldSelect.value,query:$('activitySearch').value,pollSeconds:config.pollSeconds,limit:120
  });
  const runs=(data.runs||[]).filter(r=>r.observedAt>=timeline.start && r.observedAt<=timeline.end);
  $('activitySummary').textContent=String(timeline.total)+'ユーザー / 表示 '+String(timeline.rows.length)+
    '人 / 成功した収集 '+String(runs.length)+'回（表示期間）。'+
    (timeline.truncated?'先頭120人を表示。検索で絞り込めます。':'')+
    ' 最後の観測より後は塗りません。';
  const graph=$('activityTimeline');graph.replaceChildren();
  const axis=node('div',null,'activity-axis'),side=node('div',null,'activity-axis-label');
  side.append(node('span','ユーザー'),node('span','t →','axis-t'));
  const ruler=node('div',null,'activity-axis-track');
  for(let i=0;i<=4;i++){
    const tick=node('span',activityAxisFormat.format(timeline.start+(timeline.end-timeline.start)*i/4),'activity-axis-tick');
    tick.style.left=String(i*25)+'%';
    ruler.append(tick);
  }
  axis.append(side,ruler);graph.append(axis);
  const scale=100/(timeline.end-timeline.start);
  for(const item of timeline.rows) {
    const row=node('div',null,'activity-row'),left=node('div',null,'activity-user'),track=node('div',null,'activity-track');
    const button=node('button'),label=node('span',null,'activity-user-text');
    const duration=observedDurations(item.friend);
    label.append(node('strong',item.name),
      node('small',duration ? '状態 '+formatObservedDuration(duration.presence)+'（最終観測まで）' : '履歴のみ'));
    button.append(avatar('user',item.id,item.name),label);
    button.disabled=!item.friend;
    if(item.friend)button.addEventListener('click',()=>showDetail(item.friend));
    left.append(button);
    for(const segment of item.segments) {
      const bar=node('button',null,'activity-segment state-'+segment.kind+' '+segment.confidence);
      bar.type='button';
      bar.style.left=String((segment.start-timeline.start)*scale)+'%';
      bar.style.width=String(Math.max(.12,(segment.end-segment.start)*scale))+'%';
      const world=segment.worldId ? ' / '+(timeline.worldNames.get(segment.worldId)||segment.worldId) : '';
      const note=segment.confidence==='estimated'?'推定区間（途中の状態は未確認）':'近接する同状態の観測点間';
      const description=(ACTIVITY_LABELS[segment.kind]||segment.kind)+world+' / '+
        date(segment.start)+' ～ '+date(segment.end)+' / '+note;
      bar.title=description;bar.setAttribute('aria-label',item.name+'：'+description);
      bar.disabled=!item.friend;
      if(item.friend)bar.addEventListener('click',()=>showDetail(item.friend));
      track.append(bar);
    }
    const pts=item.points.length>180
      ? item.points.filter((p,i)=>i===0||i===item.points.length-1||i%Math.ceil(item.points.length/180)===0)
      : item.points;
    for(const point of pts){
      const mark=node('span',null,'activity-mark');
      mark.style.left=String((point.at-timeline.start)*scale)+'%';
      mark.title='観測：'+date(point.at)+' / '+(ACTIVITY_LABELS[
        point.state.isFriend===false?'removed':
        point.state.presence==='online'?(point.state.location?.kind==='world'?'world':point.state.location?.kind==='private'?'private':'online-unknown'):
        point.state.presence==='active'?'active':point.state.presence==='offline'?'offline':'unknown'] || '不明');
      track.append(mark);
    }
    row.append(left,track);graph.append(row);
  }
  if (!timeline.rows.length)graph.append(node('p','この期間・検索条件に該当する観測がありません。','activity-empty'));
  const counts=changesByHour(data.journeyEvents||data.events,timeline.start),max=Math.max(1,...counts);
  const histogram=$('activityHourly');histogram.replaceChildren();
  histogram.setAttribute('aria-label','時間帯ごとの状態変更イベント数：'+counts.map((c,i)=>String(i)+'時 '+String(c)+'件').join('、'));
  for(let i=0;i<24;i++){
    const slot=node('div',null,'hour-slot');
    const bar=node('div',null,'hour-bar');
    bar.style.height=String(Math.max(1,Math.round(counts[i]/max*115)))+'px';
    const title=String(i)+'時台：'+String(counts[i])+'件';
    slot.title=title;bar.title=title;
    slot.append(bar,node('span',String(i).padStart(2,'0'),'hour-label'));
    histogram.append(slot);
  }
}

function renderInsights() {
  const ranked = rankWorlds(data.friends, data.worlds, {pollSeconds:config.pollSeconds});
  const ranking = $('worldRanking'); ranking.replaceChildren();
  $('rankingCount').textContent = `${ranked.length} ワールド / ${ranked.reduce((n,w)=>n+w.count,0)} 人`;
  if(!ranked.length) ranking.append(node('p','現在集計できるワールドはありません。収集・同期を行い、新しい観測を取得してください。','empty muted'));
  for(const world of sortWorlds(ranked,$('rankingSort').value)) {
    const card=node('article',null,'world-card'), number=node('div',String(world.rank),'world-rank'), body=node('div'), heading=node('h3');
    const link=node('a',world.name); link.href='https://vrchat.com/home/world/'+encodeURIComponent(world.id);link.target='_blank';link.rel='noreferrer';heading.append(avatar('world',world.id,world.name),link);
    body.append(heading,node('span',`${world.instances} インスタンス · 最新観測 ${date(world.observedAt)}`,'muted'));
    const users=node('div',null,'world-users');
    for(const f of world.users){const button=node('button',f.displayName);button.addEventListener('click',()=>showDetail(f));users.append(button);}
    body.append(users);
    const score=node('div',null,'world-score');score.append(node('strong',world.count+' 人'),node('small','滞在中のフレンド'));
    card.append(number,body,score);ranking.append(card);
  }
  const previous=$('journeyUser').value, people=new Map(data.friends.map(f=>[f.id,f.displayName]));
  for(const e of data.journeyEvents || data.events) if(!people.has(e.userId))people.set(e.userId,e.displayName);
  $('journeyUser').replaceChildren(new Option('全ユーザー',''),...[...people].sort((a,b)=>a[1].localeCompare(b[1],'ja')).map(([id,name])=>new Option(name,id)));
  if(!previous||people.has(previous))$('journeyUser').value=previous;
  renderJourney();
}
function renderJourney() {
  const days=Number($('journeyRange').value),userId=$('journeyUser').value;
  currentGraph=worldNetwork(data.journeyEvents||data.events,data.friends,data.worlds,{since:days?Date.now()-days*86400000:0,userId,query:$('networkSearch').value,order:$('networkSort').value,pollSeconds:config.pollSeconds});
  network.setGraph(currentGraph,[selectedAccount,userId,days,$('networkSearch').value,$('networkSort').value].join('|'),data.worlds);
  $('journeySummary').textContent=`${currentGraph.userCount} ユーザー / ${currentGraph.nodes.filter(n=>n.kind==='world').length} ワールド / ${currentGraph.edges.length} 経路 / ${currentGraph.transitionCount} 回の移動観測。${currentGraph.nodes.length?(network.mode==='radial'?'中央から配置順に並べています。':network.mode.toUpperCase()+'：選択した軸の値で配置しています。'):'この条件の記録はありません。'}`;
  const oldNode=$('networkNode').value,oldEdge=$('networkEdge').value;
  $('networkNode').replaceChildren(new Option('地点を選択',''),...currentGraph.nodes.map(n=>new Option(`${n.name} · ${n.users.size}人`,n.id)));
  const names=new Map(currentGraph.nodes.map(n=>[n.id,n.name]));
  $('networkEdge').replaceChildren(new Option('移動を選択',''),...currentGraph.edges.map(e=>new Option(`${names.get(e.from)} → ${names.get(e.to)} · ${e.count}回`,e.id)));
  if(currentGraph.nodes.some(n=>n.id===oldNode))$('networkNode').value=oldNode;
  if(currentGraph.edges.some(e=>e.id===oldEdge))$('networkEdge').value=oldEdge;
  const selected=currentGraph.nodes.find(n=>n.id===$('networkNode').value)||currentGraph.edges.find(e=>e.id===$('networkEdge').value);if(selected)network.select(selected.id);
  $('individualJourney').hidden=!userId;
  renderIndividualJourney();
}
function showNetworkDetail(item) {
  const detail=$('networkDetail');detail.replaceChildren();
  if(!item){detail.textContent='点または線を選ぶと、ユーザーと観測日時を表示します。';return;}
  if(item.transitions){
    $('networkEdge').value=item.id;$('networkNode').value='';
    const names=new Map(currentGraph.nodes.map(n=>[n.id,n.name]));detail.append(node('h3',`${names.get(item.from)} → ${names.get(item.to)}（${item.count}回 / ${item.users.size}人）`));
    const rows=[...item.transitions].sort((a,b)=>b.observedAt-a.observedAt);let shown=0;
    const list=node('ol',null,'network-events'),more=node('button','さらに100件表示');
    function append(){for(const t of rows.slice(shown,shown+100)){const li=node('li');li.append(avatar('user',t.userId,t.displayName),node('strong',t.displayName),node('span',`${date(t.previousAt)} → ${date(t.observedAt)}`),node('small',`${t.fromInstance||'—'} → ${t.toInstance||'—'}`));list.append(li);}shown+=100;more.hidden=shown>=rows.length;}
    more.addEventListener('click',append);append();detail.append(list,more);
  }else{
    $('networkNode').value=item.id;$('networkEdge').value='';
    const heading=node('h3');heading.append(avatar('world',item.id,item.name),node('span',item.name));detail.append(heading,node('p',`${item.users.size}人を観測 · 現在の滞在 ${item.currentUsers.size}人 · 最新 ${date(item.observedAt)}`));
    const axisValues=node('div',null,'network-axis-values');for(const description of network.axisDescription(item.id))axisValues.append(node('span',description));detail.append(axisValues);
    const users=node('div',null,'world-users');for(const id of item.users){const name=currentGraph.people.get(id)||id,button=node('button',name);button.addEventListener('click',()=>{$('journeyUser').value=id;renderJourney();});users.append(button);}detail.append(users);
  }
}
function renderIndividualJourney() {
  const days=Number($('journeyRange').value), userId=$('journeyUser').value;
  const journey=worldJourney(data.journeyEvents || data.events,userId,{since:days ? Date.now()-days*86400000 : 0,limit:200});
  const flow=$('journeyFlow');flow.replaceChildren();

  const labels={private:'プライベート',offline:'現実世界',traveling:'移動中',web:'Web／アプリ',unknown:'所在不明',removed:'名簿から消失'};
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
  const syncRunning=cloudState.phase==='syncing' && Date.now()-(cloudState.lastAttemptAt||0)<150000,
    serverWait=serverRetryDeadline(cloudState)>Date.now(),testRunning=testingConnection || cloudDiagnostic.phase==='testing' && Date.now()-(cloudDiagnostic.testedAt||0)<30000,
    busy=syncRunning || testRunning;
  $('syncStatus').textContent=isDemo?'デモ表示：クラウド同期は行いません。':cloudState.phase==='syncing' && !syncRunning?'前回の同期が完了していません。「接続テスト」または「今すぐ同期」で再試行してください。':cloudState.message || (cloudConfig.enabled?'クラウド同期：待機中':'クラウド同期：未設定／無効');
  $('syncTime').textContent=cloudState.lastSuccessAt?'最終同期 '+date(cloudState.lastSuccessAt):'';
  $('syncNow').disabled=isDemo || !cloudConfig.enabled || busy || serverWait;
  if(cloudState.retryAt>Date.now())$('syncTime').textContent+=' · 次回再試行 '+date(cloudState.retryAt);
  $('syncPermissionStatus').textContent=isDemo?'デモ表示：接続権限の確認は行いません。':CLOUD_ORIGINS.map((origin,i)=>new URL(origin.replace('/*','/')).hostname+'：'+(syncPermissions[i]===true?'許可済み':syncPermissions[i]===false?'未許可':'確認できません')).join(' / ');
  $('grantSyncPermissions').disabled=isDemo || syncPermissions.every(v=>v===true)&&syncPermissions.length===2;
  $('syncSavedState').textContent=cloudConfig.endpoint?`保存済み設定：同期${cloudConfig.enabled?'有効':'無効'} · 同期キー${cloudConfig.token?'保存済み':'未設定'}`:'保存済み設定：未設定';
  $('syncProgress').textContent=({permission:'接続権限の確認',hello:'GASへの接続確認',export:'送信対象の読み込み',push:'GASへ送信',pull:'GASから受信',merge:'端末へ保存',pending:'次のバッチ待ち',upgrade:'GAS更新待ち',complete:'完了'}[cloudState.stage] || (cloudState.phase==='syncing'?'同期中（旧版のため段階不明）':'未確認'));
  $('syncLastAttempt').textContent=date(cloudState.lastAttemptAt);
  $('syncLastError').textContent=cloudState.lastError || (cloudState.phase==='error'?cloudState.message:'なし');
  $('syncRetryAt').textContent=cloudState.retryAt>Date.now()?`${date(serverWait?serverRetryDeadline(cloudState):cloudState.retryAt)}（${serverWait?'サーバー指定の待機':'自動再試行の待機。今すぐ同期で再試行できます'}）`:'待機なし';
  $('testSync').disabled=isDemo || busy || serverWait;
  $('testSync').textContent=testRunning?'接続テスト中…':'接続テスト';
  $('syncTestMessage').textContent=cloudDiagnostic.phase==='testing' && !testRunning?'前回の接続テストが完了していません。もう一度実行してください。':cloudDiagnostic.message || '保存済みのURLと同期キーでhelloを送信します。観測記録の送受信は行いません。';
  $('syncTestAt').textContent=date(cloudDiagnostic.testedAt);
  $('syncTestHTTP').textContent=cloudDiagnostic.httpStatus || '応答なし';
  $('syncTestURL').textContent=cloudDiagnostic.finalUrl || '未取得';
  $('syncTestCode').textContent=cloudDiagnostic.responseCode || '未取得';
}

let viewSync;
function syncView(force=false) {
  if(isDemo || !cloudConfig.enabled)return Promise.resolve();
  if(!viewSync)viewSync=call({type:'SYNC',force}).then(response=>{if(force)showSyncSkip(response);return reload();}).finally(()=>{viewSync=null;});
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
  detailAccount=selectedAccount;
  $('detailName').replaceChildren(avatar('user',f.id,f.displayName),document.createTextNode(f.displayName));
  const fields=$('detailFields');fields.replaceChildren();
  const w=data.worlds.find(w=>w.id===f.location.worldId);
  const values=[['ユーザーID',f.id],['観測日時',date(f.observedAt)+(stale(f)?'（古い観測）':'')],['名前・状態文の取得',date(f.profileObservedAt)],['接続状態',presenceNames[f.presence]],['ステータス',userStatus(f).label],['メッセージ',f.statusDescription||'—'],['プラットフォーム',f.platform||'—'],['ワールド',place(f)],['ワールドID',f.location.worldId||'—'],['インスタンスID',f.location.instanceId||'—'],['種類',accessNames[f.location.access]||f.location.access||'—'],['地域',f.location.region||'—'],['ワールド作者',w?.authorName||'未取得'],['ワールド定員',w?.capacity??'未取得'],['定員の取得日時',date(w?.observedAt)],['初回観測',date(f.firstObservedAt)],['現在の状態の初回観測',date(f.stateFirstObservedAt)]];
  const duration = observedDurations(f);
  if (duration) {
    values.splice(4,0,['状態の観測上の継続',formatObservedDuration(duration.presence) + '（最終観測まで）']);
    if(f.presence==='online' && f.location?.kind==='world')
      values.splice(5,0,['同一ワールドの観測上の継続',formatObservedDuration(duration.place)]);
  }
  for(const [k,v] of values){const dd=node('dd');if(k==='ステータス')dd.append(statusBadge(f));else dd.textContent=v;fields.append(node('dt',k),dd);}
  const links=node('dd'),label=node('dt','公式サイト');
  const profile=node('a','プロフィールを開く ↗');profile.href='https://vrchat.com/home/user/'+encodeURIComponent(f.id);profile.target='_blank';profile.rel='noreferrer';links.append(profile);
  if(f.location.worldId){const link=node('a','　ワールドを開く ↗');link.href='https://vrchat.com/home/world/'+encodeURIComponent(f.location.worldId);link.target='_blank';link.rel='noreferrer';links.append(link);}
  const socials=node('dd');socials.id='detailXProfiles';fields.prepend(node('dt','X（Twitter）'),socials);fields.append(label,links);
  renderHistory($('detailHistory'),data.events.filter(e=>e.userId===f.id));$('detail').showModal();
  xProfileView.show(socials,selectedAccount,f.id,{demo:isDemo});
  userNotes.show(selectedAccount,f.id,{demo:isDemo});
}
let refreshQueue=Promise.resolve();
function reload() { refreshQueue=refreshQueue.then(load).catch(e=>toast('表示データを読み取れません：'+e.message));return refreshQueue; }
async function load() {
  if(isDemo){ data=demo;state=demo.state;config={...DEFAULTS,enabled:true};selectedAccount=demo.accountId;
    $('account').replaceChildren(new Option('デモアカウント',demo.accountId));$('demoFlag').hidden=false;
  } else {
    const saved=await chrome.storage.local.get(['settings','state','accountMeta','cloudSync','cloudState','cloudDiagnostic','imageCacheSettings','imageCacheState','xProfileCache','xFollowerCache','xFollowerSettings','xFollowerQueue','xFriendScan','logImportEpoch','instanceCollectionState']);logImportEpoch=saved.logImportEpoch||0;instanceCollectionState=saved.instanceCollectionState||{};xProfiles=saved.xProfileCache||{};xMetrics=Object.fromEntries(followerRecords(saved.xFollowerCache).map(r=>[r.key,r.value]));xFollowerConfig=saved.xFollowerSettings||{};xFollowerQueue=saved.xFollowerQueue||{};xFriendScan=saved.xFriendScan||{};imageConfig=saved.imageCacheSettings||{};imageRevision=saved.imageCacheState||{};cloudConfig=saved.cloudSync||{};cloudState=saved.cloudState||{};cloudDiagnostic=saved.cloudDiagnostic||{};syncPermissions=await Promise.all(CLOUD_ORIGINS.map(origin=>chrome.permissions?.contains({origins:[origin]}).catch(()=>null) ?? null));config={...DEFAULTS,...saved.settings};state=saved.state||{};
    const accounts=saved.accountMeta||{};
    if(!selectedAccount || !accounts[selectedAccount])selectedAccount=state.accountId||Object.keys(accounts)[0]||'';
    $('account').replaceChildren(...Object.entries(accounts).map(([id,meta])=>new Option(meta.displayName||id,id)));
    if(!Object.keys(accounts).length)$('account').append(new Option('未取得',''));$('account').value=selectedAccount;
    if(selectedAccount){const savedData=await exportAccount(selectedAccount,{includeResearch:false});const events=savedData.events.sort((a,b)=>b.observedAt-a.observedAt);data={friends:savedData.friends,events:events.slice(0,200),journeyEvents:events,worlds:savedData.worlds,runs:savedData.runs,visits:savedData.visits,encounters:savedData.encounters,lastSuccessAt:accounts[selectedAccount]?.lastSuccessAt};}
    else data={friends:[],events:[],worlds:[],runs:[]};
  }
  if($('detail').open&&detailAccount!==selectedAccount)$('detail').close();
  await loadImages();
  if(!xFollowerDirty){$('xFollowerEnabled').checked=xFollowerConfig.enabled===true;$('xFollowerConcurrency').value=String(xConcurrency(xFollowerConfig.concurrency));$('xFollowerScope').value=xScope(xFollowerConfig.scope);$('xFollowerBulkScope').value=xBulkScope(xFollowerConfig.bulkScope);
    const target=xFollowerConfig.accountId||selectedAccount,options=[...$('account').options].filter(o=>o.value).map(o=>new Option(o.textContent,o.value));
    if(target&&!options.some(o=>o.value===target))options.push(new Option(target+'（未登録）',target));
    $('xFollowerAccount').replaceChildren(...options);$('xFollowerAccount').value=target;
  }
  $('xFollowerAccountField').hidden=$('xFollowerScope').value!=='all';
  const xOwner=[...$('account').options].find(o=>o.value===xFollowerConfig.accountId)?.textContent||xFollowerConfig.accountId||'未設定';
  $('xFollowerStatus').textContent=`保存済みのXアカウント：${Object.values(xMetrics).filter(v=>v.accountId===selectedAccount).length}件 · ${xFollowerConfig.enabled?'取得は有効':'取得は無効'} · ${xScope(xFollowerConfig.scope)==='all'?'開いたプロフィール全員／保存先：'+xOwner:'確認済みリンクのみ'}`;
  renderSavedXProfiles();xHistogram.update(xMetrics,xProfiles,data.friends,selectedAccount);
  renderXCollection();xProfileView.refresh();userNotes.refresh(selectedAccount);gameLog.update(data,selectedAccount,logImportEpoch,instanceCollectionState,config);
  if(!imageDirty)$('imageEnabled').checked=imageConfig.enabled===true;
  $('imageStatus').textContent=`表示中のアカウント：${imageRows.filter(r=>r.blob).length}枚 · ${(imageRows.reduce((n,r)=>n+(r.bytes||0),0)/1048576).toFixed(1)}MiB · 未取得 ${imageRows.filter(r=>!r.blob||r.cachedUrl!==r.url).length}件`;
  if(!dirty){for(const id of ['contact','pollSeconds','retentionDays','offlineRefreshMinutes']){
    const field=$(id),value=String(config[id]);
    if(field.tagName==='SELECT'){
      field.querySelectorAll('[data-custom]').forEach(option=>option.remove());
      if(![...field.options].some(option=>option.value===value)){const option=new Option(value+({pollSeconds:'秒',retentionDays:'日',offlineRefreshMinutes:'分'}[id]),value);option.dataset.custom='true';field.add(option);}
    }
    field.value=value;
  }}
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
      const rows=[['account_id','user_id','display_name','is_friend','presence','status','status_description','platform','location_visibility','world_id','world_name','instance_id','instance_type','region','observed_at_utc','profile_observed_at_utc','first_observed_at_utc','state_first_observed_at_utc','presence_since_utc','world_since_utc','instance_since_utc','presence_observed_duration_ms','world_observed_duration_ms']];
      for(const f of saved.friends)rows.push([selectedAccount,f.id,f.displayName,f.isFriend,f.presence,f.status,f.statusDescription,f.platform,f.location.kind,f.location.worldId,names.get(f.location.worldId)||'',f.location.instanceId,f.location.access,f.location.region,iso(f.observedAt),iso(f.profileObservedAt),iso(f.firstObservedAt),iso(f.stateFirstObservedAt)]);
      for (let i=0;i<saved.friends.length;i++) {
        const d=observedDurations(saved.friends[i]);
        rows[i+1].push(iso(d?.since),iso(d?.placeSince),iso(d?.instanceSince),d?.presence ?? '',d?.place ?? '');
      }
      download(prefix+'.csv',csv(rows),'text/csv;charset=utf-8');
    }else{
      const rows=[['account_id','user_id','display_name','kind','observed_at_utc','previous_observed_at_utc','previous_presence','current_presence','previous_location_visibility','current_location_visibility','previous_world_id','current_world_id','previous_instance_id','current_instance_id','previous_status','current_status','previous_status_description','current_status_description']];
      for(const e of saved.events)rows.push([selectedAccount,e.userId,e.displayName,e.kind,iso(e.observedAt),iso(e.previousObservedAt),e.previous?.presence,e.current?.presence,e.previous?.location?.kind,e.current?.location?.kind,e.previous?.location?.worldId,e.current?.location?.worldId,e.previous?.location?.instanceId,e.current?.location?.instanceId,e.previous?.status,e.current?.status,e.previous?.statusDescription,e.current?.statusDescription]);
      download(prefix+'-events.csv',csv(rows),'text/csv;charset=utf-8');
    }
  }catch(e){toast('書き出しに失敗しました：'+e.message);}
}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{tab(b.dataset.tab);void syncView();}));
document.querySelectorAll('[data-go-panel]').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.goPanel)));
for(const id of ['activityRange','activityFilter','activityWorld'])$(id).addEventListener('change',renderActivity);
let activitySearchDebounce;
$('activitySearch').addEventListener('input',()=>{
  clearTimeout(activitySearchDebounce);
  activitySearchDebounce=setTimeout(renderActivity,160);
});
$('emptySettings').addEventListener('click',()=>tab('settings'));
$('friendSort').addEventListener('change',render);$('rankingSort').addEventListener('change',renderInsights);
$('search').addEventListener('input',render);$('filter').addEventListener('change',render);
$('account').addEventListener('change',()=>{selectedAccount=$('account').value;void reload().then(()=>syncView());});
$('start').addEventListener('click',async()=>{if(await send({type:config.enabled?'PAUSE':'START'}))void reload();});
$('refresh').addEventListener('click',async()=>{if(await send({type:'POLL'}))toast('更新を開始しました。');});
$('settingsForm').addEventListener('input',()=>{dirty=true;$('settingsNotice').textContent='未保存';});
$('settingsForm').addEventListener('submit',async e=>{e.preventDefault();const values={};for(const id of ['contact','pollSeconds','retentionDays','offlineRefreshMinutes'])values[id]=$(id).value;
  if(Number(values.retentionDays)<config.retentionDays&&!confirm('保存期間を短くします。期間外の履歴が削除されます。続けますか？'))return;
  if(await send({type:'SAVE',settings:values})){dirty=false;$('settingsNotice').textContent='保存しました';await reload();}});
$('clear').addEventListener('click',async()=>{if(confirm('この端末の全アカウントの記録を削除し、収集・同期を停止します。スプレッドシートの記録は残り、同期を再開すると再取得されます。実行しますか？')&&await send({type:'CLEAR'})){await gameLog.clear();selectedAccount='';await reload();toast('全記録を削除しました。');}});
$('closeDetail').addEventListener('click',()=>$('detail').close());
$('detail').addEventListener('close',()=>{xProfileView.cancel();userNotes.cancel();});
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
    if(settings.enabled && !await chrome.permissions.request({origins:CLOUD_ORIGINS}))throw Error('Googleへの接続を許可すると同期を利用できます。');
    if(await send({type:'SAVE_SYNC',settings})) {syncDirty=false;$('syncToken').value='';$('syncNotice').textContent='保存しました';await reload();}else{$('syncNotice').textContent='保存できませんでした。接続権限と入力内容を確認してください。';}
  }catch(error){$('syncNotice').textContent=error.message;toast(error.message);await reload();}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void syncView();});
window.addEventListener('focus',()=>void syncView());

initializeGasGuide({showSettings:()=>tab('settings'),notify:toast});
initializeSettingsBackup({isDemo,download,stamp,call,onImported:async()=>{
  dirty=false;syncDirty=false;imageDirty=false;xFollowerDirty=false;$('syncToken').value='';
  for(const id of ['settingsNotice','syncNotice','imageNotice','xFollowerNotice'])$(id).textContent='';
  await reload();
}});

$('networkSort').addEventListener('change',renderJourney);$('networkSearch').addEventListener('input',renderJourney);
$('zoomIn').addEventListener('click',()=>network.zoomBy(1.4));$('zoomOut').addEventListener('click',()=>network.zoomBy(1/1.4));
$('fitNetwork').addEventListener('click',()=>network.fit());$('resetNetwork').addEventListener('click',()=>network.reset());
$('networkNode').addEventListener('change',()=>network.focus($('networkNode').value));$('networkEdge').addEventListener('change',()=>network.focus($('networkEdge').value));
$('imageForm').addEventListener('input',()=>{imageDirty=true;$('imageNotice').textContent='未保存';});
$('imageForm').addEventListener('submit',async event=>{event.preventDefault();if(isDemo){toast('デモ画面では画像を取得しません。');return;}const enabled=$('imageEnabled').checked;
  try{if(enabled&&!await chrome.permissions.request({origins:IMAGE_ORIGINS}))throw Error('画像取得の追加接続権限を許可してください。');if(await send({type:'SAVE_IMAGES',enabled})){imageDirty=false;$('imageNotice').textContent='保存しました。収集時に画像を順次取得します。';await reload();}}catch(error){toast(error.message);}
});
$('clearImages').addEventListener('click',async()=>{if(await send({type:'CLEAR_IMAGES'})){await reload();toast('画像キャッシュを削除しました。収集が有効なら次回以降に再取得します。');}});

$('testSync').addEventListener('click',async()=>{
  if(syncDirty){toast('入力したURL・同期キーを先に「同期設定を保存」で保存してください。接続テストは保存済みの設定を使います。');return;}
  testingConnection=true;renderCloud();
  try {showSyncSkip(await call({type:'TEST_SYNC'}));await reload();}
  finally {testingConnection=false;renderCloud();}
});
$('grantSyncPermissions').addEventListener('click',async()=>{
  if(isDemo)return;
  try {const allowed=await chrome.permissions.request({origins:CLOUD_ORIGINS});toast(allowed?'Googleへの接続を許可しました。接続テストを実行してください。':'接続権限が許可されませんでした。同期設定は変更していません。');await reload();}
  catch(error){toast(error.message);}
});
if(!isDemo){chrome.permissions?.onAdded?.addListener(()=>void reload());chrome.permissions?.onRemoved?.addListener(()=>void reload());}

$('xFollowerForm').addEventListener('input',()=>{xFollowerDirty=true;$('xFollowerNotice').textContent='未保存';$('xFollowerAccountField').hidden=$('xFollowerScope').value!=='all';});
$('xFollowerConcurrency').replaceChildren(...Array.from({length:MAX_X_CONCURRENCY},(_,i)=>new Option((i+1)+'件',String(i+1))));
$('xFollowerForm').addEventListener('submit',async event=>{
  event.preventDefault();if(isDemo){toast('デモ画面では設定を保存しません。');return;}
  try{const enabled=$('xFollowerEnabled').checked;
    if(enabled&&!await chrome.permissions.request({origins:X_FOLLOWER_ORIGINS}))throw Error('Xへの接続が許可されませんでした。');
    await call({type:'SAVE_X_FOLLOWERS',enabled,concurrency:Number($('xFollowerConcurrency').value),scope:$('xFollowerScope').value,bulkScope:$('xFollowerBulkScope').value,accountId:$('xFollowerAccount').value},{rethrow:true});xFollowerDirty=false;
    $('xFollowerNotice').textContent=enabled?'保存しました。Xプロフィールを開くとフォロワー数を記録します。':'取得を無効にしました。';await reload();
  }catch(error){$('xFollowerNotice').textContent=error.message;}
});

function renderSavedXProfiles(){
  const query=$('xSavedSearch').value.trim().toLowerCase(),sort=$('xSavedSort').value,key=JSON.stringify([selectedAccount,query,sort]);if(key!==xSavedKey){xSavedLimit=100;xSavedKey=key;}
  const compare={latest:(a,b)=>b.observedAt-a.observedAt,oldest:(a,b)=>a.observedAt-b.observedAt,'followers-desc':(a,b)=>b.followers-a.followers,'followers-asc':(a,b)=>a.followers-b.followers}[sort];
  const rows=Object.values(xMetrics).filter(v=>v.accountId===selectedAccount&&v.url.includes(query.replace(/^@/,''))).sort((a,b)=>compare(a,b)||a.url.localeCompare(b.url));
  $('xSavedCount').textContent=rows.length+'件';$('xSavedMore').hidden=rows.length<=xSavedLimit;const body=$('xSavedBody');body.replaceChildren();
  for(const row of rows.slice(0,xSavedLimit)){const tr=node('tr'),name=node('td'),a=node('a','@'+row.url.slice(14));a.href=row.url;a.target='_blank';a.rel='noopener noreferrer';name.append(a);tr.append(name,node('td',followerText(row)),node('td',date(row.observedAt)));body.append(tr);}
  if(!rows.length){const tr=node('tr'),td=node('td','このアカウント・検索条件の記録はありません。');td.colSpan=3;tr.append(td);body.append(tr);}
}
for(const id of ['xSavedSearch','xSavedSort'])$(id).addEventListener('input',renderSavedXProfiles);
$('showXHistogram').onclick=()=>{tab('friends');$('xFollowerHistogram').open=true;$('xFollowerHistogram').scrollIntoView({block:'start'});};
$('xSavedMore').onclick=()=>{xSavedLimit+=100;renderSavedXProfiles();};

async function enableXFollowers(){
  if(isDemo)throw Error('デモではXを開きません。');
  if(!await chrome.permissions.request({origins:X_FOLLOWER_ORIGINS}))throw Error('Xへの接続が許可されませんでした。');
  const result=await call({type:'SAVE_X_FOLLOWERS',enabled:true},{rethrow:true});xFollowerConfig=result.settings||{...xFollowerConfig,enabled:true};$('xFollowerEnabled').checked=true;
}
function renderXCollection(){
  const targets=followerTargets(xProfiles,xMetrics,selectedAccount,data.friends.filter(f=>f.isFriend).map(f=>f.id)),missing=targets.filter(t=>!t.observedAt).length,old=targets.filter(t=>t.observedAt&&Date.now()-t.observedAt>=86400000).length,q=xFollowerQueue;
  const active=activeFollowerJobs(q),scan=xFriendScan,scanning=!!scan.accountId&&!['complete','idle'].includes(scan.phase),scanRunning=scanning&&!scan.paused;
  for(const n of document.querySelectorAll('[data-x-discovery]')){n.hidden=!scan.accountId;n.textContent=`全フレンドのリンク確認：${scan.checked||0}/${scan.total||0}人 · リンクあり ${scan.withLinks||0}人 / なし ${scan.withoutLinks||0}人 / 未確認 ${scan.failed||0}人 / 対象外 ${scan.skipped||0}人 · ${scan.message||''}`;}
  for(const n of document.querySelectorAll('[data-x-discovery-errors]')){n.hidden=!scan.errors?.length;n.replaceChildren(node('summary','リンク未確認 '+(scan.errors?.length||0)+'人'),...((scan.errors||[]).slice(0,30).map(e=>node('p',e.userId+'：'+e.message))));}
  const progress=q.total?`取得キュー：${q.success||0}成功 / ${q.failed||0}未確認 / ${q.skipped||0}対象外（凍結・不存在 ${q.unavailable||0}件） / 全${q.total}件 · 残り ${(q.items?.length||0)+active.length}件 · 再試行 ${q.retries||0}件 · 同時取得 ${active.length}/${xConcurrency(xFollowerConfig.concurrency)}件${active.length?'（'+active.map(j=>'@'+j.url.slice(14)).join('・')+'）':''} · ${q.message||''}`:'取得を開始すると進捗を表示します。';
  for(const n of document.querySelectorAll('[data-x-queue]'))n.textContent=`対象 ${targets.length}件（未取得 ${missing}件・24時間以上前 ${old}件） · ${progress}`;
  for(const n of document.querySelectorAll('[data-x-errors]')){n.hidden=!q.errors?.length;n.replaceChildren(node('summary','未確認のプロフィール '+(q.errors?.length||0)+'件'),...((q.errors||[]).slice(0,30).map(e=>node('p',e.message))));if(q.errors?.length>30)n.append(node('p','ほか '+(q.errors.length-30)+'件'));}
  for(const b of document.querySelectorAll('[data-x-collect]'))b.disabled=isDemo||(!targets.length&&xBulkScope(xFollowerConfig.bulkScope)!=='friends')||!selectedAccount||scanRunning||['running','waiting'].includes(q.phase);
  for(const b of document.querySelectorAll('[data-x-pause]'))b.disabled=isDemo||!scanRunning&&(!active.length&&!q.items?.length||q.phase==='paused');
  for(const b of document.querySelectorAll('[data-x-resume]'))b.disabled=isDemo||!(scanning&&scan.paused)&&(!q.items?.length||q.phase!=='paused');
  for(const b of document.querySelectorAll('[data-x-reset]'))b.disabled=isDemo||!scanning&&!active.length&&!q.items?.length;
}
for(const b of document.querySelectorAll('[data-x-collect]'))b.addEventListener('click',async()=>{b.disabled=true;try{await enableXFollowers();const result=await call({type:'COLLECT_X_FOLLOWERS',accountId:selectedAccount},{rethrow:true});toast(result.skipped?'確認済みのXリンクがありません。':result.queue?.phase==='paused'?result.queue.message:'Xフォロワー数の取得を開始しました。');await reload();}catch(error){toast(error.message);}finally{renderXCollection();}});
for(const [selector,type] of [['[data-x-pause]','PAUSE_X_FOLLOWERS'],['[data-x-resume]','RESUME_X_FOLLOWERS'],['[data-x-reset]','CLEAR_X_QUEUE']])for(const b of document.querySelectorAll(selector))b.addEventListener('click',async()=>{try{if(type==='RESUME_X_FOLLOWERS')await enableXFollowers();await call({type},{rethrow:true});await reload();}catch(error){toast(error.message);}});
