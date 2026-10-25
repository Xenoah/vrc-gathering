"""Connections UI and v2→v3 IndexedDB migration under the extension CSP, without live accounts."""
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
    with tempfile.TemporaryDirectory(prefix='vrc-connections-') as profile,sync_playwright() as p:
        context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True)
        try:
            errors=[]
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(base+'/dashboard.html?demo=1')
            page.locator('[data-tab=connections]').click()
            expect(page.locator('#connectionsPanel')).to_be_visible()
            expect(page.locator('#selfStatus')).to_contain_text('星灯りの展望台')
            expect(page.locator('#connectionsBody tr')).to_have_count(3)
            expect(page.locator('#connectionsBody')).to_contain_text('Nagi')
            expect(page.locator('#selfVisits article')).to_have_count(3)
            page.locator('#connectionsBody button').first.click()
            expect(page.locator('#connectionDetail')).to_contain_text('同じインスタンス')
            page.locator('#connectionsRelation').select_option('world')
            expect(page.locator('#connectionsBody tr')).to_have_count(1)
            expect(page.locator('#connectionsBody')).to_contain_text('Haru')
            page.locator('#connectionsBody button').click()
            expect(page.locator('#connectionDetail')).to_contain_text('一致未確認')
            expect(page.locator('#connectionDetail')).to_contain_text('99999')
            page.locator('#connectionsRelation').select_option('all')
            expect(page.locator('#connectionsBody tr')).to_have_count(4)
            page.locator('#connectionsWorld').select_option('wrld_democafe000000')
            expect(page.locator('#connectionsBody tr')).to_have_count(1)
            expect(page.locator('#connectionsBody')).to_contain_text('Riku')
            expect(page.locator('#selfVisits article')).to_have_count(1)
            page.locator('#connectionsWorld').select_option('')
            page.locator('#connectionsSearch').fill('Nagi')
            expect(page.locator('#connectionsBody tr')).to_have_count(1)
            expect(page.locator('#connectionsBody')).to_contain_text('Nagi')
            page.locator('#connectionsSearch').fill('')
            page.locator('#connectionsSort').select_option('name')
            page.locator('#connectionsFit').click()
            before=page.locator('#connectionsZoom').inner_text()
            page.locator('#connectionsZoomIn').click()
            assert page.locator('#connectionsZoom').inner_text()!=before
            page.screenshot(path='/tmp/vrc-connections-desktop.png',full_page=True)
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path='/tmp/vrc-connections-mobile.png',full_page=True)
            page.locator('[data-tab=friends]').click()
            with page.expect_download() as event:page.locator('#exportJSON').click()
            saved=json.loads(Path(event.value.path()).read_text())
            assert len(saved['visits'])==3 and len(saved['encounters'])==5
            # Demo mode leaves IndexedDB empty; seed the old schema before opening the real DB module.
            migration=context.new_page();migration.goto(base+'/setup/appsscript.json')
            migration.evaluate('''async()=>{
                const d=(await import('./../demo.js')).demoData();
                await new Promise((resolve,reject)=>{const req=indexedDB.open('vrc-friends-observer',2);req.onupgradeneeded=()=>{
                    const db=req.result;
                    for(const name of ['friends','worlds']){const store=db.createObjectStore(name,{keyPath:['accountId','id']});store.createIndex('account','accountId');store.createIndex('observed','observedAt');}
                    for(const name of ['events','runs']){const store=db.createObjectStore(name,{keyPath:'key',autoIncrement:true});store.createIndex('accountTime',['accountId','observedAt']);store.createIndex('observed','observedAt');}
                    const images=db.createObjectStore('imageCache',{keyPath:'key'});images.createIndex('account','accountId');
                };req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction(['friends','imageCache'],'readwrite');
                    tx.objectStore('friends').put(d.friends[0]);tx.objectStore('imageCache').put({key:'existing-image',accountId:d.accountId,blob:new Blob(['keep'],{type:'image/png'})});
                    tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
                };});
            }''')
            migration.evaluate('''async()=>{
                const {db,exportAccount,mergeSyncRecords,cachedImages}=await import('./../db.js');
                const {normalizeRecord}=await import('./../sync-format.js');const d=(await import('./../demo.js')).demoData();
                const opened=await db();if(opened.version!==3)throw Error('Version migration failed');
                const before=await exportAccount(d.accountId);if(before.friends.length!==1||before.visits.length||before.encounters.length)throw Error('Existing records changed');
                const images=await cachedImages(d.accountId);if(images.length!==1||await images[0].blob.text()!=='keep')throw Error('Image cache changed');
                const records=[...d.visits.map(v=>normalizeRecord('visits',v)),...d.encounters.map(v=>normalizeRecord('encounters',v))];
                await mergeSyncRecords(records);await mergeSyncRecords(records);
                const after=await exportAccount(d.accountId);if(after.visits.length!==3||after.encounters.length!==5)throw Error('Duplicate session records');
            }''')
            migration.close()
            assert not errors,errors
            print('PASS: self visits, relationship graph/table/filter/detail, mobile, JSON, real v2→v3 migration preserving records and images, idempotent session import')
        finally:context.close()
finally:server.shutdown();server.server_close()
