// Only explicit public profile URLs are accepted. Never infer an account from a display name or @mention.
export const X_CACHE_TTL = 86400000;
export const X_CACHE_LIMIT = 500;
const RESERVED = new Set(['home','i','intent','share','search','explore','notifications','messages','settings','login','logout','signup','account','compose','hashtag','tos','privacy','about','download','jobs','ads','oauth','communities','lists','topics','spaces','help','support']);
export function xProfileURL(value) {
  if(typeof value!=='string' || value.length>2048)return '';
  let text=value.trim();
  if(/^(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com\//i.test(text))text='https://'+text;
  if(!/^https?:\/\/(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com\/[a-z0-9_]{1,15}\/?(?:[?#][^\s]*)?$/i.test(text) || /[\\\x00-\x20\x7f]/.test(text))return '';
  try {
    const url=new URL(text);
    if(!['https:','http:'].includes(url.protocol) || url.username || url.password || url.port || !/^(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com$/i.test(url.hostname))return '';
    const match=/^\/([a-z0-9_]{1,15})\/?$/i.exec(url.pathname);
    if(!match || RESERVED.has(match[1].toLowerCase()))return '';
    return 'https://x.com/'+match[1].toLowerCase();
  } catch {return '';}
}
export function extractXProfiles(raw) {
  const links=Array.isArray(raw?.bioLinks)?raw.bioLinks.slice(0,100):[],bio=typeof raw?.bio==='string'?raw.bio.slice(0,10000):'';
  // Match complete URLs so lookalike hosts and URLs embedded in another URL are not mistaken for X.
  const absolute=bio.match(/https?:\/\/[^\s<>"'()（）「」【】]+/gi)||[];
  const withoutURLs=bio.replace(/https?:\/\/[^\s<>"'()（）「」【】]+/gi,' ');
  const bare=[...withoutURLs.matchAll(/(?:^|[\s（(「【:：])((?:(?:www|mobile|m)\.)?(?:x|twitter)\.com\/[^\s<>"'()（）「」【】]+)/gi)].map(m=>m[1]);
  return [...new Set([...links,...absolute,...bare].map(value=>xProfileURL(typeof value==='string'?value.replace(/[.,、。!！]+$/u,''):value)).filter(Boolean))].slice(0,5);
}
export const xCacheKey = (accountId,userId) => accountId+'/'+userId;
export function readXCache(cache,accountId,userId,now=Date.now()) {
  const entry=cache?.[xCacheKey(accountId,userId)];
  if(!entry || entry.accountId!==accountId || entry.userId!==userId || !Number.isSafeInteger(entry.checkedAt) || entry.checkedAt<=0 || entry.checkedAt>now || !Array.isArray(entry.urls))return null;
  return {accountId,userId,checkedAt:entry.checkedAt,urls:[...new Set(entry.urls.map(xProfileURL).filter(Boolean))].slice(0,5)};
}
export function writeXCache(cache,entry,now=Date.now()) {
  const rows=Object.values(cache||{}).filter(e=>e?.accountId && e?.userId).map(e=>readXCache(cache,e.accountId,e.userId,now)).filter(Boolean);
  const key=xCacheKey(entry.accountId,entry.userId),next=new Map(rows.map(e=>[xCacheKey(e.accountId,e.userId),e]));next.set(key,entry);
  return Object.fromEntries([...next].sort((a,b)=>b[1].checkedAt-a[1].checkedAt || Number(b[0]===key)-Number(a[0]===key)).slice(0,X_CACHE_LIMIT));
}
