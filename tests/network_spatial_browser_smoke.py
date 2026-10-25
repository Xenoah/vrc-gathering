"""Real Chromium canvas: layout assignment, 3D navigation, animation and large graphs."""
import functools,json,tempfile,threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def end_headers(self):
        self.send_header('Content-Security-Policy',json.loads((ROOT/'extension/manifest.json').read_text())['content_security_policy']['extension_pages'])
        super().end_headers()
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
 with tempfile.TemporaryDirectory(prefix='vrc-spatial-') as profile,sync_playwright() as p:
    context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,viewport={'width':1500,'height':1100})
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    url=f'http://127.0.0.1:{server.server_port}/dashboard.html?demo=1'
    page.goto(url);page.locator('[data-tab=journey]').click();expect(page.locator('#networkViewport')).to_be_visible()
    page.select_option('#networkMode','2d');expect(page.locator('#networkViewport')).to_be_hidden();expect(page.locator('#spatialViewport')).to_be_visible();expect(page.locator('#networkZControl')).to_be_hidden()
    page.select_option('#networkAxisX','capacity');page.select_option('#networkAxisY','name')
    node_id=page.locator('#networkNode option').nth(1).get_attribute('value');page.select_option('#networkNode',node_id)
    expect(page.locator('#networkDetail')).to_contain_text('X: ワールド定員');expect(page.locator('#networkDetail')).to_contain_text('Y: ワールド名')
    page.select_option('#networkMode','3d');page.select_option('#networkAxisZ','connections');expect(page.locator('#networkZControl')).to_be_visible()
    canvas=page.locator('#spatialCanvas');canvas.scroll_into_view_if_needed();page.wait_for_timeout(200)
    first=canvas.evaluate('(el)=>el.toDataURL()');page.wait_for_timeout(200);assert first!=canvas.evaluate('(el)=>el.toDataURL()')
    page.locator('#networkMotion').click();page.wait_for_timeout(80);first=canvas.evaluate('(el)=>el.toDataURL()');page.wait_for_timeout(150);assert first==canvas.evaluate('(el)=>el.toDataURL()')
    box=canvas.bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+130,y+50,steps=8);page.mouse.up();page.wait_for_timeout(100);assert first!=canvas.evaluate('(el)=>el.toDataURL()')
    before=page.locator('#networkZoom').inner_text();page.mouse.wheel(0,-130);page.wait_for_timeout(100);assert page.locator('#networkZoom').inner_text()!=before
    page.locator('#fitNetwork').click();page.select_option('#networkAxisX','users');page.select_option('#networkAxisY','moves');page.screenshot(path='/tmp/vrc-network-3d.png',full_page=True)
    page.reload();page.locator('[data-tab=journey]').click();expect(page.locator('#networkMode')).to_have_value('3d');expect(page.locator('#networkAxisZ')).to_have_value('connections')
    page.select_option('#networkMode','2d');page.screenshot(path='/tmp/vrc-network-2d.png',full_page=True)
    page.select_option('#networkMode','radial');expect(page.locator('#networkViewport')).to_be_visible();expect(page.locator('#networkAxes')).to_be_hidden();expect(page.locator('#networkSort')).to_be_enabled()
    for mode in ['radial','2d','3d']:
        page.set_viewport_size({'width':390,'height':850});page.select_option('#networkMode',mode);page.wait_for_timeout(80)
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),mode+' overflow'
    # Exercise camera state via the same renderer used by the dashboard, with synthetic large data.
    page.set_viewport_size({'width':1300,'height':950})
    page.evaluate('''async()=>{
      const {createSpatialView}=await import('./network-spatial-view.js');const {spatialNetwork}=await import('./network-layout.js');
      document.body.replaceChildren();const v=document.createElement('div');v.style.cssText='height:700px;width:1200px';v.tabIndex=0;v.id='testViewport';const c=document.createElement('canvas');c.id='testCanvas';v.append(c);const z=document.createElement('output');document.body.append(v,z);
      const nodes=Array.from({length:3000},(_,i)=>({id:'w'+i,name:'地点'+i,kind:i===0?'private':'world',users:new Set(Array(i%20).fill(0)),currentUsers:new Set(Array(i%4).fill(0)),moves:i,observedAt:Date.now()}));
      window.source={nodes,edges:nodes.slice(1).map((n,i)=>({id:'e'+i,from:'w'+i,to:n.id,count:1}))};window.g=spatialNetwork(source,[],{mode:'3d',x:'moves',y:'users',z:'current'});
      window.view=createSpatialView({viewport:v,canvas:c,zoomLabel:z,onSelect:n=>window.selected=n?.id});view.setActive(true);view.setMotion(false);view.setGraph(g,'same');
    }''')
    page.wait_for_timeout(250);assert page.evaluate('view.state.projected.length')==3000
    assert page.evaluate('document.querySelector("#testCanvas").width<=2400')
    before=page.evaluate('view.state.camera');page.mouse.move(600,350);page.mouse.down(button='right');page.mouse.move(660,370,steps=4)
    look=page.evaluate('view.state.camera');assert look['yaw']!=before['yaw']
    page.keyboard.down('w');page.wait_for_timeout(160);page.keyboard.up('w');page.mouse.up(button='right');after=page.evaluate('view.state.camera');assert after['target']!=look['target']
    page.mouse.move(600,350);page.mouse.down(button='middle');page.mouse.move(640,380,steps=4);page.mouse.up(button='middle');assert page.evaluate('view.state.camera.target')!=after['target'];after=page.evaluate('view.state.camera')
    page.evaluate("view.setGraph(g,'same')");assert page.evaluate('view.state.camera')==after,'refresh reset camera'
    page.locator('#testViewport').press('Home');page.evaluate("view.focus('w3')");assert page.evaluate('view.state.selected')=='w3';expect(page.locator('#testViewport')).to_be_visible()
    page.locator('#testViewport').press('ArrowRight');assert page.evaluate('view.state.camera.yaw')!=.65
    page.locator('#testViewport').press('f');assert page.evaluate('view.state.camera.target')==page.evaluate('({x:g.nodes[3].x,y:g.nodes[3].y,z:g.nodes[3].z})')
    touch=context.new_cdp_session(page);touch.send('Emulation.setTouchEmulationEnabled',{'enabled':True,'maxTouchPoints':2})
    distance=page.evaluate('view.state.camera.distance')
    touch.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':550,'y':350,'id':0},{'x':650,'y':350,'id':1}]})
    touch.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':520,'y':360,'id':0},{'x':680,'y':360,'id':1}]})
    touch.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});assert page.evaluate('view.state.camera.distance')<distance
    touch.send('Emulation.setTouchEmulationEnabled',{'enabled':False})
    # A zero-distance overlap still permits choosing each point, without changing metric coordinates.
    page.evaluate("g={...g,nodes:[{...g.nodes[0],x:0,y:0,z:0},{...g.nodes[1],x:0,y:0,z:0}],edges:[]};view.setGraph(g,'overlap');view.focus('w0')")
    page.wait_for_timeout(100);point=page.evaluate('view.state.projected[0]');b=page.locator('#testCanvas').bounding_box();page.mouse.click(b['x']+point['x'],b['y']+point['y']);one=page.evaluate('selected');page.mouse.click(b['x']+point['x'],b['y']+point['y']);assert page.evaluate('selected')!=one
    # Losing focus must stop held movement keys.
    page.mouse.down(button='right');page.keyboard.down('w');page.wait_for_timeout(80);page.evaluate('window.dispatchEvent(new Event("blur"))');page.keyboard.up('w');page.mouse.up(button='right');page.wait_for_timeout(80);before=page.evaluate('view.state.camera');page.wait_for_timeout(100);assert page.evaluate('view.state.camera')==before
    page.evaluate("view.setGraph({...g,nodes:[],edges:[]},'empty')");page.wait_for_timeout(80);assert page.evaluate('view.state.projected.length')==0
    page.emulate_media(reduced_motion='reduce');page.goto(url);page.locator('[data-tab=journey]').click();page.select_option('#networkMode','3d');expect(page.locator('#networkMotion')).to_have_attribute('aria-pressed','false')
    assert not errors,errors
    context.close();print('Spatial network: layout, axes, camera, persistence, motion, mobile and 3,000 nodes passed')
finally:server.shutdown()
