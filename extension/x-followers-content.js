// Runs only after optional X access is granted. It reads the visible profile header.
(()=>{
  if(globalThis.VRCFollowerContentLoaded)return;globalThis.VRCFollowerContentLoaded=true;
  let blocked='',timer,last='',lastSent=0,lastAttempt='',attemptAt=0,unavailable='',unavailableAttempt='',unavailableAt=0;
  function collect(force=false){
    timer=null;
    const parser=globalThis.VRCFollowerParser,reason=parser.unavailable(document,location.pathname);
    if(reason){
      const url=parser.profile(location.pathname),key=url+':'+reason;
      if(!force&&key===unavailable||key===unavailableAttempt&&Date.now()-unavailableAt<1000)return;
      unavailableAttempt=key;unavailableAt=Date.now();
      try{chrome.runtime.sendMessage({type:'X_FOLLOWERS_UNAVAILABLE',url,reason}).then(result=>{if(result?.ok)unavailable=key;}).catch(()=>{});}catch{}return;
    }
    unavailable='';
    const record=parser.read(document,location.pathname);if(!record){const reason=globalThis.VRCFollowerParser.blocked(document,location.pathname);if(reason&&blocked!==reason){blocked=reason;try{chrome.runtime.sendMessage({type:'X_FOLLOWERS_BLOCKED',reason}).catch(()=>{});}catch{}}return;}blocked='';
    const key=JSON.stringify(record);if(!force&&key===last&&Date.now()-lastSent<60000)return;
    if(key===lastAttempt&&Date.now()-attemptAt<(force?1000:60000))return;lastAttempt=key;attemptAt=Date.now();
    try{chrome.runtime.sendMessage({type:'X_FOLLOWERS_OBSERVED',...record}).then(result=>{if(result?.ok){last=key;lastSent=Date.now();}}).catch(()=>{});}catch{}
  }
  function schedule(){if(!timer)timer=setTimeout(collect,800);}
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['href','title']});
  chrome.runtime.onMessage?.addListener((message,sender,respond)=>{if(message.type==='X_FOLLOWERS_READ'&&sender.id===chrome.runtime.id){collect(true);respond({ok:true});}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
  window.addEventListener('popstate',schedule);window.addEventListener('focus',schedule);schedule();
})();
