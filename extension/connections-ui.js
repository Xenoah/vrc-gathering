import { connectionSummary, connectionGraph, observationGap } from './connections.js';
import { formatObservedDuration } from './activity-analysis.js';
import { createNetworkView } from './network-view.js';

export function createConnectionsView({node,date,imageFor,avatar}) {
  const $=id=>document.getElementById(id);
  let data={},accountId='',config={},rows=[],shown=100,visitsShown=100,selected='',renderKey='';
  const graph=createNetworkView({viewport:$('connectionsViewport'),stage:$('connectionsStage'),canvas:$('connectionsCanvas'),zoomLabel:$('connectionsZoom'),imageFor,
    onSelect:item=>{selected=item?.connection?.id || '';renderDetail(item?.connection);}});
  const worldName=id=>data.worlds?.find(w=>w.id===id)?.name || id;
  const duration=value=>value>0?formatObservedDuration(value):'時間未確認';
  const locationName=visit=>visit.location.kind==='world'?worldName(visit.location.worldId):({private:'所在非公開',offline:'オフライン',web:'Web／アプリ',traveling:'移動中',unknown:'現在地を取得できませんでした'}[visit.location.kind]||'不明');
  function renderDetail(row) {
    const holder=$('connectionDetail');holder.replaceChildren();
    if(!row){holder.append(node('p','ユーザー名や図の点・線を選ぶと、同席の根拠を表示します。'));return;}
    holder.append(node('h3',row.name+'との観測'),node('p',row.count+'区間 · '+row.worlds.size+'ワールド · 重なり時間 '+duration(row.duration)));
    const list=node('ol');
    for(const session of row.sessions.slice(0,100)) {
      const r=session.row,li=node('li');
      li.append(node('strong',worldName(r.location.worldId)),node('span',`${date(session.start)} ～ ${date(session.end)} · ${r.relation==='instance'?'同じインスタンス':'同じワールド（一致未確認）'}`,'sub'),
        node('span','自分：'+(r.location.instanceId||'不明')+' / 相手：'+(r.otherInstanceId||'不明'),'sub'));
      list.append(li);
    }
    holder.append(list);
    if(row.sessions.length>100)holder.append(node('p','最新100区間を表示しています。全履歴JSONにはすべて含まれます。'));
  }
  function render() {
    if($('connectionsPanel').hidden)return;
    const now=Date.now(),days=Number($('connectionsRange').value),since=days?now-days*86400000:0;
    const visits=(data.visits||[]).filter(v=>v.accountId===accountId).sort((a,b)=>b.lastSeenAt-a.lastSeenAt||b.startedAt-a.startedAt);
    const current=visits[0];
    $('selfStatus').textContent=current?`自分の最終観測：${locationName(current)} · ${date(current.lastSeenAt)}${now-current.lastSeenAt>observationGap(config.pollSeconds)?'（古い観測）':''}`:'自分の履歴はまだありません。収集を開始すると記録します。APIが現在地を返さない場合は不明として記録します。';
    const select=$('connectionsWorld'),previous=select.value,worlds=new Map();
    for(const v of [...visits,...(data.encounters||[])])if(v.accountId===accountId && v.location.kind==='world')worlds.set(v.location.worldId,worldName(v.location.worldId));
    select.replaceChildren(new Option('すべて',''),...[...worlds].sort((a,b)=>a[1].localeCompare(b[1],'ja')).map(([id,name])=>new Option(name,id)));
    if(worlds.has(previous))select.value=previous;
    const params={accountId,since,now,relation:$('connectionsRelation').value,worldId:select.value,query:$('connectionsSearch').value,sort:$('connectionsSort').value};
    const key=JSON.stringify([accountId,days,params.relation,params.worldId,params.query,params.sort]);
    if(renderKey!==key){shown=100;visitsShown=100;selected='';renderKey=key;}
    rows=connectionSummary(data.encounters||[],params);
    $('connectionsSummary').textContent=rows.length+'ユーザー · 線の太さは観測区間の回数です。回数・時間は交流の強さそのものではありません。';
    graph.setGraph(connectionGraph(rows,accountId,current?.displayName || '自分'),key);
    const body=$('connectionsBody');body.replaceChildren();
    for(const row of rows.slice(0,shown)) {
      const tr=node('tr'),name=node('td'),button=node('button');button.append(avatar('user',row.id,row.name),node('span',row.name));
      button.addEventListener('click',()=>graph.focus(row.id));name.append(button);
      tr.append(name,node('td',String(row.count)),node('td',duration(row.duration)),node('td',String(row.worlds.size)),node('td',date(row.lastSeenAt)));body.append(tr);
    }
    if(!rows.length){const tr=node('tr'),td=node('td','この条件で重なった記録はありません。');td.colSpan=5;tr.append(td);body.append(tr);}
    $('connectionsMore').hidden=rows.length<=shown;
    renderDetail(rows.find(row=>row.id===selected));
    const filtered=visits.filter(v=>v.lastSeenAt>=since && v.startedAt<=now && (!params.worldId || v.location.worldId===params.worldId));
    const holder=$('selfVisits');holder.replaceChildren();
    for(const visit of filtered.slice(0,visitsShown)) {
      const row=node('article');row.append(node('strong',locationName(visit)),
        node('span',date(Math.max(visit.startedAt,since))+' ～ '+date(Math.min(visit.lastSeenAt,now))+' · '+duration(Math.min(visit.lastSeenAt,now)-Math.max(visit.startedAt,since)),'sub'));
      if(visit.location.instanceId)row.append(node('span',visit.location.instanceId,'sub'));
      holder.append(row);
    }
    if(!filtered.length)holder.append(node('p','この期間の訪問記録はありません。','activity-empty'));
    $('visitsMore').hidden=filtered.length<=visitsShown;
  }
  for(const id of ['connectionsRange','connectionsRelation','connectionsWorld','connectionsSort'])$(id).addEventListener('change',render);
  let timer;$('connectionsSearch').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(render,160);});
  $('connectionsMore').addEventListener('click',()=>{shown+=100;render();});$('visitsMore').addEventListener('click',()=>{visitsShown+=100;render();});
  $('connectionsZoomIn').addEventListener('click',()=>graph.zoomBy(1.4));$('connectionsZoomOut').addEventListener('click',()=>graph.zoomBy(1/1.4));$('connectionsFit').addEventListener('click',()=>graph.fit());
  return {update(next,account,settings){data=next;accountId=account;config=settings;render();},render,redraw:()=>graph.redraw()};
}
