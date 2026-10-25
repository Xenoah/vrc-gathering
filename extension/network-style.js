export function worldRadius(node,maxCurrent){return node.kind==='world'?30+(maxCurrent?60*Math.sqrt(node.currentUsers.size/maxCurrent):0):35;}
export function routeColor(count,maxCount){
  if(count<=1||maxCount<=1)return '#518b9b';
  const t=Math.log(count)/Math.log(maxCount),a=t<.5?[81,139,155]:[247,207,87],b=t<.5?[247,207,87]:[255,93,72],p=t<.5?t*2:(t-.5)*2;
  return '#'+a.map((v,i)=>Math.round(v+(b[i]-v)*p).toString(16).padStart(2,'0')).join('');
}
export function routePoint(path,t){
  if(path.self){const angle=.5+t*(Math.PI*2-.4);return {x:path.c.x+Math.cos(angle)*path.r,y:path.c.y+Math.sin(angle)*path.r};}
  return {x:(1-t)**2*path.a.x+2*(1-t)*t*path.c.x+t*t*path.b.x,y:(1-t)**2*path.a.y+2*(1-t)*t*path.c.y+t*t*path.b.y};
}
