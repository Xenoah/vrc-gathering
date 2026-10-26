"""Current location and roster UI using real worker/IndexedDB with synthetic API responses."""
import functools,json,tempfile,threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
FIXTURE=r"""
const owner='usr_ownfixture0001',friend='usr_friendfixture001',peer='usr_peerfixture00001',world='wrld_ownfixture00001';
const values=JSON.parse(localStorage.getItem('own-fixture')||'null')||{settings:{enabled:false,contact:'https://github.com/example',pollSeconds:180,retentionDays:30},accountMeta:{}};
const noop={addListener(){}},listeners=[];let messageListener;window.fixture={values,calls:[],offset:0,mode:'normal',instance:'123~region(jp)'};
const realNow=Date.now;Date.now=()=>realNow()+fixture.offset;
const storage={get:async keys=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]]))),set:async next=>{Object.assign(values,structuredClone(next));localStorage.setItem('own-fixture',JSON.stringify(values));listeners.forEach(fn=>fn());},setAccessLevel:async()=>{}};
window.chrome={storage:{local:storage,onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{contains:async()=>false},alarms:{create:async()=>{},clear:async()=>{},get:async()=>null,onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:noop},declarativeNetRequest:{updateDynamicRules:async()=>{}},tabs:{create:async()=>{},query:async()=>fixture.mode==='website'?[{id:55,url:'https://vrchat.com/home'}]:[],get:async()=>({id:55,url:'https://vrchat.com/home'})},scripting:{executeScript:async req=>{if(req.target.tabId!==55||req.args[0]!==owner)throw Error('Wrong website binding');return [{frameId:0,result:{accountId:owner,worldId:world,instanceId:fixture.instance+'~nonce(SECRET_NONCE)',worldName:'Website Fixture World',friendCount:99}}];}},runtime:{id:'testextension',getURL:path=>new URL(path,location.href).href,onInstalled:noop,onStartup:noop,onMessage:{addListener:fn=>messageListener=fn},sendMessage:async message=>{await window.workerReady;return new Promise(resolve=>messageListener(message,{id:'testextension',url:location.href},resolve));}}};
const realFetch=fetch;window.fetch=async(url,options)=>{
 if(!String(url).startsWith('https://'))return realFetch(url,options);
 fixture.offset+=2300;fixture.calls.push(String(url));const path=new URL(url).pathname,place=world+':'+fixture.instance;let body,status=200;
 if(path.endsWith('/auth/user'))body={id:owner,displayName:'Fixture self',state:fixture.mode==='offline'?'offline':'online',location:fixture.mode==='offline'?'offline':'',...(fixture.mode==='website'?{}:{presence:{id:owner,world,instance:place+'~nonce(SECRET_NONCE)',platform:'android'}}),friends:[friend],authToken:'SECRET_TOKEN',email:'SECRET_MAIL'};
 else if(path.includes('/instances/')){if(decodeURIComponent(path)!=='/api/1/instances/'+place)throw Error('Unexpected instance');body={location:place,userCount:fixture.mode==='empty'?1:3,world:{id:world,name:'Fixture World',capacity:32,assetUrl:'SECRET_ASSET'}};if(fixture.mode!=='unavailable')body.users=fixture.mode==='empty'?[{id:owner,displayName:'Self'}]:[{id:owner,displayName:'Self'},{id:friend,displayName:'Fixture Friend'},{id:peer,displayName:'Visitor <img>',email:'SECRET_MAIL'}];}
 else throw Error('Unexpected API '+path);
 return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
};
window.workerReady=import('/background.js');
"""
try:
 with tempfile.TemporaryDirectory(prefix='vrc-own-ui-') as profile,sync_playwright() as p:
  context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,viewport={'width':1440,'height':1000});context.add_init_script(FIXTURE)
  errors=[];page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(base+'/dashboard.html');page.locator('[data-tab=gameLog]').click();expect(page.locator('#instanceSelfPlace')).to_contain_text('未取得')
  def collect():
   page.locator('#collectOwnInstance').click();expect(page.locator('#instanceRequestStatus')).to_contain_text('記録しました',timeout=15000);expect(page.locator('#collectOwnInstance')).to_be_enabled()
  def data():return page.evaluate("async()=>await (await import('/db.js')).exportAccount('usr_ownfixture0001')")
  collect();expect(page.locator('#instanceSelfPlace')).to_contain_text('Fixture World');expect(page.locator('#instanceSelfId')).to_have_text('123~region(jp)')
  expect(page.locator('#instanceCurrentUsers')).to_contain_text('Visitor <img>');expect(page.locator('#instanceCurrentUsers img')).to_have_count(0)
  expect(page.locator('#instanceCurrentUsers tr').filter(has_text='Fixture Friend')).to_contain_text('フレンド');expect(page.locator('#instanceCurrentUsers tr').filter(has_text='Visitor')).to_contain_text('非フレンド')
  rows=data();assert len(rows['visits'])==1 and len(rows['instanceEncounters'])==2;assert not page.evaluate('fixture.values.settings.enabled');assert not rows['friends'];assert 'SECRET' not in json.dumps([rows,page.evaluate('fixture.values.instanceCollectionState')])
  count=page.evaluate('fixture.calls.length');page.locator('#collectOwnInstance').click();expect(page.locator('#instanceRequestStatus')).to_contain_text('60秒');assert page.evaluate('fixture.calls.length')==count
  page.evaluate('fixture.offset+=180000');collect();rows=data();assert len(rows['visits'])==1 and len(rows['instanceEncounters'])==2;assert all(r['sampleCount']==2 for r in rows['instanceEncounters'])
  expect(page.locator('#logSummary')).to_contain_text('2人');expect(page.locator('#logBody tr').filter(has_text='Fixture Friend')).to_contain_text('フレンド');page.select_option('#logRelation','nonfriend');expect(page.locator('#logSummary')).to_contain_text('1人');page.select_option('#logRelation','all');page.locator('.instance-current').screenshot(path='/tmp/vrc-own-instance-desktop.png')
  page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.locator('.instance-current').screenshot(path='/tmp/vrc-own-instance-mobile.png');page.set_viewport_size({'width':1440,'height':1000})
  offset=page.evaluate('fixture.offset');page.reload();page.evaluate('(n)=>fixture.offset=n',offset);page.locator('[data-tab=gameLog]').click();expect(page.locator('#instanceCurrentUsers')).to_contain_text('Visitor <img>')
  page.evaluate("async()=>{fixture.offset+=600000;await chrome.storage.local.set({state:fixture.values.state});}");expect(page.locator('#instanceCollectionStatus')).to_contain_text('古い観測')
  page.evaluate("()=>{fixture.mode='unavailable';fixture.offset+=61000;}");collect();expect(page.locator('#instanceSelfPlace')).to_contain_text('Fixture World');expect(page.locator('#instanceCurrentUsers')).to_contain_text('未取得');assert page.evaluate('fixture.values.instanceCollectionState.count') is None
  assert all(r['endReason']=='unavailable' for r in data()['instanceEncounters'])
  page.evaluate("()=>{fixture.mode='empty';fixture.offset+=61000;}");collect();expect(page.locator('#instanceCurrentUsers')).to_contain_text('自分以外の参加者はありません');assert page.evaluate('fixture.values.instanceCollectionState.count')==0
  page.evaluate("()=>{fixture.mode='normal';fixture.instance='456~region(jp)';fixture.offset+=61000;}");collect();expect(page.locator('#instanceSelfId')).to_have_text('456~region(jp)');assert len(data()['visits'])>=2;assert len(data()['instanceEncounters'])==4
  page.evaluate("()=>{fixture.mode='offline';fixture.offset+=61000;}");collect();expect(page.locator('#instanceSelfPlace')).to_contain_text('現実世界');expect(page.locator('#instanceCurrentUsers')).to_contain_text('未取得');assert data()['visits'][-1]['location']['kind']=='offline'
  page.evaluate("()=>{fixture.mode='website';fixture.offset+=61000;}");collect();expect(page.locator('#instanceSelfPlace')).to_contain_text('Website Fixture World');expect(page.locator('#instanceCollectionStatus')).to_contain_text('公式Web');expect(page.locator('#instanceCurrentUsers tr')).to_have_count(2);assert data()['visits'][-1]['extensions']['vrc.location']['source']=='vrchat-website'
  page.evaluate("async()=>{fixture.offset+=61000;await chrome.storage.local.set({accountMeta:{...fixture.values.accountMeta,usr_otherfixture0001:{displayName:'Other'}}});}");page.select_option('#account','usr_otherfixture0001');expect(page.locator('#instanceCurrentUsers')).not_to_contain_text('Visitor');page.locator('#collectOwnInstance').click();expect(page.locator('#instanceRequestStatus')).to_contain_text('異なります')
  assert not errors,errors;context.close();print('PASS: manual own collection from empty state, Quest presence and official-Web location fallbacks, friend/nonfriend roster, change-only visits, timestamps/reload/staleness, unavailable vs zero, world change/offline, account isolation, no secrets and mobile')
finally:server.shutdown()
