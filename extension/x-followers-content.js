// Runs only after optional X access is granted. It reads the visible profile header.
(()=>{
  let timer,last='',lastSent=0,lastAttempt='',attemptAt=0;
  function collect(){
    timer=null;
    const record=globalThis.VRCFollowerParser.read(document,location.pathname);if(!record)return;
    const key=JSON.stringify(record);if(key===last&&Date.now()-lastSent<86400000)return;
    if(key===lastAttempt&&Date.now()-attemptAt<60000)return;lastAttempt=key;attemptAt=Date.now();
    try{chrome.runtime.sendMessage({type:'X_FOLLOWERS_OBSERVED',...record}).then(result=>{if(result?.ok){last=key;lastSent=Date.now();}}).catch(()=>{});}catch{}
  }
  function schedule(){if(!timer)timer=setTimeout(collect,800);}
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['href','title']});
  window.addEventListener('popstate',schedule);window.addEventListener('focus',schedule);schedule();
})();
