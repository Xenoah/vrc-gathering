// Shared by the isolated X content script and the extension's browser/module tests.
globalThis.VRCFollowerParser = Object.freeze({
  count(value) {
    if(typeof value!=='string'||value.length>80)return null;
    const text=value.normalize('NFKC').trim().replace(/[\s\u00a0\u202f]/g,'');
    const match=/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([KMB万億])?$/i.exec(text);
    if(!match||match[2]&&!match[3])return null;
    const unit=match[3]?.toUpperCase(),factor={K:1000,M:1000000,B:1000000000,'万':10000,'億':100000000}[unit]||1;
    const followers=Math.round(Number(match[1].replaceAll(',','')+(match[2]?'.'+match[2]:''))*factor);
    return Number.isSafeInteger(followers)&&followers>=0?{followers,approximate:!!unit}:null;
  },
  profile(pathname) {
    const match=/^\/([a-z0-9_]{1,15})\/?$/i.exec(pathname||'');
    const reserved=['home','i','intent','share','search','explore','notifications','messages','settings','login','logout','signup','account','compose','hashtag','tos','privacy','about','download','jobs','ads','oauth','communities','lists','topics','spaces','help','support'];
    return match&&!reserved.includes(match[1].toLowerCase())?'https://x.com/'+match[1].toLowerCase():'';
  },
  read(document,pathname) {
    const url=this.profile(pathname);if(!url)return null;
    const handle=url.slice(14),area=document.querySelector('[data-testid="primaryColumn"]');if(!area)return null;
    // Profile header only: never interpret numbers from posts, sidebars or follower lists.
    const name=area.querySelector('[data-testid="UserName"]');
    if(!name||![...name.querySelectorAll('span')].some(n=>n.textContent.trim().toLowerCase()==='@'+handle))return null;
    for(const link of area.querySelectorAll('a[href]')) {
      let target;try{target=new URL(link.getAttribute('href'),'https://x.com');}catch{continue;}
      if(target.origin!=='https://x.com')continue;const path=target.pathname.toLowerCase();
      if(!['/'+handle+'/followers','/'+handle+'/verified_followers'].includes(path))continue;
      if(link.closest('article,[data-testid="tweet"]'))continue;
      const label=link.textContent.trim();
      if(!/(?:followers?|フォロワー)\s*$/i.test(label)||/(?:verified|認証済み)/i.test(label))continue;
      const candidates=[...link.querySelectorAll('[title]')].map(n=>n.getAttribute('title'));
      candidates.push(link.getAttribute('title'),...Array.from(link.querySelectorAll('span')).filter(n=>!n.querySelector('span')).map(n=>n.textContent));
      candidates.push(label.replace(/followers?|フォロワー/gi,''));
      const counts=candidates.map(v=>this.count(v)).filter(Boolean);
      const count=counts.find(v=>!v.approximate)||counts[0];if(count)return {url,...count};
    }
    return null;
  }
});
