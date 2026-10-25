import { worldRadius, routeColor, routePoint } from './network-style.js';
// Cache static drawing separately. Both canvases are bounded by the visible viewport, not map size.
export function createNetworkView({viewport,stage,canvas,zoomLabel,onSelect,imageFor,directional=false,wheelZoom=false,motionButton}) {
  const context=canvas.getContext('2d'),base=document.createElement('canvas'),ink=base.getContext('2d');
  let graph={nodes:[],edges:[],width:600,height:600},nodes=new Map(),paths=[],radii=new Map(),scale=1,frame=0,selected='',viewKey='',pendingFit=true,dirty=true,lastFrame=0,visible=false;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');let motion=!reduced.matches,manualMotion=false;
  let pointers=new Map(),drag=null,pinch=null;
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const radius=n=>radii.get(n.id)||35;
  const moving=()=>directional&&motion&&visible&&!document.hidden&&paths.some(p=>!p.edge.undirected);
  function schedule(){if(!frame)frame=requestAnimationFrame(draw);}
  function requestDraw(){dirty=true;schedule();}
  const offset=()=>({x:Math.max(0,viewport.clientWidth-graph.width*scale)/2,y:Math.max(0,viewport.clientHeight-graph.height*scale)/2});
  function dimensions(){stage.style.width=Math.max(viewport.clientWidth,graph.width*scale)+'px';stage.style.height=Math.max(viewport.clientHeight,graph.height*scale)+'px';zoomLabel.textContent=Math.round(scale*100)+'%';}
  function resize(){if(!viewport.clientWidth)return;if(pendingFit){fit();return;}dimensions();requestDraw();}
  function zoom(next,x=viewport.clientWidth/2,y=viewport.clientHeight/2){const old=offset(),wx=(viewport.scrollLeft+x-old.x)/scale,wy=(viewport.scrollTop+y-old.y)/scale;scale=clamp(next,.005,3);dimensions();const nextOffset=offset();viewport.scrollLeft=wx*scale-x+nextOffset.x;viewport.scrollTop=wy*scale-y+nextOffset.y;requestDraw();}
  function fit(){if(!viewport.clientWidth){pendingFit=true;return;}pendingFit=false;scale=clamp(Math.min(viewport.clientWidth/graph.width,viewport.clientHeight/graph.height)*.94,.005,1.25);dimensions();viewport.scrollLeft=0;viewport.scrollTop=0;requestDraw();}
  function edgePoints(edge){const a=nodes.get(edge.from),b=nodes.get(edge.to);if(a===b)return {a,b,self:true,c:{x:a.x+radius(a)+17,y:a.y-radius(a)-31},r:radius(a)+14};
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.max(1,Math.hypot(dx,dy)),ux=dx/len,uy=dy/len;
    return {a:{x:a.x+ux*(radius(a)+4),y:a.y+uy*(radius(a)+4)},b:{x:b.x-ux*(radius(b)+7),y:b.y-uy*(radius(b)+7)},c:{x:(a.x+b.x)/2-uy*38,y:(a.y+b.y)/2+ux*38}};
  }
  function transform(ctx,dpr){const origin=offset();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.translate(origin.x-viewport.scrollLeft,origin.y-viewport.scrollTop);ctx.scale(scale,scale);return origin;}
  function drawStatic(w,h,dpr){
    ink.setTransform(dpr,0,0,dpr,0,0);ink.fillStyle='#101a21';ink.fillRect(0,0,w,h);const origin=transform(ink,dpr);
    for(const {edge,p,color} of paths){const focused=selected===edge.id;ink.beginPath();ink.strokeStyle=focused?'#fff0b3':color;ink.globalAlpha=focused?1:edge.count>1?.78:.35;ink.lineWidth=(focused?4:Math.min(7,1+Math.log2(edge.count+1)))/Math.max(scale,.5);
      if(p.self){ink.arc(p.c.x,p.c.y,p.r,.5,Math.PI*2+.1);}else{ink.moveTo(p.a.x,p.a.y);ink.quadraticCurveTo(p.c.x,p.c.y,p.b.x,p.b.y);}ink.stroke();
      if(scale>.15&&!edge.undirected){const end=routePoint(p,1),near=routePoint(p,.98),angle=Math.atan2(end.y-near.y,end.x-near.x),s=10/Math.max(scale,.6);ink.beginPath();ink.moveTo(end.x,end.y);ink.lineTo(end.x-Math.cos(angle-.45)*s,end.y-Math.sin(angle-.45)*s);ink.lineTo(end.x-Math.cos(angle+.45)*s,end.y-Math.sin(angle+.45)*s);ink.closePath();ink.fillStyle=ink.strokeStyle;ink.fill();}
    }
    ink.globalAlpha=1;
    for(const n of graph.nodes){const sx=n.x*scale+origin.x-viewport.scrollLeft,sy=n.y*scale+origin.y-viewport.scrollTop;if(sx<-180||sy<-130||sx>w+180||sy>h+130)continue;
      const r=radius(n),drawRadius=Math.max(r,2.3/scale);
      ink.beginPath();ink.arc(n.x,n.y,drawRadius,0,Math.PI*2);ink.fillStyle=n.kind==='world'?'#153b48':'#292d48';ink.fill();ink.strokeStyle=n.kind==='private'?'#ffa653':selected===n.id?'#fff0b3':n.kind==='world'?'#48c9dd':'#a18aea';ink.lineWidth=Math.max(selected===n.id?4:2,1/scale);ink.stroke();
      const image=n.kind==='world'?imageFor?.('world',n.id):n.kind==='user'?imageFor?.('user',n.imageId||n.id):null;
      if(image?.complete&&image.naturalWidth&&r*scale>5){ink.save();ink.beginPath();ink.arc(n.x,n.y,r-4,0,Math.PI*2);ink.clip();ink.drawImage(image,n.x-r+4,n.y-r+4,(r-4)*2,(r-4)*2);ink.restore();}
      else if(scale>.2){ink.fillStyle='#b5e9f1';ink.font='600 22px sans-serif';ink.textAlign='center';ink.fillText([...n.name][0]||'?',n.x,n.y+8);}
      if(scale>.22){ink.fillStyle='#d2e9f2';ink.font='600 14px sans-serif';ink.textAlign='center';const label=[...n.name].length>23?[...n.name].slice(0,22).join('')+'…':n.name;ink.fillText(label,n.x,n.y+r+23);ink.font='12px sans-serif';ink.fillStyle='#91b0c2';ink.fillText(n.caption??(n.currentUsers.size+' 人滞在 · '+n.moves+' 回移動'),n.x,n.y+r+42);}
    }
  }
  function draw(time){frame=0;const w=viewport.clientWidth,h=viewport.clientHeight;if(!w||!h)return;
    if(!dirty&&time-lastFrame<32){if(moving())schedule();return;}lastFrame=time;
    const dpr=Math.min(devicePixelRatio||1,2);
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=base.width=Math.round(w*dpr);canvas.height=base.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';dirty=true;}
    if(dirty){drawStatic(w,h,dpr);dirty=false;}
    context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(base,0,0);
    if(moving()){
      const origin=transform(context,dpr);
      for(const [index,{edge,p,color}] of paths.entries()){
        if(edge.undirected)continue;
        const point=routePoint(p,(time/3800+index*.61803398875)%1),sx=point.x*scale+origin.x-viewport.scrollLeft,sy=point.y*scale+origin.y-viewport.scrollTop;
        if(sx<0||sy<0||sx>w||sy>h)continue;
        const size=(selected===edge.id?2.5:edge.count>1?1.8:1.1)/scale;
        context.fillStyle=color;context.globalAlpha=.2;context.beginPath();context.arc(point.x,point.y,size*2.8,0,Math.PI*2);context.fill();
        context.globalAlpha=.95;context.fillStyle=edge.count>1?'#fff1cb':'#b3f7ff';context.beginPath();context.arc(point.x,point.y,size,0,Math.PI*2);context.fill();
      }
      context.globalAlpha=1;schedule();
    }
  }
  function select(id){selected=id;onSelect?.(graph.nodes.find(n=>n.id===id)||graph.edges.find(e=>e.id===id)||null);requestDraw();}
  function hit(x,y){const origin=offset(),world={x:(x+viewport.scrollLeft-origin.x)/scale,y:(y+viewport.scrollTop-origin.y)/scale};
    for(const n of [...graph.nodes].reverse())if(Math.hypot(n.x-world.x,n.y-world.y)<=Math.max(radius(n)+5,5/scale))return select(n.id);
    let best=null,distance=10/scale;
    for(const {edge,p} of paths)for(let i=0;i<=24;i++){const point=routePoint(p,i/24),d=Math.hypot(point.x-world.x,point.y-world.y);if(d<distance){best=edge;distance=d;}}
    select(best?.id||'');
  }
  viewport.addEventListener('scroll',requestDraw,{passive:true});
  viewport.addEventListener('wheel',e=>{if(wheelZoom||e.ctrlKey||e.metaKey){e.preventDefault();const r=viewport.getBoundingClientRect(),delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?viewport.clientHeight:1);zoom(scale*Math.exp(-clamp(delta,-300,300)*.006),e.clientX-r.left,e.clientY-r.top);}},{passive:false});
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});drag={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop,moved:false};if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),scale};}viewport.classList.add('dragging');});
  canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===2&&pinch){const [a,b]=[...pointers.values()],r=viewport.getBoundingClientRect();zoom(pinch.scale*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,pinch.distance),(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);drag.moved=true;return;}if(!drag||pinch)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>4)drag.moved=true;viewport.scrollLeft=drag.left-dx;viewport.scrollTop=drag.top-dy;});
  function release(e){if(!pointers.has(e.pointerId))return;const r=viewport.getBoundingClientRect();if(e.type==='pointerup'&&drag&&!drag.moved&&!pinch)hit(e.clientX-r.left,e.clientY-r.top);pointers.delete(e.pointerId);if(!pointers.size){drag=null;pinch=null;viewport.classList.remove('dragging');}}
  canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
  viewport.addEventListener('keydown',e=>{if(e.key==='+'||e.key==='='){e.preventDefault();zoom(scale*1.3);}if(e.key==='-'){e.preventDefault();zoom(scale/1.3);}if(e.key==='Home'){e.preventDefault();fit();}});
  function motionState(){if(motionButton){motionButton.textContent='光の流れ：'+(motion?'ON':'OFF');motionButton.setAttribute('aria-pressed',String(motion));}requestDraw();}
  motionButton?.addEventListener('click',()=>{manualMotion=true;motion=!motion;motionState();});
  reduced.addEventListener('change',()=>{if(!manualMotion){motion=!reduced.matches;motionState();}});
  document.addEventListener('visibilitychange',requestDraw);
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;requestDraw();}).observe(viewport);
  new ResizeObserver(resize).observe(viewport);motionState();
  return {setGraph(next,key){graph=next;nodes=new Map(graph.nodes.map(n=>[n.id,n]));const maxCurrent=Math.max(0,...graph.nodes.map(n=>n.currentUsers?.size||0)),maxCount=Math.max(1,...graph.edges.map(e=>e.count));radii=new Map(graph.nodes.map(n=>[n.id,directional?worldRadius(n,maxCurrent):35]));paths=graph.edges.map(edge=>({edge,p:edgePoints(edge),color:directional?routeColor(edge.count,maxCount):'#5fa7b8'}));if(viewKey!==key){viewKey=key;selected='';pendingFit=true;onSelect?.(null);}if(pendingFit)fit();else{dimensions();requestDraw();}},fit,zoomBy:factor=>zoom(scale*factor),reset:()=>zoom(1),redraw:requestDraw,
    focus(id){const edge=graph.edges.find(e=>e.id===id),n=nodes.get(id)||(edge?{x:(nodes.get(edge.from).x+nodes.get(edge.to).x)/2,y:(nodes.get(edge.from).y+nodes.get(edge.to).y)/2}:null);if(n){zoom(Math.max(scale,.8));const origin=offset();viewport.scrollLeft=n.x*scale+origin.x-viewport.clientWidth/2;viewport.scrollTop=n.y*scale+origin.y-viewport.clientHeight/2;}select(id);},get scale(){return scale;}};
}
