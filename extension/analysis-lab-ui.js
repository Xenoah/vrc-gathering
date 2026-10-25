import { buildAnalysisReport, sharedWorldGraph, comparePeople, analysisCSV, jstDay, DAY, WEEKDAYS } from './analysis-lab.js';
import { formatObservedDuration } from './activity-analysis.js';
import { createNetworkView } from './network-view.js';
import { lineChart, barChart, donutChart, columnChart, comparisonChart, scatterChart } from './charts.js';

export function createAnalysisLab({node,date,download,imageFor}) {
  const $=id=>document.getElementById(id);
  let data={},accountId='',config={},report=null,graphData=null,selectedPair=null,tools=[],category='overview',filterKey='',shown=new Map(),sorts=new Map();
  const expanded=new Set(['firstEncounters','gaps','pair']);
  const duration=value=>value==null?'未確認':value===0?'0分':formatObservedDuration(Math.abs(value));
  const observedTime=value=>value>0?duration(value):'時間未確認';
  const signedTime=value=>(value<0?'−':value>0?'+':'')+duration(value);
  const number=value=>Number(value).toLocaleString('ja-JP',{maximumFractionDigits:1});
  const percent=value=>value==null?'比較元なし':number(value*100)+'%';
  const signed=value=>(value>0?'+':'')+number(value);
  const col=(key,label,format=null)=>({key,label,format});
  const graph=createNetworkView({viewport:$('labNetworkViewport'),stage:$('labNetworkStage'),canvas:$('labNetworkCanvas'),zoomLabel:$('labNetworkZoom'),imageFor,onSelect:item=>{
    if(item?.from){$('labPairA').value=item.from;$('labPairB').value=item.to;renderPair();}
    else if(item?.id){$('labPairA').value=item.id;renderPair();}
  }});
  const compareLabels={observations:'保存された観測点',users:'観測ユーザー数',worlds:'記録ワールド数',changes:'変更イベント',moves:'ワールド変更',selfVisits:'自分の訪問区間',selfDuration:'自分の観測時間',companions:'同席ユーザー数'};
  const categories={overview:'概要・比較',time:'時間帯',world:'ワールド',movement:'移動',self:'自分の行動',people:'つながり',quality:'記録の内訳・品質',all:'すべて'};

  function choices(select,entries,initialLabel) {
    const previous=select.value;select.replaceChildren(...(initialLabel?[new Option(initialLabel,'')]:[]),...entries.map(([id,name])=>new Option(name,id)));
    if(entries.some(([id])=>id===previous))select.value=previous;
  }
  function updateChoices() {
    const people=new Map(),worlds=new Map(),names=new Map((data.worlds||[]).filter(w=>!w.accountId||w.accountId===accountId).map(w=>[w.id,w.name]));
    const addWorld=location=>{if(location?.kind==='world')worlds.set(location.worldId,names.get(location.worldId)||location.worldId);};
    for(const f of data.friends||[])if(f.accountId===accountId){people.set(f.id,f.displayName);addWorld(f.location);}
    for(const e of data.journeyEvents||data.events||[])if(e.accountId===accountId){if(!people.has(e.userId))people.set(e.userId,e.displayName);addWorld(e.current?.location);addWorld(e.previous?.location);}
    for(const v of [...(data.visits||[]),...(data.encounters||[])])if(v.accountId===accountId)addWorld(v.location);
    const sorted=map=>[...map].sort((a,b)=>a[1].localeCompare(b[1],'ja'));
    choices($('labUser'),sorted(people),'全フレンド');choices($('labWorld'),sorted(worlds),'すべてのワールド');
  }
  function range() {
    const now=Date.now(),value=$('labRange').value;
    if(value!=='custom')return {now,since:now-Number(value)*DAY,until:now+1};
    const since=Date.parse($('labStart').value+'T00:00:00+09:00'),until=Date.parse($('labEnd').value+'T00:00:00+09:00')+DAY;
    if(!Number.isFinite(since)||!Number.isFinite(until)||since>=until)throw Error('開始日と終了日を正しく指定してください。');
    return {now,since,until};
  }
  function customRange(day) {
    $('labRange').value='custom';$('labStart').value=day;$('labEnd').value=day;$('labCustomDates').hidden=false;calculate();
  }
  function calculate() {
    if($('labPanel').hidden)return;
    try {
      report=buildAnalysisReport(data,{accountId,pollSeconds:config.pollSeconds,userId:$('labUser').value,worldId:$('labWorld').value,...range()});
      const key=JSON.stringify([accountId,$('labUser').value,$('labWorld').value,$('labRange').value,$('labStart').value,$('labEnd').value]);
      if(key!==filterKey){shown.clear();filterKey=key;}
      $('labError').hidden=true;$('labResults').hidden=false;$('labExportJSON').disabled=false;$('labExportCSV').disabled=false;
      render();
    } catch(error) {
      report=null;$('labError').textContent=error.message;$('labError').hidden=false;$('labResults').hidden=true;$('labExportJSON').disabled=true;$('labExportCSV').disabled=true;
    }
  }
  function makeTools() {
    const r=report,tool=(id,category,title,note,rows,columns)=>({id,category,title,note,rows,columns});
    const compare=Object.entries(compareLabels).map(([id,name])=>({id,name,current:r.metrics[id],previous:r.previousMetrics[id],delta:r.metrics[id]-r.previousMetrics[id]}));
    const comparisonFormat=(value,row)=>row.id==='selfDuration'?duration(value):number(value);
    const timeColumns=[col('observations','観測点'),col('users','ユーザー'),col('changes','変更'),col('moves','ワールド変更'),col('selfDuration','自分の時間',duration)];
    const networkRows=graphData.edges.map(e=>({name:report.people.find(p=>p.id===e.from)?.name,other:report.people.find(p=>p.id===e.to)?.name,count:e.count,worlds:e.worlds.map(id=>r.worldNames[id]||id).join(' / ')}));
    return [
      tool('comparison','overview','同じ長さの前期間と比較','前期に収集されていない場合も0になります。増減は保存範囲と収集頻度に影響されます。',compare,[col('name','指標'),col('current','今期',comparisonFormat),col('previous','前期',comparisonFormat),col('delta','差分',(v,row)=>row.id==='selfDuration'?signedTime(v):signed(v))]),
      tool('daily','overview','日別の変化・観測カレンダー','グラフの日付を選ぶと、その日の分析に絞り込めます。観測点は在室人数ではありません。',r.daily,[col('day','日付（JST）'),...timeColumns,col('companions','同席相手')]),
      tool('heatmap','time','曜日 × 時間帯ヒートマップ','JST。保存された変更イベントの分布です。空白は未観測の場合があり、活動していなかったことを意味しません。',r.heatmap,[col('day','曜日',v=>WEEKDAYS[v]),col('hour','時台'),col('changes','変更'),col('observations','観測点'),col('users','ユーザー')]),
      tool('hourly','time','時間帯別の傾向','自分の時間は区間を時刻の境界で分割し、重複観測を除いて集計します。',r.hourly,[col('hour','時台（JST）'),...timeColumns]),
      tool('weekdays','time','曜日別の傾向','期間中の合計。曜日ごとの日数や収集頻度は同一とは限りません。',r.weekdays,[col('name','曜日'),...timeColumns]),
      tool('worlds','world','ワールド別の観測・流入・流出','ユーザー数は期間内の公開ワールド観測のユニーク数。流入・流出は場所が確認できた前後の変更件数です。',r.worlds,[col('name','ワールド'),col('users','ユーザー'),col('observations','観測点'),col('arrivals','流入'),col('departures','流出'),col('selfVisits','自分の区間'),col('companions','同席相手')]),
      tool('currentWorlds','world','現在の注目ワールド','期間指定にかかわらず、鮮度が有効な最新の公開ワールドだけを集計します。',r.currentWorlds,[col('name','ワールド'),col('users','滞在フレンド'),col('instances','確認インスタンス')]),
      tool('worldGrowth','overview','ワールドの注目度の変化','観測されたユニークユーザー数を前期と比較。前期0の場合、増減率は算出しません。',r.worldGrowth,[col('name','ワールド'),col('current','今期の人'),col('previous','前期の人'),col('delta','差分',signed),col('change','増減率',percent)]),
      tool('routes','movement','よく観測された移動経路','間の経路は不明です。「近接」は前後の観測間隔が収集設定の許容幅内だった件数です。',r.routes,[col('name','ワールド変更'),col('count','件数'),col('users','ユーザー'),col('nearby','近接観測'),col('lastSeenAt','最終観測',date)]),
      tool('roundTrips','movement','往復パターン','観測順にA→B→Aが続いた記録。途中にプライベートなどがあれば接続しません。実際の全移動経路ではありません。',r.roundTrips,[col('name','ユーザー'),col('route','観測順'),col('count','回数'),col('lastSeenAt','最終観測',date)]),
      tool('explorers','movement','ユーザー別の探索傾向','変更履歴のあるユーザーほど観測点が多くなります。活動時間のランキングではありません。',r.people,[col('name','ユーザー'),col('worlds','ワールド数',v=>v.length),col('moves','ワールド変更'),col('days','観測日数'),col('changes','変更イベント'),col('observations','観測点')]),
      tool('selfWorlds','self','自分の再訪・滞在傾向','自分の公開ワールド区間。再訪間隔は前の区間の最終観測から次の開始まで。インスタンス変更も別区間です。',r.selfWorlds,[col('name','ワールド'),col('visits','訪問区間'),col('returns','2回目以降'),col('duration','推定時間',observedTime),col('medianGap','再訪間隔の中央値',duration)]),
      tool('dwell','self','自分の滞在区間の分布','1回だけの観測は「時間未確認」に分け、長さの統計から除外します。',r.dwell,[col('name','観測区間の長さ'),col('count','区間数')]),
      tool('dwellStats','self','滞在時間の統計','公開ワールドの区間ごとの長さです。90パーセンタイルは90%の区間が収まる長さです。',[
        {name:'時間を算出できる区間',value:r.dwellStats.confirmed,unit:'件'},{name:'時間未確認の区間',value:r.dwellStats.unconfirmed,unit:'件'},
        {name:'平均',value:r.dwellStats.mean,unit:'時間'},{name:'中央値',value:r.dwellStats.median,unit:'時間'},{name:'90パーセンタイル',value:r.dwellStats.p90,unit:'時間'}],[col('name','指標'),col('value','値',(v,row)=>row.unit==='時間'?duration(v):number(v)+'件')]),
      tool('company','self','同席を確認できた時間の割合','自分の訪問区間と同じインスタンスの同席区間の重なり。未確認時間は一人だった時間とは限りません。相手指定時はその人との重なりです。',[
        {name:'同席を確認できた推定時間',duration:r.company.together},{name:'同席を確認できない観測時間',duration:r.company.unconfirmed}],
        [col('name','区分'),col('duration','時間',duration),col('duration','構成比',v=>r.metrics.selfDuration?percent(v/r.metrics.selfDuration):'未確認')]),
      tool('connections','people','同席相手ランキング','同じインスタンスの観測区間のみ。複数端末からの重なる区間は合算せず、重複を除きます。',r.connections,[col('name','ユーザー'),col('count','区間数'),col('duration','推定時間',observedTime),col('worlds','共通ワールド数',v=>v.length),col('lastSeenAt','最終観測',date)]),
      tool('connectionChanges','people','つながりの変化','同席区間の回数・推定時間を前期と比較。未観測だけで交流が減ったとは判断できません。',r.connectionChanges,[col('name','ユーザー'),col('current','今期の区間'),col('previous','前期の区間'),col('delta','差分',signed),col('durationDelta','時間差',signedTime),col('cohort','観測期間')]),
      tool('cohorts','people','継続・今期のみ・前期のみの同席','両期間に記録があるかで分類します。フレンド追加や関係の開始・終了を示すものではありません。',r.cohorts,[col('name','分類'),col('count','ユーザー')]),
      tool('firstEncounters','people','保存範囲で初めて同席した相手','保存されている履歴で最初の同席が今期だった相手。実際の初対面を意味しません。',r.firstEncounters,[col('name','ユーザー'),col('at','最初の同席観測',date),col('world','ワールド')]),
      tool('connectionWorlds','people','人と重なるワールド','同席ユーザー数・区間数・延べ時間。延べ時間は相手ごとの時間を足すため、同時にいた人数分が含まれます。',r.connectionWorlds,[col('name','ワールド'),col('users','同席相手'),col('count','区間数'),col('duration','延べ推定時間',duration)]),
      tool('network','people','共通ワールドネットワーク','線は共通する公開ワールドの数です。同時刻の同席やフレンド関係を意味しません。この図・表・出力は観測ワールド数順に最大80人が対象です。',networkRows,[col('name','ユーザーA'),col('other','ユーザーB'),col('count','共通数'),col('worlds','ワールド')]),
      tool('groups','people','共通ワールドでつながるグループ','ネットワークの線で間接的につながる集合。全員が同じ場所にいたことや、実際のコミュニティを示しません。',graphData.groups.map((ids,i)=>({name:'集合 '+(i+1),count:ids.length,members:ids.map(id=>r.people.find(p=>p.id===id)?.name||id).join(' / ')})),[col('name','集合'),col('count','人数'),col('members','ユーザー')]),
      tool('pair','people','2ユーザーのワールド比較','共通ワールドとJaccard係数（共通数 ÷ 両者のワールドの和集合）。同席・親密さの指標ではありません。',[],[col('name','共通ワールド'),col('id','ワールドID')]),
      tool('states','quality','観測された状態の内訳','保存された観測点の件数です。状態ごとの在室時間・割合ではありません。',r.states,[col('name','状態'),col('count','観測点')]),
      tool('platforms','quality','プラットフォーム分布','観測点の件数。ユーザー数や利用時間ではありません。',r.platforms,[col('name','プラットフォーム'),col('count','観測点')]),
      tool('access','quality','インスタンス公開範囲の内訳','公開ワールドとして取得できた観測点のみ。private状態を特定の場所に割り当てません。',r.access,[col('name','公開範囲'),col('count','観測点')]),
      tool('regions','quality','リージョン分布','公開ワールドのインスタンス情報から取得できた地域です。',r.regions,[col('name','リージョン'),col('count','観測点')]),
      tool('changeFields','quality','何が変わったか','1イベントで複数項目が変わるため、合計は変更イベント数と一致しない場合があります。',r.changeFields,[col('name','変更項目'),col('count','件数')]),
      tool('freshness','quality','最新記録の鮮度','期間指定によらず最新スナップショットを分類。古い記録は現在の滞在として扱いません。',r.quality.freshness,[col('name','鮮度'),col('count','フレンド')]),
      tool('coverage','quality','収集履歴の充足状況','収集記録はアカウント全体。完了した巡回のみ記録されるため、失敗率は計算できません。',[
        {name:'保存された巡回',value:number(r.quality.runs)+'件'},{name:'オンライン一覧を最後まで取得した巡回',value:number(r.quality.completeRuns)+'件'},
        {name:'収集記録のある日',value:r.quality.runDays+' / '+r.quality.days+'日'},{name:'全保存範囲の最終巡回',value:date(r.quality.lastRunAt)},
        {name:'同ワールドだがインスタンス一致未確認の区間',value:number(r.quality.worldOnly)+'件'}],[col('name','指標'),col('value','値')]),
      tool('gaps','quality','収集記録の長い空白','保存された巡回間の空白です。停止・スリープ・未取得などの原因は判別できません。期間両端の未観測部分は含みません。',r.quality.gaps,[col('start','前の巡回終了',date),col('end','次の巡回開始',date),col('duration','空白時間',duration)])
    ];
  }
  const valueOf=(column,row)=>column.format?column.format(row[column.key],row):row[column.key]??'—';
  function exportTable(tool) { download('vrc-analysis-'+tool.id+'.csv',analysisCSV([tool.columns.map(c=>c.label),...tool.rows.map(row=>tool.columns.map(c=>valueOf(c,row)))]),'text/csv;charset=utf-8'); }
  function renderTable(holder,tool) {
    holder.replaceChildren();const wrapper=node('div',null,'table-wrap'),table=node('table'),head=node('thead'),headRow=node('tr'),body=node('tbody'),ordering=sorts.get(tool.id);
    const rows=[...tool.rows];
    if(ordering)rows.sort((a,b)=>{let x=a[ordering.key],y=b[ordering.key];if(Array.isArray(x))x=x.length;if(Array.isArray(y))y=y.length;return (typeof x==='number'&&typeof y==='number'?x-y:String(x??'').localeCompare(String(y??''),'ja'))*ordering.direction;});
    for(const c of tool.columns) {const th=node('th'),button=node('button',c.label+(ordering?.key===c.key?(ordering.direction>0?' ↑':' ↓'):''),'lab-sort');button.type='button';button.addEventListener('click',()=>{sorts.set(tool.id,{key:c.key,direction:ordering?.key===c.key?-ordering.direction:typeof rows[0]?.[c.key]==='string'?1:-1});renderTable(holder,tool);});th.append(button);headRow.append(th);}
    head.append(headRow);
    const limit=shown.get(tool.id)||50;
    for(const row of rows.slice(0,limit)){const tr=node('tr');for(const c of tool.columns)tr.append(node('td',String(valueOf(c,row))));body.append(tr);}
    if(!rows.length){const tr=node('tr'),td=node('td','この条件の記録はありません。');td.colSpan=tool.columns.length;tr.append(td);body.append(tr);}
    table.append(head,body);wrapper.append(table);holder.append(wrapper);
    if(rows.length>limit){const button=node('button',`さらに50件表示（${limit} / ${rows.length}件）`,'lab-more');button.addEventListener('click',()=>{shown.set(tool.id,limit+50);renderTable(holder,tool);});holder.append(button);}
  }
  function dailyChart(holder) {
    const metric=$('labDailyMetric').value;
    lineChart(holder,report.daily,{label:'日別の観測傾向',series:[{key:metric,label:$('labDailyMetric').selectedOptions[0].textContent}],format:metric==='selfDuration'?duration:number,onSelect:day=>customRange(day.day),pointClass:'lab-day'});
  }
  function toolChart(holder,tool) {
    const options={label:tool.title};
    if(tool.id==='daily'){dailyChart(holder);return;}
    if(tool.id==='comparison'){comparisonChart(holder,tool.rows,{...options,format:(v,r)=>r.id==='selfDuration'?duration(v):number(v)});return;}
    if(tool.id==='explorers'){scatterChart(holder,tool.rows,{...options,onSelect:row=>{$('labUser').value=row.id;calculate();}});return;}
    if(['hourly','weekdays'].includes(tool.id)){columnChart(holder,tool.rows,options);return;}
    if(['states','platforms','regions','access','freshness','cohorts','company'].includes(tool.id)){donutChart(holder,tool.rows,{...options,...(tool.id==='company'?{key:'duration',format:duration,unit:'推定時間'}:{})});return;}
    const keys={worlds:'users',currentWorlds:'users',worldGrowth:'delta',routes:'count',roundTrips:'count',selfWorlds:'duration',dwell:'count',connections:'duration',connectionChanges:'delta',connectionWorlds:'users',groups:'count',changeFields:'count'};
    if(keys[tool.id])barChart(holder,tool.id==='roundTrips'?tool.rows.map(row=>({...row,name:row.name+' · '+row.route})):tool.rows,{...options,key:keys[tool.id],signed:keys[tool.id]==='delta',format:keys[tool.id]==='duration'?observedTime:number});
    if(tool.id==='dwellStats'||tool.id==='coverage'){
      const list=node('div',null,'chart-facts');for(const row of tool.rows){const item=node('div');item.append(node('span',row.name),node('strong',String(valueOf(tool.columns[1],row))));list.append(item);}holder.append(list);
    }
  }
  function heatmap(holder) {
    const grid=node('div',null,'lab-heatmap'),max=Math.max(1,...report.heatmap.map(d=>d.changes));grid.setAttribute('role','table');grid.setAttribute('aria-label','曜日別・時間帯別の変更件数');
    grid.append(node('span','JST'));for(let h=0;h<24;h++)grid.append(node('span',String(h)));
    for(let d=0;d<7;d++){grid.append(node('strong',WEEKDAYS[d]));for(let h=0;h<24;h++){const cell=report.heatmap[d*24+h],button=node('button',String(cell.changes),'lab-heat');button.style.backgroundColor=`color-mix(in srgb, var(--chart-cyan) ${Math.round(cell.changes/max*85)}%, var(--chart-track))`;button.style.color=cell.changes/max>.5?'#061e25':'var(--muted)';button.title=WEEKDAYS[d]+'曜日 '+h+'時：'+cell.changes+'変更 / '+cell.users+'ユーザー';button.setAttribute('aria-label',button.title);button.addEventListener('click',()=>{$('labHeatDetail').textContent=button.title+' / '+cell.observations+'観測点';});grid.append(button);}}
    holder.append(grid,node('p','セルを選ぶと件数を表示します。','lab-detail'));holder.lastChild.id='labHeatDetail';
  }
  function renderCards() {
    const holder=$('labCards');
    // Read the live state before replacing cards; details.toggle can be delivered after a refresh.
    for(const card of holder.children){const details=card.querySelector('.lab-data');if(details?.open)expanded.add(card.dataset.tool);else expanded.delete(card.dataset.tool);}
    holder.replaceChildren();
    for(const tool of tools) {
      const card=node('section',null,'lab-card');card.dataset.tool=tool.id;card.dataset.category=tool.category;card.dataset.search=tool.title+' '+tool.note;
      const heading=node('div',null,'lab-card-heading'),text=node('div'),csv=node('button','CSV');text.append(node('span',categories[tool.category],'eyebrow'),node('h3',tool.title));heading.append(text,csv);csv.addEventListener('click',()=>exportTable(tool));
      card.append(heading,node('p',tool.note,'lab-note'));
      toolChart(card,tool);
      if(tool.id==='heatmap'){const overflow=node('div',null,'lab-scroll');heatmap(overflow);card.append(overflow);}
      if(tool.id==='network') {const block=$('labNetworkBlock');block.hidden=false;card.append(block);}
      if(tool.id==='pair'){const block=$('labPairBlock');block.hidden=false;card.append(block);}
      const table=node('div');table.id='labTable-'+tool.id;renderTable(table,tool);
      const details=node('details',null,'lab-data'),summary=node('summary','データを表示 · '+tool.rows.length+'件');
      details.open=expanded.has(tool.id);
      details.append(summary,table);card.append(details);holder.append(card);
    }
    applyVisibility();
  }
  function renderPair() {
    if(!report)return;
    selectedPair=comparePeople(report.people,$('labPairA').value,$('labPairB').value,new Map(Object.entries(report.worldNames)));
    $('labPairSummary').textContent=selectedPair?`${selectedPair.first} × ${selectedPair.second}：共通 ${selectedPair.shared.length}ワールド · 類似度 ${percent(selectedPair.similarity)} · 共通の観測時間帯 ${selectedPair.sharedHours.map(h=>h+'時').join('、')||'なし'}（同じ日・時刻とは限りません）`:'異なる2人を選択してください。';
    $('labNetworkSelection').textContent=selectedPair?`${selectedPair.first} × ${selectedPair.second}：${selectedPair.shared.map(w=>w.name).join(' / ')||'共通ワールドなし'}`:'図の点・線を選ぶと共通ワールドを表示します。';
    const tool=tools.find(t=>t.id==='pair');if(tool){tool.rows=selectedPair?.shared||[];const holder=$('labTable-pair');if(holder){renderTable(holder,tool);holder.previousElementSibling.textContent='データを表示 · '+tool.rows.length+'件';}}
  }
  function applyVisibility() {
    const query=$('labToolSearch').value.trim().toLocaleLowerCase();let count=0;
    for(const card of $('labCards').children){card.hidden=!(category==='all'||card.dataset.category===category)||!!query&&!card.dataset.search.toLocaleLowerCase().includes(query);if(!card.hidden)count++;}
    $('labToolCount').textContent=`${tools.length}種類の分析 · 表示 ${count}件`;
    $('labNoTools').hidden=count>0;
    for(const button of $('labCategories').children){button.classList.toggle('selected',button.dataset.category===category);button.setAttribute('aria-pressed',String(button.dataset.category===category));}
    graph.redraw();
  }
  function render() {
    $('labSummary').textContent=`${date(report.range.since)} ～ ${date(report.range.until-1)}（JST） · ${report.metrics.observations}観測点 / ${report.metrics.users}ユーザー / ${report.metrics.worlds}ワールド。前期：${date(report.range.previousSince)} ～ ${date(report.range.previousUntil-1)}。`;
    const kpis=$('labKPIs');kpis.replaceChildren();for(const id of ['users','worlds','moves','selfDuration','companions','selfVisits']){const card=node('div');card.append(node('span',compareLabels[id]),node('strong',id==='selfDuration'?duration(report.metrics[id]):number(report.metrics[id])),node('small','前期 '+(id==='selfDuration'?duration(report.previousMetrics[id]):number(report.previousMetrics[id]))));kpis.append(card);}
    graphData=sharedWorldGraph(report.people,{limit:$('labGraphLimit').value,minShared:$('labGraphMinimum').value});
    // Preserve the interactive blocks before replacing the card container.
    for(const id of ['labNetworkBlock','labPairBlock'])$('labParking').append($(id));
    const people=report.people.map(p=>[p.id,p.name]);choices($('labPairA'),people);choices($('labPairB'),people);
    if($('labPairA').value===$('labPairB').value && people.length>1)$('labPairB').value=people.find(([id])=>id!==$('labPairA').value)[0];
    tools=makeTools();renderCards();renderPair();
    $('labNetworkSummary').textContent=`公開ワールド記録がある ${graphData.total}人中 ${graphData.nodes.length}人 / ${graphData.edges.length}本の線。共通${graphData.minShared}ワールド以上。図の線を選ぶと2ユーザー比較を更新します。`;
    graph.setGraph(graphData,JSON.stringify([report.accountId,report.filters,$('labRange').value,$('labStart').value,$('labEnd').value,graphData.limit,graphData.minShared]));
  }
  for(const [key,label] of Object.entries(categories)){const button=node('button',label);button.dataset.category=key;button.addEventListener('click',()=>{category=key;applyVisibility();});$('labCategories').append(button);}
  $('labRange').addEventListener('change',()=>{$('labCustomDates').hidden=$('labRange').value!=='custom';if($('labRange').value!=='custom')calculate();});
  $('labApply').addEventListener('click',calculate);
  for(const id of ['labUser','labWorld'])$(id).addEventListener('change',calculate);
  $('labToolSearch').addEventListener('input',applyVisibility);
  $('labDailyMetric').addEventListener('change',()=>{if(report)render();});
  for(const id of ['labGraphLimit','labGraphMinimum'])$(id).addEventListener('change',()=>{if(report)render();});
  for(const id of ['labPairA','labPairB'])$(id).addEventListener('change',renderPair);
  $('labNetworkIn').addEventListener('click',()=>graph.zoomBy(1.4));$('labNetworkOut').addEventListener('click',()=>graph.zoomBy(1/1.4));$('labNetworkFit').addEventListener('click',()=>graph.fit());
  $('labExportJSON').addEventListener('click',()=>{if(report)download('vrc-analysis-report.json',JSON.stringify({...report,sharedWorldNetwork:graphData,pairComparison:selectedPair},null,2),'application/json');});
  $('labExportCSV').addEventListener('click',()=>{if(report)download('vrc-analysis-report.csv',analysisCSV([['分析','行','項目','値'],
    ...Object.entries({accountId:report.accountId,since:new Date(report.range.since).toISOString(),until:new Date(report.range.until).toISOString(),timezone:report.timezone,userId:report.filters.userId,worldId:report.filters.worldId,networkLimit:graphData.limit,networkMinimum:graphData.minShared}).map(([key,value])=>['集計条件','',key,value]),
    ...tools.flatMap(t=>t.rows.flatMap((row,i)=>t.columns.map(c=>[t.title,i+1,c.label,valueOf(c,row)])))]),'text/csv;charset=utf-8');});
  $('labStart').value=jstDay(Date.now()-6*DAY);$('labEnd').value=jstDay(Date.now());
  return {update(next,account,settings){const changed=accountId!==account;data=next;accountId=account;config=settings;if(changed){$('labUser').value='';$('labWorld').value='';}if(!$('labPanel').hidden){updateChoices();calculate();}},
    explore({day,worldId,userId,section='overview'}={}){category=section;$('labToolSearch').value='';$('labUser').value=userId||'';$('labWorld').value=worldId||'';if(day)customRange(day);else{$('labRange').value='7';$('labCustomDates').hidden=true;calculate();}},redraw:()=>graph.redraw()};
}
