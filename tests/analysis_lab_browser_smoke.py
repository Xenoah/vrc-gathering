"""Analytics controls, charts, exports and large tables in Chromium under the extension CSP."""
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
server = ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    with tempfile.TemporaryDirectory(prefix='vrc-lab-') as profile, sync_playwright() as p:
        context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True)
        try:
            errors=[]
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(base+'/dashboard.html?demo=1')
            page.locator('[data-tab=lab]').click()
            expect(page.locator('#labError')).to_be_hidden()
            expect(page.locator('#labCards .lab-card')).to_have_count(31)
            expect(page.locator('#labToolCount')).to_contain_text('31種類')
            expect(page.locator('#labSummary')).to_contain_text('9ユーザー')
            expect(page.locator('#labTable-comparison tbody tr')).to_have_count(8)
            page.locator('#labCategories [data-category=time]').click()
            expect(page.locator('.lab-heat')).to_have_count(168)
            page.locator('.lab-heat').first.click()
            expect(page.locator('#labHeatDetail')).to_contain_text('日曜日 0時')
            page.locator('#labCategories [data-category=people]').click()
            expect(page.locator('#labNetworkSummary')).to_contain_text('8本の線')
            expect(page.locator('#labPairSummary')).to_contain_text('類似度')
            page.locator('#labPairA').select_option('usr_demofriend0000')
            page.locator('#labPairB').select_option('usr_demofriend0003')
            expect(page.locator('#labPairSummary')).to_contain_text('共通 3ワールド')
            expect(page.locator('#labNetworkSelection')).to_contain_text('星灯りの展望台')
            page.locator('[data-tool=pair] .lab-data > summary').click()
            page.locator('#labGraphMinimum').select_option('3')
            assert not page.locator('[data-tool=pair] .lab-data').evaluate('(el)=>el.open')
            expect(page.locator('#labNetworkSummary')).to_contain_text('1本の線')
            page.locator('#labNetworkFit').click();before=page.locator('#labNetworkZoom').inner_text()
            page.locator('#labNetworkIn').click();assert page.locator('#labNetworkZoom').inner_text()!=before
            page.locator('#labGraphMinimum').select_option('1')
            # Re-rendering must keep the network controls and table event handlers alive.
            page.locator('#labGraphLimit').select_option('80')
            expect(page.locator('#labNetworkViewport')).to_be_visible()
            page.locator('[data-tool=network]').screenshot(path='/tmp/vrc-lab-network.png')
            with page.expect_download() as event:page.locator('#labExportJSON').click()
            exported=json.loads(Path(event.value.path()).read_text())
            assert exported['schema']==1 and exported['metrics']['users']==9
            assert exported['pairComparison']['similarity']==1
            assert len(exported['sharedWorldNetwork']['edges'])==8
            with page.expect_download() as event:page.locator('#labExportCSV').click()
            csv=Path(event.value.path()).read_text(encoding='utf-8-sig')
            assert '同じ長さの前期間と比較' in csv and '同席相手ランキング' in csv
            assert '集計条件' in csv and 'networkLimit' in csv and 'Asia/Tokyo' in csv
            page.locator('#labUser').select_option('usr_demofriend0003')
            expect(page.locator('#labSummary')).to_contain_text('1ユーザー')
            expect(page.locator('#labTable-explorers tbody tr')).to_have_count(1)
            page.locator('#labUser').select_option('')
            page.locator('#labWorld').select_option('wrld_democafe000000')
            expect(page.locator('#labTable-worlds tbody tr')).to_have_count(1)
            page.locator('#labWorld').select_option('')
            page.locator('#labCategories [data-category=all]').click()
            page.locator('#labToolSearch').fill('再訪')
            expect(page.locator('#labCards .lab-card:visible')).to_have_count(1)
            page.locator('#labToolSearch').fill('存在しない分析')
            expect(page.locator('#labNoTools')).to_be_visible()
            page.locator('#labToolSearch').fill('')
            page.locator('#labCategories [data-category=overview]').click()
            page.locator('.lab-day').last.click()
            expect(page.locator('#labRange')).to_have_value('custom')
            expect(page.locator('#labTable-daily tbody tr')).to_have_count(1)
            page.locator('#labStart').fill('2026-10-21');page.locator('#labEnd').fill('2026-10-20');page.locator('#labApply').click()
            expect(page.locator('#labError')).to_be_visible();expect(page.locator('#labExportJSON')).to_be_disabled()
            page.locator('#labRange').select_option('7');expect(page.locator('#labError')).to_be_hidden()
            page.locator('#labDailyMetric').select_option('selfDuration')
            page.evaluate('scrollTo(0,0)');page.screenshot(path='/tmp/vrc-lab-desktop.png',full_page=True)
            page.set_viewport_size({'width':390,'height':844})
            for category in ['overview','time','people','quality']:
                page.locator('#labCategories [data-category='+category+']').click()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),category
            page.locator('#labCategories [data-category=people]').click()
            page.screenshot(path='/tmp/vrc-lab-mobile.png',full_page=True)
            page.locator('[data-tab=connections]').click();expect(page.locator('#connectionsBody tr')).to_have_count(3)
            page.locator('[data-tab=lab]').click();expect(page.locator('#labError')).to_be_hidden()
            # Isolated UI harness exercises pagination, account switching and hostile text without API access.
            large=context.new_page();large.on('pageerror',lambda e:errors.append(str(e)))
            large.route('**/dashboard.js',lambda route:route.fulfill(status=200,content_type='text/javascript',body=''))
            large.goto(base+'/dashboard.html')
            large.evaluate('''async()=>{
                const {createAnalysisLab}=await import('./analysis-lab-ui.js');const {friend}=await import('./core.js');
                const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
                document.getElementById('labPanel').hidden=false;
                const lab=createAnalysisLab({node,date:v=>String(v),download:(name,text)=>{window.saved={name,text};}});
                const accountId='usr_testaccount1',now=Date.now();
                const friends=Array.from({length:125},(_,i)=>({...friend({id:'usr_test'+String(i).padStart(8,'0'),displayName:i===0?'<img src=x onerror=alert(1)>':'User '+String(i).padStart(3,'0'),location:'wrld_testworld1:123'},now-1000,'online'),accountId}));
                window.lab=lab;window.labData={friends,events:[],worlds:[]};lab.update(window.labData,accountId,{pollSeconds:180});
            }''')
            large.locator('#labCategories [data-category=movement]').click()
            expect(large.locator('#labTable-explorers tbody tr')).to_have_count(50)
            large.locator('[data-tool=explorers] .lab-data > summary').click()
            large.locator('#labTable-explorers .lab-more').click();expect(large.locator('#labTable-explorers tbody tr')).to_have_count(100)
            large.locator('#labTable-explorers .lab-more').click();expect(large.locator('#labTable-explorers tbody tr')).to_have_count(125)
            large.evaluate("window.lab.update(window.labData,'usr_testaccount1',{pollSeconds:180})")
            expect(large.locator('#labTable-explorers tbody tr')).to_have_count(125)
            assert large.locator('[data-tool=explorers] .lab-data').evaluate('(el)=>el.open')
            large.locator('#labTable-explorers th button').first.click()
            assert large.locator('#labTable-explorers img').count()==0
            large.evaluate("window.lab.update(window.labData,'usr_otheraccount',{pollSeconds:180})")
            expect(large.locator('#labSummary')).to_contain_text('0ユーザー')
            expect(large.locator('#labError')).to_be_hidden()
            assert not errors,errors
            print('PASS: 31 tools, filters, heatmap/calendar, network/pair comparison, CSV/JSON, sorting/pagination, account isolation, empty states, mobile, hostile text')
        finally: context.close()
finally: server.shutdown();server.server_close()
