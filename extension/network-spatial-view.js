import { worldRadius, routeColor } from './network-style.js';
import { clamp, add, sub, mul, cameraBasis, projectPoint, fitCamera, rotateCamera } from './network-camera.js';

// Perspective projection with a viewport-sized static canvas. No remote code or image fetches.
export function createSpatialView({viewport,canvas,zoomLabel,onSelect,imageFor,motionButton}) {
  const ctx=canvas.getContext('2d'),base=document.createElement('canvas'),ink=base.getContext('2d');
  let graph={nodes:[],edges:[],axes:[],mode:'2d'},camera=fitCamera(800,600,'2d'),nodes=new Map(),paths=[],radii=new Map();
  let active=false,visible=false,dirty=true,frame=0,lastFrame=0,selected='',viewKey='',pendingFit=true,projected=[],projectedPaths=[];
  let motion=!matchMedia('(prefers-reduced-motion: reduce)').matches,drag=null,pinch=null,lastHit=null;
  const pointers=new Map(),keys=new Set(),reduced=matchMedia('(prefers-reduced-motion: reduce)');let manualMotion=false;
  const is3d=()=>graph.mode==='3d';
  const project=p=>projectPoint(p,camera,viewport.clientWidth,viewport.clientHeight,graph.mode);
  const moving=()=>active&&visible&&!document.hidden&&motion&&paths.length>0;
  const flying=()=>active&&visible&&!document.hidden&&drag?.action==='look'&&keys.size>0;
  function schedule(){if(active&&!frame)frame=requestAnimationFrame(draw);}
  function redraw(){dirty=true;schedule();}
  function label(){if(active)zoomLabel.textContent=Math.round((is3d()?fitCamera(viewport.clientWidth,viewport.clientHeight,'3d').distance/camera.distance:camera.zoom)*100)+'%';}
  function fit(){if(!viewport.clientWidth){pendingFit=true;return;}pendingFit=false;camera=fitCamera(viewport.clientWidth,viewport.clientHeight,graph.mode);label();redraw();}
  function zoomBy(factor){if(is3d())camera.distance=clamp(camera.distance/factor,35,100000);else camera.zoom=clamp(camera.zoom*factor,.01,6);label();redraw();}
  function pan(dx,dy){const basis=cameraBasis(camera),factor=is3d()?Math.max(5,camera.distance)/(viewport.clientHeight/2/Math.tan(Math.PI/8)):1/camera.zoom;camera.target=add(camera.target,add(mul(basis.right,-dx*factor),mul(basis.up,dy*factor)));redraw();}
  function select(id){selected=id;onSelect?.(nodes.get(id)||graph.edges.find(e=>e.id===id)||null);redraw();}
  function focus(id=selected){const n=nodes.get(id),edge=graph.edges.find(e=>e.id===id),a=edge&&nodes.get(edge.from),b=edge&&nodes.get(edge.to);const target=n||(a&&b?mul(add(a,b),.5):null);
    if(target){camera.target={x:target.x,y:target.y,z:target.z};if(is3d())camera.distance=900;else camera.zoom=Math.max(camera.zoom,.8);label();}select(id);}
  function point(path,t){const {a,b,c,self}=path;if(self){const angle=.5+t*(Math.PI*2-.4);return {x:c.x+Math.cos(angle)*65,y:c.y+Math.sin(angle)*65,z:c.z};}return add(add(mul(a,(1-t)**2),mul(c,2*(1-t)*t)),mul(b,t*t));}
  function line(a,b,color,width=1){const p=project(a),q=project(b);if(!p||!q)return;ink.strokeStyle=color;ink.lineWidth=width;ink.beginPath();ink.moveTo(p.x,p.y);ink.lineTo(q.x,q.y);ink.stroke();}
  function textAt(p,text,color='#9cb9c5',size=11){const s=project(p);if(!s||s.x<-100||s.y<-50||s.x>viewport.clientWidth+100||s.y>viewport.clientHeight+50)return;ink.fillStyle=color;ink.font=`${size}px sans-serif`;ink.textAlign='left';ink.fillText(text.length>28?text.slice(0,27)+'…':text,s.x+5,s.y-5);}
  function axes(){
    const low=graph.axes.some(a=>a.missing)?-720:-500,high=600,origin={x:low,y:low,z:is3d()?low:0},colors=['#ff9b95','#9fdb8c','#7baeff'];
    for(let i=0;i<=4;i++){const v=-500+i*250;line({x:-500,y:v,z:is3d()?low:0},{x:500,y:v,z:is3d()?low:0},'#20343c');line({x:v,y:-500,z:is3d()?low:0},{x:v,y:500,z:is3d()?low:0},'#20343c');if(is3d())line({x:v,y:low,z:-500},{x:v,y:low,z:500},'#20343c');}
    graph.axes.forEach((axis,index)=>{const key=['x','y','z'][index],end={...origin,[key]:high};line(origin,end,colors[index],1.6);textAt(end,`${key.toUpperCase()} · ${axis.label}${axis.logarithmic?' (log)':''}`,colors[index],12);
      for(const tick of axis.ticks){const at={...origin,[key]:tick.position},endTick={...at,[index===0?'y':'x']:low-14};line(at,endTick,colors[index]);textAt(endTick,tick.label,colors[index],10);}
    });
  }
  function drawStatic(w,h,dpr){
    ink.setTransform(dpr,0,0,dpr,0,0);ink.fillStyle='#101a21';ink.fillRect(0,0,w,h);axes();
    projectedPaths=[];
    for(const path of paths){const points=Array.from({length:path.self?33:17},(_,i)=>project(point(path,i/(path.self?32:16))));projectedPaths.push({path,points});const focused=selected===path.edge.id;
      ink.strokeStyle=focused?'#fff0b3':path.color;ink.globalAlpha=focused?1:path.edge.count>1?.65:.3;ink.lineWidth=focused?3:Math.min(4,1+Math.log2(path.edge.count+1)*.5);ink.beginPath();let started=false;
      for(const p of points){if(!p){started=false;continue;}if(started)ink.lineTo(p.x,p.y);else ink.moveTo(p.x,p.y);started=true;}ink.stroke();
      // Arrow at 80% remains visible even when a large destination dot covers the endpoint.
      const p=project(point(path,.8)),q=project(point(path,.78));if(p&&q){const angle=Math.atan2(p.y-q.y,p.x-q.x);ink.fillStyle=ink.strokeStyle;ink.beginPath();ink.moveTo(p.x,p.y);ink.lineTo(p.x-7*Math.cos(angle-.5),p.y-7*Math.sin(angle-.5));ink.lineTo(p.x-7*Math.cos(angle+.5),p.y-7*Math.sin(angle+.5));ink.closePath();ink.fill();}
    }
    ink.globalAlpha=1;
    projected=graph.nodes.map(n=>({n,p:project(n)})).filter(({p})=>p&&p.x>-100&&p.y>-100&&p.x<w+100&&p.y<h+100).sort((a,b)=>b.p.depth-a.p.depth);
    const overlaps=new Map();for(const {n} of projected){const key=[n.x,n.y,n.z].join('|');if(!overlaps.has(key))overlaps.set(key,[]);overlaps.get(key).push(n.id);}
    for(const item of projected){const {n,p}=item,r=clamp(radii.get(n.id)*.55*p.factor,3,85);item.r=r;const focused=selected===n.id;
      ink.globalAlpha=is3d()?clamp(1-(p.depth-camera.distance)/6000,.4,1):1;
      ink.beginPath();ink.arc(p.x,p.y,r,0,Math.PI*2);ink.fillStyle=n.kind==='world'?'#153b48':n.kind==='offline'?'#292929':'#292d48';ink.fill();
      ink.strokeStyle=n.kind==='private'?'#ffa653':n.kind==='offline'?'#909090':'#48c9dd';ink.lineWidth=1.5;ink.stroke();
      if(focused){ink.beginPath();ink.arc(p.x,p.y,r+4,0,Math.PI*2);ink.strokeStyle='#fff0b3';ink.lineWidth=2;ink.stroke();}
      const image=n.kind==='world'?imageFor?.('world',n.id):null;
      if(image?.complete&&image.naturalWidth&&r>7){ink.save();ink.beginPath();ink.arc(p.x,p.y,r-2,0,Math.PI*2);ink.clip();ink.drawImage(image,p.x-r+2,p.y-r+2,(r-2)*2,(r-2)*2);ink.restore();}
      else if(r>9){ink.fillStyle='#b5e9f1';ink.font=`600 ${Math.min(18,r)}px sans-serif`;ink.textAlign='center';ink.fillText([...n.name][0]||'?',p.x,p.y+Math.min(6,r/3));}
      const group=overlaps.get([n.x,n.y,n.z].join('|')),labelId=group.includes(selected)?selected:group.at(-1);
      if(n.id===labelId&&(focused||graph.nodes.length<25||r>22)){ink.font='12px sans-serif';ink.textAlign='center';const title=[...n.name].slice(0,24).join('')+(group.length>1?' ＋'+(group.length-1)+'地点':'');ink.lineWidth=4;ink.strokeStyle='#101a21';ink.strokeText(title,p.x,p.y+r+18);ink.fillStyle='#d2e9f2';ink.fillText(title,p.x,p.y+r+18);}
    }
    ink.globalAlpha=1;
    if(is3d()){
      const basis=cameraBasis(camera),origin={x:w-57,y:57};ink.beginPath();ink.arc(origin.x,origin.y,42,0,Math.PI*2);ink.fillStyle='#0c151edb';ink.fill();
      [{x:1,y:0,z:0},{x:0,y:1,z:0},{x:0,y:0,z:1}].forEach((v,i)=>{const x=origin.x+(v.x*basis.right.x+v.y*basis.right.y+v.z*basis.right.z)*28,y=origin.y-(v.x*basis.up.x+v.y*basis.up.y+v.z*basis.up.z)*28;ink.strokeStyle=['#ff9b95','#9fdb8c','#7baeff'][i];ink.lineWidth=2;ink.beginPath();ink.moveTo(origin.x,origin.y);ink.lineTo(x,y);ink.stroke();ink.fillStyle=ink.strokeStyle;ink.font='bold 12px sans-serif';ink.textAlign='center';ink.fillText('XYZ'[i],x,y-5);});
    }
    if(!graph.nodes.length){ink.fillStyle='#a5bdc9';ink.font='14px sans-serif';ink.textAlign='center';ink.fillText('この条件の記録はありません',w/2,h/2);}
  }
  function draw(time){frame=0;if(!active||!visible||document.hidden)return;const w=viewport.clientWidth,h=viewport.clientHeight;if(!w||!h)return;
    const elapsed=Math.min(50,time-lastFrame||16);if(!dirty&&!flying()&&time-lastFrame<32){if(moving())schedule();return;}lastFrame=time;
    if(flying()){
      const basis=cameraBasis(camera),speed=elapsed*Math.max(100,camera.distance)*.00045*(keys.has('Shift')?3:1),sign=(a,b)=>Number(keys.has(a))-Number(keys.has(b));
      camera.target=add(camera.target,add(add(mul(basis.right,sign('d','a')*speed),mul(basis.back,sign('s','w')*speed)),{x:0,y:sign('e','q')*speed,z:0}));dirty=true;
    }
    const dpr=Math.min(devicePixelRatio||1,2);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=base.width=Math.round(w*dpr);canvas.height=base.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';dirty=true;}
    if(dirty){drawStatic(w,h,dpr);dirty=false;}ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(base,0,0);
    if(moving()){
      ctx.setTransform(dpr,0,0,dpr,0,0);
      paths.forEach((path,index)=>{const p=project(point(path,(time/3800+index*.61803398875)%1));if(!p||p.x<0||p.y<0||p.x>w||p.y>h)return;const r=selected===path.edge.id?2.7:path.edge.count>1?2:1.3;ctx.fillStyle=path.color;ctx.globalAlpha=.23;ctx.beginPath();ctx.arc(p.x,p.y,r*3,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.fillStyle='#dbfbff';ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();});
    }
    if(moving()||flying())schedule();
  }
  function hit(x,y){
    const candidates=projected.filter(({p,r})=>Math.hypot(p.x-x,p.y-y)<=Math.max(7,r+3)).reverse();
    if(candidates.length){const same=lastHit&&Math.hypot(x-lastHit.x,y-lastHit.y)<5&&lastHit.ids===candidates.map(c=>c.n.id).join('|'),index=same?(lastHit.index+1)%candidates.length:0;lastHit={x,y,index,ids:candidates.map(c=>c.n.id).join('|')};select(candidates[index].n.id);return;}
    lastHit=null;let best=null,distance=8;
    for(const {path,points} of projectedPaths)for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,t=clamp(((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1),0,1),d=Math.hypot(x-a.x-t*dx,y-a.y-t*dy);if(d<distance){distance=d;best=path.edge;}}
    select(best?.id||'');
  }
  canvas.addEventListener('pointerdown',e=>{if(!active||![0,1,2].includes(e.button))return;e.preventDefault();viewport.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false,action:is3d()?(e.button===2?'look':e.button===1||e.shiftKey?'pan':'orbit'):'pan',button:e.button};
    if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};drag.moved=true;}viewport.classList.add('dragging');
  });
  canvas.addEventListener('pointermove',e=>{if(!drag||!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===2&&pinch){const [a,b]=[...pointers.values()],distance=Math.hypot(a.x-b.x,a.y-b.y),x=(a.x+b.x)/2,y=(a.y+b.y)/2;zoomBy(distance/Math.max(1,pinch.distance));pan(x-pinch.x,y-pinch.y);pinch={distance,x,y};return;}
    if(pinch)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.moved ||= Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>4;
    if(drag.action==='pan')pan(dx,dy);else{rotateCamera(camera,dx,dy,drag.action==='look');redraw();}drag.x=e.clientX;drag.y=e.clientY;
  });
  function release(e){if(!pointers.has(e.pointerId))return;if(e.type==='pointerup'&&drag&&!drag.moved&&!pinch&&drag.button===0){const r=canvas.getBoundingClientRect();hit(e.clientX-r.left,e.clientY-r.top);}pointers.delete(e.pointerId);if(!pointers.size){drag=null;pinch=null;keys.clear();viewport.classList.remove('dragging');}}
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,release);
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('dblclick',()=>focus());
  viewport.addEventListener('wheel',e=>{if(!active)return;e.preventDefault();const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?viewport.clientHeight:1),factor=Math.exp(-clamp(delta,-300,300)*.004);
    if(!is3d()){const r=viewport.getBoundingClientRect(),x=e.clientX-r.left-viewport.clientWidth/2,y=e.clientY-r.top-viewport.clientHeight/2,old=camera.zoom;zoomBy(factor);camera.target.x+=x*(1/old-1/camera.zoom);camera.target.y-=y*(1/old-1/camera.zoom);redraw();}else zoomBy(factor);
  },{passive:false});
  viewport.addEventListener('keydown',e=>{if(!active||e.target!==viewport||e.ctrlKey||e.metaKey)return;const key=e.key.length===1?e.key.toLowerCase():e.key;
    if(drag?.action==='look'&&['w','a','s','d','q','e','Shift'].includes(key)){e.preventDefault();keys.add(key);schedule();return;}
    if(['+','=','-','Home','f','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape'].includes(key)){e.preventDefault();if(key==='Home')fit();else if(key==='f')focus();else if(key==='Escape')select('');else if(['+','=','-'].includes(key))zoomBy(key==='-'?1/1.3:1.3);else if(e.shiftKey||!is3d())pan(key==='ArrowLeft'?40:key==='ArrowRight'?-40:0,key==='ArrowUp'?40:key==='ArrowDown'?-40:0);else{rotateCamera(camera,key==='ArrowLeft'?-20:key==='ArrowRight'?20:0,key==='ArrowUp'?-20:key==='ArrowDown'?20:0);redraw();}}
  });
  viewport.addEventListener('keyup',e=>keys.delete(e.key.length===1?e.key.toLowerCase():e.key));
  function stop(){keys.clear();pointers.clear();drag=null;pinch=null;viewport.classList.remove('dragging');}
  window.addEventListener('blur',stop);viewport.addEventListener('blur',stop);document.addEventListener('visibilitychange',()=>{stop();redraw();});
  function motionState(){if(active&&motionButton){motionButton.textContent='光の流れ：'+(motion?'ON':'OFF');motionButton.setAttribute('aria-pressed',String(motion));}redraw();}
  motionButton?.addEventListener('click',()=>{if(!active)return;manualMotion=true;motion=!motion;motionState();});
  reduced.addEventListener('change',()=>{if(!manualMotion){motion=!reduced.matches;motionState();}});
  new ResizeObserver(()=>{if(!active)return;if(pendingFit)fit();else{label();redraw();}}).observe(viewport);
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(!visible)stop();redraw();}).observe(viewport);
  return {
    setGraph(next,key){graph=next;nodes=new Map(graph.nodes.map(n=>[n.id,n]));const maxCurrent=Math.max(0,...graph.nodes.map(n=>n.currentUsers.size)),maxCount=Math.max(1,...graph.edges.map(e=>e.count));radii=new Map(graph.nodes.map(n=>[n.id,worldRadius(n,maxCurrent)]));
      paths=graph.edges.map(edge=>{const a=nodes.get(edge.from),b=nodes.get(edge.to),self=a===b,dx=b.x-a.x,dy=b.y-a.y,len=Math.max(1,Math.hypot(dx,dy));return {edge,a,b,self,c:self?{x:a.x+60,y:a.y+60,z:a.z}:{x:(a.x+b.x)/2-dy/len*30,y:(a.y+b.y)/2+dx/len*30,z:(a.z+b.z)/2},color:routeColor(edge.count,maxCount)};});
      if(selected&&!nodes.has(selected)&&!graph.edges.some(e=>e.id===selected))select('');
      if(viewKey!==key){viewKey=key;selected='';lastHit=null;pendingFit=true;onSelect?.(null);}if(pendingFit)fit();else redraw();
    },
    setActive(value){active=value;if(!active){stop();cancelAnimationFrame(frame);frame=0;}else{label();motionState();redraw();}},
    setMotion(value){motion=value;motionState();},get motion(){return motion;},fit,zoomBy,reset(){fit();},focus,select,redraw,
    get state(){return {camera:structuredClone(camera),selected,projected:projected.map(({n,p,r})=>({id:n.id,...p,r})),mode:graph.mode};}
  };
}
