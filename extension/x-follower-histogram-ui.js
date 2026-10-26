import {followerHistogram} from './x-follower-histogram.js';
import {followerText} from './x-followers.js';
import {csv} from './core.js';

export function createFollowerHistogram({root,node,date,download}) {
  const $=id=>root.querySelector('[data-histogram="'+id+'"]'),NS='http://www.w3.org/2000/svg';
  let input={},report={rows:[],bins:[]},selection=null,shown=100,account='',dirty=true;
  const num=value=>value.toLocaleString('ja-JP',{maximumFractionDigits:1});
  function svg(tag,attrs={},text){const n=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attrs))n.setAttribute(key,value);if(text!=null)n.textContent=text;return n;}
  function select(bin){selection=bin;shown=100;renderList();for(const mark of $('plot').querySelectorAll('[role="button"]'))mark.setAttribute('aria-pressed',String(Number(mark.dataset.min)===bin.min));}
  function renderList(){
    const rows=selection?report.rows.filter(r=>r.followers>=selection.min&&r.followers<=selection.max):[];
    $('selection').textContent=selection?selection.label+'人：'+num(rows.length)+'アカウント':'棒を選ぶと、この範囲のXアカウントを表示します。';
    $('listWrap').hidden=!selection;$('more').hidden=rows.length<=shown;$('list').replaceChildren();
    for(const row of rows.slice(0,shown)){
      const tr=node('tr'),td=node('td'),link=node('a','@'+row.url.slice(14));link.href=row.url;link.target='_blank';link.rel='noopener noreferrer';td.append(link);tr.append(td,node('td',followerText(row)),node('td',date(row.observedAt)));$('list').append(tr);
    }
    if(selection&&!rows.length){const td=node('td','この範囲の記録はありません。');td.colSpan=3;const tr=node('tr');tr.append(td);$('list').append(tr);}
  }
  function render(){
    if(!root.open)return;dirty=false;
    const scale=$('scale').value,binCount=Number($('bins').value);$('binField').hidden=scale!=='linear';
    report=followerHistogram(input.metrics,input.profiles,{accountId:account,friends:input.friends,scope:$('scope').value,scale,binCount});
    $('summary').textContent=`取得済み ${num(report.total)}アカウント · 未取得のXリンク ${num(report.missing)}件 · 概数 ${num(report.approximate)}件`+(report.total?` · 中央値 ${num(report.median)}人 · 最大 ${num(report.max)}人`:'');
    $('dates').textContent=report.total?'保存済みの最新値で集計 · 確認日時 '+date(report.oldest)+'〜'+date(report.newest)+'（JST） · 未取得は除外、0人は含む。':'Xフォロワー数を取得すると表示します。';
    $('csv').disabled=!report.total;$('plot').replaceChildren();$('table').replaceChildren();
    if(!report.total){$('plot').append(node('p','この対象には取得済みのフォロワー数がありません。','chart-empty'));selection=null;renderList();return;}
    const plot=svg('svg',{viewBox:'0 0 760 286',class:'x-histogram-plot','aria-label':'Xフォロワー数の分布'}),left=62,right=742,top=26,bottom=220;
    const peak=Math.max(...report.bins.map(b=>b.count)),tick=Math.max(1,Math.ceil(peak/4)),yMax=tick*Math.ceil(peak/tick),step=(right-left)/report.bins.length;
    plot.append(svg('text',{x:left,y:15,class:'chart-tick'},'Xアカウント数'));
    for(let i=0;i<=yMax/tick;i++){const value=i*tick,y=bottom-(value/yMax)*(bottom-top);plot.append(svg('line',{x1:left,y1:y,x2:right,y2:y,class:'chart-grid'}),svg('text',{x:left-10,y:y+4,'text-anchor':'end',class:'chart-tick'},num(value)));}
    const labelStep=Math.max(1,Math.ceil(report.bins.length/8));
    for(const [i,bin] of report.bins.entries()){
      const x=left+i*step,h=bin.count/yMax*(bottom-top),group=svg('g',{tabindex:0,role:'button','aria-pressed':'false','aria-label':bin.label+'人：'+bin.count+'アカウント',class:'x-histogram-bin','data-min':bin.min});
      group.append(svg('title',{},bin.label+'人：'+bin.count+'アカウント'),svg('rect',{x,y:top,width:step,height:bottom-top,fill:'transparent'}),svg('rect',{x:x+1,y:bottom-h,width:Math.max(1,step-2),height:h,fill:'var(--chart-cyan)'}));
      const describe=()=>{$('readout').textContent=`${bin.label}人：${num(bin.count)}アカウント（${num(bin.count/report.total*100)}%） · 概数 ${num(bin.approximate)}件`;};
      group.addEventListener('pointerenter',describe);group.addEventListener('focus',describe);group.addEventListener('click',()=>select(bin));group.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select(bin);}});plot.append(group);
      if(i%labelStep===0||i===report.bins.length-1){const label=bin.min.toLocaleString('ja-JP',{notation:'compact',maximumFractionDigits:1});plot.append(svg('text',{x:x+step/2,y:243,'text-anchor':'middle',class:'chart-tick'},label));}
      const tr=node('tr'),td=node('td'),button=node('button',bin.label+'人');button.type='button';button.onclick=()=>select(bin);td.append(button);tr.append(td,node('td',num(bin.count)),node('td',num(bin.count/report.total*100)+'%'));$('table').append(tr);
    }
    plot.append(svg('text',{x:(left+right)/2,y:274,'text-anchor':'middle',class:'chart-tick'},scale==='log'?'フォロワー数（桁別・0人は独立した区間）':'フォロワー数（等間隔・目盛りは区間の下限）'));
    $('plot').append(plot);$('readout').textContent='棒にカーソルを合わせるか、Tabキーで値を確認できます。クリック／Enterで該当アカウントを表示。';
    if(selection){selection=report.bins.find(b=>b.min===selection.min&&b.max===selection.max)||null;for(const mark of $('plot').querySelectorAll('[role="button"]'))mark.setAttribute('aria-pressed',String(!!selection&&Number(mark.dataset.min)===selection.min));}renderList();
  }
  for(const id of ['scope','scale','bins'])$(id).addEventListener('change',()=>{selection=null;render();});
  $('more').onclick=()=>{shown+=100;renderList();};
  $('csv').onclick=()=>download('x-follower-histogram.csv',csv([['フォロワー数下限','フォロワー数上限','Xアカウント数','概数を含む件数'],...report.bins.map(b=>[b.min,b.max,b.count,b.approximate])]),'text/csv;charset=utf-8');
  root.addEventListener('toggle',()=>{if(root.open&&dirty)render();});
  return {update(metrics,profiles,friends,accountId){input={metrics,profiles,friends};if(account!==accountId){account=accountId;selection=null;}dirty=true;if(root.open)render();}};
}
