#!/usr/bin/env python3
"""Distribution rendering and controls using synthetic saved data, without API calls."""
import csv,functools,io,json,tempfile,threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def end_headers(self):
  self.send_header('Content-Security-Policy',json.loads((ROOT/'extension/manifest.json').read_text())['content_security_policy']['extension_pages']);super().end_headers()
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True)
  context=browser.new_context(viewport={'width':1450,'height':1050},accept_downloads=True)
  context.add_init_script('''
   if(location.hostname==='127.0.0.1'){
   const values={},listeners=[],noop={addListener(){}};window.fixture={values};
   window.chrome={storage:{local:{get:async keys=>{await seedReady;return structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])));},set:async next=>{Object.assign(values,structuredClone(next));listeners.forEach(fn=>fn());}},onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{contains:async()=>false},runtime:{getURL:path=>new URL(path,location.href).href,sendMessage:async()=>{throw Error('Histogram must not request collection');}}};
   window.seedReady=(async()=>{
    const d=(await import('/demo.js')).demoData(),a=d.accountId,b='usr_otherhist001',now=Date.now(),{mergeSyncRecords}=await import('/db.js'),{normalizeRecord}=await import('/sync-format.js');
    await mergeSyncRecords(d.friends.map(f=>normalizeRecord('friends',f)));
    const metrics={};[0,1,9,10,100,1000,1200,10000].forEach((followers,i)=>{const url='https://x.com/follower'+i;metrics['xFollowers:'+a+':follower'+i]={accountId:a,url,followers,source:'x-profile',observedAt:now-86400000+i*1000,approximate:i===6};});
    metrics.other={accountId:b,url:'https://x.com/otherfixture',followers:999999,source:'x-profile',observedAt:now,approximate:false};
    const profiles={};d.friends.slice(0,3).forEach((f,i)=>{profiles[a+'/'+f.id]={accountId:a,userId:f.id,checkedAt:now,urls:(i===0?['follower0','follower1']:i===1?['follower0']:['missing']).map(n=>'https://x.com/'+n)};});
    Object.assign(values,{state:{accountId:a},settings:{enabled:false},accountMeta:{[a]:{displayName:'Fixture A'},[b]:{displayName:'Fixture B'}},xProfileCache:profiles,xFollowerCache:metrics});
   })();}
  ''')
  external=[];context.route('https://**/*',lambda r:(external.append(r.request.url),r.abort()))
  page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(f'http://127.0.0.1:{server.server_port}/dashboard.html');page.locator('[data-tab=friends]').click();root=page.locator('#xFollowerHistogram')
  root.locator(':scope > summary').click();summary=root.locator('[data-histogram=summary]')
  expect(summary).to_contain_text('取得済み 8アカウント');expect(summary).to_contain_text('未取得のXリンク 1件');expect(summary).to_contain_text('概数 1件');expect(summary).to_contain_text('中央値 55人')
  expect(root.locator('[data-histogram=plot] [role=button]')).to_have_count(6)
  root.get_by_role('button',name='1〜9人：2アカウント',exact=True).focus();page.keyboard.press('Enter')
  expect(root.locator('[data-histogram=list] tr')).to_have_count(2);expect(root.locator('[data-histogram=selection]')).to_contain_text('1〜9人：2アカウント')
  root.get_by_role('button',name='0人：1アカウント',exact=True).click();expect(root.locator('[data-histogram=list]')).to_contain_text('@follower0')
  root.locator('[data-histogram=scope]').select_option('friends');expect(summary).to_contain_text('取得済み 2アカウント');expect(summary).to_contain_text('未取得のXリンク 1件')
  root.locator('[data-histogram=scope]').select_option('all');root.locator('[data-histogram=scale]').select_option('linear');root.locator('[data-histogram=bins]').fill('5')
  expect(root.locator('[data-histogram=plot] [role=button]')).to_have_count(5)
  root.get_by_role('button',name='0〜1,999人：7アカウント',exact=True).click();expect(root.locator('[data-histogram=list] tr')).to_have_count(7)
  with page.expect_download() as item:root.locator('[data-histogram=csv]').click()
  rows=list(csv.reader(io.StringIO(Path(item.value.path()).read_text(encoding='utf-8-sig'))));assert len(rows)==6;assert sum(int(r[2]) for r in rows[1:])==8
  page.evaluate("()=>{const cache=structuredClone(fixture.values.xFollowerCache);const row=Object.values(cache).find(r=>r.url==='https://x.com/follower0');row.followers=50;row.observedAt=Date.now();return chrome.storage.local.set({xFollowerCache:cache});}")
  expect(root.locator('[data-histogram=list] tr').filter(has_text='@follower0').locator('td').nth(1)).to_have_text('50')
  original=page.evaluate('fixture.values.xFollowerCache')
  page.evaluate('''()=>{const cache=structuredClone(fixture.values.xFollowerCache),accountId='usr_demoaccount0001';for(let i=0;i<205;i++)cache['bulk'+i]={accountId,url:'https://x.com/bulk'+i,followers:2000,approximate:false,source:'x-profile',observedAt:Date.now()};return chrome.storage.local.set({xFollowerCache:cache});}''')
  root.locator('[data-histogram=bins]').fill('');root.locator('[data-histogram=scale]').select_option('log');expect(summary).to_contain_text('取得済み 213アカウント')
  root.get_by_role('button',name='1,000〜9,999人：207アカウント',exact=True).click();expect(root.locator('[data-histogram=list] tr')).to_have_count(100)
  root.locator('[data-histogram=more]').click();expect(root.locator('[data-histogram=list] tr')).to_have_count(200)
  page.evaluate('()=>{window.previousHistogramRow=document.querySelector("[data-histogram=list] tr");return chrome.storage.local.set({xFollowerCache:fixture.values.xFollowerCache});}');page.wait_for_function('()=>!previousHistogramRow.isConnected');expect(root.locator('[data-histogram=list] tr')).to_have_count(200)
  root.locator('[data-histogram=more]').click();expect(root.locator('[data-histogram=list] tr')).to_have_count(207);expect(root.locator('[data-histogram=more]')).not_to_be_visible()
  page.evaluate('(cache)=>chrome.storage.local.set({xFollowerCache:cache})',original);expect(summary).to_contain_text('取得済み 8アカウント')
  page.locator('#account').select_option('usr_otherhist001');expect(summary).to_contain_text('取得済み 1アカウント');expect(summary).to_contain_text('999,999');expect(root.locator('[data-histogram=listWrap]')).not_to_be_visible()
  root.locator('[data-histogram=scope]').select_option('friends');expect(summary).to_contain_text('取得済み 0アカウント');expect(root.locator('[data-histogram=csv]')).to_be_disabled();expect(root.locator('[data-histogram=plot]')).to_contain_text('取得済みのフォロワー数がありません')
  page.locator('#account').select_option('usr_demoaccount0001');root.locator('[data-histogram=scope]').select_option('all');root.locator('[data-histogram=scale]').select_option('log');expect(summary).to_contain_text('取得済み 8アカウント')
  bins=root.locator('[data-histogram=bins]');marks=root.locator('[data-histogram=plot] [role=button]')
  bins.fill('7');expect(marks).to_have_count(7);expect(root.locator('[data-histogram=binStatus]')).to_contain_text('表示 7階級（指定 7）')
  for value in ['0','101','2.5']:
   bins.fill(value);expect(bins).to_have_attribute('aria-invalid','true');expect(root.locator('[data-histogram=binError]')).to_be_visible();expect(marks).to_have_count(7)
  bins.fill('100');expect(marks).to_have_count(100);expect(root.locator('[data-histogram=binError]')).not_to_be_visible()
  assert root.locator('[data-histogram=plot]').evaluate('(n)=>n.scrollWidth>n.clientWidth')
  marks.last.focus();page.keyboard.press('Enter');expect(root.locator('[data-histogram=list]')).to_contain_text('@follower7')
  with page.expect_download() as item:root.locator('[data-histogram=csv]').click()
  rows=list(csv.reader(io.StringIO(Path(item.value.path()).read_text(encoding='utf-8-sig'))));assert len(rows)==101;assert sum(int(r[2]) for r in rows[1:])==8
  root.locator('[data-histogram=scope]').select_option('friends');expect(root.locator('[data-histogram=binStatus]')).to_contain_text('表示 51階級（指定 100）');expect(root.locator('[data-histogram=binStatus]')).to_contain_text('減らしています')
  root.locator('[data-histogram=scope]').select_option('all');bins.fill('37');root.locator('[data-histogram=scale]').select_option('linear');expect(marks).to_have_count(37)
  # Only valid view preferences persist; reload never triggers new collection.
  bins.fill('101');page.reload();page.locator('[data-tab=friends]').click();root.evaluate('(n)=>n.open=true')
  expect(bins).to_have_value('37');expect(root.locator('[data-histogram=scale]')).to_have_value('linear');expect(marks).to_have_count(37);expect(root.locator('[data-histogram=binError]')).not_to_be_visible()
  bins.fill('');page.reload();page.locator('[data-tab=friends]').click();root.evaluate('(n)=>n.open=true');expect(bins).to_have_value('');expect(marks).to_have_count(10)
  root.locator('[data-histogram=scale]').select_option('log');expect(marks).to_have_count(6);bins.fill('7');expect(marks).to_have_count(7)
  root.screenshot(path='/tmp/vrc-x-histogram-desktop.png')
  page.locator('[data-tab=settings]').click();page.locator('#xSavedProfiles').evaluate('(n)=>n.open=true');page.locator('#showXHistogram').click();expect(root).to_be_visible()
  page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  assert root.locator('[data-histogram=plot]').evaluate('(n)=>n.scrollWidth>n.clientWidth')
  bins.fill('100');expect(marks).to_have_count(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  root.screenshot(path='/tmp/vrc-x-histogram-mobile.png');assert not errors,errors;assert not external,external
  browser.close();print('PASS: histogram scopes, custom 1–100 bins on both scales, validation and persistence, narrow ranges, keyboard selection, matching CSV, live updates, account isolation, empty states, settings shortcut, mobile scrolling and no API calls')
finally:server.shutdown();server.server_close()
