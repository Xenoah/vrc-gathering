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
FIXTURE="\n                const accountId='usr_demoaccount0001',values=JSON.parse(localStorage.getItem('x-test-storage')||'null')||{settings:{enabled:false,contact:'https://github.com/example',pollSeconds:180,retentionDays:30},accountMeta:{[accountId]:{displayName:'Demo'},usr_notesaccount002:{displayName:'Other'}}};\n                let messageListener;const noop={addListener:()=>{}},listeners=[];\n                window.fixture={values,requests:[],note:'20250309 kakuteishinkoku_World',missing:false,denied:false,activeAccount:accountId};\n                const storage={get:async keys=>{await window.seedReady;return structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])));},set:async next=>{Object.assign(values,structuredClone(next));localStorage.setItem('x-test-storage',JSON.stringify(values));listeners.forEach(fn=>fn());},setAccessLevel:async()=>{}};\n                window.chrome={storage:{local:storage,onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{contains:async()=>false},alarms:{create:async()=>{},clear:async()=>{},get:async()=>null,onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:noop},declarativeNetRequest:{updateDynamicRules:async()=>{}},tabs:{create:async()=>{}},runtime:{id:'testextension',getURL:path=>new URL(path,location.href).href,onInstalled:noop,onStartup:noop,onMessage:{addListener:fn=>{messageListener=fn;}},sendMessage:async message=>{if(message.type==='X_PROFILE')return {ok:true,profile:{urls:[],checkedAt:Date.now()}};await window.workerReady;return new Promise(resolve=>messageListener(message,{id:'testextension',url:location.href},resolve));}}};\n                const originalFetch=window.fetch.bind(window);\n                window.fetch=async(url,options)=>{\n                    if(!String(url).startsWith('https://vrchat.com/api/1/'))return originalFetch(url,options);\n                    fixture.requests.push({url:String(url),method:options.method});const path=new URL(url).pathname;\n                    if(fixture.denied)return new Response('{}',{status:401,headers:{'Content-Type':'application/json'}});\n                    if(fixture.gate&&path.includes('/users/'))await new Promise(resolve=>fixture.release=resolve);\n                    const body=path.endsWith('/auth/user')?{id:fixture.activeAccount,displayName:'Demo'}:{id:path.split('/').at(-1),...(!fixture.missing?{note:fixture.note}:{}),authToken:'SECRET',userIcon:'SECRET'};\n                    return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});\n                };\n                window.seedReady=(async()=>{const d=(await import('/demo.js')).demoData();const {mergeSyncRecords}=await import('/db.js');const {normalizeRecord}=await import('/sync-format.js');await mergeSyncRecords(d.friends.flatMap(f=>[normalizeRecord('friends',f),normalizeRecord('friends',{...f,accountId:'usr_notesaccount002'})]));})();\n                window.workerReady=seedReady.then(()=>import('/background.js'));\n            "
try:
    with tempfile.TemporaryDirectory(prefix='vrc-notes-') as profile,sync_playwright() as p:
        context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,viewport={'width':1400,'height':1000})
        context.add_init_script(FIXTURE)
        errors=[];page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        def open_user(name='星灯り'):
            page.locator('[data-tab=friends]').click();page.locator('#friendsBody tr').filter(has_text=name).click()
        def age():page.evaluate("Object.keys(fixture.values.userNoteChecks||{}).forEach(k=>fixture.values.userNoteChecks[k]=Date.now()-61000)")
        page.goto(base+'/dashboard.html');open_user()
        expect(page.locator('#userNoteText')).to_have_text('20250309 kakuteishinkoku_World',timeout=15000)
        expect(page.locator('#userNotes textarea')).to_have_count(0);expect(page.locator('#userNotes a')).to_have_attribute('href',__import__('re').compile(r'https://vrchat.com/home/user/usr_'))
        assert page.evaluate('fixture.requests.length')==3
        old=page.evaluate("async()=>(await (await import('/db.js')).researchKind('userNotes','usr_demoaccount0001'))[0]")
        history=lambda:page.evaluate("async()=>(await (await import('/db.js')).researchKind('userNoteHistory','usr_demoaccount0001')).length")
        assert history()==1;assert 'SECRET' not in str(old)
        age();page.locator('#refreshUserNote').click();expect(page.locator('#refreshUserNote')).to_be_enabled(timeout=15000);assert history()==1
        age();page.evaluate("note=>{fixture.note=note;}","改行した公式ノート\n<img src=x onerror=alert(1)>");page.locator('#refreshUserNote').click();expect(page.locator('#userNoteText')).to_contain_text('<img',timeout=15000);expect(page.locator('#userNotes img')).to_have_count(0);assert history()==2
        page.locator('#userNotes summary').click();expect(page.locator('.user-note-history article')).to_have_count(2)
        page.locator('#detail').screenshot(path='/tmp/vrc-official-notes-desktop.png')
        page.reload();open_user();expect(page.locator('#userNoteText')).to_contain_text('<img');assert page.evaluate('fixture.requests.length')==0
        age();page.evaluate('fixture.missing=true');page.locator('#refreshUserNote').click();expect(page.locator('#userNoteStatus')).to_contain_text('本文を確認できません',timeout=15000);expect(page.locator('#userNoteText')).to_contain_text('<img');assert history()==2
        page.evaluate("fixture.missing=false;fixture.note=''");page.locator('#refreshUserNote').click();expect(page.locator('#userNoteText')).to_contain_text('未設定',timeout=15000);assert history()==3
        page.locator('#closeDetail').click();page.select_option('#account','usr_notesaccount002');page.wait_for_timeout(300);page.evaluate("fixture.activeAccount='usr_notesaccount002';fixture.note='別アカウントの公式ノート'");open_user();expect(page.locator('#userNoteText')).to_have_text('別アカウントの公式ノート',timeout=15000)
        page.locator('#closeDetail').click();page.select_option('#account','usr_demoaccount0001');page.wait_for_timeout(300);open_user();expect(page.locator('#userNoteText')).to_contain_text('未設定')
        # A different active VRChat account must not replace this account's saved note.
        age();page.locator('#refreshUserNote').click();expect(page.locator('#userNoteStatus')).to_contain_text('ログインアカウントが異なります',timeout=15000);expect(page.locator('#userNoteText')).to_contain_text('未設定')
        page.evaluate("fixture.activeAccount='usr_demoaccount0001';fixture.note='再設定';fixture.gate=true");page.locator('#refreshUserNote').click();page.wait_for_function("()=>typeof fixture.release==='function'")
        page.locator('#closeDetail').click();open_user('蒼のアトリエ');expect(page.locator('#userNoteText')).not_to_have_text('再設定');page.evaluate('()=>{fixture.gate=false;fixture.release();}')
        page.wait_for_timeout(350);expect(page.locator('#userNoteText')).not_to_have_text('再設定')
        # The completed request belongs to the earlier user; reopening reads its persisted result.
        page.locator('#closeDetail').click();page.wait_for_timeout(2500);open_user();expect(page.locator('#userNoteText')).to_have_text('再設定',timeout=15000)
        page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.locator('#detail').screenshot(path='/tmp/vrc-official-notes-mobile.png')
        exported=page.evaluate("async()=>await (await import('/db.js')).exportAccount('usr_demoaccount0001')");assert exported['userNotes'];assert len(exported['userNoteHistory'])==4;assert all(r['accountId']=='usr_demoaccount0001' for r in exported['userNotes']);assert all(r['method']=='GET' for r in page.evaluate('fixture.requests'))
        # Retention preserves the latest note, while old note history follows the normal period.
        page.evaluate("""async()=>{const {normalizeRecord}=await import('/sync-format.js');const {mergeSyncRecords,prune}=await import('/db.js');const at=Date.now()-90*86400000;const v={accountId:'usr_demoaccount0001',userId:'usr_oldnote0001',note:'過去から残る最新ノート',noteId:'',createdAt:null,observedAt:at,changedAt:at,source:'vrchat-user-note'};await mergeSyncRecords(['userNotes','userNoteHistory'].map(k=>normalizeRecord(k,v)));await prune(30);}""")
        saved=page.evaluate("async()=>await (await import('/db.js')).exportAccount('usr_demoaccount0001')");assert any(r['userId']=='usr_oldnote0001' for r in saved['userNotes']);assert not any(r['userId']=='usr_oldnote0001' for r in saved['userNoteHistory'])
        assert not errors,errors
        context.close();print('PASS: official note fetching, unchanged/changed/cleared values, persisted history, account isolation, missing fields, stale responses, read-only UI, exports and retention')
finally:server.shutdown()
