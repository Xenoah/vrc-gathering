export const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
export const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
export const mul=(v,n)=>({x:v.x*n,y:v.y*n,z:v.z*n});
export const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
export const sub=(a,b)=>add(a,mul(b,-1));
export function cameraBasis(camera){const s=Math.sin(camera.yaw),c=Math.cos(camera.yaw),p=Math.sin(camera.pitch),q=Math.cos(camera.pitch);return {right:{x:c,y:0,z:-s},up:{x:-s*p,y:q,z:-c*p},back:{x:s*q,y:p,z:c*q}};}
export function cameraPosition(camera){return add(camera.target,mul(cameraBasis(camera).back,camera.distance));}
export function projectPoint(point,camera,width,height,mode='3d') {
  const basis=cameraBasis(camera),relative=sub(point,cameraPosition(camera)),depth=-dot(relative,basis.back),focal=Math.max(1,height)/2/Math.tan(Math.PI/8);
  if(mode==='3d'&&depth<5)return null;
  const factor=mode==='3d'?focal/depth:camera.zoom;
  return {x:width/2+dot(relative,basis.right)*factor,y:height/2-dot(relative,basis.up)*factor,depth,factor};
}
export function fitCamera(width,height,mode='3d'){
  const halfFov=Math.atan(Math.tan(Math.PI/8)*Math.min(1,width/Math.max(1,height)));
  return {target:{x:-60,y:-60,z:mode==='3d'?-60:0},yaw:mode==='3d'?.65:0,pitch:mode==='3d'?.4:0,distance:1150/Math.sin(halfFov),zoom:Math.max(.01,Math.min((width-180)/1300,(height-120)/1300))};
}
export function rotateCamera(camera,dx,dy,look=false){
  const position=cameraPosition(camera);camera.yaw-=dx*.006;camera.pitch=clamp(camera.pitch+dy*.006,-Math.PI/2+.02,Math.PI/2-.02);
  if(look)camera.target=sub(position,mul(cameraBasis(camera).back,camera.distance));
}
