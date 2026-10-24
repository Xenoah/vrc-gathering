"""Settings backup UI with the actual worker/modules and IndexedDB, mocked Chrome APIs only."""
import functools
import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def end_headers(self):
        self.send_header('Content-Security-Policy', json.loads((ROOT/'extension/manifest.json').read_text())['content_security_policy']['extension_pages'])
        super().end_headers()
server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    with tempfile.TemporaryDirectory(prefix='vrc-settings-ui-') as profile, sync_playwright() as p:
        context = p.chromium.launch_persistent_context(profile, executable_path='/usr/bin/chromium', headless=True)
        try:
            context.add_init_script('''
              const token='browser_backup_key_0123456789_abcdefghijklmnopqrstuvwxyz';
              const initial={settings:{enabled:false,contact:'https://github.com/example',pollSeconds:180,retentionDays:30,offlineRefreshMinutes:60},cloudSync:{enabled:false,endpoint:'https://script.google.com/macros/s/test/exec',token},accountMeta:{}};
              const values=JSON.parse(localStorage.getItem('test-storage')||'null')||initial;
              const listeners=[],allowed=new Set();let messageListener;
              const noop={addListener:()=>{}};
              window.fixture={values,commands:[],requests:[],allowPermissions:true,permissionRequests:[]};
              const storage={get:async keys=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]]))),set:async value=>{Object.assign(values,structuredClone(value));localStorage.setItem('test-storage',JSON.stringify(values));listeners.forEach(fn=>fn());},setAccessLevel:async()=>{}};
              window.chrome={storage:{local:storage,onChanged:{addListener:fn=>listeners.push(fn)}},
                permissions:{contains:async({origins})=>origins.every(v=>allowed.has(v)),request:async({origins})=>{fixture.permissionRequests.push(origins);if(!fixture.allowPermissions)return false;origins.forEach(v=>allowed.add(v));return true;}},
                alarms:{create:async()=>{},clear:async()=>{},get:async()=>null,onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:noop},
                declarativeNetRequest:{updateDynamicRules:async()=>{}},tabs:{create:async()=>{}},
                runtime:{id:'testextension',getURL:path=>new URL(path,location.href).href,onInstalled:noop,onStartup:noop,onMessage:{addListener:fn=>{messageListener=fn;}},sendMessage:async message=>{
                  fixture.commands.push(message.type);await window.workerReady;
                  return new Promise(resolve=>messageListener(message,{id:'testextension',url:location.href},resolve));
                }}};
              const originalFetch=window.fetch.bind(window);
              window.fetch=(url,options)=>{
                if(!String(url).startsWith('https://script.google.com/'))return originalFetch(url,options);
                const action=JSON.parse(options.body).action;fixture.requests.push(action);
                return Promise.resolve(new Response(JSON.stringify(action==='hello'?{protocol:2,ok:true,datasetId:'test',protocols:[1,2],recordSchemas:[1,2],operations:['upsert'],maxBatch:100}:{protocol:2,ok:true,datasetId:'test',records:[],cursor:0,hasMore:false})));
              };
              window.workerReady=import('/background.js');
            ''')
            errors=[]
            page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base+'/dashboard.html');page.locator('[data-tab=settings]').click()
            expect(page.locator('#contact')).to_have_value('https://github.com/example')
            page.locator('#contact').fill('https://github.com/unsaved')
            with page.expect_download() as event: page.locator('#exportSettings').click()
            backup=json.loads(Path(event.value.path()).read_text())
            assert backup['settings']['collection']['contact']=='https://github.com/example'
            assert 'token' not in backup['settings']['sync']
            assert not any(key in backup for key in ['state','cloudCheckpoint','accountMeta'])
            page.locator('#includeSyncToken').check()
            with page.expect_download() as event: page.locator('#exportSettings').click()
            with_key=json.loads(Path(event.value.path()).read_text())
            token=with_key['settings']['sync']['token']
            assert token=='browser_backup_key_0123456789_abcdefghijklmnopqrstuvwxyz'
            assert '-with-key' in event.value.suggested_filename
            expect(page.locator('#includeSyncToken')).not_to_be_checked()
            before=page.evaluate('JSON.stringify(fixture.values)')
            def upload(value):
                page.locator('#settingsFile').set_input_files({'name':'settings.json','mimeType':'application/json','buffer':json.dumps(value).encode()})
            with page.expect_file_chooser() as chooser: page.locator('#importSettings').click()
            chooser.value.set_files({'name':'settings.json','mimeType':'application/json','buffer':json.dumps(with_key).encode()})
            expect(page.locator('#settingsImportDialog')).to_be_visible()
            assert token not in page.locator('#settingsImportDialog').inner_text()
            page.locator('#cancelSettingsImport').click()
            assert page.evaluate('JSON.stringify(fixture.values)')==before
            upload({'schema':1,'friends':[]})
            expect(page.locator('#backupNotice')).to_contain_text('履歴JSON')
            assert page.evaluate('JSON.stringify(fixture.values)')==before
            future={**backup,'schema':2};upload(future)
            expect(page.locator('#backupNotice')).to_contain_text('未対応')
            page.locator('#settingsFile').set_input_files({'name':'large.json','mimeType':'application/json','buffer':b' '*65537})
            expect(page.locator('#backupNotice')).to_contain_text('64KiB')
            with_key['settings']['sync']['enabled']=True
            with_key['settings']['images']['enabled']=True
            page.evaluate('fixture.allowPermissions=false');upload(with_key)
            page.locator('#confirmSettingsImport').click()
            expect(page.locator('#settingsImportError')).to_contain_text('権限が許可されなかった')
            assert page.evaluate('JSON.stringify(fixture.values)')==before
            page.locator('#cancelSettingsImport').click()
            # Omitted key + same endpoint keeps this device's key, including uncommon valid intervals.
            backup['settings']['collection'].update(contact='https://github.com/restored',pollSeconds=120,retentionDays=14,offlineRefreshMinutes=120)
            upload(backup);expect(page.locator('#settingsImportFields')).to_contain_text('保存済みキーを維持')
            page.locator('#confirmSettingsImport').click()
            expect(page.locator('#backupNotice')).to_contain_text('読み込み、保存しました')
            expect(page.locator('#settingsImportDialog')).not_to_be_visible()
            expect(page.locator('#contact')).to_have_value('https://github.com/restored')
            expect(page.locator('#pollSeconds')).to_have_value('120')
            expect(page.locator('#retentionDays')).to_have_value('14')
            assert page.evaluate('fixture.values.settings.enabled') is False
            assert page.evaluate('fixture.values.cloudSync.token')==token
            expect(page.locator('#syncToken')).to_have_value('')
            page.reload();page.locator('[data-tab=settings]').click()
            expect(page.locator('#contact')).to_have_value('https://github.com/restored')
            expect(page.locator('#pollSeconds')).to_have_value('120')
            # Different endpoint never borrows the old key; sync remains off until a key is saved.
            backup['settings']['sync'].update(enabled=True,endpoint='https://script.google.com/macros/s/other/exec')
            upload(backup);expect(page.locator('#settingsImportFields')).to_contain_text('既存キーは引き継ぎません')
            page.locator('#confirmSettingsImport').click()
            expect(page.locator('#backupNotice')).to_contain_text('同期キーの入力')
            assert page.evaluate('fixture.values.cloudSync.token')==''
            expect(page.locator('#syncEnabled')).not_to_be_checked()
            # A full backup enables the requested features through the real worker command.
            upload(with_key);page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path='/tmp/vrc-settings-import-mobile.png',full_page=True)
            page.locator('#confirmSettingsImport').click()
            expect(page.locator('#settingsImportDialog')).not_to_be_visible()
            expect(page.locator('#syncEnabled')).to_be_checked();expect(page.locator('#imageEnabled')).to_be_checked()
            assert page.evaluate('fixture.values.cloudSync.token')==token
            assert len(page.evaluate('fixture.permissionRequests.at(-1)'))==4
            assert token not in page.locator('body').inner_text()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path='/tmp/vrc-settings-backup-mobile.png',full_page=True)
            assert not errors,errors
            print('PASS: actual worker settings backup/restore, secret opt-in, preview/cancel, invalid files, denied permissions, key isolation, persistence, custom intervals, mobile layout')
        finally: context.close()
finally:
    server.shutdown();server.server_close()
