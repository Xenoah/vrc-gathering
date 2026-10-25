// A viewport-sized canvas draws a scrollable logical map. No canvas grows with the dataset.
export function createNetworkView({viewport,stage,canvas,zoomLabel,onSelect,imageFor}) {
  const context=canvas.getContext('2d');let graph={nodes:[],edges:[],width:600,height:600},nodes=new Map(),scale=1,frame=0,selected='',viewKey='',pendingFit=true;
  let pointers=new Map(),drag=null,pinch=null;
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  function requestDraw(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
  const offset=()=>({x:Math.max(0,viewport.clientWidth-graph.width*scale)/2,y:Math.max(0,viewport.clientHeight-graph.height*scale)/2});
  function dimensions(){stage.style.width=Math.max(viewport.clientWidth,graph.width*scale)+'px';stage.style.height=Math.max(viewport.clientHeight,graph.height*scale)+'px';zoomLabel.textContent=Math.round(scale*100)+'%';}
  function resize(){if(!viewport.clientWidth)return;if(pendingFit){fit();return;}dimensions();requestDraw();}
  function zoom(next,x=viewport.clientWidth/2,y=viewport.clientHeight/2){const old=offset(),wx=(viewport.scrollLeft+x-old.x)/scale,wy=(viewport.scrollTop+y-old.y)/scale;scale=clamp(next,.005,3);dimensions();const nextOffset=offset();viewport.scrollLeft=wx*scale-x+nextOffset.x;viewport.scrollTop=wy*scale-y+nextOffset.y;requestDraw();}
  function fit(){if(!viewport.clientWidth){pendingFit=true;return;}pendingFit=false;scale=clamp(Math.min(viewport.clientWidth/graph.width,viewport.clientHeight/graph.height)*.94,.005,1.25);dimensions();viewport.scrollLeft=0;viewport.scrollTop=0;requestDraw();}
  function edgePoints(edge){const a=nodes.get(edge.from),b=nodes.get(edge.to);if(a===b)return {a,b,self:true,c:{x:a.x+52,y:a.y-66},r:49};
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),ux=dx/len,uy=dy/len;
    return {a:{x:a.x+ux*39,y:a.y+uy*39},b:{x:b.x-ux*42,y:b.y-uy*42},c:{x:(a.x+b.x)/2-uy*38,y:(a.y+b.y)/2+ux*38}};
  }
  function draw(){const w=viewport.clientWidth,h=viewport.clientHeight;if(!w||!h)return;const dpr=Math.min(devicePixelRatio||1,2);
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';}
    context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,w,h);context.fillStyle='#f5f8f7';context.fillRect(0,0,w,h);
    const origin=offset();context.translate(origin.x-viewport.scrollLeft,origin.y-viewport.scrollTop);context.scale(scale,scale);
    for(const edge of graph.edges){const p=edgePoints(edge),focused=selected===edge.id;context.beginPath();context.strokeStyle=focused?'#c16b27':'#709c96';context.globalAlpha=focused?1:.58;context.lineWidth=(focused?4:Math.min(7,1+Math.log2(edge.count+1)))/Math.max(scale,.5);
      if(p.self){context.arc(p.c.x,p.c.y,p.r,.5,Math.PI*2+.1);}else{context.moveTo(p.a.x,p.a.y);context.quadraticCurveTo(p.c.x,p.c.y,p.b.x,p.b.y);}context.stroke();
      if(scale>.15 && !edge.undirected){if(p.self)p.b={x:p.c.x+Math.cos(.1)*p.r,y:p.c.y+Math.sin(.1)*p.r};const angle=p.self ? .1+Math.PI/2 : Math.atan2(p.b.y-p.c.y,p.b.x-p.c.x),s=10/Math.max(scale,.6);context.beginPath();context.moveTo(p.b.x,p.b.y);context.lineTo(p.b.x-Math.cos(angle-.45)*s,p.b.y-Math.sin(angle-.45)*s);context.lineTo(p.b.x-Math.cos(angle+.45)*s,p.b.y-Math.sin(angle+.45)*s);context.closePath();context.fillStyle=context.strokeStyle;context.fill();}
    }
    context.globalAlpha=1;
    for(const n of graph.nodes){const sx=n.x*scale+origin.x-viewport.scrollLeft,sy=n.y*scale+origin.y-viewport.scrollTop;if(sx<-150||sy<-100||sx>w+150||sy>h+100)continue;
      context.beginPath();context.arc(n.x,n.y,35,0,Math.PI*2);context.fillStyle=n.kind==='world'?'#dceee8':'#e8e8ed';context.fill();context.strokeStyle=selected===n.id?'#c16b27':n.kind==='world'?'#31796e':'#8a8999';context.lineWidth=selected===n.id?4:2;context.stroke();
      const image=n.kind==='world'?imageFor?.('world',n.id):n.kind==='user'?imageFor?.('user',n.imageId||n.id):null;
      if(image?.complete&&image.naturalWidth){context.save();context.beginPath();context.arc(n.x,n.y,31,0,Math.PI*2);context.clip();context.drawImage(image,n.x-31,n.y-31,62,62);context.restore();}
      else if(scale>.2){context.fillStyle='#285c53';context.font='600 22px sans-serif';context.textAlign='center';context.fillText([...n.name][0]||'?',n.x,n.y+8);}
      if(scale>.22){context.fillStyle='#253c38';context.font='600 14px sans-serif';context.textAlign='center';const label=[...n.name].length>23?[...n.name].slice(0,22).join('')+'…':n.name;context.fillText(label,n.x,n.y+58);context.font='12px sans-serif';context.fillStyle='#60746f';context.fillText(n.caption ?? (n.currentUsers.size+' 人滞在 · '+n.moves+' 回移動'),n.x,n.y+77);}
    }
  }
  function select(id){selected=id;onSelect(graph.nodes.find(n=>n.id===id)||graph.edges.find(e=>e.id===id)||null);requestDraw();}
  function hit(x,y){const origin=offset(),world={x:(x+viewport.scrollLeft-origin.x)/scale,y:(y+viewport.scrollTop-origin.y)/scale};
    for(const n of graph.nodes)if(Math.hypot(n.x-world.x,n.y-world.y)<=40)return select(n.id);
    let best=null,distance=10/scale;
    for(const e of graph.edges){const p=edgePoints(e);for(let i=0;i<=24;i++){const t=i/24,x=p.self?p.c.x+Math.cos(t*Math.PI*2)*p.r:(1-t)**2*p.a.x+2*(1-t)*t*p.c.x+t*t*p.b.x,y=p.self?p.c.y+Math.sin(t*Math.PI*2)*p.r:(1-t)**2*p.a.y+2*(1-t)*t*p.c.y+t*t*p.b.y,d=Math.hypot(x-world.x,y-world.y);if(d<distance){best=e;distance=d;}}}
    select(best?.id||'');
  }
  viewport.addEventListener('scroll',requestDraw,{passive:true});
  viewport.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();const r=viewport.getBoundingClientRect();zoom(scale*Math.exp(-e.deltaY*.006),e.clientX-r.left,e.clientY-r.top);}},{passive:false});
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});drag={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop,moved:false};if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),scale};}viewport.classList.add('dragging');});
  canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===2&&pinch){const [a,b]=[...pointers.values()],r=viewport.getBoundingClientRect();zoom(pinch.scale*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,pinch.distance),(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);drag.moved=true;return;}if(!drag||pinch)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>4)drag.moved=true;viewport.scrollLeft=drag.left-dx;viewport.scrollTop=drag.top-dy;});
  function release(e){if(!pointers.has(e.pointerId))return;const r=viewport.getBoundingClientRect();if(e.type==='pointerup'&&drag&&!drag.moved&&!pinch)hit(e.clientX-r.left,e.clientY-r.top);pointers.delete(e.pointerId);if(!pointers.size){drag=null;pinch=null;viewport.classList.remove('dragging');}}
  canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
  viewport.addEventListener('keydown',e=>{if(e.key==='+'||e.key==='='){e.preventDefault();zoom(scale*1.3);}if(e.key==='-'){e.preventDefault();zoom(scale/1.3);}if(e.key==='Home'){e.preventDefault();fit();}});
  new ResizeObserver(resize).observe(viewport);
  return {setGraph(next,key){graph=next;nodes=new Map(graph.nodes.map(n=>[n.id,n]));if(viewKey!==key){viewKey=key;selected='';pendingFit=true;onSelect(null);}if(pendingFit)fit();else{dimensions();requestDraw();}},fit,zoomBy:factor=>zoom(scale*factor),reset:()=>zoom(1),redraw:requestDraw,
    focus(id){const edge=graph.edges.find(e=>e.id===id),n=nodes.get(id)||(edge?{x:(nodes.get(edge.from).x+nodes.get(edge.to).x)/2,y:(nodes.get(edge.from).y+nodes.get(edge.to).y)/2}:null);if(n){zoom(Math.max(scale,.8));const origin=offset();viewport.scrollLeft=n.x*scale+origin.x-viewport.clientWidth/2;viewport.scrollTop=n.y*scale+origin.y-viewport.clientHeight/2;}select(id);},get scale(){return scale;}};
}
