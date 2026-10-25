"""Browser UI with the real sync client and a mocked Chrome/HTTP boundary; no live credentials."""
import functools
import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
    def end_headers(self):
        self.send_header('Content-Security-Policy',json.loads((ROOT/'extension/manifest.json').read_text())['content_security_policy']['extension_pages'])
        super().end_headers()
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
    with tempfile.TemporaryDirectory(prefix='vrc-sync-ui-') as profile,sync_playwright() as p:
        context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True)
        try:
            context.add_init_script('''
              const token='browser_test_key_0123456789_abcdefghijklmnopqrstuvwxyz';
              const values={settings:{enabled:false},accountMeta:{},cloudSync:{enabled:false,endpoint:'https://script.google.com/macros/s/test/exec',token}};
              const listeners=[],allowed=new Set();let client;
              window.fixture={values,requests:[],commands:[],mode:'html'};
              const storage={get:async keys=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]]))),set:async value=>{Object.assign(values,structuredClone(value));listeners.forEach(fn=>fn());}};
              const permissions={contains:async({origins})=>origins.every(v=>allowed.has(v)),request:async({origins})=>{origins.forEach(v=>allowed.add(v));return true;}};
              window.chrome={storage:{local:storage,onChanged:{addListener:fn=>listeners.push(fn)}},permissions,runtime:{sendMessage:async message=>{
                fixture.commands.push(message.type);
                const {createSync,syncSettings,CLOUD_ORIGINS}=await import('./sync.js');
                client ||= createSync({storage,hasPermission:()=>permissions.contains({origins:CLOUD_ORIGINS}),exportRecords:async()=>[],mergeRecords:async()=>{},fetcher:async(url,options)=>{
                  const body=JSON.parse(options.body);fixture.requests.push(body.action);
                  let response;
                  if(fixture.mode==='html')response=new Response('<html>Sign in</html>',{headers:{'Content-Type':'text/html'}});
                  else if(fixture.mode==='auth')response=new Response(JSON.stringify({protocol:2,ok:false,code:'AUTH'}));
                  else response=new Response(JSON.stringify(body.action==='hello'?{protocol:2,ok:true,datasetId:'test',protocols:[1,2],recordSchemas:[1,2],operations:['upsert'],kinds:['friends','events','worlds','runs','accounts','visits','encounters','profiles','xFollowers','segments','crowd','coverage','followerHistory','annotations','views','reports'],retentionDays:0,maxBatch:100}:{protocol:2,ok:true,datasetId:'test',records:[],cursor:0,hasMore:false}));
                  Object.defineProperty(response,'url',{value:'https://script.googleusercontent.com/macros/echo?user_content_key=PRIVATE_REDIRECT_TOKEN'});return response;
                }});
                if(message.type==='TEST_SYNC')return {ok:true,...await client.testConnection()};
                if(message.type==='SYNC')return {ok:true,...await client.sync({force:message.force})};
                if(message.type==='SAVE_SYNC'){const config=syncSettings({...message.settings,token:message.settings.token||values.cloudSync.token});await storage.set({cloudSync:config});return {ok:true};}
                return {ok:false,error:'Unexpected test command'};
              }}};
            ''')
            errors=[]
            page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base+'/dashboard.html')
            page.locator('[data-tab=settings]').click()
            expect(page.locator('#syncSavedState')).to_contain_text('同期無効')
            expect(page.locator('#syncPermissionStatus')).to_contain_text('script.google.com：未許可')
            page.locator('#testSync').click()
            expect(page.locator('#syncTestCode')).to_have_text('PERMISSION')
            assert page.evaluate('fixture.requests.length')==0
            page.locator('#grantSyncPermissions').click()
            expect(page.locator('#syncPermissionStatus')).to_contain_text('script.googleusercontent.com：許可済み')
            page.locator('#testSync').click()
            expect(page.locator('#syncTestCode')).to_have_text('PUBLIC_ACCESS')
            expect(page.locator('#syncTestMessage')).to_contain_text('アクセスできるユーザー：全員')
            expect(page.locator('#syncTestHTTP')).to_have_text('200')
            expect(page.locator('#syncTestURL')).to_have_text('https://script.googleusercontent.com/macros/echo')
            page.evaluate("fixture.mode='auth'")
            page.locator('#testSync').click();expect(page.locator('#syncTestCode')).to_have_text('AUTH')
            page.evaluate("fixture.mode='ok'")
            page.locator('#testSync').click();expect(page.locator('#syncTestMessage')).to_contain_text('接続成功')
            assert page.evaluate('fixture.requests.every(a=>a==="hello")')
            page.locator('#syncToken').fill('new_browser_test_key_0123456789_abcdefghijklmnopqrstuvwxyz')
            count=page.evaluate('fixture.requests.length')
            page.locator('#testSync').click();expect(page.locator('#toast')).to_contain_text('先に「同期設定を保存」')
            assert page.evaluate('fixture.requests.length')==count
            page.locator('#syncEnabled').check();page.locator('#syncForm button[type=submit]').click()
            expect(page.locator('#syncNotice')).to_have_text('保存しました')
            expect(page.locator('#syncToken')).to_have_value('')
            await_state="""async()=>chrome.storage.local.set({cloudState:{phase:'error',lastAttemptAt:Date.now(),retryAt:Date.now()+3600000,serverRetryAt:0,lastError:'テスト用の通信エラー'}})"""
            page.evaluate(await_state)
            expect(page.locator('#syncLastError')).to_contain_text('テスト用の通信エラー')
            expect(page.locator('#syncRetryAt')).to_contain_text('今すぐ同期で再試行')
            expect(page.locator('#syncNow')).to_be_enabled();page.locator('#syncNow').click()
            expect(page.locator('#syncStatus')).to_contain_text('同期完了')
            assert page.evaluate('fixture.requests.includes("pull")')
            page.locator('[data-tab=settings]').click()
            page.evaluate("async()=>chrome.storage.local.set({cloudState:{serverRetryAt:Date.now()+60000,retryAt:Date.now()+60000}})")
            expect(page.locator('#syncRetryAt')).to_contain_text('サーバー指定')
            expect(page.locator('#syncNow')).to_be_disabled();expect(page.locator('#testSync')).to_be_disabled()
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path='/tmp/vrc-sync-diagnostics-mobile.png',full_page=True)
            page.evaluate("async()=>chrome.storage.local.set({cloudState:{},cloudDiagnostic:{phase:'testing',testedAt:Date.now()-60000}})")
            expect(page.locator('#testSync')).to_be_enabled();expect(page.locator('#syncTestMessage')).to_contain_text('もう一度実行')
            page.evaluate("async()=>chrome.storage.local.set({cloudState:{phase:'syncing',lastAttemptAt:Date.now()-180000}})")
            expect(page.locator('#syncStatus')).to_contain_text('前回の同期が完了していません')
            expect(page.locator('#syncNow')).to_be_enabled()
            expect(page.locator('#syncProgress')).to_contain_text('旧版のため段階不明')
            assert 'PRIVATE_REDIRECT_TOKEN' not in page.locator('body').inner_text()
            assert not errors,errors
            print('PASS: permission diagnosis/grant, hello-only test, public access/auth errors, safe response details, unsaved settings, manual retry/server wait, interruption recovery, mobile layout')
        finally:context.close()
finally:
    server.shutdown();server.server_close()
