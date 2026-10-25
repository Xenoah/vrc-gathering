"""Dark dashboard charts, keyboard drilldowns, empty states and responsive navigation."""
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
try:
    with tempfile.TemporaryDirectory(prefix='vrc-ui-') as profile, sync_playwright() as p:
        context = p.chromium.launch_persistent_context(profile, executable_path='/usr/bin/chromium', headless=True, viewport={'width':1600,'height':1100})
        errors=[]
        page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(f'http://127.0.0.1:{server.server_port}/dashboard.html?demo=1')
        expect(page.locator('#homePresence .chart-total')).to_have_text('9')
        expect(page.locator('#homeWorlds .chart-bar-row')).to_have_count(3)
        expect(page.locator('#homeConnections .chart-bar-row')).to_have_count(3)
        assert page.locator('#homePresence .chart-donut-legend').inner_text().find('古い観測')>=0
        point=page.locator('#homeTrend .chart-point').first
        point.focus();expect(page.locator('#homeTrend .chart-readout')).to_contain_text('変更イベント')
        point.press('Enter');expect(page.locator('#labPanel')).to_be_visible()
        expect(page.locator('#labRange')).to_have_value('custom')
        expect(page.locator('#labTable-daily tbody tr')).to_have_count(1)
        page.locator('[data-tab=home]').click()
        page.locator('#homeWorlds .chart-bar-row').first.click()
        expect(page.locator('#labWorld')).to_have_value('wrld_demoobservatory')
        expect(page.locator('[data-tool=worlds]')).to_be_visible()
        page.locator('[data-tab=home]').click()
        page.locator('#homeConnections .chart-bar-row').first.click()
        assert page.locator('#labUser').input_value()
        expect(page.locator('[data-tool=connections]')).to_be_visible()
        page.locator('[data-tab=home]').click();page.evaluate('scrollTo(0,0)')
        page.screenshot(path='/tmp/vrc-dashboard-dark-desktop.png',full_page=True)
        # Test keyboard-readable values and hostile labels in all new primitives, without any remote content.
        page.evaluate('''async()=>{
          const {donutChart,lineChart,barChart,scatterChart}=await import('./charts.js');
          const host=document.createElement('section');host.id='chartHarness';document.body.append(host);
          donutChart(host,[{name:'empty',count:0}],{label:'zero'});
          barChart(host,[{name:'<img src=x onerror=alert(1)>',count:2}],{label:'hostile'});
          lineChart(host,[{day:'2026-10-25',changes:0}],{label:'single',series:[{key:'changes',label:'変更'}]});
          scatterChart(host,[{name:'same',worlds:[],changes:0}],{label:'zero scatter'});
        }''')
        expect(page.locator('#chartHarness .chart-empty')).to_have_count(1)
        expect(page.locator('#chartHarness img')).to_have_count(0)
        assert 'NaN' not in page.locator('#chartHarness').inner_html()
        page.locator('#chartHarness').evaluate('(el)=>el.remove()')
        for width in [1600,1280,768,390]:
            page.set_viewport_size({'width':width,'height':1000})
            for tab in ['home','lab','analytics','connections','friends','ranking','journey','history','settings','help']:
                page.locator('[data-tab='+tab+']').click()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,tab)
                expect(page.locator('#'+tab+'Panel')).to_be_visible()
            page.locator('[data-tab=home]').click();page.evaluate('scrollTo(0,0)')
            if width==390:page.screenshot(path='/tmp/vrc-dashboard-dark-mobile.png',full_page=True)
        page.set_viewport_size({'width':1600,'height':1100})
        page.locator('[data-tab=lab]').click()
        page.locator('#labUser').select_option('');page.locator('#labWorld').select_option('')
        page.locator('#labRange').select_option('7')
        for category in ['overview','time','world','movement','self','people','quality']:
            page.locator('#labCategories [data-category='+category+']').click()
            assert page.locator('#labCards .lab-card:visible').count()>0
            page.evaluate('scrollTo(0,0)')
            page.screenshot(path='/tmp/vrc-dashboard-dark-'+category+'.png',full_page=True)
        assert not errors,errors
        context.close()
    print('PASS: dark overview charts, keyboard/day/world/user drilldowns, zero/hostile data, all tabs at 390/768/1280/1600px and seven analytics categories')
finally:
    server.shutdown()
