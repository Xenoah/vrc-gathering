#!/usr/bin/env python3
"""All-friends settings/discovery UI with synthetic VRChat responses and Chrome boundaries."""
import asyncio, functools, json, threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
  def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True)
  context=await browser.new_context(viewport={'width':1450,'height':1000},accept_downloads=True)
  await context.add_init_script('''
  const accountId='usr_fixtureowner01',ids=['usr_fixturefriend01','usr_fixturefriend02','usr_fixturefriend03','usr_fixturefriend04'];
  const values=JSON.parse(localStorage.getItem('friend-fixture')||'null')||{settings:{enabled:false,contact:'https://github.com/example',pollSeconds:180,retentionDays:30},state:{accountId},accountMeta:{[accountId]:{displayName:'Fixture owner'}}};
  const listeners=[],noop={addListener(){}},scripts=new Map(),alarms=new Map(),tabs=new Map();let tabId=100;
  window.fixture={values,requests:[],hold:true,entered:false,offset:0,ids};const realNow=Date.now;Date.now=()=>realNow()+fixture.offset;
  const storage={get:async keys=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]]))),set:async next=>{Object.assign(values,structuredClone(next));localStorage.setItem('friend-fixture',JSON.stringify(values));listeners.forEach(fn=>fn());},setAccessLevel:async()=>{}};
  window.chrome={storage:{local:storage,onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{contains:async()=>true,request:async()=>true},scripting:{getRegisteredContentScripts:async()=>[...scripts.values()],registerContentScripts:async rows=>rows.forEach(r=>scripts.set(r.id,r)),updateContentScripts:async rows=>rows.forEach(r=>scripts.set(r.id,r)),unregisterContentScripts:async({ids})=>ids.forEach(id=>scripts.delete(id))},alarms:{create:async(n,v)=>alarms.set(n,v),clear:async n=>alarms.delete(n),get:async n=>alarms.get(n),onAlarm:{addListener:fn=>fixture.alarm=fn}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:noop},declarativeNetRequest:{updateDynamicRules:async()=>{}},tabs:{create:async opts=>{const tab={...opts,id:++tabId,status:'loading'};tabs.set(tab.id,tab);return tab;},get:async id=>tabs.get(id),query:async()=>[...tabs.values()],remove:async id=>tabs.delete(id),sendMessage:async()=>({ok:true}),onUpdated:noop,onRemoved:noop},runtime:{id:'testextension',getURL:path=>new URL(path,location.href).href,onInstalled:noop,onStartup:noop,onMessage:{addListener:fn=>fixture.message=fn},sendMessage:async message=>{await workerReady;return new Promise(resolve=>fixture.message(message,{id:'testextension',url:location.href},resolve));}}};
  const realFetch=fetch;window.fetch=async(url,options)=>{
    if(!String(url).startsWith('https://vrchat.com/api/1/')){if(String(url).startsWith('https://'))throw Error('Unexpected external request');return realFetch(url,options);}
    fixture.requests.push(url);fixture.offset+=2201;
    const path=new URL(url).pathname;
    if(path.endsWith('/auth/user'))return new Response(JSON.stringify({id:accountId,displayName:'Fixture owner',friends:ids,onlineFriends:[],offlineFriends:ids,activeFriends:[]}),{headers:{'Content-Type':'application/json'}});
    if(path.includes('/profile/')){
      if(fixture.hold){fixture.entered=true;await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));}
      const userId=path.split('/').at(-1),i=ids.indexOf(userId);if(i===3)return new Response('{}',{status:500,headers:{'Content-Type':'application/json'}});
      return new Response(JSON.stringify({id:userId,bioLinks:i===2?[]:['https://twitter.com/fixture_x_'+i],bio:'@not_a_link'}),{headers:{'Content-Type':'application/json'}});
    }throw Error('Unexpected VRChat path '+path);
  };
  window.workerReady=import('/background.js');
  ''')
  page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  await page.goto(base+'/dashboard.html');await page.locator('[data-tab=settings]').click()
  await expect(page.locator('#xFollowerBulkScope')).to_have_value('known')
  await page.locator('#xFollowerBulkScope').select_option('friends');await page.locator('#xFollowerConcurrency').select_option('4')
  await page.locator('#xFollowerEnabled').check();await page.locator('#xFollowerForm button[type=submit]').click()
  await page.wait_for_function("fixture.values.xFollowerSettings?.bulkScope==='friends'")
  await page.locator('[data-tab=friends]').click();await expect(page.locator('#friendsPanel [data-x-collect]')).to_be_enabled()
  await page.locator('#friendsPanel [data-x-collect]').click();await page.wait_for_function('fixture.entered')
  await expect(page.locator('#friendsPanel [data-x-discovery]')).to_contain_text('0/4人')
  await page.locator('#friendsPanel [data-x-pause]').click();await page.wait_for_function("fixture.values.xFriendScan.phase==='paused'")
  assert await page.evaluate('fixture.values.xFriendScan.items.length')==4
  await page.evaluate('fixture.hold=false');await page.locator('#friendsPanel [data-x-resume]').click()
  await page.wait_for_function("fixture.values.xFriendScan.phase==='complete' && fixture.values.xFollowerQueue.active.length===2")
  await expect(page.locator('#friendsPanel [data-x-discovery]')).to_contain_text('4/4人')
  await expect(page.locator('#friendsPanel [data-x-discovery]')).to_contain_text('リンクあり 2人 / なし 1人 / 未確認 1人')
  await expect(page.locator('#friendsPanel [data-x-discovery-errors]')).to_be_visible()
  assert await page.evaluate("async()=> (await (await import('/db.js')).list('friends','usr_fixtureowner01')).length")==0
  assert await page.evaluate('fixture.values.xFollowerQueue.total')==2
  assert await page.evaluate("fixture.requests.filter(url=>url.endsWith('usr_fixturefriend04')).length")==2
  # Persisted scope survives reload; a reset removes pending work, not collected links.
  await page.locator('#friendsPanel [data-x-reset]').click();await page.wait_for_function("fixture.values.xFriendScan.phase==='idle'")
  assert await page.evaluate('Object.keys(fixture.values.xProfileCache).length')==3
  await page.reload();await page.locator('[data-tab=settings]').click();await expect(page.locator('#xFollowerBulkScope')).to_have_value('friends')
  backup=await page.evaluate("async()=> (await import('/settings-backup.js')).createSettingsBackup(fixture.values)")
  assert backup['settings']['xFollowers']['bulkScope']=='friends';assert backup['settings']['xFollowers']['scope']=='linked'
  await page.set_viewport_size({'width':390,'height':844})
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  await page.locator('#xFollowerForm').screenshot(path='/tmp/vrc-friend-discovery-settings.png')
  assert errors==[],errors
  await browser.close();print('PASS: all-friends option, empty local roster, authenticated discovery, pause/resume, no-link/error progress, reset, backup, reload and 390px layout')
try:asyncio.run(main())
finally:server.shutdown()
