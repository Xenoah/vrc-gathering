// Local SVG/HTML charts. Values and labels always come from the selected account's report.
const NS='http://www.w3.org/2000/svg';
const colors=['var(--chart-cyan)','var(--chart-purple)','var(--chart-gold)','var(--chart-blue)','var(--chart-pink)','var(--chart-gray)'];
const num=value=>Number(value).toLocaleString('ja-JP',{maximumFractionDigits:1});
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function svg(tag,attrs={},text){const n=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attrs))n.setAttribute(key,String(value));if(text!=null)n.textContent=text;return n;}
function frame(holder,label){const wrap=el('div',null,'chart');wrap.setAttribute('role','group');wrap.setAttribute('aria-label',label);holder.append(wrap);return wrap;}
function empty(wrap){wrap.append(el('p','この条件の記録はありません。','chart-empty'));}
function detail(wrap){const hint=el('p','ポイントにカーソルを合わせるか、Tabキーで値を確認できます。','chart-readout');wrap.append(hint);return hint;}
function interactive(mark,label,readout,onSelect){
  mark.setAttribute('tabindex','0');mark.setAttribute('aria-label',label+(onSelect?'。選択して詳しく見る':''));
  if(onSelect)mark.setAttribute('role','button');
  mark.append(svg('title',{},label));
  for(const event of ['pointerenter','focus'])mark.addEventListener(event,()=>{readout.textContent=label;});
  if(onSelect){mark.addEventListener('click',onSelect);mark.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();onSelect();}});}
}
function legend(wrap,series){const list=el('div',null,'chart-legend');series.forEach((s,i)=>{const item=el('span'),dot=el('i');dot.style.background=colors[i%colors.length];item.append(dot,document.createTextNode(s.label));list.append(item);});wrap.append(list);}

export function lineChart(holder,rows,{label,series,format=num,onSelect,pointClass='',gaps=false,timeKey=''}={}){
  const wrap=frame(holder,label);if(!rows.length){empty(wrap);return;}
  legend(wrap,series);
  const plot=svg('svg',{viewBox:'0 0 640 224',class:'chart-plot','aria-label':label});wrap.append(plot);
  const readout=detail(wrap),max=Math.max(1,Math.ceil(Math.max(0,...rows.flatMap(r=>series.map(s=>r[s.key]||0)))/4))*4,left=58,right=622,top=18,bottom=184;
  const firstTime=timeKey?Number(rows[0][timeKey]):0,lastTime=timeKey?Number(rows[rows.length-1][timeKey]):0;
  const x=i=>rows.length===1?(left+right)/2:left+(timeKey&&lastTime>firstTime?(Number(rows[i][timeKey])-firstTime)/(lastTime-firstTime):i/(rows.length-1))*(right-left),y=v=>bottom-(v/max)*(bottom-top);
  for(let i=0;i<=4;i++){const value=max*i/4,yy=y(value);plot.append(svg('line',{x1:left,y1:yy,x2:right,y2:yy,class:'chart-grid'}),svg('text',{x:left-10,y:yy+4,'text-anchor':'end',class:'chart-tick'},format(value)));}
  const step=Math.max(1,Math.ceil(rows.length/7));
  rows.forEach((r,i)=>{if(i%step===0||i===rows.length-1)plot.append(svg('text',{x:x(i),y:210,'text-anchor':i===0?'start':i===rows.length-1?'end':'middle',class:'chart-tick'},String(r.label??r.day).slice(5)));});
  series.forEach((s,index)=>{
    const points=rows.map((r,i)=>gaps&&r[s.key]==null?null:[x(i),y(r[s.key]||0)]),path=points.map((p,i)=>p?((i&&points[i-1]?'L':'M')+p[0]+','+p[1]):'').join(' '),color=colors[index%colors.length];
    if(index===0&&!gaps)plot.append(svg('path',{d:path+` L ${x(rows.length-1)},${bottom} L ${x(0)},${bottom} Z`,fill:color,opacity:'.09'}));
    plot.append(svg('path',{d:path,fill:'none',stroke:color,'stroke-width':2.5,'stroke-linejoin':'round','stroke-linecap':'round'}));
    points.forEach((p,i)=>{if(!p)return;const [xx,yy]=p;const point=svg('circle',{cx:xx,cy:yy,r:rows.length>60?3:4,fill:color,class:'chart-point '+pointClass});interactive(point,`${rows[i].label??rows[i].day} · ${s.label} ${format(rows[i][s.key]||0)}`,readout,onSelect?()=>onSelect(rows[i]):null);plot.append(point);});
  });
}

export function barChart(holder,rows,{label,key='count',format=num,limit=8,signed=false,onSelect,moreLabel='全件はデータ表で確認できます。'}={}){
  const wrap=frame(holder,label),items=[...rows].sort((a,b)=>signed?Math.abs(b[key])-Math.abs(a[key]):b[key]-a[key]).slice(0,limit);
  if(!items.length){empty(wrap);return;}
  const max=Math.max(1,...items.map(r=>Math.abs(r[key]||0))),list=el('div',null,'chart-bars');wrap.append(list);
  for(const [i,row] of items.entries()){
    const value=row[key]||0,bar=el(onSelect?'button':'div',null,'chart-bar-row'),name=el('span',row.name??row.label,'chart-bar-name'),valueLabel=el('strong',(signed&&value>0?'+':'')+format(value),'chart-bar-value'),track=el('div',null,'chart-bar-track'),fill=el('i');
    bar.title=(row.name??row.label)+'：'+valueLabel.textContent;name.title=row.name??row.label;
    fill.style.width=(Math.abs(value)/max*(signed?50:100))+'%';fill.style.background=colors[signed?(value<0?2:0):i%3];
    if(signed){track.classList.add('chart-diverging');fill.style.left=(value<0?50-Math.abs(value)/max*50:50)+'%';}
    track.append(fill);bar.append(name,valueLabel,track);list.append(bar);
    if(onSelect){bar.type='button';bar.addEventListener('click',()=>onSelect(row));}
  }
  if(rows.length>limit)wrap.append(el('p',`全${num(rows.length)}件中、${signed?'変化の大きさ':'値'}の上位${limit}件。${moreLabel}`,'chart-caption'));
}

export function donutChart(holder,rows,{label,key='count',format=num,unit='件'}={}){
  const wrap=frame(holder,label),items=rows.filter(r=>r[key]>0),total=items.reduce((sum,r)=>sum+r[key],0);
  if(!total){empty(wrap);return;}
  const layout=el('div',null,'chart-donut'),plot=svg('svg',{viewBox:'0 0 200 200',class:'chart-ring','aria-label':label}),list=el('div',null,'chart-donut-legend');layout.append(plot,list);wrap.append(layout);const readout=detail(wrap);
  plot.append(svg('circle',{cx:100,cy:100,r:75,fill:'none',stroke:'var(--chart-track)','stroke-width':22}));
  let offset=0;const circumference=Math.PI*150;
  items.forEach((r,i)=>{const share=r[key]/total,color=colors[i%colors.length],arc=svg('circle',{cx:100,cy:100,r:75,fill:'none',stroke:color,'stroke-width':22,'stroke-dasharray':`${share*circumference} ${circumference}`,'stroke-dashoffset':-offset*circumference,transform:'rotate(-90 100 100)',class:'chart-point'}),text=`${r.name}：${format(r[key])}（${num(share*100)}%）`;offset+=share;interactive(arc,text,readout);plot.append(arc);
    const row=el('div'),dot=el('i'),name=el('span',r.name),value=el('strong',format(r[key]));dot.style.background=color;row.title=text;row.append(dot,name,value);list.append(row);
  });
  const totalLabel=svg('text',{x:100,y:101,'text-anchor':'middle',class:'chart-total'},format(total));
  totalLabel.style.fontSize=Math.min(28,132/[...format(total)].length)+'px';
  plot.append(totalLabel,svg('text',{x:100,y:123,'text-anchor':'middle',class:'chart-tick'},unit));
}

export function columnChart(holder,rows,{label,key='changes',format=num}={}){
  const wrap=frame(holder,label);if(!rows.length){empty(wrap);return;}
  const plot=svg('svg',{viewBox:'0 0 640 224',class:'chart-plot','aria-label':label});wrap.append(plot);const readout=detail(wrap),max=Math.max(1,Math.ceil(Math.max(0,...rows.map(r=>r[key]||0))/4))*4,step=568/rows.length;
  for(let i=0;i<=4;i++){const y=184-i*40;plot.append(svg('line',{x1:52,y1:y,x2:624,y2:y,class:'chart-grid'}),svg('text',{x:42,y:y+4,'text-anchor':'end',class:'chart-tick'},format(max*i/4)));}
  rows.forEach((row,i)=>{const height=(row[key]||0)/max*160,name=row.name??row.hour,bar=svg('rect',{x:54+i*step,y:184-height,width:Math.max(1,step*.65),height:Math.max(1,height),rx:3,fill:colors[0],class:'chart-point'});interactive(bar,`${name}：${format(row[key]||0)}`,readout);plot.append(bar);if(i%Math.ceil(rows.length/8)===0)plot.append(svg('text',{x:54+i*step+step*.325,y:208,'text-anchor':'middle',class:'chart-tick'},name));});
}

export function comparisonChart(holder,rows,{label,format=(v)=>num(v)}={}){
  const wrap=frame(holder,label);legend(wrap,[{label:'今期'},{label:'前期'}]);
  const list=el('div',null,'chart-comparison');wrap.append(list);
  for(const r of rows){const row=el('div',null,'chart-compare-row'),heading=el('div'),max=Math.max(1,r.current,r.previous);heading.append(el('span',r.name),el('strong',format(r.current,r)+' / '+format(r.previous,r)));row.append(heading);
    for(const [i,key] of ['current','previous'].entries()){const track=el('div',null,'chart-bar-track'),fill=el('i');fill.style.width=r[key]/max*100+'%';fill.style.background=colors[i];track.append(fill);row.append(track);}list.append(row);}
  wrap.append(el('p','各指標の今期・前期を個別のスケールで比較。','chart-caption'));
}

export function scatterChart(holder,rows,{label,onSelect}={}){
  const wrap=frame(holder,label);if(!rows.length){empty(wrap);return;}
  const plot=svg('svg',{viewBox:'0 0 640 260',class:'chart-plot','aria-label':label});wrap.append(plot);const readout=detail(wrap),maxX=Math.max(1,...rows.map(r=>r.worlds.length)),maxY=Math.max(1,...rows.map(r=>r.changes));
  for(let i=0;i<=4;i++){const y=204-i*44;plot.append(svg('line',{x1:52,y1:y,x2:620,y2:y,class:'chart-grid'}),svg('text',{x:42,y:y+4,'text-anchor':'end',class:'chart-tick'},num(maxY*i/4)));plot.append(svg('text',{x:52+i*142,y:225,'text-anchor':'middle',class:'chart-tick'},num(maxX*i/4)));}
  plot.append(svg('text',{x:52,y:16,class:'chart-tick'},'変更イベント数'),svg('text',{x:336,y:250,'text-anchor':'middle',class:'chart-tick'},'観測ワールド数'));
  for(const r of rows){const point=svg('circle',{cx:52+r.worlds.length/maxX*568,cy:204-r.changes/maxY*176,r:6,fill:colors[0],opacity:.7,class:'chart-point'});interactive(point,`${r.name}：${r.worlds.length}ワールド / ${r.changes}変更`,readout,onSelect?()=>onSelect(r):null);plot.append(point);}
}
