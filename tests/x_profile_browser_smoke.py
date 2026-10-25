"""Public profile links through the actual worker, DB and dialog, using mocked API responses."""
import functools
import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def end_headers(self):
        self.send_header('Content-Security-Policy',json.loads((ROOT/'extension/manifest.json').read_text())['content_security_policy']['extension_pages'])
        super().end_headers()
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
    with tempfile.TemporaryDirectory(prefix='vrc-x-profile-') as profile,sync_playwright() as p:
        context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True)
        try:
            context.add_init_script('''
                const accountId='usr_demoaccount0001',values=JSON.parse(localStorage.getItem('x-test-storage')||'null')||{settings:{enabled:false,contact:'https://github.com/example',pollSeconds:180,retentionDays:30},accountMeta:{[accountId]:{displayName:'Demo'}}};
                let messageListener;const noop={addListener:()=>{}},listeners=[];
                window.fixture={values,requests:[],mode:'links'};
                const storage={get:async keys=>{await window.seedReady;return structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])));},set:async next=>{Object.assign(values,structuredClone(next));localStorage.setItem('x-test-storage',JSON.stringify(values));listeners.forEach(fn=>fn());},setAccessLevel:async()=>{}};
                window.chrome={storage:{local:storage,onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{contains:async()=>false},alarms:{create:async()=>{},clear:async()=>{},get:async()=>null,onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:noop},declarativeNetRequest:{updateDynamicRules:async()=>{}},tabs:{create:async()=>{}},runtime:{id:'testextension',getURL:path=>new URL(path,location.href).href,onInstalled:noop,onStartup:noop,onMessage:{addListener:fn=>{messageListener=fn;}},sendMessage:async message=>{await window.workerReady;return new Promise(resolve=>messageListener(message,{id:'testextension',url:location.href},resolve));}}};
                const originalFetch=window.fetch.bind(window);
                window.fetch=async(url,options)=>{
                    if(!String(url).startsWith('https://vrchat.com/api/1/'))return originalFetch(url,options);
                    fixture.requests.push(String(url));const path=new URL(url).pathname;
                    if(fixture.mode==='denied')return new Response('{}',{status:401,headers:{'Content-Type':'application/json'}});
                    const body=path.endsWith('/auth/user')?{id:accountId,displayName:'Demo'}:{id:path.split('/').at(-1),bioLinks:fixture.mode==='empty'?[]:['https://twitter.com/Example?tracking=1','https://evil.example/x.com/other','javascript:alert(1)'],bio:'SECRET_BIO',email:'SECRET_EMAIL'};
                    return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
                };
                window.seedReady=(async()=>{const d=(await import('/demo.js')).demoData();const {mergeSyncRecords}=await import('/db.js');const {normalizeRecord}=await import('/sync-format.js');await mergeSyncRecords(d.friends.map(f=>normalizeRecord('friends',f)));})();
                window.workerReady=seedReady.then(()=>import('/background.js'));
            ''')
            context.route('https://x.com/**',lambda route:route.fulfill(status=200,content_type='text/html',body='<title>Mock X profile</title>'))
            errors=[];page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(base+'/dashboard.html');page.locator('[data-tab=friends]').click()
            assert page.evaluate('fixture.requests.length')==0
            before=page.evaluate("async()=>JSON.stringify((await (await import('/db.js')).exportAccount('usr_demoaccount0001')).friends)")
            page.locator('#friendsBody tr').filter(has_text='星灯り').click()
            link=page.locator('#detailXProfiles a')
            expect(link).to_have_count(1,timeout=15000);expect(link).to_have_attribute('href','https://x.com/example')
            expect(link).to_have_attribute('rel','noopener noreferrer')
            with page.expect_popup() as event:link.click()
            popup=event.value;popup.wait_for_load_state();assert popup.url=='https://x.com/example';popup.close()
            assert page.evaluate('fixture.requests.length')==3
            assert page.evaluate('fixture.values.settings.enabled') is False
            after=page.evaluate("async()=>JSON.stringify((await (await import('/db.js')).exportAccount('usr_demoaccount0001')).friends)")
            assert before==after
            assert 'SECRET' not in page.evaluate('JSON.stringify(fixture.values.xProfileCache)')
            page.locator('#detail').screenshot(path='/tmp/vrc-x-profile-desktop.png')
            page.reload();page.locator('[data-tab=friends]').click();page.locator('#friendsBody tr').filter(has_text='星灯り').click()
            expect(page.locator('#detailXProfiles a')).to_have_count(1);assert page.evaluate('fixture.requests.length')==0
            page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.locator('#detail').screenshot(path='/tmp/vrc-x-profile-mobile.png')
            page.evaluate("fixture.mode='empty';Object.values(fixture.values.xProfileCache).forEach(e=>e.checkedAt=Date.now()-61000)")
            page.locator('#detailXProfiles button').click()
            expect(page.locator('#detailXProfiles .sub')).to_contain_text('見つかりませんでした',timeout=15000)
            expect(page.locator('#detailXProfiles a')).to_have_count(0)
            page.evaluate("fixture.mode='denied';Object.values(fixture.values.xProfileCache).forEach(e=>e.checkedAt=Date.now()-61000)")
            page.locator('#detailXProfiles button').click()
            expect(page.locator('#detailXProfiles .sub')).to_contain_text('ログイン',timeout=15000)
            page.locator('#closeDetail').click()
            # Late responses must never replace the selected user's links.
            page.evaluate('''async()=>{
                const {createXProfileView}=await import('/x-profile-ui.js');const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
                const holder=node('div');holder.id='raceProfile';document.body.append(holder);let finish;
                const view=createXProfileView({node,date:String,isOpen:()=>true,request:m=>m.userId==='a'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({ok:true,profile:{urls:['https://x.com/second','javascript:evil'],checkedAt:1}})});
                view.show(holder,'owner','a');view.show(holder,'owner','b');await new Promise(r=>setTimeout(r,0));finish({ok:true,profile:{urls:['https://x.com/first'],checkedAt:1}});await new Promise(r=>setTimeout(r,0));
            }''')
            expect(page.locator('#raceProfile a')).to_have_count(1);expect(page.locator('#raceProfile a')).to_have_attribute('href','https://x.com/second')
            assert not errors,errors
            print('PASS: actual worker/API-to-dialog links, new tab, local cache across reload, no presence refresh, removal, login errors, mobile and late response isolation')
        finally:context.close()
finally:server.shutdown();server.server_close()
