"""Real Chromium tabs + actual worker/parser; only Chrome API and X page responses are fixtures."""
import asyncio,functools,json,tempfile,threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
async def main():
  async with async_playwright() as p:
    browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True)
    context=await browser.new_context(viewport={'width':1450,'height':1050})
    pages={};rows={};created=[];errors=[];requests=[];counter=0;worker=None;counts={'missing':555,'old':222,'fresh':333};modes={}
    async def tab_create(source,options):
      nonlocal counter
      counter+=1;id=counter;page=await context.new_page();pages[id]=page;rows[id]={'id':id,'active':options.get('active',False),'pinned':False};created.append(options['url'])
      await page.goto(options['url']);rows[id].update(url=page.url,status='complete')
      return dict(rows[id])
    async def tab_get(source,id):
      if id not in pages or pages[id].is_closed():raise Exception('closed')
      return {**rows[id],'url':pages[id].url,'status':'complete'}
    async def tab_remove(source,id):
      if id in pages and not pages[id].is_closed():await pages[id].close()
    async def tab_query(source):
      return [{**rows[id],'url':page.url,'status':'complete'} for id,page in pages.items() if not page.is_closed()]
    async def tab_probe(source,id,message):
      if id in pages and not pages[id].is_closed():await pages[id].evaluate("m=>window.contentListener?.(m,{id:'testextension'},()=>{})",message)
      return {'ok':True}
    async def observed(source,message):
      page=source['page'];id=next((id for id,v in pages.items() if v==page),99999)
      return await worker.evaluate("({message,sender})=>new Promise(resolve=>fixture.message(message,sender,resolve))",{'message':message,'sender':{'id':'testextension','url':page.url,'frameId':0,'tab':{'id':id}}})
    for name,fn in [('tabCreate',tab_create),('tabGet',tab_get),('tabRemove',tab_remove),('tabQuery',tab_query),('tabProbe',tab_probe),('observed',observed)]:await context.expose_binding(name,fn)
    parser=(ROOT/'extension/x-followers-parser.js').read_text();content=(ROOT/'extension/x-followers-content.js').read_text()
    await context.add_init_script('''
    if(location.hostname==='x.com'){
      window.chrome={runtime:{id:'testextension',sendMessage:message=>window.observed(message),onMessage:{addListener:fn=>window.contentListener=fn}}};
      document.addEventListener('DOMContentLoaded',()=>{PARSER_SOURCE\nCONTENT_SOURCE});
    }else if(location.hostname==='127.0.0.1'){
      const accountId='usr_demoaccount0001',values=JSON.parse(localStorage.getItem('queue-fixture')||'null')||{settings:{enabled:false,contact:'https://github.com/example',pollSeconds:180,retentionDays:30},accountMeta:{[accountId]:{displayName:'Demo'}},state:{accountId}};
      const listeners=[],noop={addListener(){}},scripts=new Map(),alarms=new Map();window.fixture={values,api:[],message:null,alarm:null,offset:0};const realNow=Date.now;Date.now=()=>realNow()+fixture.offset;
      const storage={get:async keys=>{await window.seedReady;return structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])));},set:async next=>{Object.assign(values,structuredClone(next));localStorage.setItem('queue-fixture',JSON.stringify(values));listeners.forEach(fn=>fn());},setAccessLevel:async()=>{}};
      window.chrome={storage:{local:storage,onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{contains:async()=>true,request:async()=>true},scripting:{getRegisteredContentScripts:async()=>[...scripts.values()],registerContentScripts:async list=>list.forEach(s=>scripts.set(s.id,s)),updateContentScripts:async list=>list.forEach(s=>scripts.set(s.id,s)),unregisterContentScripts:async({ids})=>ids.forEach(id=>scripts.delete(id))},alarms:{create:async(n,v)=>alarms.set(n,v),clear:async n=>alarms.delete(n),get:async n=>alarms.get(n),onAlarm:{addListener:fn=>fixture.alarm=fn}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:noop},declarativeNetRequest:{updateDynamicRules:async()=>{}},tabs:{create:opts=>tabCreate(opts),get:id=>tabGet(id),query:()=>tabQuery(),remove:id=>tabRemove(id),sendMessage:(id,m)=>tabProbe(id,m),onUpdated:noop,onRemoved:noop},runtime:{id:'testextension',getURL:path=>new URL(path,location.href).href,onInstalled:noop,onStartup:noop,onMessage:{addListener:fn=>fixture.message=fn},sendMessage:async message=>{await window.workerReady;return new Promise(resolve=>fixture.message(message,{id:'testextension',url:location.href},resolve));}}};
      const fetchReal=fetch;window.fetch=(...args)=>{if(String(args[0]).startsWith('https://')){fixture.api.push(String(args[0]));throw Error('No external API calls expected');}return fetchReal(...args);};
      window.seedReady=(async()=>{const d=(await import('/demo.js')).demoData(),{mergeSyncRecords}=await import('/db.js'),{normalizeRecord}=await import('/sync-format.js');await mergeSyncRecords(d.friends.map(f=>normalizeRecord('friends',f)));if(!values.xProfileCache){const profiles={},metrics={},names=['missing','old','fresh'];d.friends.slice(0,3).forEach((f,i)=>{const url='https://x.com/'+names[i];profiles[accountId+'/'+f.id]={accountId,userId:f.id,checkedAt:Date.now(),urls:[url]};if(i)metrics['xFollowers:'+accountId+':'+names[i]]={accountId,url,followers:i,approximate:false,source:'x-profile',observedAt:Date.now()-(i===1?172800000:300000)};});values.xProfileCache=profiles;values.xFollowerCache=metrics;}})();
      window.workerReady=seedReady.then(()=>import('/background.js'));
    }
    '''.replace('PARSER_SOURCE',parser).replace('CONTENT_SOURCE',content))
    async def x_route(route):
      path=route.request.url.split('x.com/',1)[1].split('#')[0].split('?')[0];requests.append(route.request.url)
      if path not in counts:raise Exception('Unexpected X request '+path)
      if modes.get(path)=='limit':body='<main data-testid="primaryColumn"><div role="alert">Rate limit exceeded</div></main>'
      else:body=f'<main data-testid="primaryColumn"><div data-testid="UserName"><span>@{path}</span></div><a href="/{path}/following"><span>99999</span> Following</a><a href="/{path}/verified_followers"><span title="{counts[path]:,}">{counts[path]:,}</span> Followers</a><article><a href="/{path}/followers">999999 Followers</a></article></main>'
      await route.fulfill(status=200,content_type='text/html',body='<html><body>'+body+'</body></html>')
    await context.route('https://x.com/**',x_route)
    worker=await context.new_page();worker.on('pageerror',lambda e:errors.append(str(e)))
    await worker.goto(base+'/dashboard.html');await worker.locator('[data-tab=friends]').click()
    await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('対象 3件')
    await worker.locator('#friendsPanel [data-x-collect]').click()
    await worker.wait_for_function('fixture.values.xFollowerQueue?.success===1')
    assert '/missing#' in created[0];assert not [v for v in pages.values() if not v.is_closed()]
    async def next_job():await worker.evaluate("()=>{fixture.offset+=16000;fixture.alarm({name:'vrc-x-follower-queue'});}")
    await next_job();await worker.wait_for_function('fixture.values.xFollowerQueue?.success===2');assert '/old#' in created[1]
    await next_job();await worker.wait_for_function("fixture.values.xFollowerQueue?.phase==='complete'");assert '/fresh#' in created[2]
    await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('3成功')
    # Actual user detail triggers one priority refresh and updates its visible count.
    await worker.evaluate('fixture.offset+=61000');counts['missing']=777
    await worker.locator('#friendsBody tr').filter(has_text='星灯り').click()
    await expect(worker.locator('#detailXProfiles .follower-count')).to_contain_text('777',timeout=15000)
    assert len(created)==4
    counts['missing']=888;await worker.get_by_role('button',name='フォロワー数を更新',exact=True).click();await next_job()
    await expect(worker.locator('#detailXProfiles .follower-count')).to_contain_text('888')
    await worker.locator('#closeDetail').click()
    # A separately opened profile is collected but never closed by the queue.
    counts['missing']=999;manual=await context.new_page();await manual.goto('https://x.com/missing')
    await worker.wait_for_function("fixture.values.xFollowerCache['xFollowers:usr_demoaccount0001:missing'].followers===999");assert not manual.is_closed();await manual.close()
    # Explicit page rate-limit notice pauses, preserving the previous value and pending jobs.
    modes['old']='limit';await worker.locator('#friendsPanel [data-x-collect]').click();await next_job()
    await worker.wait_for_function("fixture.values.xFollowerQueue?.phase==='paused'")
    assert await worker.evaluate("fixture.values.xFollowerCache['xFollowers:usr_demoaccount0001:old'].followers")==222
    assert await worker.evaluate('fixture.api.length')==0
    assert all('/api/' not in u for u in requests)
    await worker.screenshot(path='/tmp/vrc-x-collection-desktop.png',full_page=True)
    await worker.set_viewport_size({'width':390,'height':844});assert await worker.evaluate('document.documentElement.scrollWidth<=innerWidth')
    await worker.screenshot(path='/tmp/vrc-x-collection-mobile.png',full_page=True)
    assert not errors,errors
    await browser.close();print('PASS: real separate tabs, priority bulk queue, automatic and manual detail refresh, live counts, preserved manual tab, rate-limit pause, no X/VRChat API calls, mobile')
try:asyncio.run(main())
finally:server.shutdown()
