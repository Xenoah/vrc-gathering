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
    pages={};rows={};created=[];errors=[];requests=[];counter=0;worker=None;counts={'missing':555,'old':222,'fresh':333,'missing_b':44,'missing_c':55,'missing_d':66};modes={name:'hold' for name in counts if name.startswith('missing')}
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
      window.seedReady=(async()=>{const d=(await import('/demo.js')).demoData(),{mergeSyncRecords}=await import('/db.js'),{normalizeRecord}=await import('/sync-format.js');await mergeSyncRecords(d.friends.map(f=>normalizeRecord('friends',f)));if(!values.xProfileCache){const profiles={},metrics={},names=['missing','old','fresh','missing_b','missing_c','missing_d'];d.friends.slice(0,6).forEach((f,i)=>{const url='https://x.com/'+names[i];profiles[accountId+'/'+f.id]={accountId,userId:f.id,checkedAt:Date.now(),urls:[url]};if(i===1||i===2)metrics['xFollowers:'+accountId+':'+names[i]]={accountId,url,followers:i,approximate:false,source:'x-profile',observedAt:Date.now()-(i===1?172800000:300000)};});values.xProfileCache=profiles;values.xFollowerCache=metrics;}})();
      window.workerReady=seedReady.then(()=>import('/background.js'));
    }
    '''.replace('PARSER_SOURCE',parser).replace('CONTENT_SOURCE',content))
    def profile_body(path):
      return f'<main data-testid="primaryColumn"><div data-testid="UserName"><span>@{path}</span></div><a href="/{path}/following"><span>99999</span> Following</a><a href="/{path}/verified_followers"><span title="{counts[path]:,}">{counts[path]:,}</span> Followers</a><article><a href="/{path}/followers">999999 Followers</a></article></main>'
    async def x_route(route):
      path=route.request.url.split('x.com/',1)[1].split('#')[0].split('?')[0];requests.append(route.request.url)
      if path not in counts:raise Exception('Unexpected X request '+path)
      if modes.get(path)=='limit':body='<main data-testid="primaryColumn"><div role="alert">Rate limit exceeded</div></main>'
      elif modes.get(path)=='hold':body='<main>Loading</main>'
      else:body=profile_body(path)
      await route.fulfill(status=200,content_type='text/html',body='<html><body>'+body+'</body></html>')
    await context.route('https://x.com/**',x_route)
    worker=await context.new_page();worker.on('pageerror',lambda e:errors.append(str(e)))
    await worker.goto(base+'/dashboard.html');await worker.locator('[data-tab=friends]').click()
    await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('対象 6件')
    await worker.locator('#friendsPanel [data-x-collect]').click()
    await worker.wait_for_function('fixture.values.xFollowerQueue?.active?.length===3 && fixture.values.xFollowerQueue.active.every(j=>j.tabId!=null)')
    assert [u.split('/')[3].split('#')[0] for u in created]==['missing','missing_b','missing_c'],created
    assert len([v for v in pages.values() if not v.is_closed()])==3
    await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('同時取得 3/3件')
    assert await worker.evaluate('fixture.api.length')==0
    async def enqueue_again():
      return await worker.evaluate("chrome.runtime.sendMessage({type:'COLLECT_X_FOLLOWERS',accountId:'usr_demoaccount0001'})")
    assert (await enqueue_again())['added']==0
    async def next_job():await worker.evaluate("()=>{fixture.offset+=16000;fixture.alarm({name:'vrc-x-follower-queue'});}")
    async def release(name):
      modes.pop(name,None)
      page=next(page for page in pages.values() if not page.is_closed() and page.url.split('#')[0]=='https://x.com/'+name)
      await page.evaluate('(html)=>document.body.innerHTML=html',profile_body(name))
    # One completion refills only its slot; an unobserved user precedes both refreshes.
    await next_job();await release('missing')
    await worker.wait_for_function('fixture.values.xFollowerQueue?.success===1 && fixture.values.xFollowerQueue?.active?.length===3 && fixture.values.xFollowerQueue.active.every(j=>j.tabId!=null)')
    assert '/missing_d#' in created[3];assert len(created)==4
    for name in ['missing_b','missing_c','missing_d']:await release(name)
    await worker.wait_for_function('fixture.values.xFollowerQueue?.success===4')
    assert (await enqueue_again())['added']==0
    await next_job();await worker.wait_for_function("fixture.values.xFollowerQueue?.phase==='complete'")
    assert '/old#' in created[4] and '/fresh#' in created[5]
    assert len(created)==6;await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('6成功')
    assert not [v for v in pages.values() if not v.is_closed()]
    offset=await worker.evaluate('fixture.offset')
    await worker.reload();await worker.evaluate('(n)=>fixture.offset=n',offset);await worker.locator('[data-tab=friends]').click()
    await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('6成功');assert len(created)==6
    # Actual user detail triggers one priority refresh and updates its visible count.
    await worker.evaluate('fixture.offset+=61000');counts['missing']=777
    await worker.locator('#friendsBody tr').filter(has_text='星灯り').click()
    await expect(worker.locator('#detailXProfiles .follower-count')).to_contain_text('777',timeout=15000)
    assert len(created)==7
    counts['missing']=888;await worker.get_by_role('button',name='フォロワー数を更新',exact=True).click();await next_job()
    await expect(worker.locator('#detailXProfiles .follower-count')).to_contain_text('888')
    await worker.locator('#closeDetail').click()
    # A separately opened profile is collected but never closed by the queue.
    counts['missing']=999;manual=await context.new_page();await manual.goto('https://x.com/missing')
    await worker.wait_for_function("fixture.values.xFollowerCache['xFollowers:usr_demoaccount0001:missing'].followers===999");assert not manual.is_closed();await manual.close()
    # Saved concurrency applies to bulk auto-enable, survives reload, and offers every value 1..10.
    await worker.locator('[data-tab=settings]').click()
    assert await worker.locator('#xFollowerConcurrency option').all_text_contents()==[str(i)+'件' for i in range(1,11)]
    await worker.locator('#xFollowerConcurrency').select_option('10')
    await worker.get_by_role('button',name='Xの設定を保存',exact=True).click()
    await worker.wait_for_function('fixture.values.xFollowerSettings.concurrency===10')
    offset=await worker.evaluate('fixture.offset');await worker.reload();await worker.evaluate('(n)=>fixture.offset=n',offset)
    await worker.locator('[data-tab=settings]').click();await expect(worker.locator('#xFollowerConcurrency')).to_have_value('10')
    await worker.screenshot(path='/tmp/vrc-x-settings-desktop.png',full_page=True)
    await worker.set_viewport_size({'width':390,'height':844});assert await worker.evaluate('document.documentElement.scrollWidth<=innerWidth')
    await worker.screenshot(path='/tmp/vrc-x-settings-mobile.png',full_page=True)
    await worker.set_viewport_size({'width':1450,'height':1050})
    # Thirty targets with three unreadable profiles must all be processed without a global pause.
    original_profiles=await worker.evaluate('fixture.values.xProfileCache')
    batch=['batch'+str(i).zfill(2) for i in range(24)];bad=set(batch[:3])
    counts.update({name:i+1000 for i,name in enumerate(batch)});modes.update({name:'hold' for name in batch})
    await worker.evaluate('''async names=>{const cache=structuredClone(fixture.values.xProfileCache);
      Object.values(cache).forEach((entry,i)=>entry.urls.push(...names.slice(i*4,i*4+4).map(n=>'https://x.com/'+n)));
      fixture.offset+=16000;await chrome.storage.local.set({xProfileCache:cache});}''',batch)
    await worker.locator('[data-tab=friends]').click();await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('対象 30件')
    before=len(created);await worker.locator('#friendsPanel [data-x-collect]').click()
    await worker.wait_for_function('fixture.values.xFollowerQueue.active.length===10 && fixture.values.xFollowerQueue.active.every(j=>j.tabId!=null)')
    assert len(created)-before==10;await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('同時取得 10/10件')
    for name in batch[10:]:modes.pop(name,None)
    for name in batch[3:10]:await release(name)
    for _ in range(25):
      await asyncio.sleep(1)
      state=await worker.evaluate('fixture.values.xFollowerQueue')
      assert not state['paused'],state
      assert len(state['active'])<=10,state
      if state['phase']=='complete':break
      await next_job()
    await worker.wait_for_function("fixture.values.xFollowerQueue.phase==='complete'")
    state=await worker.evaluate('fixture.values.xFollowerQueue')
    assert (state['total'],state['success'],state['failed'],state['retries'])==(30,27,3,3),state
    assert not state['items'] and not state['active'];assert len(created)-before==33
    await expect(worker.locator('#friendsPanel [data-x-queue]')).to_contain_text('残り 0件')
    await worker.locator('#friendsPanel [data-x-errors] summary').click()
    await expect(worker.locator('#friendsPanel [data-x-errors]')).to_contain_text('@batch00')
    await worker.screenshot(path='/tmp/vrc-x-batch-complete.png',full_page=True)
    await worker.evaluate('(cache)=>chrome.storage.local.set({xProfileCache:cache})',original_profiles)
    # Explicit page rate-limit notice pauses, preserving the previous value and pending jobs.
    modes['old']='limit';await worker.locator('#friendsPanel [data-x-collect]').click();await next_job();await next_job()
    await worker.wait_for_function("fixture.values.xFollowerQueue?.phase==='paused'")
    assert await worker.evaluate("fixture.values.xFollowerCache['xFollowers:usr_demoaccount0001:old'].followers")==222
    # The independent official-note reader may try an identity GET when the detail opens.
    assert all(u=='https://vrchat.com/api/1/auth/user' for u in await worker.evaluate('fixture.api'))
    assert all('/api/' not in u for u in requests)
    await worker.screenshot(path='/tmp/vrc-x-collection-desktop.png',full_page=True)
    await worker.set_viewport_size({'width':390,'height':844});assert await worker.evaluate('document.documentElement.scrollWidth<=innerWidth')
    await worker.screenshot(path='/tmp/vrc-x-collection-mobile.png',full_page=True)
    assert not errors,errors
    await browser.close();print('PASS: three and ten concurrent real tabs, 30 targets completed despite three failures, bounded retries, missing-first refill, saved concurrency/reload/mobile, no repeated bulk jobs, detail refresh, preserved manual tab, rate-limit pause, no APIs during bulk X collection')
try:asyncio.run(main())
finally:server.shutdown()
