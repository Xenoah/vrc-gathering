"""Animated journey interaction and local-only image caching in Chromium."""
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
    with tempfile.TemporaryDirectory(prefix='vrc-network-') as profile,sync_playwright() as p:
        context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,viewport={'width':1500,'height':1000})
        errors=[];page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(base+'/dashboard.html?demo=1');page.locator('[data-tab=journey]').click()
        canvas=page.locator('#networkCanvas');canvas.scroll_into_view_if_needed()
        expect(page.locator('#networkMotion')).to_have_attribute('aria-pressed','true')
        first=canvas.evaluate('(el)=>el.toDataURL()');page.wait_for_timeout(220)
        assert first!=canvas.evaluate('(el)=>el.toDataURL()'),'Particles did not advance'
        page.locator('#networkMotion').click();page.wait_for_timeout(80)
        first=canvas.evaluate('(el)=>el.toDataURL()');page.wait_for_timeout(180)
        assert first==canvas.evaluate('(el)=>el.toDataURL()'),'Paused animation kept running'
        canvas.hover();before=page.locator('#networkZoom').inner_text();page.mouse.wheel(0,-100)
        page.wait_for_function('(before)=>document.getElementById("networkZoom").value!==before',arg=before)
        expect(page.locator('#networkNode')).to_contain_text('プライベート');expect(page.locator('#networkNode')).to_contain_text('現実世界')
        page.locator('#fitNetwork').click();page.evaluate('document.activeElement.blur();scrollTo(0,0)');page.screenshot(path='/tmp/vrc-v08-network.png',full_page=True)
        # A clean page follows the OS preference by default and can still be enabled explicitly.
        reduced=context.new_page();reduced.emulate_media(reduced_motion='reduce');reduced.goto(base+'/dashboard.html?demo=1');reduced.locator('[data-tab=journey]').click()
        expect(reduced.locator('#networkMotion')).to_have_attribute('aria-pressed','false');reduced.close()
        page.set_viewport_size({'width':390,'height':844});page.locator('[data-tab=journey]').click()
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path='/tmp/vrc-v08-network-mobile.png',full_page=True)
        assert not errors,errors
        context.close()
        print('PASS: animated direction, pause/reduced motion, wheel zoom without modifiers, renamed nodes, local image behavior covered by browser_smoke.py')
finally:server.shutdown()
