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
            page.locator('[data-tab=ranking]').click()
            expect(page.locator('.world-card')).to_have_count(3)
            expect(page.locator('.world-card').first).to_contain_text('星灯りの展望台')
            expect(page.locator('.world-card').first.locator('.world-score')).to_contain_text('2 人')
            page.locator('[data-tab=journey]').click()
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
                    assert len(saved['friends']) == 9 and len(saved['events']) == 12
                else:
                    assert 'account_id' in content and '星灯り' in content
            account = page.evaluate('''async () => {
                const {demoData} = await import('./demo.js');
                const {normalizeRecord} = await import('./sync-format.js');
                const {mergeSyncRecords, exportSyncRecords, exportAccount} = await import('./db.js');
                const d = demoData();
                const records = [...d.friends.map(v=>normalizeRecord('friends',v)), ...d.events.map(v=>normalizeRecord('events',v)), ...d.worlds.map(v=>normalizeRecord('worlds',{...v,accountId:d.accountId}))];
                await mergeSyncRecords([...records,...records]);
                await mergeSyncRecords(records);
                let saved = await exportAccount(d.accountId);
                if(saved.friends.length!==9 || saved.events.length!==12) throw Error('Duplicate imported history');
                const newer=normalizeRecord('friends',{...d.friends[1],observedAt:Date.now(),location:{kind:'private'}});
                await mergeSyncRecords([newer]);
                await mergeSyncRecords(records);
                saved=await exportAccount(d.accountId);
                if(saved.friends.find(f=>f.id===newer.value.id).location.kind!=='private') throw Error('Old import overwrote new observation');
                // Local autoincrement keys must never be exported as remote identities.
                const exported=await exportSyncRecords();
                if(exported.some(r=>'key' in r.value)) throw Error('Local keys leaked');
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
            page.locator('[data-tab=journey]').click()
            page.locator('#journeyUser').select_option(label='星灯り')
            expect(page.locator('#journeyFlow > li')).to_have_count(4)
            page.locator('[data-tab=settings]').click()
            expect(page.locator('#syncEndpoint')).to_be_visible()
            expect(page.locator('#syncToken')).to_have_value('')
            assert not errors, errors
            print('PASS: persisted cloud records render after restart; sync setup fields do not expose saved keys')
        finally:
            context.close()
finally:
    server.shutdown()
    server.server_close()
