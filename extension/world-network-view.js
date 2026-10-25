import { createNetworkView } from './network-view.js';
import { createSpatialView } from './network-spatial-view.js';
import { NETWORK_AXES, networkPreferences, spatialNetwork, formatAxisValue } from './network-layout.js';

export function createWorldNetworkView({onSelect,imageFor,onLayoutChange}) {
  const $=id=>document.getElementById(id),storageKey='vrc-world-network-layout-v1';
  let preferences=networkPreferences(),spatialGraph=null;
  try{preferences=networkPreferences(JSON.parse(localStorage.getItem(storageKey)));}catch{}
  for(const key of ['x','y','z']){const select=$('networkAxis'+key.toUpperCase());select.replaceChildren(...NETWORK_AXES.map(a=>new Option(a.label,a.id)));select.value=preferences[key];}
  $('networkMode').value=preferences.mode;$('networkScale').value=preferences.scale;
  const radial=createNetworkView({viewport:$('networkViewport'),stage:$('networkStage'),canvas:$('networkCanvas'),zoomLabel:$('networkZoom'),directional:true,wheelZoom:true,motionButton:$('networkMotion'),onSelect,imageFor});
  const spatial=createSpatialView({viewport:$('spatialViewport'),canvas:$('spatialCanvas'),zoomLabel:$('networkZoom'),motionButton:$('networkMotion'),onSelect,imageFor});
  const current=()=>preferences.mode==='radial'?radial:spatial;
  function controls(){const isRadial=preferences.mode==='radial',is3d=preferences.mode==='3d';
    $('networkViewport').hidden=!isRadial;$('spatialViewport').hidden=isRadial;$('networkAxes').hidden=isRadial;$('networkZControl').hidden=!is3d;$('networkAxisNote').hidden=isRadial;
    $('networkSort').disabled=!isRadial;$('resetNetwork').textContent=isRadial?'100%':'視点をリセット';
    $('networkControlsHelp').textContent=is3d?'左ドラッグ／Alt＋左：回転 · 中ドラッグ／Shift＋左：平行移動 · 右ドラッグ：視点回転＋WASD移動／QE上下（Shiftで加速） · ホイール：ズーム · F：選択へ · Home：全体 · 矢印キー：回転（Shiftで平行移動） · タッチ：1本で回転／2本で移動・ズーム':'ドラッグで移動 · ホイール／ピンチでズーム · ＋／−：ズーム · Home：全体表示'+(isRadial?'':' · F：選択へ · 矢印キー：平行移動');
    $('spatialViewport').setAttribute('aria-label',(is3d?'3D':'2D')+'ワールド遷移ネットワーク。操作方法は直前の説明、詳細は直後の選択欄を参照。');
    $('networkAxisNote').textContent='各軸は表示中の地点で正規化します。未取得は0と区別した「未取得」の位置に表示。重なる点は繰り返しクリック、または下の「地点の詳細」で選択できます。流入・流出・接続先数は表示中の経路が対象。定員・累計訪問・お気に入り・制作者は保存済みワールド情報（取得時点）で、フレンドの観測期間とは別です。数値は詳細欄で確認できます。表示と軸の選択はこのブラウザーに保存します。';
    radial.setActive(isRadial);spatial.setActive(!isRadial);
  }
  for(const id of ['networkMode','networkAxisX','networkAxisY','networkAxisZ','networkScale'])$(id).addEventListener('change',()=>{
    const motion=current().motion;preferences=networkPreferences({mode:$('networkMode').value,x:$('networkAxisX').value,y:$('networkAxisY').value,z:$('networkAxisZ').value,scale:$('networkScale').value});
    try{localStorage.setItem(storageKey,JSON.stringify(preferences));}catch{}
    controls();current().setMotion(motion);onLayoutChange();
  });
  controls();
  return {setGraph(graph,key,worlds){if(preferences.mode==='radial'){spatialGraph=null;radial.setGraph(graph,key);}else{spatialGraph=spatialNetwork(graph,worlds,preferences);spatial.setGraph(spatialGraph,key+'|'+JSON.stringify(preferences));}},
    fit:()=>current().fit(),zoomBy:f=>current().zoomBy(f),reset:()=>current().reset(),focus:id=>current().focus(id),select:id=>current().select(id),redraw:()=>current().redraw(),
    get mode(){return preferences.mode;},axisDescription(id){if(!spatialGraph)return [];const values=spatialGraph.values.get(id);return values?spatialGraph.axes.map((axis,i)=>'XYZ'[i]+': '+axis.label+' = '+formatAxisValue(axis,values[axis.id])):[];}
  };
}
