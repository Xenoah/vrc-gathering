import {location as parseLocation, WORLD_ID} from './core.js';
import {logInstanceId} from './sync-format.js';

// Serialized by executeScript; keep this function independent of module scope.
// Read only the signed-in user's left navigation, never profile/main-panel cards.
export function readOwnLocationCard(accountId) {
  if (location.origin !== 'https://vrchat.com' || !/^\/home(?:\/|$)/.test(location.pathname)) return null;
  const visible = node => {
    if (!node?.getClientRects().length) return false;
    for (let p=node; p; p=p.parentElement) {
      const s=getComputedStyle(p);
      if (p.hidden || p.getAttribute('aria-hidden')==='true' || s.display==='none' || s.visibility==='hidden') return false;
    }
    return true;
  };
  const url = a => { try { const u=new URL(a.getAttribute('href'), location.href); return u.origin===location.origin?u:null; } catch { return null; } };
  const profile = a => /^\/home\/user\/([^/]+)\/?$/.exec(url(a)?.pathname||'')?.[1];
  const navigation = new Set(['/home/friends','/home/groups','/home/worlds','/home/avatars','/home/favorites','/home/inventory','/home/download']);
  const found=[];
  for (const card of document.querySelectorAll('.location-card')) {
    if (!visible(card) || card.closest('main,[role="main"],[role="dialog"]')) continue;
    let sidebar=null;
    for (let p=card.parentElement; p && p!==document.body; p=p.parentElement) {
      const box=p.getBoundingClientRect();
      if (box.left<0 || box.left>innerWidth*.2 || box.width>Math.min(460, innerWidth>600?innerWidth*.48:innerWidth)) continue;
      const links=[...p.querySelectorAll('a[href]')].filter(visible);
      const owners=links.filter(a=>profile(a));
      if (!owners.some(a=>profile(a)===accountId && (a.compareDocumentPosition(card)&Node.DOCUMENT_POSITION_FOLLOWING)) || owners.some(a=>profile(a)!==accountId)) continue;
      if (new Set(links.map(a=>url(a)?.pathname.replace(/\/$/,'')).filter(path=>navigation.has(path))).size<2) continue;
      if ([...p.querySelectorAll('.location-card')].filter(visible).length!==1) continue;
      sidebar=p; break;
    }
    if (!sidebar) continue;
    const links=[...card.querySelectorAll('a[href]')], launches=links.map(url).filter(u=>u?.pathname==='/home/launch');
    const title=card.querySelector('.location-title a[href]');
    if (!title || !launches.length || !launches.some(u=>u.href===url(title)?.href)) continue;
    const values=launches.map(u=>({worldId:u.searchParams.get('worldId'),instanceId:u.searchParams.get('instanceId')}));
    if (values.some(v=>!/^wrld_[a-zA-Z0-9-]{8,64}$/.test(v.worldId||'') || !v.instanceId || v.instanceId.length>1024 || JSON.stringify(v)!==JSON.stringify(values[0]))) continue;
    // Badges count friends, not total occupants. Images and page text are not copied.
    found.push({accountId,...values[0],worldName:(title.getAttribute('title')||'').slice(0,256)});
  }
  return found.length===1?found[0]:null;
}

const officialHome = value => {
  try { const u=new URL(value); return u.origin==='https://vrchat.com' && /^\/home(?:\/|$)/.test(u.pathname); } catch { return false; }
};

// No persistent DOM cache: inspect again before and after the roster request.
export async function websiteOwnLocation(chrome, me, signal, tabId=null) {
  const apiPlace=me.self.location;
  if (!( ['unknown','web'].includes(apiPlace.kind) || apiPlace.kind==='world'&&!apiPlace.instanceId ) || !chrome.scripting?.executeScript || !chrome.tabs?.query) return null;
  let tabs;
  try { tabs=tabId===null?await chrome.tabs.query({url:'https://vrchat.com/home*'}):[await chrome.tabs.get(tabId)]; } catch { return null; }
  signal.throwIfAborted();
  tabs=tabs.filter(t=>Number.isInteger(t.id) && !t.discarded && officialHome(t.url));
  if (tabs.length>10) return null; // Ambiguous/stale collections of tabs need user cleanup.
  const observations=[];
  for (const tab of tabs) {
    let rows;
    try { rows=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'ISOLATED',func:readOwnLocationCard,args:[me.id]}); } catch { continue; }
    signal.throwIfAborted();
    const value=rows?.find(row=>row.frameId===0)?.result;
    if (value?.accountId!==me.id || !WORLD_ID.test(value.worldId) || typeof value.instanceId!=='string' || value.instanceId.length>1024) continue;
    if (apiPlace.kind==='world' && apiPlace.worldId!==value.worldId) continue;
    // Allowlist again at the worker boundary; never send a join nonce to storage/API.
    const instance=logInstanceId(value.instanceId);
    if (!instance || !/^[a-zA-Z0-9_()~.+,-]+$/.test(instance)) continue;
    observations.push({tabId:tab.id,worldName:typeof value.worldName==='string'?value.worldName.slice(0,256):'',
      self:{...me.self,presence:'online',location:parseLocation(value.worldId+':'+instance),observedAt:Date.now(),extensions:{'vrc.location':{source:'vrchat-website'}}}});
  }
  const first=observations[0];
  if (!first || observations.some(o=>o.self.location.worldId!==first.self.location.worldId || o.self.location.instanceId!==first.self.location.instanceId)) return null;
  return first;
}
