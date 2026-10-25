"""Optional real-browser checks: python3 tests/browser_smoke.py (requires Playwright + Chromium)."""
import functools
import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
class QuietHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
        self.send_header('Content-Security-Policy', manifest['content_security_policy']['extension_pages'])
        super().end_headers()

    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'extension')))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    with tempfile.TemporaryDirectory(prefix='vrc-browser-test-') as profile, sync_playwright() as p:
        def launch():
            return p.chromium.launch_persistent_context(profile, executable_path='/usr/bin/chromium', headless=True)
        errors = []
        context = launch()
        try:
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/dashboard.html?demo=1')
            expect(page.locator('#friendsBody tr')).to_have_count(9)
            # New A/B/C initial screen must not expose the legacy friends panel underneath.
            expect(page.locator('#homePanel')).to_be_visible()
            expect(page.locator('#friendsPanel')).to_be_hidden()
            page.locator('[data-tab=analytics]').click()
            expect(page.locator('#analyticsPanel')).to_be_visible()
            assert page.locator('#activityTimeline .activity-row').count() > 0
            page.locator('#activityWorld').select_option('wrld_demoobservatory')
            expect(page.locator('#activityWorld')).to_have_value('wrld_demoobservatory')
            assert page.locator('#activityTimeline .activity-row').count() > 0
            page.set_viewport_size({'width':390, 'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.locator('#activityTimeline').evaluate('(el)=>{el.scrollLeft=200;}')
            assert page.locator('#activityTimeline').evaluate('(el)=>el.scrollLeft')==200
            page.screenshot(path='/tmp/vrc-activity-timeline-mobile.png',full_page=True)
            page.set_viewport_size({'width':1280,'height':900})
            page.locator('[data-tab=friends]').click()
            expect(page.locator('#friendsPanel')).to_be_visible()
            expect(page.locator('#friendsPanel thead th')).to_contain_text(['フレンド','最終観測状態','ワールド / インスタンス','種類 / 地域','観測上の継続','観測日時'])
            assert page.locator('.brand-icon').evaluate('(img) => img.complete && img.naturalWidth === 128')
            page.locator('[data-tab=help]').click()
            page.locator('#helpPanel [data-open-gas-setup]').click()
            expect(page.locator('#gasSetupGuide')).to_have_attribute('open', '')
            expect(page.locator('#settingsPanel')).to_be_visible()
            expect(page.locator('.setup-steps > li')).to_have_count(6)
            context.grant_permissions(['clipboard-read', 'clipboard-write'])
            for name in ['Code.gs', 'Protocol.gs']:
                page.locator(f'[data-copy-gas="{name}"]').click()
                expect(page.locator('#toast')).to_contain_text(name + ' をコピーしました。')
                assert page.evaluate('navigator.clipboard.readText()') == (ROOT / 'gas' / name).read_text()
                with page.expect_download() as event:
                    page.locator(f'a[download="{name}"]').click()
                assert Path(event.value.path()).read_bytes() == (ROOT / 'gas' / name).read_bytes()
            page.set_viewport_size({'width':390, 'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path='/tmp/vrc-gas-guide-mobile.png', full_page=True)
            page.locator('#backToSyncSettings').click()
            expect(page.locator('#syncEndpoint')).to_be_focused()
            page.set_viewport_size({'width':1280, 'height':900})
            print('PASS: bundled icon, six-step GAS guide, code copy/download under CSP, mobile layout and settings navigation')
            page.locator('[data-tab=ranking]').click()
            expect(page.locator('.world-card')).to_have_count(3)
            expect(page.locator('.world-card').first).to_contain_text('星灯りの展望台')
            expect(page.locator('.world-card').first.locator('.world-score')).to_contain_text('2 人')
            page.locator('[data-tab=journey]').click()
            expect(page.locator('#journeyUser')).to_have_value('')
            expect(page.locator('#journeySummary')).to_contain_text('9 ユーザー')
            page.locator('#networkViewport').scroll_into_view_if_needed()
            page.locator('#resetNetwork').click()
            expect(page.locator('#networkZoom')).to_have_text('100%')
            page.locator('#zoomIn').click()
            expect(page.locator('#networkZoom')).to_have_text('140%')
            page.locator('#zoomIn').click()
            expect(page.locator('#networkZoom')).to_have_text('196%')
            viewport = page.locator('#networkViewport')
            # Zoom controls can scroll above the canvas; drag a visible point.
            viewport.scroll_into_view_if_needed()
            box = viewport.bounding_box()
            viewport.evaluate('(el)=>{el.scrollLeft=200;el.scrollTop=200;}')
            before = viewport.evaluate('(el)=>[el.scrollLeft,el.scrollTop]')
            page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
            page.mouse.down()
            page.mouse.move(box['x']+box['width']/2-80,box['y']+box['height']/2-70,steps=5)
            page.mouse.up()
            after = viewport.evaluate('(el)=>[el.scrollLeft,el.scrollTop]')
            assert after[0]>before[0] and after[1]>before[1], (before,after)
            page.keyboard.down('Control')
            page.mouse.wheel(0,-120)
            page.keyboard.up('Control')
            page.wait_for_function("parseInt(document.getElementById('networkZoom').value)>196")
            viewport.focus()
            page.keyboard.press('Home')
            assert int(page.locator('#networkZoom').inner_text().rstrip('%'))<100
            page.locator('#networkEdge').select_option(index=1)
            expect(page.locator('#networkDetail')).to_contain_text('星灯り')
            page.locator('#networkNode').select_option('wrld_demoobservatory')
            expect(page.locator('#networkDetail')).to_contain_text('Nagi')
            page.locator('#networkSearch').fill('展望台')
            expect(page.locator('#networkNode option')).to_have_count(2)
            page.locator('#networkSearch').fill('')
            page.locator('#fitNetwork').click()
            page.locator('#toast').evaluate('(el)=>el.hidden=true')
            page.screenshot(path='/tmp/vrc-network-overview.png',full_page=True)
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path='/tmp/vrc-network-mobile.png',full_page=True)
            viewport.scroll_into_view_if_needed()
            box=viewport.bounding_box()
            touch=context.new_cdp_session(page)
            touch.send('Emulation.setTouchEmulationEnabled',{'enabled':True,'maxTouchPoints':2})
            scale=int(page.locator('#networkZoom').inner_text().rstrip('%'))
            x,y=box['x']+box['width']/2,box['y']+box['height']/2
            touch.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x-40,'y':y,'id':0},{'x':x+40,'y':y,'id':1}]})
            touch.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x-75,'y':y,'id':0},{'x':x+75,'y':y,'id':1}]})
            touch.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
            page.wait_for_function("previous=>parseInt(document.getElementById('networkZoom').value)>previous",arg=scale)
            touch.send('Emulation.setTouchEmulationEnabled',{'enabled':False})
            page.set_viewport_size({'width':1280,'height':900})
            page.locator('#journeyUser').select_option(label='星灯り')
            expect(page.locator('#journeyFlow > li')).to_have_count(4)
            expect(page.locator('#journeyFlow > li').nth(1)).to_contain_text('所在非公開')
            page.screenshot(path='/tmp/vrc-gathering-journey.png', full_page=True)
            page.set_viewport_size({'width':390, 'height':844})
            page.locator('[data-tab=ranking]').click()
            expect(page.locator('.world-card').first).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path='/tmp/vrc-gathering-ranking-mobile.png', full_page=True)
            page.set_viewport_size({'width':1280, 'height':900})
            page.locator('[data-tab=friends]').click()
            for selector, kind in [('#exportCSV', 'csv'), ('#exportJSON', 'json')]:
                with page.expect_download() as event:
                    page.locator(selector).click()
                content = Path(event.value.path()).read_text(encoding='utf-8-sig')
                if kind == 'json':
                    saved = json.loads(content)
                    assert len(saved['friends']) == 9 and len(saved['events']) == 15
                else:
                    assert 'account_id' in content and '星灯り' in content
            page.locator('#friendSort').select_option('oldest')
            expect(page.locator('#friendsBody tr').first).to_contain_text('Haru')
            page.locator('#friendSort').select_option('name')
            page.evaluate("""async()=>{
              const {worldNetwork}=await import('./insights.js'),{createNetworkView}=await import('./network-view.js'),{demoData}=await import('./demo.js');
              const sample=demoData().friends[0],friends=Array.from({length:3000},(_,i)=>({...sample,id:'usr_bulkuser'+i,location:{...sample.location,worldId:'wrld_bulkworld'+String(i).padStart(5,'0')}}));
              const viewport=document.createElement('div'),stage=document.createElement('div'),canvas=document.createElement('canvas'),output=document.createElement('output');
              viewport.className='network-viewport';viewport.style.width='600px';viewport.style.height='400px';stage.className='network-stage';canvas.style.position='sticky';canvas.style.top='0';canvas.style.left='0';stage.append(canvas);viewport.append(stage);document.body.append(viewport);
              const view=createNetworkView({viewport,stage,canvas,zoomLabel:output,onSelect:()=>{}});view.setGraph(worldNetwork([],friends,[]),'large');
              await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
              if(canvas.width>600*devicePixelRatio||canvas.height>400*devicePixelRatio)throw Error('Canvas allocated entire map');
              view.reset();viewport.scrollLeft=1000;viewport.scrollTop=1000;await new Promise(requestAnimationFrame);
              if(viewport.scrollLeft!==1000||viewport.scrollTop!==1000)throw Error('Large graph scroll failed');viewport.remove();
            }""")
            print('PASS: all-user network, drag/scroll/pinch/wheel zoom, Home/fit, details, sorting, mobile and 3000-node canvas')
            account = page.evaluate('''async () => {
                const {demoData} = await import('./demo.js');
                const {normalizeRecord} = await import('./sync-format.js');
                const {mergeSyncRecords, exportSyncRecords, exportAccount, enqueueImages, cachedImages, updateCachedImage, trimImageCache, clearImageCache, db} = await import('./db.js');
                const {thumbnail}=await import('./image-cache.js');
                const d = demoData();
                // Start with the released v1 database and verify the additive v2 image-store upgrade.
                await new Promise((resolve,reject)=>{const open=indexedDB.open('vrc-friends-observer',1);open.onupgradeneeded=()=>{
                  for(const name of ['friends','worlds']){const store=open.result.createObjectStore(name,{keyPath:['accountId','id']});store.createIndex('account','accountId');store.createIndex('observed','observedAt');}
                  for(const name of ['events','runs']){const store=open.result.createObjectStore(name,{keyPath:'key',autoIncrement:true});store.createIndex('accountTime',['accountId','observedAt']);store.createIndex('observed','observedAt');}
                  open.transaction.objectStore('friends').put(d.friends[0]);
                };open.onsuccess=()=>{open.result.close();resolve();};open.onerror=()=>reject(open.error);});
                if((await db()).version!==2)throw Error('Database upgrade failed');
                if((await exportAccount(d.accountId)).friends.length!==1)throw Error('Upgrade lost records');
                const records = [...d.friends.map(v=>normalizeRecord('friends',v)), ...d.events.map(v=>normalizeRecord('events',v)), ...d.worlds.map(v=>normalizeRecord('worlds',{...v,accountId:d.accountId}))];
                await mergeSyncRecords([...records,...records]);
                await mergeSyncRecords(records);
                let saved = await exportAccount(d.accountId);
                if(saved.friends.length!==9 || saved.events.length!==15) throw Error('Duplicate imported history');
                const newer=normalizeRecord('friends',{...d.friends[1],observedAt:Date.now(),location:{kind:'private'}});
                await mergeSyncRecords([newer]);
                await mergeSyncRecords(records);
                saved=await exportAccount(d.accountId);
                if(saved.friends.find(f=>f.id===newer.value.id).location.kind!=='private') throw Error('Old import overwrote new observation');
                // Local autoincrement keys must never be exported as remote identities.
                const exported=await exportSyncRecords();
                if(exported.some(r=>'key' in r.value)) throw Error('Local keys leaked');
                const extra=normalizeRecord('friends',{...d.friends[0],extensions:{'example.notes':{text:'keep'}}});
                await mergeSyncRecords([extra,normalizeRecord('friends',{...d.friends[0],observedAt:Date.now()})]);
                if(!(await exportAccount(d.accountId)).friends.find(f=>f.id===extra.value.id).extensions)throw Error('Extension namespace lost');
                const source='https://api.vrchat.cloud/api/1/file/file_01234567-abcd-1234-abcd-012345678901/1/file';
                await enqueueImages(d.accountId,[{kind:'user',id:d.friends[0].id,url:source},{kind:'world',id:d.worlds[0].id,url:source}]);
                await enqueueImages('usr_anotheraccount0001',[{kind:'user',id:d.friends[0].id,url:source}]);
                const blob=await thumbnail(await (await fetch('icons/icon-128.png')).blob());
                const bitmap=await createImageBitmap(blob);if(bitmap.width!==128||bitmap.height!==128)throw Error('Thumbnail dimensions');bitmap.close();
                for(const row of await cachedImages())await updateCachedImage(row.key,current=>({...current,blob,bytes:blob.size,cachedUrl:current.url,fetchedAt:Date.now()}));
                if((await cachedImages(d.accountId)).length!==2)throw Error('Image account isolation');
                if(JSON.stringify(await exportSyncRecords()).includes(source)||JSON.stringify(await exportAccount(d.accountId)).includes('blob'))throw Error('Image data exported');
                await trimImageCache(blob.size*2,2,0);if((await cachedImages()).length!==2)throw Error('Cache bound');
                await trimImageCache(32*1024*1024,1000,Date.now()+1);if((await cachedImages()).length!==0)throw Error('Cache TTL');
                await enqueueImages(d.accountId,[{kind:'user',id:d.friends[0].id,url:source}]);
                let row=(await cachedImages(d.accountId))[0];await clearImageCache();await updateCachedImage(row.key,current=>current?.url===source?{...current,blob}:current);
                if((await cachedImages()).length)throw Error('Deleted image resurrected');
                // Keep a real Blob for the restart/UI check.
                await enqueueImages(d.accountId,[{kind:'user',id:d.friends[0].id,url:source}]);row=(await cachedImages(d.accountId))[0];
                await updateCachedImage(row.key,current=>({...current,blob,bytes:blob.size,cachedUrl:source,fetchedAt:Date.now()}));
                return d.accountId;
            }''')
            assert not errors, errors
            print('PASS: rankings, journey/privacy gaps, mobile layout, exports, idempotent IndexedDB merge and conflicts')
        finally:
            context.close()
        context = launch()
        try:
            # Browser policy blocks unpacked extensions; only the Chrome API boundary is stubbed for this dashboard check.
            context.add_init_script('''const values={settings:{enabled:false,pollSeconds:180},state:{phase:'paused'},accountMeta:{usr_demoaccount0001:{displayName:'同期したアカウント'}}};
                window.chrome={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]]))},onChanged:{addListener:()=>{}}},runtime:{sendMessage:async()=>({ok:true})}};''')
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/dashboard.html')
            expect(page.locator('#friendsBody tr')).to_have_count(9)
            expect(page.locator('#account')).to_have_value(account)
            expect(page.locator('#friendsBody img.cached-avatar')).to_have_count(1)
            page.wait_for_function("document.querySelector('#friendsBody img.cached-avatar').naturalWidth===128")
            page.locator('[data-tab=journey]').click()
            page.locator('#journeyUser').select_option(label='星灯り')
            expect(page.locator('#journeyFlow > li')).to_have_count(4)
            page.locator('[data-tab=settings]').click()
            expect(page.locator('#syncEndpoint')).to_be_visible()
            expect(page.locator('#syncToken')).to_have_value('')
            assert not errors, errors
            print('PASS: v1 DB upgrade, Blob cache limits/isolation, export exclusion, real thumbnail conversion and cached images after restart')
        finally:
            context.close()
finally:
    server.shutdown()
    server.server_close()
