"""Synthetic log files through the real dashboard, worker, IndexedDB and folder watcher."""
import functools
import json
import tempfile
import threading
from datetime import datetime, timedelta, timezone
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
owner='usr_demoaccount0001';visitor='usr_logvisitor001';friend='usr_demofriend0000'
at=datetime.now(timezone(timedelta(hours=9)))-timedelta(hours=2)
def line(minutes,body):return (at+timedelta(minutes=minutes)).strftime('%Y.%m.%d %H:%M:%S')+' Log - '+body+'\n'
initial=line(0,f'User Authenticated: Self ({owner})')+line(0,'[Behaviour] Entering Room: Fixture world')+line(0,'[Behaviour] Joining wrld_logworld0001:123~region(jp)~nonce(SECRET_NONCE)')+line(1,f'[Behaviour] OnPlayerJoined =Visitor <img> ({visitor})')+line(1,f'[Behaviour] OnPlayerJoined Friend ({friend})')+line(5,f'[Behaviour] OnPlayerLeft Friend ({friend})')+line(11,'[API] SECRET_TOKEN')
ending=line(16,f'[Behaviour] OnPlayerLeft =Visitor <img> ({visitor})')
FIXTURE=r"""
if(location.protocol==='http:'){
const accountId='usr_demoaccount0001',values={settings:{enabled:false,contact:'https://github.com/example',pollSeconds:180,retentionDays:30},accountMeta:{[accountId]:{displayName:'Fixture'},usr_otheraccount001:{displayName:'Other'}}};
let messageListener;const noop={addListener:()=>{}},listeners=[];window.fixture={values,requests:[],messages:[]};
const storage={get:async keys=>{await window.seedReady;return structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])));},set:async next=>{Object.assign(values,structuredClone(next));listeners.forEach(fn=>fn());},setAccessLevel:async()=>{}};
window.chrome={storage:{local:storage,onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{contains:async()=>false},alarms:{create:async()=>{},clear:async()=>{},get:async()=>null,onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:noop},declarativeNetRequest:{updateDynamicRules:async()=>{}},tabs:{create:async()=>{}},runtime:{id:'testextension',getURL:path=>new URL(path,location.href).href,onInstalled:noop,onStartup:noop,onMessage:{addListener:fn=>{messageListener=fn;}},sendMessage:async message=>{fixture.messages.push(message.type);await window.workerReady;return new Promise(resolve=>messageListener(message,{id:'testextension',url:location.href},resolve));}}};
const originalFetch=window.fetch.bind(window);window.fetch=async(url,options)=>{if(!String(url).startsWith('https://vrchat.com/'))return originalFetch(url,options);fixture.requests.push(String(url));throw Error('Unexpected account network access');};
window.seedReady=(async()=>{const d=(await import('/demo.js')).demoData();const {mergeSyncRecords}=await import('/db.js');const {normalizeRecord}=await import('/sync-format.js');await mergeSyncRecords(d.friends.map(f=>normalizeRecord('friends',f)));})();window.workerReady=seedReady.then(()=>import('/background.js'));
}
"""
try:
    with tempfile.TemporaryDirectory(prefix='vrc-log-ui-') as profile,sync_playwright() as p:
        context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,viewport={'width':1440,'height':1000})
        context.add_init_script(FIXTURE);errors=[];page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(base+'/dashboard.html');page.locator('[data-tab=gameLog]').click()
        expect(page.locator('#logSummary')).to_contain_text('0人');page.locator('#chooseLogFiles').click();expect(page.locator('#logImportStatus')).to_contain_text('一致')
        page.locator('#logOwnerConfirmed').check()
        def upload(body,name='output_log_fixture.txt'):
            page.locator('#logFiles').set_input_files({'name':name,'mimeType':'text/plain','buffer':body.encode()});expect(page.locator('#chooseLogFiles')).to_be_enabled(timeout=20000)
        def records():return page.evaluate("async()=>(await (await import('/db.js')).researchKind('instanceEncounters','usr_demoaccount0001')).map(r=>r.value)")
        upload(initial);expect(page.locator('#logSummary')).to_contain_text('2人');assert len(records())==2;assert 'SECRET' not in json.dumps(records());expect(page.locator('#logBody img')).to_have_count(0)
        expect(page.locator('#logBody')).to_contain_text('終了未確認');page.select_option('#logRelation','nonfriend');expect(page.locator('#logSummary')).to_contain_text('1人');expect(page.locator('#logBody')).to_contain_text('10分')
        page.locator('#logBody button').click();expect(page.locator('#logDetail')).to_contain_text('Fixture world');expect(page.locator('#logDetail a')).to_have_attribute('href','https://vrchat.com/home/user/'+visitor)
        with page.expect_download() as dl:page.locator('#logSummaryCSV').click()
        assert "'=Visitor <img>" in Path(dl.value.path()).read_text()
        upload(initial+ending);expect(page.locator('#logBody')).to_contain_text('15分');expect(page.locator('#logBody')).not_to_contain_text('終了未確認');assert len(records())==2
        upload(initial+ending);assert len(records())==2
        upload(initial.replace(owner,'usr_otheraccount001'),'output_log_other.txt');expect(page.locator('#logImportStatus')).to_contain_text('異なり');assert len(records())==2
        # A copied log is distinct evidence, but must not double the displayed time/count.
        upload(initial+ending,'output_log_copy.txt');expect(page.locator('#logBody')).to_contain_text('15分');assert len(records())==4;assert page.locator('#logBody tr td').nth(2).inner_text()=='1'
        page.select_option('#logRelation','friend');expect(page.locator('#logSummary')).to_contain_text('1人');expect(page.locator('#logBody')).to_contain_text('4分')
        page.select_option('#logRelation','all');page.locator('#logSearch').fill('visitor');expect(page.locator('#logSummary')).to_contain_text('1人');page.locator('#logSearch').fill('')
        page.locator('#gameLogPanel').screenshot(path='/tmp/vrc-game-logs-desktop.png');page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.locator('#gameLogPanel').screenshot(path='/tmp/vrc-game-logs-mobile.png');page.set_viewport_size({'width':1440,'height':1000})
        # Origin-private FileSystem handles provide real file reads/IDB cloning;
        # directory-picker permission is mocked, not a real desktop permission grant.
        watched=initial.replace(visitor,'usr_watched00001').replace('=Visitor <img>','Watched')
        page.evaluate("""async text=>{fixture.folder=await (await navigator.storage.getDirectory()).getDirectoryHandle('fixture-logs',{create:true});fixture.file=await fixture.folder.getFileHandle('output_log_watch.txt',{create:true});fixture.write=async text=>{const w=await fixture.file.createWritable();await w.write(text);await w.close();};await fixture.write(text);FileSystemHandle.prototype.queryPermission=async()=> 'granted';FileSystemHandle.prototype.requestPermission=async()=> 'granted';window.showDirectoryPicker=async()=>fixture.folder;}""",watched)
        page.locator('#chooseLogFolder').click();expect(page.locator('#logBody')).to_contain_text('Watched',timeout=20000)
        page.evaluate('text=>fixture.write(text)',watched+line(21,'[Behaviour] OnPlayerLeft Watched (usr_watched00001)'))
        expect(page.locator('#logBody tr').filter(has_text='Watched')).to_contain_text('20分',timeout=25000)
        expect(page.locator('#logBody tr').filter(has_text='Watched')).not_to_contain_text('終了未確認')
        page.locator('#stopLogWatch').click();page.locator('#resumeLogWatch').click();expect(page.locator('#logImportStatus')).to_contain_text('変更なし',timeout=10000)
        page.select_option('#account','usr_otheraccount001');expect(page.locator('#logSummary')).to_contain_text('0人');expect(page.locator('#logOwnerConfirmed')).not_to_be_checked()
        page.select_option('#account',owner);expect(page.locator('#logSummary')).to_contain_text('3人')
        exported=page.evaluate("async()=>await (await import('/db.js')).exportAccount('usr_demoaccount0001')");assert len(exported['instanceEncounters'])==6;assert not page.evaluate('fixture.requests')
        # The ordinary collector can add nonfriends from an explicit current-instance
        # response. This fixture does not claim the live API always supplies users.
        page.evaluate("""()=>{window.fetch=async(url,options)=>{fixture.requests.push(String(url));const path=new URL(url).pathname,owner='usr_demoaccount0001',world='wrld_logworld0001',place=world+':123~region(jp)';let body;if(path.endsWith('/auth/user'))body={id:owner,displayName:'Self',location:place,friends:['usr_demofriend0000']};else if(path.endsWith('/friends'))body=[];else if(path.endsWith('/userNotes'))body=[];else if(path.includes('/instances/'))body={location:place,userCount:2,users:[{id:owner,displayName:'Self'},{id:'usr_apipeer00001',displayName:'API Visitor',friendKey:'SECRET',userIcon:'SECRET'}],world:{name:'API world'}};else body={id:world,name:'Fixture world',capacity:16};return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});};}""")
        page.evaluate("()=>chrome.runtime.sendMessage({type:'START'})");expect(page.locator('#instanceCollectionStatus')).to_contain_text('参加者 1人',timeout=25000)
        page.select_option('#logDevice','api');expect(page.locator('#logSummary')).to_contain_text('1人');expect(page.locator('#logBody')).to_contain_text('API Visitor');expect(page.locator('#logBody')).to_contain_text('API観測');assert 'SECRET' not in json.dumps(records())
        page.evaluate("()=>chrome.runtime.sendMessage({type:'PAUSE'})");page.select_option('#logDevice','')
        old_epoch=page.evaluate("fixture.values.logImportEpoch||0");value=records()[0];page.evaluate("()=>chrome.runtime.sendMessage({type:'CLEAR'})");expect(page.locator('#logSummary')).to_contain_text('0人')
        result=page.evaluate("({value,epoch})=>chrome.runtime.sendMessage({type:'IMPORT_LOG_ENCOUNTERS',accountId:value.accountId,epoch,records:[value]})",{'value':value,'epoch':old_epoch});assert result['ok'] is False;assert records()==[]
        assert not errors,errors
        context.close();print('PASS: log import/watch/append, nonfriends, overlap deduplication, CSV, account isolation, explicit In Instance API observations, reset gate and mobile layout')
finally:server.shutdown()
