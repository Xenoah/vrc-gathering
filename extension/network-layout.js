// Axis coordinates are derived only from the visible graph and cached world metadata.
export const NETWORK_AXES = [
  {id:'current',label:'現在の滞在人数',unit:'人'}, {id:'users',label:'観測ユーザー数',unit:'人'},
  {id:'moves',label:'移動の観測回数',unit:'回'}, {id:'incoming',label:'流入の観測回数',unit:'回'},
  {id:'outgoing',label:'流出の観測回数',unit:'回'}, {id:'connections',label:'接続先の数',unit:'地点'},
  {id:'latest',label:'最終観測日時',type:'time'}, {id:'capacity',label:'ワールド定員',unit:'人'},
  {id:'visits',label:'ワールド累計訪問数',unit:'回'}, {id:'favorites',label:'ワールドお気に入り数',unit:'件'},
  {id:'name',label:'ワールド名',type:'category'}, {id:'author',label:'制作者',type:'category'},
  {id:'kind',label:'地点の種類',type:'category'}
];
const defaults={mode:'radial',x:'users',y:'moves',z:'current',scale:'linear'};
export function networkPreferences(value={}) {
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,
    (key==='mode'?['radial','2d','3d']:key==='scale'?['linear','log']:NETWORK_AXES.map(a=>a.id)).includes(value?.[key])?value[key]:fallback]));
}
const kinds={world:'ワールド',private:'プライベート',offline:'現実世界',web:'Web／アプリ',unknown:'所在不明',removed:'名簿から消失'};
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
export function networkAxisValues(graph,worlds=[]) {
  const metadata=new Map(worlds.map(w=>[w.id,w])),values=new Map(),neighbors=new Map();
  for(const n of graph.nodes){const w=metadata.get(n.id);neighbors.set(n.id,new Set());values.set(n.id,{
    current:n.currentUsers.size,users:n.users.size,moves:n.moves,incoming:0,outgoing:0,connections:0,
    latest:number(n.observedAt)||null,capacity:number(w?.capacity),visits:number(w?.traits?.visits),favorites:number(w?.traits?.favorites),
    name:n.name,author:w?.authorName||null,kind:kinds[n.kind]||'所在不明'
  });}
  for(const e of graph.edges){if(!values.has(e.from)||!values.has(e.to))continue;values.get(e.from).outgoing+=e.count;values.get(e.to).incoming+=e.count;
    if(e.from!==e.to){neighbors.get(e.from).add(e.to);neighbors.get(e.to).add(e.from);}}
  for(const [id,set] of neighbors)values.get(id).connections=set.size;
  return values;
}
export function formatAxisValue(axis,value) {
  if(value==null)return '未取得';
  if(axis.type==='time')return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(value)+' JST';
  return axis.type==='category'?String(value):new Intl.NumberFormat('ja-JP',{maximumFractionDigits:1}).format(value)+(axis.unit||'');
}
function domain(axis,values,scale) {
  const valid=values.filter(v=>v!=null),missing=valid.length!==values.length;
  const categories=axis.type==='category'?[...new Set(valid)].sort((a,b)=>a.localeCompare(b,'ja')):null;
  const min=axis.type==='time'&&valid.length?Math.min(...valid):0,max=categories?Math.max(0,categories.length-1):valid.length?Math.max(...valid):min;
  const logarithmic=scale==='log'&&!axis.type,transform=v=>logarithmic?Math.log1p(v):v;
  function position(value){if(value==null)return -650;const v=categories?categories.indexOf(value):value;return max===min?0:((transform(v)-transform(min))/(transform(max)-transform(min))-.5)*1000;}
  let ticks=categories?categories.map((v,i)=>({value:v,index:i})).filter(({index})=>categories.length<=5||index%Math.ceil((categories.length-1)/4)===0||index===categories.length-1).map(({value})=>value):max===min?[min]:Array.from({length:5},(_,i)=>logarithmic?Math.expm1(transform(min)+(transform(max)-transform(min))*i/4):min+(max-min)*i/4);
  if(!axis.type&&!logarithmic)ticks=[...new Set(ticks.map(Math.round))];
  return {...axis,min,max,missing,categories,logarithmic,position,ticks:[...(missing?[{value:null,position:-650,label:'未取得'}]:[]),...ticks.map(value=>({value,position:position(value),label:formatAxisValue(axis,value)}))]};
}
export function spatialNetwork(graph,worlds,preferences) {
  const prefs=networkPreferences(preferences),values=networkAxisValues(graph,worlds),keys=prefs.mode==='3d'?['x','y','z']:['x','y'];
  const axes=keys.map(key=>domain(NETWORK_AXES.find(a=>a.id===prefs[key]),[...values.values()].map(v=>v[prefs[key]]),prefs.scale));
  return {...graph,axes,mode:prefs.mode,values,nodes:graph.nodes.map(n=>({...n,x:axes[0].position(values.get(n.id)[prefs.x]),y:axes[1].position(values.get(n.id)[prefs.y]),z:axes[2]?.position(values.get(n.id)[prefs.z])||0}))};
}
